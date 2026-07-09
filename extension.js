'use strict';

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { MediaWatcher } from './mediaWatcher.js';

const COLLAPSED_WIDTH = 140;
const COLLAPSED_HEIGHT = 26;
const EXPANDED_WIDTH = 380;
const EXPANDED_HEIGHT = 64;
const ANIM_MS = 320;
const DISPLAY_MS = 4000;
const MAX_BODY_CHARS = 80;

const DynamicIsland = GObject.registerClass(
class DynamicIsland extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'dynamic-island',
            vertical: false,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });

        this._icon = new St.Icon({
            style_class: 'dynamic-island-icon',
            icon_size: 20,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        this._textBox = new St.BoxLayout({
            style_class: 'dynamic-island-text-box',
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        this._titleLabel = new St.Label({ style_class: 'dynamic-island-title' });
        this._bodyLabel = new St.Label({ style_class: 'dynamic-island-body' });
        this._titleLabel.clutter_text.set_ellipsize(3); // PANGO_ELLIPSIZE_END
        this._bodyLabel.clutter_text.set_ellipsize(3);

        this._textBox.add_child(this._titleLabel);
        this._textBox.add_child(this._bodyLabel);

        this._mediaButton = new St.Button({
            style_class: 'dynamic-island-media-button',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._mediaButtonIcon = new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            icon_size: 16,
        });
        this._mediaButton.set_child(this._mediaButtonIcon);
        this._mediaButton.connect('clicked', () => {
            if (this._onMediaToggle)
                this._onMediaToggle();
        });

        this.add_child(this._icon);
        this.add_child(this._textBox);
        this.add_child(this._mediaButton);

        this._textBox.hide();
        this.set_size(COLLAPSED_WIDTH, COLLAPSED_HEIGHT);

        this._collapseTimeoutId = null;
        this._notificationShowing = false;
        this._mediaMode = false;

        this.connect('destroy', () => this._clearTimeout());
    }

    _clearTimeout() {
        if (this._collapseTimeoutId) {
            GLib.source_remove(this._collapseTimeoutId);
            this._collapseTimeoutId = null;
        }
    }

    _expand() {
        this.ease({
            width: EXPANDED_WIDTH,
            height: EXPANDED_HEIGHT,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    // --- Notifications (temporary) ---------------------------------

    showNotification(gicon, title, body) {
        this._clearTimeout();
        this._notificationShowing = true;

        if (gicon) {
            this._icon.set_gicon(gicon);
            this._icon.show();
        } else {
            this._icon.hide();
        }

        this._mediaButton.hide();
        this._titleLabel.set_text(title || '');

        let bodyText = (body || '').replace(/\n/g, ' ');
        if (bodyText.length > MAX_BODY_CHARS)
            bodyText = bodyText.substring(0, MAX_BODY_CHARS - 1) + '…';
        this._bodyLabel.set_text(bodyText);
        this._bodyLabel.visible = bodyText.length > 0;

        this._textBox.show();
        this._expand();

        this._collapseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DISPLAY_MS, () => {
            this._collapseTimeoutId = null;
            this._notificationShowing = false;
            if (this._mediaMode)
                this._renderMedia(); // fall back to the persistent media pill
            else
                this._collapse();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Media (persistent while playing) ---------------------------

    setMedia(active, info) {
        if (!active) {
            this._mediaMode = false;
            this._lastMediaInfo = null;
            this._mediaButton.hide();
            if (!this._notificationShowing)
                this._collapse();
            return;
        }

        this._mediaMode = true;
        this._lastMediaInfo = info;
        this._onMediaToggle = info.playPause;

        if (!this._notificationShowing)
            this._renderMedia();
    }

    _renderMedia() {
        const info = this._lastMediaInfo;
        if (!info)
            return;

        this._icon.set_icon_name('audio-x-generic-symbolic');
        this._icon.show();

        this._titleLabel.set_text(info.title || 'Playing');
        this._bodyLabel.set_text(info.artist || '');
        this._bodyLabel.visible = !!info.artist;
        this._textBox.show();

        this._mediaButtonIcon.set_icon_name(
            info.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic');
        this._mediaButton.show();

        this._expand();
    }

    _collapse() {
        this.ease({
            width: COLLAPSED_WIDTH,
            height: COLLAPSED_HEIGHT,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._textBox.hide();
                this._icon.hide();
                this._mediaButton.hide();
            },
        });
    }
});

export default class DynamicIslandExtension extends Extension {
    enable() {
        this._island = new DynamicIsland();

        Main.layoutManager.addChrome(this._island, {
            affectsStruts: false,
            trackFullscreen: false,
        });

        this._island.connect('notify::width', () => this._reposition());
        this._reposition();

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._reposition());

        // --- Notifications ---
        this._sourceHandlers = new Map();
        this._sourceAddedId = Main.messageTray.connect(
            'source-added', (tray, source) => this._hookSource(source));
        Main.messageTray.getSources().forEach(source => this._hookSource(source));

        // --- Media (MPRIS: browser tabs, Spotify, etc.) ---
        this._mediaWatcher = new MediaWatcher();
        this._mediaChangedId = this._mediaWatcher.connect('changed', () => {
            const info = this._mediaWatcher.getActivePlayerInfo();
            this._island.setMedia(!!info, info);
        });
    }

    _hookSource(source) {
        if (this._sourceHandlers.has(source))
            return;

        const notifId = source.connect('notification-added', (src, notification) => {
            this._onNotification(src, notification);
        });
        const destroyId = source.connect('destroy', () => {
            this._sourceHandlers.delete(source);
        });

        this._sourceHandlers.set(source, [notifId, destroyId]);
    }

    _onNotification(source, notification) {
        let gicon = null;
        try {
            gicon = notification.gicon || (source.icon ?? null);
        } catch (e) {
            gicon = null;
        }
        this._island.showNotification(gicon, notification.title, notification.body);
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._island)
            return;
        this._island.set_position(
            monitor.x + Math.floor(monitor.width / 2 - this._island.width / 2),
            monitor.y
        );
    }

    disable() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._sourceAddedId) {
            Main.messageTray.disconnect(this._sourceAddedId);
            this._sourceAddedId = null;
        }
        if (this._sourceHandlers) {
            for (const [source, [notifId, destroyId]] of this._sourceHandlers) {
                try {
                    source.disconnect(notifId);
                    source.disconnect(destroyId);
                } catch (e) { /* source may already be gone */ }
            }
            this._sourceHandlers.clear();
            this._sourceHandlers = null;
        }

        if (this._mediaWatcher) {
            if (this._mediaChangedId)
                this._mediaWatcher.disconnect(this._mediaChangedId);
            this._mediaWatcher.destroy();
            this._mediaWatcher = null;
        }

        if (this._island) {
            Main.layoutManager.removeChrome(this._island);
            this._island.destroy();
            this._island = null;
        }
    }
}
