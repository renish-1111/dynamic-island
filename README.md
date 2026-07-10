# Dynamic Island Notifications

Turns incoming notifications into an iPhone-style Dynamic Island pill at the top of the screen, with MPRIS media controls and a full preferences window.

## Features

- **Notification takeover** — incoming notifications pop as an animated pill instead of a standard banner, with a "spring" pop-in and settle-out animation.
- **Urgency accent** — HIGH/CRITICAL notifications get a red accent glow, both on the pill and in the queue.
- **Notification queue** — single-click the island (any time) to see every pending notification, grouped by app, with per-app mute toggles and a "Clear All" action.
- **Unread badge** — a small red count appears next to the clock whenever notifications are waiting in the queue.
- **Media pill (MPRIS)** — shows the currently playing track (Spotify, browser tabs, etc.) with play/pause/skip controls. Hover to preview, double-click or press-and-hold to pin it open.
- **Seek bar** — a clickable progress bar with elapsed/total time when a track supports seeking.
- **Playing pulse** — the album art subtly pulses while media is playing.
- **Preferences window** — configure timing, position, colors, and feature toggles from the standard GNOME Extensions app (or `gnome-extensions prefs dynamic-island@claude.local`).

## Compatibility

Supported GNOME Shell versions: 45, 46, 47, 48, 49, 50.

## Installation

### Method 1: Using GNOME Extensions CLI (Recommended)

If you have the bundled `.zip` file (`dynamic-island@claude.local.shell-extension.zip`), you can easily install it using the command line:

```bash
gnome-extensions install --force dynamic-island@claude.local.shell-extension.zip
```

### Method 2: Manual Installation

1. Create the extension directory:
   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/schemas
   ```
2. Copy the extension files into the new directory:
   ```bash
   cp extension.js prefs.js metadata.json stylesheet.css mediaWatcher.js ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/
   cp schemas/org.gnome.shell.extensions.dynamic-island.gschema.xml ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/schemas/
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/schemas/
   ```

### Enabling the Extension

After installing, you will need to restart GNOME Shell or log out and log back in (this is required on Wayland).
*   **X11:** Press `Alt` + `F2`, type `r`, and hit `Enter`.
*   **Wayland:** Log out of your desktop session and log back in.

Finally, enable the extension:
```bash
gnome-extensions enable dynamic-island@claude.local
```

Alternatively, you can enable it graphically using the **Extensions** app.

## Settings

Open preferences with:
```bash
gnome-extensions prefs dynamic-island@claude.local
```
or via the gear icon next to the extension in the **Extensions** app.

| Setting | Description |
|---|---|
| Notification duration | How long a notification pill stays expanded before collapsing |
| Animation speed | Duration of expand/collapse animations |
| Top offset | Vertical gap between the screen edge and the island |
| Enable notification takeover | Toggle the pill takeover vs. standard GNOME banners |
| Unread badge | Show/hide the pending-notification count next to the clock |
| Muted applications | Apps muted from the queue (toggle per-app via the mute icon in the notification queue) |
| Enable media integration | Toggle the MPRIS media pill |
| Show seek bar | Toggle the clickable progress bar under media info |
| Playing pulse | Toggle the subtle pulsing animation while media plays |
| Accent color | Color used for the seek bar fill |
