'use strict';

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { MediaWatcher } from './mediaWatcher.js';

const COLLAPSED_HEIGHT = 34;
const MIN_COLLAPSED_WIDTH = 140;
const MAX_COLLAPSED_WIDTH = 200;
const MIN_COLLAPSED_MEDIA_WIDTH = 180;
const MAX_COLLAPSED_MEDIA_WIDTH = 300;
const MIN_EXPANDED_WIDTH = 300;
const MAX_EXPANDED_WIDTH = 420;
const MIN_EXPANDED_WIDTH_MEDIA = 280;
const MAX_EXPANDED_WIDTH_MEDIA = 340;
const MIN_EXPANDED_WIDTH_WITH_SEEK = 340;
const MAX_EXPANDED_WIDTH_WITH_SEEK = 420;
const EXPANDED_HEIGHT = 68;
const EXPANDED_HEIGHT_WITH_SEEK = 100;
const CONTENT_WIDTH_PADDING = 40;
const MAX_BODY_CHARS = 80;
const MAX_QUEUE_HEIGHT = 400;
const MIN_QUEUE_WIDTH = 300;
const MAX_QUEUE_WIDTH = 420;
const MEDIA_ICON_COLLAPSED_SIZE = 24;
const MEDIA_ICON_EXPANDED_SIZE = 40;
const MEDIA_CONTROL_ICON_SIZE = 14;
const POSITION_POLL_MS = 1000;
const PULSE_MS = 1400;
const MULTI_CLICK_MS = 300;
const LONG_PRESS_MS = 500;

