'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const BLUEZ_NAME = 'org.bluez';
const DEVICE_IFACE = 'org.bluez.Device1';

// Watches BlueZ for device connect/disconnect transitions (e.g. headphones
// pairing) and emits 'changed' with a one-shot pending event, mirroring
// batteryWatcher.js's takePendingEvent() convention.
//
// Entirely passive: subscribing to a signal never auto-starts bluetoothd, so
// this stays silent forever if Bluetooth is off/uninstalled, and picks up
// automatically whenever the service does appear (GDBusConnection resolves
// the well-known sender name to its current owner on every signal).
export const BluetoothWatcher = GObject.registerClass({
    Signals: { 'changed': {} },
}, class BluetoothWatcher extends GObject.Object {
    _init() {
        super._init();
        this._pendingEvent = null;
        // arg0 = DEVICE_IFACE filters at the bus/match-rule level (PropertiesChanged's
        // first argument is the interface name being described) so Adapter1/
        // MediaTransport1/Battery1/etc. property spam — especially RSSI updates
        // while a scan is running — never gets delivered to this process at all,
        // instead of arriving here just to be thrown away in JS.
        this._propsChangedId = Gio.DBus.system.signal_subscribe(
            BLUEZ_NAME, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
            null, DEVICE_IFACE, Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => this._onPropertiesChanged(path, params));
    }

    _onPropertiesChanged(path, params) {
        const [, changed] = params.deep_unpack();
        if (!('Connected' in changed))
            return;

        const connected = changed['Connected'].deep_unpack();
        this._fetchDeviceInfo(path, info => {
            this._pendingEvent = {
                type: connected ? 'connected' : 'disconnected',
                name: info.name,
                icon: info.icon,
            };
            this.emit('changed');
        });
    }

    _fetchDeviceInfo(path, callback) {
        Gio.DBus.system.call(
            BLUEZ_NAME, path, 'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', [DEVICE_IFACE]), new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                let name = 'Device';
                let icon = 'bluetooth-active-symbolic';
                try {
                    const [props] = conn.call_finish(res).deep_unpack();
                    if (props['Alias'])
                        name = props['Alias'].deep_unpack();
                    else if (props['Name'])
                        name = props['Name'].deep_unpack();
                    if (props['Icon'])
                        icon = `${props['Icon'].deep_unpack()}-symbolic`;
                } catch (e) {
                    // Device vanished mid-flight (e.g. unpaired right as it
                    // disconnected) — fall back to the generic name/icon above.
                }
                callback({ name, icon });
            });
    }

    // One-shot: consumes and clears whatever event triggered the last
    // 'changed' emission.
    takePendingEvent() {
        const event = this._pendingEvent;
        this._pendingEvent = null;
        return event;
    }

    destroy() {
        if (this._propsChangedId) {
            Gio.DBus.system.signal_unsubscribe(this._propsChangedId);
            this._propsChangedId = null;
        }
    }
});
