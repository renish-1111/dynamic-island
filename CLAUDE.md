# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GNOME Shell extension (`dynamic-island@claude.local`) that replaces standard notification banners with an iPhone-style "Dynamic Island" pill, plus an MPRIS media-control pill and a GTK4/Adwaita preferences window. Pure GJS (GNOME JavaScript) — no Node tooling, no package manager, no test framework.

Supported GNOME Shell versions: 45–50 (see `metadata.json`).

## Commands

There is no build system. The only useful checks are:

```bash
# Syntax-check a file (GJS is ESM but there's no bundler/transpiler)
node --check extension.js
node --check mediaWatcher.js
node --check prefs.js

# Recompile the GSettings schema after editing the .xml
glib-compile-schemas schemas/

# Install into the local extensions dir for manual testing
cp extension.js prefs.js metadata.json stylesheet.css mediaWatcher.js \
  ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/
cp schemas/org.gnome.shell.extensions.dynamic-island.gschema.xml \
  ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/schemas/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/schemas/

# Reload the extension: X11 can Alt+F2, r, Enter; Wayland requires logout/login
gnome-extensions enable dynamic-island@claude.local
gnome-extensions prefs dynamic-island@claude.local   # open the prefs window

# Repackage the distributable zip
gnome-extensions pack --force --extra-source=mediaWatcher.js
```

There is no automated way to exercise Shell UI code — verifying changes means installing the extension and reloading GNOME Shell (Wayland requires a full logout/login since the Shell process can't be restarted in place). `journalctl -f -o cat /usr/bin/gnome-shell` (or `/usr/bin/gnome-shell-wayland`) is the way to see `logError`/exceptions at runtime.

## Architecture

Three runtime files, loaded by GNOME Shell's extension system:

- **`extension.js`** — the entire UI. `export default class DynamicIslandExtension extends Extension` is the entry point (`enable()`/`disable()`), which owns exactly one `DynamicIsland` actor (a `St.BoxLayout` subclass) added to `Main.layoutManager` as chrome. All notification/media/queue/animation logic lives as methods on this one class in `extension.js`.
- **`mediaWatcher.js`** — a standalone `GObject.Object` (`MediaWatcher`) that owns all MPRIS D-Bus plumbing: discovers `org.mpris.MediaPlayer2.*` names, tracks per-player proxies, picks the "active" player (playing, else most-recently-paused), and emits a single `changed` signal. `extension.js` never talks D-Bus directly for media — it only calls `getActivePlayerInfo()` / `queryPosition()` on this watcher.
- **`prefs.js`** — `ExtensionPreferences` subclass building the Adwaita prefs window (Behavior / Notifications / Media pages), bound directly to GSettings via `settings.bind(...)`. No logic here talks to `extension.js` — the two only share state through GSettings.

### Extension lifecycle (`enable()`/`disable()` in `extension.js`)

`enable()` wires up, in order: the `DynamicIsland` actor + chrome placement, monitor/top-offset repositioning, mute-toggle handlers, notification-banner suppression (toggles GNOME's own `org.gnome.desktop.notifications show-banners` off while the island is active, restoring the original value on `disable()`), hooking every `MessageTray` source (`source-added` plus per-source `notification-added`), and the `MediaWatcher`. `disable()` must symmetrically tear down every signal connection and destroy the island/watcher — GNOME Shell extensions are loaded/unloaded in-process, so leaked signal handlers or actors persist as ghosts across future `enable()` calls.

### The island state machine (`DynamicIsland` in `extension.js`)

The island is a single actor that morphs between three visual states via `_easeIsland`/`_easeIconSize` (Clutter ease animations sized off the `animation-duration-ms` setting): collapsed pill → expanded (notification or media detail) → notification queue (scrollable list). Key entry points:
- `showNotification()` — pops a notification pill, auto-collapses after `display-duration-ms`, and always queues the notification (`_addNotificationToQueue`) regardless of whether the pill is shown, so the badge/queue stay authoritative.
- `setMedia(active, info)` — swaps in the persistent media pill when nothing else is showing; `info` is the plain object returned by `MediaWatcher.getActivePlayerInfo()`.
- Click handling is manual gesture disambiguation (`_onPress`/`_onRelease`/`_onClick`/`_onHold`), not GTK gesture recognizers, because `St` actors on the Shell's Clutter stage need hand-rolled timers to distinguish single-click / double-click / press-and-hold (`DOUBLE_CLICK_MS`, `LONG_PRESS_MS`).
- Notification icon resolution (`resolveNotificationIcon`) tries several fallbacks in order (notification gicon → app gicon → source icon → themed icon by name → running-app name match → generic symbolic icon) because the notification daemon doesn't reliably attach a usable icon.

### Settings

All user-configurable state is a single GSettings schema, `org.gnome.shell.extensions.dynamic-island` (`schemas/org.gnome.shell.extensions.dynamic-island.gschema.xml`). Adding a new preference means: add the `<key>` to the schema XML, run `glib-compile-schemas schemas/`, read/bind it in `extension.js` (`this._settings.get_*`/`connect('changed::key', ...)`) and/or add a row for it in the relevant `prefs.js` page. `schemas/gschemas.compiled` is a generated binary — always regenerate it after editing the XML, don't hand-edit it.

### Styling

`stylesheet.css` uses GNOME Shell's St CSS dialect (a CSS subset), scoped under a `.dynamic-island` class hierarchy. Layout dimensions (widths/heights per state) are defined as JS constants at the top of `extension.js`, not in CSS — CSS handles color/spacing/radius, JS handles size transitions.

for online guidance
https://gjs.guide/extensions/