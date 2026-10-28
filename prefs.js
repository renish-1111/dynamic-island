'use strict';

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DynamicIslandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._buildBehaviorPage(settings));
        window.add(this._buildNotificationsPage(settings));
        window.add(this._buildMediaPage(settings));
        window.add(this._buildSystemPage(settings));
    }

    _buildBehaviorPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Behavior',
            icon_name: 'preferences-system-symbolic',
        });

        const group = new Adw.PreferencesGroup({ title: 'Timing & Placement' });
        page.add(group);

        group.add(this._spinRow(settings, 'display-duration-ms',
            'Notification duration', 'How long a notification stays expanded (ms)',
            1000, 10000, 250));

        group.add(this._spinRow(settings, 'animation-duration-ms',
            'Animation speed', 'Duration of expand/collapse animations (ms)',
            100, 500, 10));

        group.add(this._spinRow(settings, 'top-offset',
            'Top offset', 'Gap between the screen edge and the island (px)',
            -20, 40, 1));

        group.add(this._clockFormatRow(settings));

        return page;
    }

    _clockFormatRow(settings) {
        const values = ['system', '24h', '12h'];
        const row = new Adw.ComboRow({
            title: 'Clock format',
            subtitle: 'How the time is displayed on the collapsed pill',
            model: new Gtk.StringList({ strings: ['Match system', '24-hour', '12-hour (AM/PM)'] }),
        });
        row.selected = Math.max(0, values.indexOf(settings.get_string('clock-format')));
        row.connect('notify::selected', () => {
            settings.set_string('clock-format', values[row.selected]);
        });
        return row;
    }

    _buildNotificationsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Notifications',
            icon_name: 'preferences-system-notifications-symbolic',
        });

        const group = new Adw.PreferencesGroup({ title: 'Notification Takeover' });
        page.add(group);

        group.add(this._switchRow(settings, 'notifications-enabled',
            'Enable notification takeover',
            'Show incoming notifications as an island pill instead of standard banners'));

        group.add(this._switchRow(settings, 'enable-badge',
            'Unread badge',
            'Show a small count next to the clock when notifications are queued'));

        page.add(this._buildMutedGroup(settings));

        return page;
    }

    // Muted apps still land in the queue; they just never pop the pill. The
    // extension matches on the notification source's title, which for
    // desktop apps is the app's display name — hence picking from app names.
    _buildMutedGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Muted Applications',
            description: 'These apps are queued silently, without popping the island',
        });

        const apps = [...new Set(Gio.AppInfo.get_all()
            .filter(a => a.should_show())
            .map(a => a.get_display_name()))]
            .sort((a, b) => a.localeCompare(b));

        const picker = new Adw.ComboRow({
            title: 'Mute an app',
            model: new Gtk.StringList({ strings: apps }),
        });
        const addButton = new Gtk.Button({ label: 'Mute', valign: Gtk.Align.CENTER });
        addButton.connect('clicked', () => {
            const name = apps[picker.selected];
            const muted = settings.get_strv('muted-apps');
            if (name && !muted.includes(name))
                settings.set_strv('muted-apps', [...muted, name]);
        });
        picker.add_suffix(addButton);
        group.add(picker);

        let rows = [];
        const rebuild = () => {
            rows.forEach(r => group.remove(r));
            rows = settings.get_strv('muted-apps').map(name => {
                const row = new Adw.ActionRow({ title: GLib.markup_escape_text(name, -1) });
                const unmute = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    tooltip_text: 'Unmute',
                });
                unmute.connect('clicked', () => settings.set_strv('muted-apps',
                    settings.get_strv('muted-apps').filter(n => n !== name)));
                row.add_suffix(unmute);
                group.add(row);
                return row;
            });
        };
        const changedId = settings.connect('changed::muted-apps', rebuild);
        group.connect('destroy', () => settings.disconnect(changedId));
        rebuild();

        return group;
    }

    _buildMediaPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Media',
            icon_name: 'audio-x-generic-symbolic',
        });

        const group = new Adw.PreferencesGroup({ title: 'Playback' });
        page.add(group);

        group.add(this._switchRow(settings, 'media-enabled',
            'Enable media integration',
            'Show a persistent pill with playback controls while media is playing (MPRIS)'));

        group.add(this._switchRow(settings, 'show-seek-bar',
            'Show seek bar',
            'Show a clickable progress bar under media info when expanded'));

        group.add(this._switchRow(settings, 'enable-pulse',
            'Playing pulse',
            'Subtly pulse the album art while media is playing'));

        const appearanceGroup = new Adw.PreferencesGroup({ title: 'Appearance' });
        page.add(appearanceGroup);
        appearanceGroup.add(this._switchRow(settings, 'color-tint-enabled',
            'Album-art color tint',
            'Tint the seek bar and pulse with a color sampled from the current album art'));
        appearanceGroup.add(this._colorRow(settings));

        return page;
    }

    _buildSystemPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'System',
            icon_name: 'preferences-system-devices-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'System Alerts',
            description: 'Brief pills for system events, separate from app notifications',
        });
        page.add(group);

        group.add(this._switchRow(settings, 'battery-alerts-enabled',
            'Battery alerts',
            'Show a pill when the charger is plugged/unplugged or the battery gets low'));

        group.add(this._switchRow(settings, 'bluetooth-alerts-enabled',
            'Bluetooth alerts',
            'Show a pill when a Bluetooth device connects or disconnects'));

        group.add(this._switchRow(settings, 'osd-pill-enabled',
            'Volume & brightness pill',
            'Show volume/brightness changes as an island pill with a level bar instead of the Shell OSD'));

        return page;
    }

    _spinRow(settings, key, title, subtitle, lower, upper, step) {
        const row = new Adw.ActionRow({ title, subtitle });
        const spin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({ lower, upper, step_increment: step, page_increment: step * 4 }),
            valign: Gtk.Align.CENTER,
            numeric: true,
        });
        settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(spin);
        row.activatable_widget = spin;
        return row;
    }

    _switchRow(settings, key, title, subtitle) {
        const row = new Adw.ActionRow({ title, subtitle });
        const toggle = new Gtk.Switch({
            active: settings.get_boolean(key),
            valign: Gtk.Align.CENTER,
        });
        settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(toggle);
        row.activatable_widget = toggle;
        return row;
    }

    _colorRow(settings) {
        const row = new Adw.ActionRow({
            title: 'Accent color',
            subtitle: 'Used for the seek bar fill and highlights',
        });

        const colorButton = new Gtk.ColorButton({ valign: Gtk.Align.CENTER });
        const rgba = new Gdk.RGBA();
        rgba.parse(settings.get_string('accent-color'));
        colorButton.set_rgba(rgba);

        colorButton.connect('color-set', () => {
            const c = colorButton.get_rgba();
            const hex = '#' + [c.red, c.green, c.blue]
                .map(v => Math.round(v * 255).toString(16).padStart(2, '0'))
                .join('');
            settings.set_string('accent-color', hex);
        });

        row.add_suffix(colorButton);
        row.activatable_widget = colorButton;
        return row;
    }
}
