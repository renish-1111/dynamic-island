'use strict';

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DynamicIslandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._buildBehaviorPage(settings));
        window.add(this._buildNotificationsPage(settings));
        window.add(this._buildMediaPage(settings));
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
            0, 40, 1));

        return page;
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

        const mutedGroup = new Adw.PreferencesGroup({
            title: 'Muted Applications',
            description: 'Apps muted from the island (toggle per app in the notification queue)',
        });
        page.add(mutedGroup);

        const mutedRow = new Adw.ActionRow({ title: 'Clear all muted apps' });
        const clearButton = new Gtk.Button({
            label: 'Clear',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        clearButton.connect('clicked', () => settings.set_strv('muted-apps', []));
        mutedRow.add_suffix(clearButton);
        mutedGroup.add(mutedRow);

        return page;
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
        appearanceGroup.add(this._colorRow(settings));

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
