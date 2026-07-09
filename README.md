# Dynamic Island Notifications

Turns incoming notifications into an iPhone-style Dynamic Island pill at the top of the screen.

## Compatibility

Supported GNOME Shell versions: 45, 46, 47, 48, 49, 50.

## Installation

### Method 1: Using GNOME Extensions CLI (Recommended)

If you have the bundled `.zip` file (`dynamic-island@claude.local.shell-extension.zip`), you can easily install it using the command line:

```bash
gnome-extensions install dynamic-island@claude.local.shell-extension.zip
```

### Method 2: Manual Installation

1. Create the extension directory:
   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local
   ```
2. Copy the extension files into the new directory:
   ```bash
   cp -r extension.js metadata.json stylesheet.css mediaWatcher.js ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/
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
