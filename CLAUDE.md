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
node --check batteryWatcher.js
node --check bluetoothWatcher.js
node --check colorExtract.js
node --check prefs.js

# Recompile the GSettings schema after editing the .xml
glib-compile-schemas schemas/

# Install into the local extensions dir for manual testing
cp extension.js prefs.js metadata.json stylesheet.css \
  mediaWatcher.js batteryWatcher.js bluetoothWatcher.js colorExtract.js \
  ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/
cp schemas/org.gnome.shell.extensions.dynamic-island.gschema.xml \
  ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/schemas/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/schemas/

# Reload the extension: X11 can Alt+F2, r, Enter; Wayland requires logout/login
gnome-extensions enable dynamic-island@claude.local
gnome-extensions prefs dynamic-island@claude.local   # open the prefs window

# Repackage the distributable zip
gnome-extensions pack --force \
  --extra-source=mediaWatcher.js --extra-source=batteryWatcher.js \
  --extra-source=bluetoothWatcher.js --extra-source=colorExtract.js
```

There is no automated way to exercise Shell UI code — verifying changes means installing the extension and reloading GNOME Shell (Wayland requires a full logout/login since the Shell process can't be restarted in place). `journalctl -f -o cat /usr/bin/gnome-shell` (or `/usr/bin/gnome-shell-wayland`) is the way to see `logError`/exceptions at runtime.

**Before editing, check for drift between this repo and the installed extension.** There is no CI and deployment is a manual `cp`, so the running copy at `~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/` can silently diverge from `master` — a prior session (or manual testing) may have patched the installed files directly, or fixed something on an unmerged branch under a worktree (`.claude/worktrees/`, check `git worktree list`) without ever merging it back. Diff both before trusting the repo is current:

```bash
diff extension.js ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/extension.js
```

See the `deploy-and-verify` project skill (`.claude/skills/deploy-and-verify/SKILL.md`) for the full check → syntax-check → recompile → redeploy → verify loop.

## Architecture

Runtime files, loaded by GNOME Shell's extension system:

- **`extension.js`** — the entire UI. `export default class DynamicIslandExtension extends Extension` is the entry point (`enable()`/`disable()`), which owns exactly one `DynamicIsland` actor (a `St.BoxLayout` subclass) added to `Main.layoutManager` as chrome. All notification/media/timer/queue/animation logic lives as methods on this one class in `extension.js`.
- **`mediaWatcher.js`** — a standalone `GObject.Object` (`MediaWatcher`) that owns all MPRIS D-Bus plumbing: discovers `org.mpris.MediaPlayer2.*` names, tracks per-player proxies, picks the "active" player (playing, else most-recently-paused), and emits a single `changed` signal. `extension.js` never talks D-Bus directly for media — it only calls `getActivePlayerInfo()` / `queryPosition()` on this watcher.
- **`batteryWatcher.js`** — `GObject.Object` (`BatteryWatcher`) watching UPower's `DisplayDevice` for charging-state transitions and low-battery threshold crossings. Emits `changed`; `extension.js` calls `takePendingEvent()` (one-shot) to get what happened. No-ops forever on hardware with no battery (e.g. this dev desktop).
- **`bluetoothWatcher.js`** — `GObject.Object` (`BluetoothWatcher`) watching BlueZ for `Device1.Connected` transitions via a raw `PropertiesChanged` signal subscription (never instantiates a proxy, so it never auto-starts `bluetoothd`). Same `takePendingEvent()` one-shot convention as the battery watcher.
- **`colorExtract.js`** — stateless helper, `extractDominantColor(artUrl)`: samples an average color from a local (`file://`-only) MPRIS art image via GdkPixbuf, boosts it into a legible saturation/lightness range, and returns `{r, g, b, hex}` or `null`. Pure function, no GObject/signals.
- **`prefs.js`** — `ExtensionPreferences` subclass building the Adwaita prefs window (Behavior / Notifications / Media / System pages), bound directly to GSettings via `settings.bind(...)`. No logic here talks to `extension.js` — the two only share state through GSettings.

### Battery/Bluetooth/timer pills vs. notifications

Battery and Bluetooth events surface as **transient pills** (`DynamicIsland.showTransient()`): lower priority than a real notification, reusing the same icon/title/body/close widgets (they can never show at once) and the same hover-pause/auto-collapse timer. Unlike real notifications they are **never queued** — if one is already showing, a new one is just dropped.

The **timer** is a genuine second persistent activity alongside media (started from the island's right-click quick-menu, not GSettings-backed). `DynamicIsland._renderActive()` is the dispatcher: media alone → `_renderMedia()`, timer alone → `_renderTimerOnly()` (takes over the main icon/text slot), both → media stays primary and the timer rides as a small compact accessory chip (`_timerBadge`) — the "two islands merged" look. Any code path that used to fall back to `_renderMedia()`/`_collapse()` after a notification/queue/transient closes must go through `_renderActive()` instead, or a running timer won't resume correctly.

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