function formatTime(micros) {
    const totalSeconds = Math.max(0, Math.floor(micros / 1000000));
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatRelativeTime(dateTime) {
    if (!dateTime)
        return '';
    const diffSeconds = Math.max(0, GLib.DateTime.new_now_local().difference(dateTime) / 1000000);
    if (diffSeconds < 60)
        return 'now';
    if (diffSeconds < 3600)
        return `${Math.floor(diffSeconds / 60)}m ago`;
    if (diffSeconds < 86400)
        return `${Math.floor(diffSeconds / 3600)}h ago`;
    return `${Math.floor(diffSeconds / 86400)}d ago`;
}

// Best-effort resolution of a "real" app icon for a notification, since the
// notification daemon doesn't always attach a usable gicon. Tries the most
// specific/authoritative source first and falls back to a themed icon.
function resolveNotificationIcon(source, notification) {
    try {
        if (notification && notification.gicon)
            return notification.gicon;
    } catch (e) { /* older API */ }

    try {
        if (source && source.app && source.app.get_icon)
            return source.app.get_icon();
    } catch (e) { /* not an app-backed source */ }

    try {
        if (source && source.icon)
            return source.icon;
    } catch (e) { /* ignore */ }

    try {
        if (source && source.iconName)
            return new Gio.ThemedIcon({ name: source.iconName });
    } catch (e) { /* ignore */ }

    try {
        const title = source && source.title;
        if (title) {
            const match = Shell.AppSystem.get_default().get_running()
                .find(app => app.get_name().toLowerCase() === title.toLowerCase());
            if (match)
                return match.get_icon();
        }
    } catch (e) { /* ignore */ }

    return new Gio.ThemedIcon({ name: 'preferences-system-notifications-symbolic' });
}

const DynamicIsland = GObject.registerClass(
class DynamicIsland extends St.BoxLayout {
    _init(settings) {
        super._init({
            style_class: 'dynamic-island dynamic-island-compact',
            vertical: true,
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });

        this._settings = settings;

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

        this._badgeLabel = new St.Label({
            style_class: 'dynamic-island-badge',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        this._icon = new St.Icon({
            style_class: 'dynamic-island-icon',
            icon_size: MEDIA_ICON_COLLAPSED_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
            visible: false,
            reactive: true,
        });
        // Tapping the album art jumps straight to the player, like tapping
        // the artwork in iOS's Dynamic Island / Control Center does.
        this._icon.connect('button-press-event', () => {
            if (this._mediaMode && !this._notificationShowing && this._onMediaRaise) {
                this._onMediaRaise();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
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

        // Seek/progress bar (media only)
        this._progressRow = new St.BoxLayout({
            style_class: 'dynamic-island-progress-row',
            vertical: false,
            visible: false,
            x_expand: true,
        });
        this._elapsedLabel = new St.Label({ style_class: 'dynamic-island-time', text: '0:00' });
        this._progressBg = new St.Widget({
            style_class: 'dynamic-island-progress-bg',
            reactive: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._progressFill = new St.Widget({ style_class: 'dynamic-island-progress-fill' });
        this._progressBg.add_child(this._progressFill);
        this._seeking = false;
        this._seekMotionId = null;
        this._seekReleaseId = null;
        this._pendingSeekFraction = null;
        this._progressBg.connect('button-press-event', (actor, event) => this._onSeekStart(actor, event));
        // The bg only gets a real width once it's actually allocated by the layout
        // (e.g. right after it goes from hidden to visible, or mid resize-animation).
        // Re-render the fill whenever that allocation lands instead of waiting for
        // the next 1s poll tick, so the bar never flashes empty/invisible.
        this._lastPositionMicros = 0;
        this._progressBg.connect('notify::allocation', () => {
            if (this._progressRow.visible)
                this._updateProgressUI(this._lastPositionMicros);
        });
        this._totalLabel = new St.Label({ style_class: 'dynamic-island-time', text: '0:00' });
        this._progressRow.add_child(this._elapsedLabel);
        this._progressRow.add_child(this._progressBg);
        this._progressRow.add_child(this._totalLabel);
        // Lives directly on the island (not inside textBox) so it spans the
        // full pill width — edge to edge under the art/title/buttons row —
        // instead of stopping wherever the text column happens to end.

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
        this._addPressFeedback(this._mediaButton);

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
        this._addPressFeedback(this._prevButton);

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
        this._addPressFeedback(this._nextButton);

        this._notifCloseButton = new St.Button({
            style_class: 'dynamic-island-media-button dynamic-island-notif-close',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._notifCloseButton.set_child(new St.Icon({
            icon_name: 'window-close-symbolic',
            icon_size: MEDIA_CONTROL_ICON_SIZE,
        }));
        this._notifCloseButton.connect('clicked', () => this._dismissNotification());
        this._addPressFeedback(this._notifCloseButton);

        this._topBox.add_child(this._clockLabel);
        this._topBox.add_child(this._badgeLabel);
        this._topBox.add_child(this._icon);
        this._topBox.add_child(this._textBox);
        this._topBox.add_child(this._prevButton);
        this._topBox.add_child(this._mediaButton);
        this._topBox.add_child(this._nextButton);
        this._topBox.add_child(this._notifCloseButton);

        this.add_child(this._topBox);
        this.add_child(this._progressRow);

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
        this._addPressFeedback(this._closeAllButton);
        headerBox.add_child(headerTitle);
        headerBox.add_child(this._closeAllButton);

        // Overlaid above the scroll view; shown only once the real header for
        // the currently-visible group has scrolled out of view, so long queues
        // read like sectioned lists instead of losing track of whose group
        // you're looking at.
        this._queueStickyHeader = new St.BoxLayout({
            style_class: 'dynamic-island-queue-group-header dynamic-island-queue-sticky-header',
            vertical: false,
            visible: false,
            x_expand: true,
        });
        this._queueStickyIcon = new St.Icon({
            style_class: 'dynamic-island-queue-group-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._queueStickyTitle = new St.Label({
            style_class: 'dynamic-island-queue-group-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._queueStickyHeader.add_child(this._queueStickyIcon);
        this._queueStickyHeader.add_child(this._queueStickyTitle);

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
        this._queueScroll.vadjustment.connect('notify::value', () => this._updateStickyHeader());

        this._queueGroups = [];

        this._queueContainer.add_child(headerBox);
        this._queueContainer.add_child(this._queueStickyHeader);
        this._queueContainer.add_child(this._queueScroll);

        this.add_child(this._queueContainer);

        this._textBox.hide();
        this.set_size(
            this._computeContentWidth(MIN_COLLAPSED_WIDTH, MAX_COLLAPSED_WIDTH),
            COLLAPSED_HEIGHT);

        this._collapseTimeoutId = null;
        this._positionPollId = null;
        this._pulseTimeoutId = null;
        this._notificationShowing = false;
        this._lastNotificationIcon = null;
        this._mediaMode = false;
        this._isPinned = false;
        this._isHovered = false;
        this._queueShowing = false;
        this._clickTimeoutId = null;
        this._clickCount = 0;
        this._pressTimeoutId = null;
        this._longPressFired = false;
        this._stageClickId = null;
        this._muteHandlers = null;
        this._queueTimeEntries = [];
        this._queueTimeRefreshId = null;

        this.connect('destroy', () => this._clearTimeouts());
        // Using notify::hover (backed by St's track-hover) rather than raw
        // enter-event/leave-event: those fire every time the pointer crosses
        // onto a reactive child (the seek bar, media buttons), which made the
        // pill collapse mid-hover. St's hover tracking checks the crossing
        // event's related actor so it stays "hovered" while inside children.
        this.connect('notify::hover', () => {
            if (this.hover)
                this._onEnter();
            else
                this._onLeave();
        });
        this.connect('button-press-event', () => this._onPress());
        this.connect('button-release-event', () => this._onRelease());

        this._refreshBadge();
    }

    setMuteHandlers(handlers) {
        this._muteHandlers = handlers;
    }

    _animMs() {
        return this._settings.get_int('animation-duration-ms');
    }

    _accentColor() {
        return this._settings.get_string('accent-color') || '#0a84ff';
    }

    _easeIsland(params) {
        this.remove_all_transitions();
        this.ease(params);
    }

    _easeIconSize(iconSize) {
        this._icon.remove_all_transitions();
        this._icon.ease({
            icon_size: iconSize,
            duration: this._animMs(),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    // Small tactile scale-down/pop-back on press, like a real button —
    // makes every control in the island feel responsive instead of static.
    _addPressFeedback(button) {
        button.set_pivot_point(0.5, 0.5);
        const restore = () => {
            button.remove_all_transitions();
            button.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        };
        button.connect('button-press-event', () => {
            button.remove_all_transitions();
            button.ease({
                scale_x: 0.88,
                scale_y: 0.88,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('button-release-event', restore);
        button.connect('leave-event', restore);
    }

    // Natural width of the given actor's current content (defaults to the
    // top row: icon + text + any visible buttons), clamped to a sane range
    // so the pill/queue hugs its content instead of always jumping to a
    // fixed size.
    _computeContentWidth(minWidth, maxWidth, actor = this._topBox) {
        const [, naturalWidth] = actor.get_preferred_width(-1);
        return Math.min(Math.max(naturalWidth + CONTENT_WIDTH_PADDING, minWidth), maxWidth);
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

    _getNotificationCount() {
        try {
            return Main.messageTray.getSources()
                .reduce((n, source) => n + source.notifications.length, 0);
        } catch (e) {
            return 0;
        }
    }

    _refreshBadge() {
        if (!this._settings.get_boolean('enable-badge')) {
            this._badgeLabel.hide();
            return;
        }
        const count = this._getNotificationCount();
        if (count > 0) {
            this._badgeLabel.set_text(count > 9 ? '9+' : String(count));
            this._badgeLabel.show();
        } else {
            this._badgeLabel.hide();
        }
    }

    _isIdle() {
        return !this._mediaMode && !this._notificationShowing && !this._queueShowing;
    }

    _onEnter() {
        this._isHovered = true;
        if (this._mediaMode && !this._notificationShowing && !this._queueShowing) {
            this._renderMedia();
        } else if (this._isIdle()) {
            this.ease({
                scale_x: 1.03,
                scale_y: 1.03,
                duration: this._animMs() / 2,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _onLeave() {
        this._isHovered = false;
        if (this._mediaMode && !this._notificationShowing && !this._queueShowing) {
            this._renderMedia();
        } else if (this._isIdle()) {
            this.ease({
                scale_x: 1,
                scale_y: 1,
                duration: this._animMs() / 2,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    // Press-and-hold is a second, independent way to expand/collapse the
    // pinned music view (alongside triple-click). Started on button-press
    // and cancelled on release; if it fires, the matching button-release
    // must not also be treated as a click.
    _onPress() {
        this._longPressFired = false;
        if (this._pressTimeoutId)
            GLib.source_remove(this._pressTimeoutId);
        this._pressTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
            this._pressTimeoutId = null;
            this._longPressFired = true;
            this._onHold();
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_PROPAGATE;
    }

    _onRelease() {
        if (this._pressTimeoutId) {
            GLib.source_remove(this._pressTimeoutId);
            this._pressTimeoutId = null;
        }
        if (this._longPressFired) {
            this._longPressFired = false;
            return Clutter.EVENT_PROPAGATE;
        }
        return this._onClick();
    }

    _onHold() {
        if (this._notificationShowing) {
            this._activateNotification();
            return;
        }
        if (this._mediaMode && !this._queueShowing) {
            this._isPinned = !this._isPinned;
            this._renderMedia();
        }
    }

    // Clicks are counted over a debounce window so single/double/triple taps
    // on the same spot can be told apart without any of them firing early.
    // While a notification is showing: single click dismisses it, double
    // (or more) opens/activates it. Otherwise: double click opens/closes the
    // notification queue, triple click expands/collapses the pinned music
    // view (single click is intentionally not bound to anything).
    _onClick() {
        this._clickCount = (this._clickCount || 0) + 1;
        if (this._clickTimeoutId)
            return Clutter.EVENT_PROPAGATE;

        this._clickTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MULTI_CLICK_MS, () => {
            this._clickTimeoutId = null;
            const count = this._clickCount;
            this._clickCount = 0;

            if (this._notificationShowing) {
                if (count >= 2) {
                    this._activateNotification();
                }
            } else if (count === 2) {
                this._onDoubleClick();
            } else if (count >= 3) {
                this._onTripleClick();
            }
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_PROPAGATE;
    }

    _onDoubleClick() {
        // While the pinned/held-expanded music view is showing, a plain
        // double click shouldn't also pop the notification queue open underneath it.
        if (this._mediaMode && this._isPinned)
            return;

        if (this._queueShowing)
            this._hideQueue();
        else
            this._showQueue();
    }

    _onTripleClick() {
        if (this._mediaMode && !this._queueShowing) {
            this._isPinned = !this._isPinned;
            this._renderMedia();
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
        if (this._clickTimeoutId) {
            GLib.source_remove(this._clickTimeoutId);
            this._clickTimeoutId = null;
        }
        this._clickCount = 0;
        if (this._pressTimeoutId) {
            GLib.source_remove(this._pressTimeoutId);
            this._pressTimeoutId = null;
        }
        this._stopPositionPolling();
        this._stopPulse();
        this._stopQueueTimeRefresh();
        this._onSeekEnd();
        this._disconnectStageClickOutside();
    }

    // A notification only opens on a double click on the pill itself
    // (_onClick); any other click anywhere on screen dismisses it, same as
    // tapping outside a native banner would. Captured on the stage (rather
    // than the pill) so it fires for clicks landing on windows, the top bar,
    // or anywhere else — not just re-clicks of the island.
    _connectStageClickOutside() {
        if (this._stageClickId)
            return;
        this._stageClickId = global.stage.connect('captured-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_PROPAGATE;
            if (!this._notificationShowing)
                return Clutter.EVENT_PROPAGATE;
            const source = event.get_source();
            if (source && this.contains(source))
                return Clutter.EVENT_PROPAGATE;
            this._clearCollapseTimeout();
            this._dismissNotification();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _disconnectStageClickOutside() {
        if (this._stageClickId) {
            global.stage.disconnect(this._stageClickId);
            this._stageClickId = null;
        }
    }

    _showQueue() {
        this.remove_style_class_name('dynamic-island-compact');
        this.set_scale(1, 1);
        this._stopPositionPolling();
        this._stopPulse();
        if (this._collapseTimeoutId) {
            GLib.source_remove(this._collapseTimeoutId);
            this._collapseTimeoutId = null;
        }
        this._queueBox.destroy_all_children();
        this._queueGroups = [];
        this._queueTimeEntries = [];
        this._queueStickyHeader.hide();

        const sources = Main.messageTray.getSources().filter(s => s.notifications.length > 0);

        if (sources.length === 0) {
            let emptyLabel = new St.Label({ text: 'No new notifications', style_class: 'dynamic-island-body', x_align: Clutter.ActorAlign.CENTER });
            this._queueBox.add_child(emptyLabel);
        } else {
            sources.forEach(source => this._addSourceGroupToQueue(source));
        }

        this._queueShowing = true;
        this._clockLabel.hide();
        this._badgeLabel.hide();
        this._textBox.hide();
        this._icon.hide();
        this._mediaButton.hide();
        this._prevButton.hide();
        this._nextButton.hide();
        this._progressRow.hide();
        this._notifCloseButton.hide();

        this._queueContainer.show();
        this._startQueueTimeRefresh();

        // Let it layout first to get preferred height/width
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            let [, targetHeight] = this._queueContainer.get_preferred_height(-1);
            targetHeight += COLLAPSED_HEIGHT;
            targetHeight = Math.min(targetHeight, MAX_QUEUE_HEIGHT);

            const targetWidth = this._computeContentWidth(
                MIN_QUEUE_WIDTH, MAX_QUEUE_WIDTH, this._queueContainer);

            const monitor = Main.layoutManager.primaryMonitor;
            const targetX = monitor ? monitor.x + monitor.width / 2 - targetWidth / 2 : this.x;

            this._easeIsland({
                width: targetWidth,
                height: targetHeight,
                x: targetX,
                duration: this._animMs(),
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
            this._updateStickyHeader();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Shows the currently-scrolled-past group's header pinned above the
    // scroll view, so a long queue still reads as sectioned by app.
    _updateStickyHeader() {
        if (!this._queueShowing || this._queueGroups.length < 2) {
            this._queueStickyHeader.hide();
            return;
        }

        const offset = this._queueScroll.vadjustment.value;
        let active = null;
        for (const group of this._queueGroups) {
            if (group.headerRow.get_position()[1] <= offset + 1)
                active = group;
            else
                break;
        }

        if (active) {
            this._queueStickyIcon.set_gicon(active.gicon);
            this._queueStickyTitle.set_text(active.title);
            this._queueStickyHeader.show();
        } else {
            this._queueStickyHeader.hide();
        }
    }

    // Relative timestamps ("5m ago") are computed once at build time, so a
    // queue left open for a while would otherwise show a stale age forever.
    _startQueueTimeRefresh() {
        this._stopQueueTimeRefresh();
        this._queueTimeRefreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._queueTimeEntries.forEach(entry => {
                entry.label.set_text(formatRelativeTime(entry.receivedTime));
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopQueueTimeRefresh() {
        if (this._queueTimeRefreshId) {
            GLib.source_remove(this._queueTimeRefreshId);
            this._queueTimeRefreshId = null;
        }
    }

    _hideQueue() {
        this._queueShowing = false;
        this._stopQueueTimeRefresh();
        this._queueContainer.hide();
        this._queueStickyHeader.hide();

        if (this._mediaMode) {
            this._renderMedia();
        } else {
            this._collapse();
        }
    }

    _addSourceGroupToQueue(source) {
        const isMuted = this._muteHandlers ? this._muteHandlers.isMuted(source.title) : false;

        const headerRow = new St.BoxLayout({
            style_class: 'dynamic-island-queue-group-header',
            vertical: false,
            x_expand: true,
        });
        const appIcon = new St.Icon({
            gicon: resolveNotificationIcon(source, null),
            style_class: 'dynamic-island-queue-group-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const appLabel = new St.Label({
            text: `${source.title || 'Notifications'} (${source.notifications.length})`,
            style_class: 'dynamic-island-queue-group-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const muteBtn = new St.Button({
            style_class: isMuted ? 'dynamic-island-mute-btn dynamic-island-mute-btn-active' : 'dynamic-island-mute-btn',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: isMuted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic',
                icon_size: 14,
            }),
        });
        muteBtn.connect('clicked', () => {
            if (!this._muteHandlers)
                return;
            this._muteHandlers.toggleMute(source.title);
            this._showQueue();
        });
        this._addPressFeedback(muteBtn);

        headerRow.add_child(appIcon);
        headerRow.add_child(appLabel);
        headerRow.add_child(muteBtn);
        this._queueBox.add_child(headerRow);

        this._queueGroups.push({
            headerRow,
            gicon: resolveNotificationIcon(source, null),
            title: source.title || 'Notifications',
        });

        source.notifications.forEach(notif => this._addNotificationToQueue(source, notif));
    }

    _addNotificationToQueue(source, notif) {
        let urgent = false;
        try { urgent = notif.urgency >= 2; } catch (e) { /* older API */ }

        let itemBox = new St.BoxLayout({
            style_class: urgent
                ? 'dynamic-island-queue-item dynamic-island-urgent-item'
                : 'dynamic-island-queue-item',
            vertical: false,
            reactive: true,
            x_expand: true,
        });
        let clickCount = 0;
        let clickTimeoutId = null;

        itemBox.connect('button-release-event', () => {
            clickCount++;
            if (clickTimeoutId)
                return Clutter.EVENT_STOP;

            clickTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MULTI_CLICK_MS, () => {
                clickTimeoutId = null;
                if (clickCount >= 2) {
                    try {
                        notif.activate();
                    } catch (e) {
                        logError(e, 'DynamicIsland: notification activate failed');
                    }
                    this._hideQueue();
                }
                clickCount = 0;
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_STOP;
        });

        let icon = new St.Icon({
            gicon: resolveNotificationIcon(source, notif),
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

        let timeLabel = new St.Label({
            text: formatRelativeTime(notif._diReceivedTime),
            style_class: 'dynamic-island-queue-time',
            x_align: Clutter.ActorAlign.START,
        });
        let titleLabel = new St.Label({ text: titleText, style_class: 'dynamic-island-queue-title', x_align: Clutter.ActorAlign.START });
        let bodyLabel = new St.Label({ text: bodyText, style_class: 'dynamic-island-queue-body' });

        textBox.add_child(timeLabel);
        textBox.add_child(titleLabel);
        if (bodyText.length > 0) textBox.add_child(bodyLabel);

        this._queueTimeEntries.push({ label: timeLabel, receivedTime: notif._diReceivedTime });

        let closeBtn = new St.Button({
            style_class: 'dynamic-island-queue-close',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 16 })
        });
        closeBtn.connect('clicked', () => {
            notif.destroy();
            itemBox.destroy();
            this._refreshBadge();
        });
        this._addPressFeedback(closeBtn);

        itemBox.add_child(icon);
        itemBox.add_child(textBox);
        itemBox.add_child(closeBtn);

        this._queueBox.add_child(itemBox);

        // Each card pops in with a slight delay after the previous one, so a
        // queue full of notifications reads as a cascade rather than a dump.
        const itemIndex = this._queueBox.get_n_children() - 1;
        itemBox.set_pivot_point(0.5, 0.5);
        itemBox.set_opacity(0);
        itemBox.set_scale(0.94, 0.94);
        itemBox.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            delay: Math.min(itemIndex * 40, 200),
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _clearAllNotifications() {
        const sources = Main.messageTray.getSources();
        sources.forEach(source => {
            source.notifications.forEach(notif => notif.destroy());
        });
        this._hideQueue();
        this._refreshBadge();
    }

    _expand() {
        if (this._queueShowing) return;

        this.remove_style_class_name('dynamic-island-compact');
        this.remove_style_class_name('dynamic-island-compact-music');
        this.set_scale(1, 1);
        this._clockLabel.hide();
        this._badgeLabel.hide();

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

        const isMedia = this._mediaMode && !this._notificationShowing;
        const showSeek = isMedia &&
            this._settings.get_boolean('show-seek-bar') &&
            this._lastMediaInfo && this._lastMediaInfo.length > 0;
        const targetHeight = showSeek ? EXPANDED_HEIGHT_WITH_SEEK : EXPANDED_HEIGHT;
        let targetWidth;
        if (showSeek)
            targetWidth = this._computeContentWidth(MIN_EXPANDED_WIDTH_WITH_SEEK, MAX_EXPANDED_WIDTH_WITH_SEEK);
        else if (isMedia)
            targetWidth = this._computeContentWidth(MIN_EXPANDED_WIDTH_MEDIA, MAX_EXPANDED_WIDTH_MEDIA);
        else
            targetWidth = this._computeContentWidth(MIN_EXPANDED_WIDTH, MAX_EXPANDED_WIDTH);

        const monitor = Main.layoutManager.primaryMonitor;
        const targetX = monitor ? monitor.x + monitor.width / 2 - targetWidth / 2 : this.x;

        // EASE_OUT_BACK gives it a small springy overshoot on the way out,
        // closer to the real Dynamic Island's pop than a plain ease-out.
        this._easeIsland({
            width: targetWidth,
            height: targetHeight,
            x: targetX,
            duration: this._animMs(),
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    // --- Notifications (temporary) ---------------------------------

    showNotification(gicon, title, body, urgent, notification) {
        if (this._queueShowing) return;

        if (this._collapseTimeoutId) {
            GLib.source_remove(this._collapseTimeoutId);
        }
        this._stopPositionPolling();
        this._progressRow.hide();

        this._notificationShowing = true;
        this._lastNotificationIcon = gicon;
        this._lastNotification = notification || null;
        this._connectStageClickOutside();
        this._clockLabel.hide();
        this._badgeLabel.hide();

        if (urgent)
            this.add_style_class_name('dynamic-island-urgent');
        else
            this.remove_style_class_name('dynamic-island-urgent');

        this._setIconArtMode(true);
        this._icon.set_gicon(gicon);
        this._icon.show();

        this._mediaButton.hide();
        this._prevButton.hide();
        this._nextButton.hide();
        this._notifCloseButton.show();
        this._titleLabel.set_text(title || '');

        let bodyText = (body || '').replace(/\n/g, ' ');
        if (bodyText.length > MAX_BODY_CHARS)
            bodyText = bodyText.substring(0, MAX_BODY_CHARS - 1) + '…';
        this._bodyLabel.set_text(bodyText);
        this._bodyLabel.visible = bodyText.length > 0;

        this._textBox.show();
        this._expand();

        const displayMs = this._settings.get_int('display-duration-ms');
        this._collapseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, displayMs, () => {
            this._collapseTimeoutId = null;
            this._closeNotificationPopup();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Shared teardown for the notification popup — called whether it times
    // out, gets activated, or gets dismissed via the close button.
    _closeNotificationPopup() {
        this._notificationShowing = false;
        this._lastNotification = null;
        this._disconnectStageClickOutside();
        this._notifCloseButton.hide();
        this.remove_style_class_name('dynamic-island-urgent');
        this._refreshBadge();

        if (this._mediaMode)
            this._renderMedia(); // fall back to the persistent media pill
        else
            this._collapse();
    }

    _clearCollapseTimeout() {
        if (this._collapseTimeoutId) {
            GLib.source_remove(this._collapseTimeoutId);
            this._collapseTimeoutId = null;
        }
    }

    // Clicking the pill body while a notification is showing opens/focuses
    // the app that sent it, same as clicking a native GNOME banner would.
    _activateNotification() {
        const notification = this._lastNotification;
        if (!notification)
            return;

        try {
            notification.activate();
        } catch (e) {
            logError(e, 'DynamicIsland: notification activate failed');
        }

        this._clearCollapseTimeout();
        this._closeNotificationPopup();
    }

    // Clicking the X dismisses the notification without opening its app.
    _dismissNotification() {
        const notification = this._lastNotification;
        if (notification) {
            try {
                notification.destroy();
            } catch (e) {
                logError(e, 'DynamicIsland: notification dismiss failed');
            }
        }

        this._clearCollapseTimeout();
        this._closeNotificationPopup();
    }

    // --- Media (persistent while playing) ---------------------------

    setMedia(active, info) {
        if (!active) {
            this._mediaMode = false;
            this._lastMediaInfo = null;
            this._isPinned = false;
            this._mediaButton.hide();
            this._prevButton.hide();
            this._nextButton.hide();
            this._progressRow.hide();
            this._stopPositionPolling();
            this._stopPulse();
            if (!this._notificationShowing && !this._queueShowing)
                this._collapse();
            return;
        }

        this._mediaMode = true;
        this._lastMediaInfo = info;
        this._onMediaToggle = info.playPause;
        this._onMediaNext = info.next;
        this._onMediaPrev = info.previous;
        this._onMediaSeek = info.seekTo;
        this._onMediaRaise = info.raise;
        this._queryPosition = info.queryPosition;

        if (!this._notificationShowing && !this._queueShowing)
            this._renderMedia();
    }

    _renderMedia() {
        if (this._queueShowing) return;

        const info = this._lastMediaInfo;
        if (!info)
            return;

        this._clockLabel.hide();
        this._badgeLabel.hide();

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

        if (info.playing && this._settings.get_boolean('enable-pulse'))
            this._startPulse();
        else
            this._stopPulse();

        if (this._isPinned || this._isHovered) {
            this._bodyLabel.visible = !!info.artist;
            if (info.canGoPrevious)
                this._prevButton.show();
            else
                this._prevButton.hide();
            
            this._mediaButton.show();
            
            if (info.canGoNext)
                this._nextButton.show();
            else
                this._nextButton.hide();

            if (this._settings.get_boolean('show-seek-bar') && info.length > 0) {
                this._progressRow.show();
                this._progressFill.set_style(`background-color: ${this._accentColor()};`);
                this._startPositionPolling();
            } else {
                this._progressRow.hide();
                this._stopPositionPolling();
            }

            this._expand();
        } else {
            this._bodyLabel.hide();
            this._progressRow.hide();
            // Hide controls immediately rather than waiting for the collapse
            // animation to finish — otherwise they stay full-size while the
            // pill is still shrinking underneath them and visibly overlap it.
            this._prevButton.hide();
            this._mediaButton.hide();
            this._nextButton.hide();
            this._stopPositionPolling();
            this._collapse();
        }
    }

    // --- Seek bar -----------------------------------------------------

    _updateProgressUI(positionMicros) {
        const info = this._lastMediaInfo;
        if (!info || !info.length)
            return;

        this._lastPositionMicros = positionMicros;
        this._elapsedLabel.set_text(formatTime(positionMicros));
        this._totalLabel.set_text(formatTime(info.length));

        const trackWidth = this._progressBg.width;
        if (trackWidth <= 0)
            return; // not allocated yet; notify::allocation will redraw once it is

        const fraction = Math.min(Math.max(positionMicros / info.length, 0), 1);
        const trackHeight = this._progressBg.height || 4;
        this._progressFill.set_position(0, 0);
        this._progressFill.set_size(Math.round(trackWidth * fraction), trackHeight);
    }

    _startPositionPolling() {
        if (this._positionPollId)
            return;

        const poll = () => {
            if (!this._queryPosition) {
                this._positionPollId = null;
                return GLib.SOURCE_REMOVE;
            }
            this._queryPosition(pos => {
                if (pos !== null && !this._seeking)
                    this._updateProgressUI(pos);
            });
            return GLib.SOURCE_CONTINUE;
        };
        // Defer the first read one idle cycle so the bar has a real allocation to size against.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            poll();
            return GLib.SOURCE_REMOVE;
        });
        this._positionPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POSITION_POLL_MS, poll);
    }

    _stopPositionPolling() {
        if (this._positionPollId) {
            GLib.source_remove(this._positionPollId);
            this._positionPollId = null;
        }
    }

    // Supports both a plain click-to-seek and press-and-drag scrubbing.
    // Dragging tracks motion on the stage (not just the bar) so the seek
    // doesn't drop out if the pointer strays slightly outside the thin bar.
    _onSeekStart(actor, event) {
        const info = this._lastMediaInfo;
        if (!info || !info.canSeek || !this._onMediaSeek)
            return Clutter.EVENT_PROPAGATE;

        this._seeking = true;
        this._onSeekMove(actor, event);

        this._seekMotionId = global.stage.connect('motion-event', (a, e) => this._onSeekMove(actor, e));
        this._seekReleaseId = global.stage.connect('button-release-event', () => this._onSeekEnd());
        return Clutter.EVENT_STOP;
    }

    _onSeekMove(actor, event) {
        const info = this._lastMediaInfo;
        if (!info || !info.length)
            return;

        const [stageX] = event.get_coords();
        const [actorX] = actor.get_transformed_position();
        const fraction = Math.min(Math.max((stageX - actorX) / actor.width, 0), 1);

        // Optimistically update the UI; the next poll will correct any drift.
        this._pendingSeekFraction = fraction;
        this._updateProgressUI(fraction * info.length);
    }

    _onSeekEnd() {
        if (!this._seeking)
            return;
        this._seeking = false;

        if (this._seekMotionId) {
            global.stage.disconnect(this._seekMotionId);
            this._seekMotionId = null;
        }
        if (this._seekReleaseId) {
            global.stage.disconnect(this._seekReleaseId);
            this._seekReleaseId = null;
        }

        const info = this._lastMediaInfo;
        if (info && this._pendingSeekFraction !== null && this._onMediaSeek)
            this._onMediaSeek(this._pendingSeekFraction);
        this._pendingSeekFraction = null;
    }

    // --- Playing pulse --------------------------------------------------

    _startPulse() {
        if (this._pulseTimeoutId)
            return;
        this._pulseDirection = true;
        const step = () => {
            this._icon.ease({
                opacity: this._pulseDirection ? 165 : 255,
                duration: PULSE_MS,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            });
            this._pulseDirection = !this._pulseDirection;
            return GLib.SOURCE_CONTINUE;
        };
        step();
        this._pulseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PULSE_MS, step);
    }

    _stopPulse() {
        if (this._pulseTimeoutId) {
            GLib.source_remove(this._pulseTimeoutId);
            this._pulseTimeoutId = null;
        }
        this._icon.remove_all_transitions();
        this._icon.opacity = 255;
    }

    _collapse() {
        if (this._queueShowing) return;

        this.add_style_class_name('dynamic-island-compact');
        this._easeIconSize(MEDIA_ICON_COLLAPSED_SIZE);

        // A persistent media pill (icon + title, no controls) hugs its
        // content; the true idle pill (clock only) hugs its own (much
        // narrower) content too, just within a tighter range.
        const isCollapsedMedia = this._mediaMode && !this._notificationShowing;
        
        if (isCollapsedMedia) {
            this.add_style_class_name('dynamic-island-compact-music');
        } else {
            this.remove_style_class_name('dynamic-island-compact-music');
        }
        const targetWidth = isCollapsedMedia
            ? this._computeContentWidth(MIN_COLLAPSED_MEDIA_WIDTH, MAX_COLLAPSED_MEDIA_WIDTH)
            : this._computeContentWidth(MIN_COLLAPSED_WIDTH, MAX_COLLAPSED_WIDTH);

        const monitor = Main.layoutManager.primaryMonitor;
        const targetX = monitor ? monitor.x + monitor.width / 2 - targetWidth / 2 : this.x;

        this._easeIsland({
            width: targetWidth,
            height: COLLAPSED_HEIGHT,
            x: targetX,
            duration: this._animMs(),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (!this._notificationShowing && !this._mediaMode && !this._queueShowing) {
                    this._textBox.hide();
                    this._icon.hide();
                    this._mediaButton.hide();
                    this._prevButton.hide();
                    this._nextButton.hide();
                    this._clockLabel.show();
                    this._refreshBadge();
                } else if (this._mediaMode && !this._isHovered && !this._isPinned && !this._notificationShowing) {
                    this._mediaButton.hide();
                    this._prevButton.hide();
                    this._nextButton.hide();
                    this._clockLabel.hide();
                    this._badgeLabel.hide();
                }
            },
        });
    }
});

export default class DynamicIslandExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._island = new DynamicIsland(this._settings);

        Main.layoutManager.addChrome(this._island, {
            affectsStruts: false,
            trackFullscreen: false,
        });

        this._reposition();

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._reposition());
        this._topOffsetChangedId = this._settings.connect(
            'changed::top-offset', () => this._reposition());

        this._island.setMuteHandlers({
            isMuted: appName => this._settings.get_strv('muted-apps').includes(appName),
            toggleMute: appName => {
                const muted = this._settings.get_strv('muted-apps');
                const idx = muted.indexOf(appName);
                if (idx >= 0)
                    muted.splice(idx, 1);
                else
                    muted.push(appName);
                this._settings.set_strv('muted-apps', muted);
            },
        });

        // --- Notifications ---
        this._notifSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        this._origShowBanners = this._notifSettings.get_boolean('show-banners');
        this._updateShowBanners();
        this._notificationsEnabledChangedId = this._settings.connect(
            'changed::notifications-enabled', () => this._updateShowBanners());

        this._sourceHandlers = new Map();
        this._sourceAddedId = Main.messageTray.connect(
            'source-added', (tray, source) => this._hookSource(source));
        Main.messageTray.getSources().forEach(source => this._hookSource(source));

        // --- Media (MPRIS: browser tabs, Spotify, etc.) ---
        this._mediaWatcher = new MediaWatcher();
        this._mediaChangedId = this._mediaWatcher.connect('changed', () => {
            if (!this._settings.get_boolean('media-enabled')) {
                this._island.setMedia(false, null);
                return;
            }
            const info = this._mediaWatcher.getActivePlayerInfo();
            if (info)
                info.queryPosition = cb => this._mediaWatcher.queryPosition(cb);
            this._island.setMedia(!!info, info);
        });
    }

    _updateShowBanners() {
        // While the extension shows its own popups, suppress GNOME's native
        // notification banners so a notification doesn't appear twice.
        this._notifSettings.set_boolean('show-banners',
            this._settings.get_boolean('notifications-enabled') ? false : this._origShowBanners);
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
        notification._diReceivedTime = GLib.DateTime.new_now_local();
        this._island._refreshBadge();

        if (!this._settings.get_boolean('notifications-enabled'))
            return;

        const muted = this._settings.get_strv('muted-apps').includes(source.title);
        if (muted)
            return;

        const gicon = resolveNotificationIcon(source, notification);

        let urgent = false;
        try { urgent = notification.urgency >= 2; } catch (e) { /* older API */ }

        this._island.showNotification(gicon, notification.title, notification.body, urgent, notification);
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._island)
            return;
        const topOffset = this._settings ? this._settings.get_int('top-offset') : 0;
        this._island.set_position(
            monitor.x + monitor.width / 2 - this._island.width / 2,
            monitor.y + topOffset
        );
    }

    disable() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._topOffsetChangedId) {
            this._settings.disconnect(this._topOffsetChangedId);
            this._topOffsetChangedId = null;
        }
        if (this._notificationsEnabledChangedId) {
            this._settings.disconnect(this._notificationsEnabledChangedId);
            this._notificationsEnabledChangedId = null;
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

        if (this._notifSettings) {
            this._notifSettings.set_boolean('show-banners', this._origShowBanners);
            this._notifSettings = null;
        }

        this._settings = null;
    }
}
