'use strict';

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { MediaWatcher } from './mediaWatcher.js';

const COLLAPSED_WIDTH = 220;
const COLLAPSED_HEIGHT = 40;
const EXPANDED_WIDTH = 420;
const EXPANDED_HEIGHT = 84;
const ANIM_MS = 220;
const DISPLAY_MS = 4000;
const MAX_BODY_CHARS = 80;
const MAX_QUEUE_HEIGHT = 450;
const MEDIA_ICON_COLLAPSED_SIZE = 28;
const MEDIA_ICON_EXPANDED_SIZE = 48;
const MEDIA_CONTROL_ICON_SIZE = 16;

const DynamicIsland = GObject.registerClass(
class DynamicIsland extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'dynamic-island',
            vertical: true,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });

        this._topBox = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });

        this._clockLabel = new St.Label({
            style_class: 'dynamic-island-clock',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._updateClock();
        this._clockTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });

        this._icon = new St.Icon({
            style_class: 'dynamic-island-icon',
            icon_size: MEDIA_ICON_COLLAPSED_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
            visible: false,
        });

        this._textBox = new St.BoxLayout({
            style_class: 'dynamic-island-text-box',
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        });

        this._titleLabel = new St.Label({ style_class: 'dynamic-island-title', x_align: Clutter.ActorAlign.START });
        this._bodyLabel = new St.Label({ style_class: 'dynamic-island-body', x_align: Clutter.ActorAlign.START });
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
            icon_size: MEDIA_CONTROL_ICON_SIZE,
        });
        this._mediaButton.set_child(this._mediaButtonIcon);
        this._mediaButton.connect('clicked', () => {
            if (this._onMediaToggle)
                this._onMediaToggle();
        });

        this._prevButton = new St.Button({
            style_class: 'dynamic-island-media-button',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._prevButtonIcon = new St.Icon({
            icon_name: 'media-skip-backward-symbolic',
            icon_size: MEDIA_CONTROL_ICON_SIZE,
        });
        this._prevButton.set_child(this._prevButtonIcon);
        this._prevButton.connect('clicked', () => {
            if (this._onMediaPrev)
                this._onMediaPrev();
        });

        this._nextButton = new St.Button({
            style_class: 'dynamic-island-media-button',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._nextButtonIcon = new St.Icon({
            icon_name: 'media-skip-forward-symbolic',
            icon_size: MEDIA_CONTROL_ICON_SIZE,
        });
        this._nextButton.set_child(this._nextButtonIcon);
        this._nextButton.connect('clicked', () => {
            if (this._onMediaNext)
                this._onMediaNext();
        });

        this._topBox.add_child(this._clockLabel);
        this._topBox.add_child(this._icon);
        this._topBox.add_child(this._textBox);
        this._topBox.add_child(this._prevButton);
        this._topBox.add_child(this._mediaButton);
        this._topBox.add_child(this._nextButton);

        this.add_child(this._topBox);

        // Queue Container
        this._queueContainer = new St.BoxLayout({
            style_class: 'dynamic-island-queue-container',
            vertical: true,
            visible: false,
            x_expand: true,
            y_expand: true,
        });

        const headerBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
        });
        const headerTitle = new St.Label({
            text: 'Notifications',
            style_class: 'dynamic-island-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._closeAllButton = new St.Button({
            label: 'Clear All',
            style_class: 'dynamic-island-close-all',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._closeAllButton.connect('clicked', () => this._clearAllNotifications());
        headerBox.add_child(headerTitle);
        headerBox.add_child(this._closeAllButton);

        this._queueScroll = new St.ScrollView({
            style_class: 'dynamic-island-queue-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this._queueBox = new St.BoxLayout({
            style_class: 'dynamic-island-queue',
            vertical: true,
            x_expand: true,
        });
        this._queueScroll.add_child(this._queueBox);

        this._queueContainer.add_child(headerBox);
        this._queueContainer.add_child(this._queueScroll);

        this.add_child(this._queueContainer);

        this._textBox.hide();
        this.set_size(COLLAPSED_WIDTH, COLLAPSED_HEIGHT);

        this._collapseTimeoutId = null;
        this._notificationShowing = false;
        this._lastNotificationIcon = null;
        this._mediaMode = false;
        this._isPinned = false;
        this._isHovered = false;
        this._queueShowing = false;
        this._lastClickTime = 0;

        this.connect('destroy', () => this._clearTimeouts());
        this.connect('enter-event', () => this._onEnter());
        this.connect('leave-event', () => this._onLeave());
        this.connect('button-release-event', () => this._onClick());
    }

    _easeIsland(params) {
        this.remove_all_transitions();
        this.ease(params);
    }

    _easeIconSize(iconSize) {
        this._icon.remove_all_transitions();
        this._icon.ease({
            icon_size: iconSize,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _setIconArtMode(isArt) {
        if (isArt)
            this._icon.add_style_class_name('dynamic-island-icon-art');
        else
            this._icon.remove_style_class_name('dynamic-island-icon-art');
    }

    _updateClock() {
        const now = GLib.DateTime.new_now_local();
        this._clockLabel.set_text(now.format('%a %b %d  %H:%M'));
    }

    _onEnter() {
        this._isHovered = true;
        if (this._mediaMode && !this._notificationShowing && !this._queueShowing) {
            this._renderMedia();
        }
    }

    _onLeave() {
        this._isHovered = false;
        if (this._mediaMode && !this._notificationShowing && !this._queueShowing) {
            this._renderMedia();
        }
    }

    _onClick() {
        const now = GLib.get_monotonic_time();
        if (now - this._lastClickTime < 300000) { // 300ms double click
            this._onDoubleClick();
            this._lastClickTime = 0;
            return Clutter.EVENT_PROPAGATE;
        }
        this._lastClickTime = now;

        if (this._mediaMode && !this._notificationShowing && !this._queueShowing) {
            this._isPinned = !this._isPinned;
            this._renderMedia();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onDoubleClick() {
        if (this._queueShowing) {
            this._hideQueue();
        } else {
            this._showQueue();
        }
    }

    _clearTimeouts() {
        if (this._collapseTimeoutId) {
            GLib.source_remove(this._collapseTimeoutId);
            this._collapseTimeoutId = null;
        }
        if (this._clockTimeoutId) {
            GLib.source_remove(this._clockTimeoutId);
            this._clockTimeoutId = null;
        }
    }

    _showQueue() {
        this._clearTimeouts();
        this._queueBox.destroy_all_children();
        let hasNotifs = false;

        const sources = Main.messageTray.getSources();
        sources.forEach(source => {
            source.notifications.forEach(notif => {
                hasNotifs = true;
                this._addNotificationToQueue(source, notif);
            });
        });

        if (!hasNotifs) {
            let emptyLabel = new St.Label({ text: 'No new notifications', style_class: 'dynamic-island-body', x_align: Clutter.ActorAlign.CENTER });
            this._queueBox.add_child(emptyLabel);
        }

        this._queueShowing = true;
        this._clockLabel.hide();
        this._textBox.hide();
        this._icon.hide();
        this._mediaButton.hide();
        this._prevButton.hide();
        this._nextButton.hide();
        
        this._queueContainer.show();
        
        // Let it layout first to get preferred height
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            let [, targetHeight] = this._queueContainer.get_preferred_height(-1);
            targetHeight += COLLAPSED_HEIGHT;
            targetHeight = Math.min(targetHeight, MAX_QUEUE_HEIGHT);

            const monitor = Main.layoutManager.primaryMonitor;
            const targetX = monitor ? monitor.x + monitor.width / 2 - 400 / 2 : this.x;

            this._easeIsland({
                width: 400,
                height: targetHeight,
                x: targetX,
                duration: ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideQueue() {
        this._queueShowing = false;
        this._queueContainer.hide();
        
        if (this._mediaMode) {
            this._renderMedia();
        } else {
            this._collapse();
        }
    }

    _addNotificationToQueue(source, notif) {
        let itemBox = new St.BoxLayout({
            style_class: 'dynamic-island-queue-item',
            vertical: false,
            x_expand: true,
        });

        let gicon = null;
        try { gicon = notif.gicon || (source.icon ?? null); } catch (e) {}

        let icon = new St.Icon({
            gicon: gicon,
            icon_name: 'dialog-information-symbolic',
            style_class: 'dynamic-island-queue-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });

        let textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
        });
        
        let titleText = notif.title || '';
        let bodyText = (notif.body || '').replace(/\n/g, ' ');
        if (bodyText.length > MAX_BODY_CHARS) bodyText = bodyText.substring(0, MAX_BODY_CHARS - 1) + '…';

        let titleLabel = new St.Label({ text: titleText, style_class: 'dynamic-island-queue-title' });
        let bodyLabel = new St.Label({ text: bodyText, style_class: 'dynamic-island-queue-body' });
        
        textBox.add_child(titleLabel);
        if (bodyText.length > 0) textBox.add_child(bodyLabel);

        let closeBtn = new St.Button({
            style_class: 'dynamic-island-queue-close',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 16 })
        });
        closeBtn.connect('clicked', () => {
            notif.destroy();
            itemBox.destroy();
        });

        itemBox.add_child(icon);
        itemBox.add_child(textBox);
        itemBox.add_child(closeBtn);

        this._queueBox.add_child(itemBox);
    }

    _clearAllNotifications() {
        const sources = Main.messageTray.getSources();
        sources.forEach(source => {
            source.notifications.forEach(notif => notif.destroy());
        });
        this._hideQueue();
    }

    _expand() {
        if (this._queueShowing) return;

        this._clockLabel.hide();
        
        let useLargeIcon = false;
        if (this._notificationShowing && this._lastNotificationIcon) {
            useLargeIcon = true;
        } else if (this._mediaMode && this._lastMediaInfo && this._lastMediaInfo.artUrl) {
            useLargeIcon = true;
        }

        if (useLargeIcon) {
            this._easeIconSize(MEDIA_ICON_EXPANDED_SIZE);
        } else {
            this._easeIconSize(MEDIA_ICON_COLLAPSED_SIZE);
        }

        const monitor = Main.layoutManager.primaryMonitor;
        const targetX = monitor ? monitor.x + monitor.width / 2 - EXPANDED_WIDTH / 2 : this.x;

        this._easeIsland({
            width: EXPANDED_WIDTH,
            height: EXPANDED_HEIGHT,
            x: targetX,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    // --- Notifications (temporary) ---------------------------------

    showNotification(gicon, title, body) {
        if (this._queueShowing) return;

        if (this._collapseTimeoutId) {
            GLib.source_remove(this._collapseTimeoutId);
        }
        
        this._notificationShowing = true;
        this._lastNotificationIcon = gicon;
        this._clockLabel.hide();

        if (gicon) {
            this._setIconArtMode(true);
            this._icon.set_gicon(gicon);
            this._icon.show();
        } else {
            this._setIconArtMode(false);
            this._icon.hide();
        }

        this._mediaButton.hide();
        this._prevButton.hide();
        this._nextButton.hide();
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
            this._prevButton.hide();
            this._nextButton.hide();
            if (!this._notificationShowing && !this._queueShowing)
                this._collapse();
            return;
        }

        this._mediaMode = true;
        this._lastMediaInfo = info;
        this._onMediaToggle = info.playPause;
        this._onMediaNext = info.next;
        this._onMediaPrev = info.previous;

        if (!this._notificationShowing && !this._queueShowing)
            this._renderMedia();
    }

    _renderMedia() {
        if (this._queueShowing) return;

        const info = this._lastMediaInfo;
        if (!info)
            return;

        this._clockLabel.hide();

        if (info.artUrl) {
            try {
                const file = Gio.File.new_for_uri(info.artUrl);
                this._setIconArtMode(true);
                this._icon.set_gicon(new Gio.FileIcon({ file }));
            } catch (e) {
                this._setIconArtMode(false);
                this._icon.set_icon_name('audio-x-generic-symbolic');
            }
        } else {
            this._setIconArtMode(false);
            this._icon.set_icon_name('audio-x-generic-symbolic');
        }
        this._icon.show();
        if (info.artUrl) {
            this._easeIconSize(MEDIA_ICON_EXPANDED_SIZE);
        } else {
            this._easeIconSize(MEDIA_ICON_COLLAPSED_SIZE);
        }

        this._titleLabel.set_text(info.title || 'Playing');
        this._bodyLabel.set_text(info.artist || '');
        this._textBox.show();

        this._mediaButtonIcon.set_icon_name(
            info.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic');

        if (this._isPinned || this._isHovered) {
            this._bodyLabel.visible = !!info.artist;
            this._prevButton.show();
            this._mediaButton.show();
            this._nextButton.show();
            this._expand();
        } else {
            this._bodyLabel.hide();
            this._collapse();
        }
    }

    _collapse() {
        if (this._queueShowing) return;

        this._easeIconSize(MEDIA_ICON_COLLAPSED_SIZE);

        const monitor = Main.layoutManager.primaryMonitor;
        const targetX = monitor ? monitor.x + monitor.width / 2 - COLLAPSED_WIDTH / 2 : this.x;

        this._easeIsland({
            width: COLLAPSED_WIDTH,
            height: COLLAPSED_HEIGHT,
            x: targetX,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (!this._notificationShowing && !this._mediaMode && !this._queueShowing) {
                    this._textBox.hide();
                    this._icon.hide();
                    this._mediaButton.hide();
                    this._prevButton.hide();
                    this._nextButton.hide();
                    this._clockLabel.show();
                } else if (this._mediaMode && !this._isHovered && !this._isPinned && !this._notificationShowing) {
                    this._mediaButton.hide();
                    this._prevButton.hide();
                    this._nextButton.hide();
                    this._clockLabel.hide();
                }
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

        this._reposition();

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._reposition());

        // --- Notifications ---
        this._settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        this._origShowBanners = this._settings.get_boolean('show-banners');
        this._settings.set_boolean('show-banners', false);

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
            monitor.x + monitor.width / 2 - this._island.width / 2,
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

        if (this._settings) {
            this._settings.set_boolean('show-banners', this._origShowBanners);
            this._settings = null;
        }
    }
}
