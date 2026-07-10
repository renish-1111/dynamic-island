'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

const PlayerIface = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="SetPosition">
      <arg type="o" direction="in"/>
      <arg type="x" direction="in"/>
    </method>
  </interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIface);

// Emits 'changed' whenever the "active" player (playing, or paused if
// nothing is playing) or its metadata changes.
export const MediaWatcher = GObject.registerClass({
    Signals: { 'changed': {} },
}, class MediaWatcher extends GObject.Object {
    _init() {
        super._init();
        this._players = new Map(); // busName -> { proxy, propsId }
        this._activeName = null;

        Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, null,
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deep_unpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX))
                        .forEach(n => this._addPlayer(n));
                } catch (e) {
                    logError(e, 'DynamicIsland: failed to list D-Bus names');
                }
            });

        this._nameOwnerId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                const [name, oldOwner, newOwner] = params.deep_unpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (newOwner && !oldOwner)
                    this._addPlayer(name);
                else if (!newOwner && oldOwner)
                    this._removePlayer(name);
            });
    }

    _addPlayer(name) {
        if (this._players.has(name))
            return;
        try {
            const proxy = new PlayerProxy(Gio.DBus.session, name, '/org/mpris/MediaPlayer2');
            const propsId = proxy.connect('g-properties-changed', () => this._recompute());
            this._players.set(name, { proxy, propsId });
            this._recompute();
        } catch (e) {
            logError(e, `DynamicIsland: failed to attach to ${name}`);
        }
    }

    _removePlayer(name) {
        const entry = this._players.get(name);
        if (!entry)
            return;
        try {
            entry.proxy.disconnect(entry.propsId);
        } catch (e) { /* proxy already gone */ }
        this._players.delete(name);
        this._recompute();
    }

    _recompute() {
        let playing = null;
        let paused = null;
        for (const [name, { proxy }] of this._players) {
            if (proxy.PlaybackStatus === 'Playing')
                playing = name;
            else if (proxy.PlaybackStatus === 'Paused' && !paused)
                paused = name;
        }
        this._activeName = playing || paused;
        this.emit('changed');
    }

    // Returns null, or { title, artist, artUrl, playing, playPause() }
    getActivePlayerInfo() {
        if (!this._activeName)
            return null;
        const entry = this._players.get(this._activeName);
        if (!entry)
            return null;

        const { proxy } = entry;
        const metadata = proxy.Metadata || {};

        const unpack = variant => {
            try {
                return variant ? variant.deep_unpack() : null;
            } catch (e) {
                return null;
            }
        };

        const title = unpack(metadata['xesam:title']) || '';
        const artistRaw = unpack(metadata['xesam:artist']);
        const artist = Array.isArray(artistRaw) ? artistRaw.join(', ') : '';
        const artUrl = unpack(metadata['mpris:artUrl']) || '';
        const length = unpack(metadata['mpris:length']) || 0;
        const trackId = unpack(metadata['mpris:trackid']) || null;

        return {
            title,
            artist,
            artUrl,
            length,
            canSeek: !!proxy.CanSeek && !!trackId && length > 0,
            playing: proxy.PlaybackStatus === 'Playing',
            playPause: () => {
                try {
                    proxy.PlayPauseRemote(() => {});
                } catch (e) {
                    logError(e, 'DynamicIsland: PlayPause failed');
                }
            },
            next: () => {
                try {
                    proxy.NextRemote(() => {});
                } catch (e) {
                    logError(e, 'DynamicIsland: Next failed');
                }
            },
            previous: () => {
                try {
                    proxy.PreviousRemote(() => {});
                } catch (e) {
                    logError(e, 'DynamicIsland: Previous failed');
                }
            },
            seekTo: fraction => {
                if (!trackId || length <= 0)
                    return;
                try {
                    const position = Math.round(Math.min(Math.max(fraction, 0), 1) * length);
                    proxy.SetPositionRemote(trackId, position, () => {});
                } catch (e) {
                    logError(e, 'DynamicIsland: SetPosition failed');
                }
            },
            // Asks the player to bring its own window to the front — the MPRIS
            // "open where it's playing" hook. Not every player implements it
            // (CanRaise may be false), so failures are just swallowed.
            raise: () => {
                Gio.DBus.session.call(
                    this._activeName, '/org/mpris/MediaPlayer2',
                    'org.mpris.MediaPlayer2', 'Raise', null, null,
                    Gio.DBusCallFlags.NONE, -1, null,
                    (conn, res) => {
                        try {
                            conn.call_finish(res);
                        } catch (e) { /* player doesn't support raising */ }
                    });
            },
        };
    }

    // Async — resolves with current playback position in microseconds, or null.
    queryPosition(callback) {
        if (!this._activeName) {
            callback(null);
            return;
        }
        Gio.DBus.session.call(
            this._activeName, '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const [variant] = conn.call_finish(res).deep_unpack();
                    callback(variant.deep_unpack());
                } catch (e) {
                    callback(null);
                }
            });
    }

    destroy() {
        if (this._nameOwnerId) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerId);
            this._nameOwnerId = null;
        }
        for (const [, { proxy, propsId }] of this._players) {
            try {
                proxy.disconnect(propsId);
            } catch (e) { /* ignore */ }
        }
        this._players.clear();
    }
});
