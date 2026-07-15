---
name: deploy-and-verify
description: Sync-check, syntax-check, recompile schemas, and redeploy the Dynamic Island GNOME Shell extension to the local extensions dir. Use before AND after editing extension.js/prefs.js/mediaWatcher.js/batteryWatcher.js/bluetoothWatcher.js/colorExtract.js/stylesheet.css/the gschema XML, since there is no build system or test framework for this project.
---

# /deploy-and-verify

This extension (`dynamic-island@claude.local`) has no build system, no
package manager, and no test framework — GJS loaded directly by GNOME Shell.
The only way to "run the tests" is to copy files into the local extensions
directory and reload the Shell, then read the Shell's own logs for exceptions.

## 0. Before touching any code: check for drift

The installed copy can silently diverge from this repo (a previous session or
manual test edit may have patched the installed files directly, or there may
be an unmerged worktree under `.claude/worktrees/` with a fix that never made
it to `master`). Confirm which side is authoritative before editing:

```bash
for f in extension.js stylesheet.css mediaWatcher.js batteryWatcher.js bluetoothWatcher.js colorExtract.js prefs.js; do
  diff "$f" ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/"$f"
done
git worktree list
```

If they differ, figure out why before assuming the repo is current — usually
means merging an unmerged worktree branch, not blindly overwriting one side.

## 1. Syntax-check

```bash
node --check extension.js
node --check mediaWatcher.js
node --check batteryWatcher.js
node --check bluetoothWatcher.js
node --check colorExtract.js
node --check prefs.js
```

## 2. Recompile the GSettings schema (only if the `.xml` changed)

```bash
glib-compile-schemas schemas/
```

## 3. Deploy to the local extensions dir

```bash
cp extension.js prefs.js metadata.json stylesheet.css \
  mediaWatcher.js batteryWatcher.js bluetoothWatcher.js colorExtract.js \
  ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/
cp schemas/org.gnome.shell.extensions.dynamic-island.gschema.xml \
  ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/schemas/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/dynamic-island@claude.local/schemas/
```

## 4. Reload GNOME Shell

- X11: Alt+F2, type `r`, Enter.
- Wayland: full logout/login — the Shell process cannot be restarted in place.

Tell the user which one applies and that they need to do it themselves; this
tool cannot trigger it.

## 5. Check for runtime errors

```bash
journalctl --user -b -o cat /usr/bin/gnome-shell | grep -i "JS ERROR"
# or /usr/bin/gnome-shell-wayland on Wayland
```

Ignore "Can't update stage views actor ... needs an allocation" and
"st_widget_get_theme_node called on the widget ... not in the stage" — these
are benign noise around enable/disable cycles, not real bugs.

## 6. Be honest about what's actually verified

Syntax-check + no JS errors in the log confirms the code loads without
crashing. It does **not** confirm the UI looks right or a gesture/animation
behaves as intended — that requires the user to actually reload the Shell and
interact with it. Say so explicitly rather than declaring a UI/UX fix
"done" on log-checking alone.
