'use strict';

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

const UPOWER_NAME = 'org.freedesktop.UPower';
const DISPLAY_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const LOW_BATTERY_PERCENT = 20;
const LOW_BATTERY_RESET_PERCENT = 25; // hysteresis so a "low" event can't refire on every 0.1% tick

// UPower.Device State enum (org.freedesktop.UPower.Device)
const State = {
    UNKNOWN: 0,
    CHARGING: 1,
    DISCHARGING: 2,
    EMPTY: 3,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
    PENDING_DISCHARGE: 6,
};

const DeviceIface = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
  </interface>
</node>`;

const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(DeviceIface);

// Watches the system's aggregate battery (UPower's DisplayDevice) and emits
// 'changed' whenever there's a fresh event worth surfacing as a pill: plugged
// in, unplugged, or crossed the low-battery threshold while discharging.
// Desktops with no battery (IsPresent false) just never emit anything.
export const BatteryWatcher = GObject.registerClass({
    Signals: { 'changed': {} },
}, class BatteryWatcher extends GObject.Object {
    _init() {
        super._init();
        this._proxy = null;
        this._propsId = null;
        this._lastState = null;
        this._lowFired = false;
        this._pendingEvent = null;

        try {
            this._proxy = new DeviceProxy(Gio.DBus.system, UPOWER_NAME, DISPLAY_DEVICE_PATH);
            this._propsId = this._proxy.connect('g-properties-changed', () => this._onChanged(false));
            this._onChanged(true);
        } catch (e) {
            // UPower not available (e.g. no power daemon) — stay silent forever.
            this._proxy = null;
        }
    }

    _onChanged(isInitial) {
        const proxy = this._proxy;
        if (!proxy || !proxy.IsPresent) {
            this._lastState = null;
            return;
        }

        const state = proxy.State;
        const percentage = proxy.Percentage;

        if (!isInitial && this._lastState !== null && state !== this._lastState) {
            if (state === State.CHARGING && this._lastState !== State.CHARGING) {
                this._pendingEvent = { type: 'plugged', percentage };
                this.emit('changed');
            } else if (state === State.DISCHARGING &&
                       (this._lastState === State.CHARGING || this._lastState === State.FULLY_CHARGED)) {
                this._pendingEvent = { type: 'unplugged', percentage };
                this.emit('changed');
            }
        }

        if (state === State.DISCHARGING) {
            if (percentage <= LOW_BATTERY_PERCENT && !this._lowFired) {
                this._lowFired = true;
                this._pendingEvent = { type: 'low', percentage };
                this.emit('changed');
            } else if (percentage > LOW_BATTERY_RESET_PERCENT) {
                this._lowFired = false;
            }
        } else {
            this._lowFired = false;
        }

        this._lastState = state;
    }

    // One-shot: consumes and clears whatever event triggered the last
    // 'changed' emission. Returns null if there's nothing pending (e.g. a
    // 'changed' the caller already handled, or emitted with no real event).
    takePendingEvent() {
        const event = this._pendingEvent;
        this._pendingEvent = null;
        return event;
    }

    destroy() {
        if (this._proxy && this._propsId) {
            try {
                this._proxy.disconnect(this._propsId);
            } catch (e) { /* proxy already gone */ }
        }
        this._proxy = null;
    }
});
