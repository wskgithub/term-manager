# Term Manager

[![CI](https://github.com/wskgithub/term-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/wskgithub/term-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[简体中文](README.zh-CN.md) | **English**

A tabbed terminal manager for the Linux desktop: multiple tabs, renaming, drag-and-drop
reordering and multiple profiles (positioned much like Windows Terminal). The manager owns
the tab/profile/process lifecycle; terminal emulation is [xterm.js](https://github.com/xtermjs/xterm.js)
(the component behind VS Code); PTY sessions are hosted by a **tmux Control Mode backend** —
the same architecture as WindTerm/iTerm2, which makes session persistence a natural fit.

## Screenshots

![Main view: multiple tabs + rename + mixed profiles](docs/screenshots/main-dark.png)

![Tab groups & pinning](docs/screenshots/tab-groups.png) ![New-tab dropdown: shell profile picker](docs/screenshots/newtab-menu.png)

![Command palette (Ctrl+Shift+P fuzzy search)](docs/screenshots/palette.png)

![Group sidebar tree view](docs/screenshots/sidebar-tree.png) ![Settings page (light theme)](docs/screenshots/settings-light.png)

All screenshots are produced by the E2E infrastructure driving the real UI (CDP menu
clicks, renames, pasted commands) — not staged mockups.

## Tech stack

- Electron 44 + TypeScript (main process owns backend/config, renderer owns UI)
- Vite (electron-vite) + React
- `@xterm/xterm` as the emulation component
- Backend: `tmux -C` control mode (private socket, one tmux window per tab; input via
  `send-keys`, output via the `%output` event stream)
- Profiles are stored as JSON (`~/.config/term-manager/profiles.json`, generated on first
  launch); app settings live in `settings.json` in the same directory

## Profile model

The `+` dropdown mimics Windows Terminal: it lists **shell types** (bash, zsh, fish, pwsh,
Docker Shell), not machines. On first launch the main process probes candidates along
`PATH` (the login shell `$SHELL` comes first); shells that are not installed are removed
from the menu. `profiles.json` (`{ "version": 2, "profiles": [...] }`) accepts any custom
profile you add, for example an ssh remote:

```json
{
  "version": 2,
  "profiles": [
    { "id": "gpu-27", "name": "GPU box", "command": "ssh", "args": ["user@192.168.1.100"], "color": "#aed581" }
  ]
}
```

Legacy v1 configs (no `version` field) are detected and regenerated with default shells.

## Settings

Open via the settings entry at the bottom of the `+` dropdown, or `Ctrl+,` (layout follows
Windows Terminal: category navigation on the left — "Appearance" and "Terminal"):

- **Theme**: dark / light / follow-system, applied live (including the native title bar —
  on X11 it follows instantly via `_GTK_THEME_VARIANT`).
- **Font**: dropdown of local monospace fonts (enumerated by the main process via
  `fc-list :mono`). The default "auto" is a Nerd-Font-first stack
  (`JetBrainsMono Nerd Font` → `FiraCode Nerd Font` → … → CJK monospace fallback);
  choosing a Latin-only font automatically appends a CJK fallback.
- **Font size**: 8–48 px, stepper or direct input.
- **Group sidebar** (Appearance page): show the "group → tab" tree panel on the left
  (replacing the top tab bar; **off by default**, toggle any time with `Ctrl+Shift+B` —
  see [Group sidebar](#group-sidebar) below).
- **Session** (Terminal page): the "keep sessions on exit" toggle (on by default, see
  [Session persistence](#session-persistence) below).
- **Group broadcast** (Terminal page): the "broadcast input to group" toggle
  (**off by default**, see [Group broadcast](#group-broadcast) below).

Changes apply immediately to all open terminals and persist to `settings.json`.

## Session persistence

Closing the window keeps the tmux sessions alive by default: running jobs (builds, ssh,
training) and terminal state survive, and the next launch restores all tabs — including
pin/group/manual-rename/active-tab state and **screen replay** (`capture-pane -e`
colored history + cursor repositioning, exact for both shell prompts and full-screen
apps like vim/htop). Crashes are recoverable the same way: session state is persisted on
every change (`sessions.json`) and windows are reconciled/adopted on restart.

- The settings page (Terminal → Session) can turn this off to return to
  "exit terminates everything"
- `Ctrl+Shift+Q` explicitly terminates all sessions and exits at any time
- Restored terminals remain fully interactive (not a read-only snapshot); tabs whose
  shell had already exited are not restored

## Group broadcast

When operating many machines at once (e.g. running the same command across a cluster),
a tab group can be set to **synchronize keyboard input** (paste included) across all of
its terminals: light up the broadcast toggle on the group head (or use the group
context menu's "Broadcast input to group"), and whatever is typed into any tab of that
group is delivered to every tab in it. Groups are user-defined logical sets, not tied
to window layout — more flexible than Terminator's split-pane-bound broadcast groups.

Mistakenly broadcasting is expensive (a password or `rm` hitting several machines at
once), so the design is deliberately defensive:

- A master toggle in Settings (Terminal → Group broadcast), **off by default**; no
  broadcast UI exists until it is enabled
- Broadcast state is **not kept across restarts** — relaunching always resets it to
  off, so it can never be silently left on
- While broadcasting it is always visible: the group-head toggle lights up in warning
  color, the group container deepens, and a persistent "broadcasting to N terminals"
  badge sits in the top-right of the terminal area whenever the active tab belongs to
  a broadcasting group

## Group sidebar

With many tabs the horizontal tab bar runs out of room. The **group sidebar** (Settings →
Appearance, off by default; `Ctrl+Shift+B` or the button at the left edge of the tab bar
toggles it) replaces the tab bar with a vertical tree panel: pinned tabs on top, groups
as collapsible tree nodes (colored dot, name, member count), ungrouped tabs at the root
level — same order as the tab bar, just vertical.

- Full management parity with the tab bar: click to switch, double-click to rename,
  right-click context menus (pin/group/move/close, rename/recolor/dissolve/broadcast),
  `+` new-tab dropdown and settings entry in the sidebar header
- **Tree drag-and-drop**: reorder within the same parent, drop a tab onto a group node
  to join it, drop a group member onto an ungrouped row to leave it (the pin/group
  ordering invariants are maintained centrally by the app state)
- The terminal area is re-fit live when the sidebar opens/closes (tmux panes are
  resized accordingly); group collapse state is shared with the tab bar and persists
  across restarts with the session

## Command palette

`Ctrl+Shift+P` opens a VS Code-style top-center palette (works whether focus is in a
terminal or not). Fuzzy search (subsequence matching with hit highlighting; Chinese
commands also match their English keywords), ↑↓ to select, Enter to run, Esc to close
and hand focus back to the terminal. Four command families:

- **Tab actions**: new tab (default + one entry per profile, with color dots), rename
  the current tab (a second input step inside the palette, Enter commits), pin/unpin,
  close (grayed out on pinned tabs — same anti-misclick semantics as the shortcut)
- **Quick tab switching**: "switch to tab: <title>" — one entry per tab (with
  pin/group markers), so the palette doubles as a tab switcher, faster than Ctrl+Tab
  cycling once tabs pile up
- **Grouping & broadcast**: add to a new group, leave the group, broadcast toggle
  (gated by the master settings switch; the enabling action is shown in warning color)
- **App-level**: sidebar toggle, settings page, theme switching (current theme grayed
  out and marked), quit and terminate all sessions (warning color)

Every command maps onto existing app callbacks (no new IPC or data flow);
context-sensitive entries appear and flip with state (e.g. "leave group" only exists
inside a group; close grays out once pinned).

## GPU rendering

Terminals render through the WebGL renderer (`@xterm/addon-webgl`) by default —
fast output and large-scrollback scrolling are noticeably smoother than with the DOM
renderer; glyphs live on the GPU in a texture atlas instead of per-frame DOM layout.
Works out of the box, nothing to configure:

- **Automatic fallback**: if the WebGL context cannot be created (driver unsupported /
  disabled by the environment) or is lost at runtime (GPU reset, or the browser's
  context-count limit), the terminal falls back to the DOM renderer with no functional
  impact; when tabs exceed the context limit the oldest terminals degrade one by one
  and self-heal — no crash
- **Settings toggle** (Terminal → Rendering): off forces the DOM renderer everywhere;
  the switch applies live without recreating open terminals (terminals created
  afterwards follow the new setting)
- The cost: one WebGL context + glyph atlas per terminal, a modest memory increase
  (measured ~+200MB with 20 tabs); constrained machines can turn it off

## Nautilus context-menu integration

The file manager's right-click menu (on a directory or in the empty area of a directory)
offers "Open in Term Manager": opens a tab in that directory. When the app is already
running the existing window is reused and focused (single instance); the command line
also accepts `term-manager --open-dir=<dir>` or `term-manager <dir>`.

- The deb installs the extension to
  `/usr/share/nautilus-python/extensions/term_manager_nautilus.py` and Recommends
  `python3-nautilus`: `apt install ./*.deb` pulls it in automatically, `dpkg -i` needs a
  manual `sudo apt install python3-nautilus`. Without that dependency the extension
  silently does nothing (the app itself is unaffected).
- After installing, run `nautilus -q` (or log out/in) so the file manager reloads
  extensions.
- For debugging, point the environment variable `TERM_MANAGER_BIN` at a local build.

## Directory layout

```
src/
├── main/            # Electron main process
│   ├── index.ts     # entry, window, IPC, smoke/E2E orchestration
│   ├── tmux.ts      # tmux Control Mode backend (session hosting / input / output / resize / attach & replay)
│   ├── profiles.ts  # profile registry (JSON persistence)
│   ├── settings.ts  # app settings (font/size) + fc-list font enumeration
│   └── session.ts   # session persistence (sessions.json: attach candidate + tab metadata)
├── preload/         # contextBridge API
└── renderer/src/
    ├── App.tsx      # tab state machine + single-point data fan-out + hotkeys + settings state
    ├── TabBar.tsx   # rename / drag reorder / profile menu / settings entry
    ├── Sidebar.tsx  # group sidebar tree view (replaces the tab bar when enabled)
    ├── NewTabMenu.tsx # + split button / profile dropdown (shared by tab bar & sidebar)
    ├── palette.ts   # command palette registry (command building + fuzzy match scoring)
    ├── CommandPalette.tsx # command palette overlay (keyboard nav + two-step rename)
    ├── menus.tsx    # shared tab/group context-menu builders (data-key is the e2e selector)
    ├── segs.ts      # tab-list segmentation (consecutive same-group runs), shared view model
    ├── TermView.tsx # xterm instances (single-point output dispatch, adaptive sizing, font settings)
    ├── SettingsPage.tsx # settings page (appearance → font/size + preview; terminal → defaults)
    ├── fonts.ts     # font stack resolution (auto mode / CJK fallback)
    └── e2e.ts       # E2E driving hooks
```

## Common commands

```bash
npm run dev        # development mode (hot reload)
npm run build      # build to out/
npm run typecheck  # TS checks (node + web projects)
npm run smoke      # windowless smoke: real shell echo round-trip validates the backend path
npm run rebuild    # rebuild native modules (currently none — no-op)
npm run dist       # build the deb (dist/term-manager_<version>_amd64.deb)
npm run dist:dir   # produce dist/linux-unpacked/ only (no package, quick content check)
```

## deb packaging

```bash
npm run dist        # dist/term-manager_0.1.0_amd64.deb
sudo dpkg -i dist/term-manager_*.deb   # install (into /opt + /usr/bin link + desktop entry)
sudo dpkg -r term-manager              # uninstall
```

- Configuration lives in the `build` field of `package.json` (electron-builder 26, deb target).
- Layout: the app installs to `/opt/term-manager/`; postinst creates `/usr/bin/term-manager`
  (update-alternatives), handles chrome-sandbox permissions (SUID when no user namespaces),
  registers desktop databases; Ubuntu 24+ also installs an apparmor profile.
- Desktop entry `/usr/share/applications/term-manager.desktop` (Name=Term Manager,
  Categories=Utility;TerminalEmulator) with hicolor icons 24x24…512x512 (source:
  `build/icons/`, generated once by script).
- `Depends` always includes **tmux** besides the Electron runtime libraries.
- The Electron binary is taken directly from `node_modules/electron/dist` (`electronDist`)
  instead of being downloaded again; fpm and friends are fetched through
  `ELECTRON_BUILDER_BINARIES_MIRROR` (npmmirror), cached under `.cache/` (gitignored).
- Window association verified: `desktopName` ships inside the asar and Electron derives the
  app_id from it; `xprop WM_CLASS` reports `"term-manager", "Term-manager"`, matching
  `StartupWMClass`.

## E2E tests

```bash
# 20-tab end-to-end: batch create → per-tab echo latency → screenshots → keyboard
# injection → performance summary → auto-quit
npx electron out/main/index.js --e2e-tabs=20 --e2e-out=/tmp/e2e --e2e-quit --no-sandbox
```

Watch the `E2E_RESULT` log line; screenshots land in `--e2e-out` (boot/tabs5/all-tabs/
after-typing). Add `--e2e-settings` to also open the settings page and capture
`05-settings.png`.

```bash
# Real input-path regression: sendInputEvent trusted events — focus lands in the
# terminal after a real tab click, Ctrl+Tab switches without leaking \t into the shell,
# high-volume CJK text shows no mojibake, and group broadcast behaves (settings-gated
# UI, delivery to both group panes but not outsiders, independence restored when off)
npx electron out/main/index.js --e2e-input --e2e-quit --no-sandbox
```

```bash
# Session-persistence two-phase regression (isolated userData; two processes simulate
# an app restart). Phase 1 creates tabs + pin + group + rename + a marker string, then
# exits keeping the session; phase 2 re-attaches and asserts tabs/pin/group/rename/
# screen replay/interactivity, then terminates and cleans up.
U=/tmp/e2e-sess-ud; rm -rf $U; mkdir -p $U
M=$(npx electron out/main/index.js --e2e-session=phase1 --e2e-user-data=$U --no-sandbox 2>&1 \
  | grep -oE 'E2E_SESS1_MARKER [A-Za-z0-9_]+' | cut -d' ' -f2)
npx electron out/main/index.js --e2e-session=phase2 --e2e-user-data=$U --e2e-sess-marker=$M --no-sandbox
```

```bash
# Group sidebar regression: all three toggle paths (tab-bar button / sidebar close /
# Ctrl+Shift+B through the real input pipeline), tree structure vs the tab array,
# menu-driven grouping + rename, synthetic-drag into/out-of-group and same-parent
# reorder, collapse, click-to-activate focus ownership, live terminal re-fit on toggle
npx electron out/main/index.js --e2e-sidebar --e2e-quit --no-sandbox
```

```bash
# Command palette regression: Ctrl+Shift+P through the real input pipeline (including
# xterm penetration while a terminal has focus), fuzzy filtering, arrow/Enter/mouse
# execution, two-step rename, context-sensitive commands (close grayed on pinned tabs,
# broadcast gated by settings, current theme grayed), Esc close and focus return
npx electron out/main/index.js --e2e-palette --e2e-quit --no-sandbox
```

```bash
# Profile runtime-refresh regression (self-contained env: isolated userData + an empty
# "install dir" on PATH). Writing/removing a fake shell simulates install/uninstall;
# asserts profiles:list re-probes on every call, the renderer re-fetches when the +
# menu / command palette opens, newly installed built-in shells get merged in, and
# changes persist to profiles.json
npx electron out/main/index.js --e2e-profile-refresh --e2e-quit --no-sandbox
```

```bash
# GPU rendering regression (discriminator: the WebGL main canvas only enters the DOM
# after context creation succeeds). Normal mode asserts default-on, live settings
# toggling without recreating terminal instances, new terminals following the setting,
# and font-size/theme changes keeping the renderer; add --e2e-webgl-fallback to
# disable WebGL early in boot, deterministically triggering creation failure →
# automatic DOM fallback + leftover-layer cleanup + fully working terminals
npx electron out/main/index.js --e2e-webgl --e2e-quit --no-sandbox
npx electron out/main/index.js --e2e-webgl-fallback --e2e-quit --no-sandbox
```

### Measured performance (20 hosted tabs, 2026-09-09, i5/integrated graphics)

| Metric | Value |
|---|---|
| Echo latency (renderer → backend → zsh → renderer) | p50 ≈ 12 ms, p95 ≈ 60 ms |
| Idle CPU (all processes) | ≈ 0% |
| Memory (all processes, incl. 20×2000-line scrollback) | ≈ 540 MB (baseline 197 MB, ~17 MB/tab) |
| Stability | 20/20 tabs, 0 errors, no leftover processes on exit |

## Keyboard shortcuts

- `Ctrl+Shift+T` new tab (default profile)
- `Ctrl+Shift+W` close current tab (has no effect on pinned tabs — prevents accidental closes)
- `Ctrl+Tab` / `Ctrl+Shift+Tab` switch tabs (when a terminal has focus this is intercepted
  by the xterm keyboard hook; when focus is outside terminals a window-level listener is
  the fallback — the Tab family never bubbles once claimed by xterm)
- `Ctrl+Shift+Q` quit and terminate all sessions (the tmux server and its shells end)
- `Ctrl+Shift+B` toggle the group sidebar (works whether focus is in a terminal or not)
- `Ctrl+Shift+P` toggle the command palette (same; see [Command palette](#command-palette))
- `Ctrl+,` toggle settings page (`Esc` or clicking a tab closes it)
- Double-click a tab to rename (after a manual rename the shell-reported title no longer
  overrides it)
- Tab right-click menu: pin/unpin (always at the left, narrow, no close button), add to a
  new group / move into an existing group / remove from group, close

## Done / roadmap

- [x] Multiple tabs, click-to-switch, close, grayed-out prompt on exit
- [x] Double-click rename (title-override semantics)
- [x] Drag-and-drop tab reordering
- [x] Profile system: the `+` menu lists local shell types (bash / zsh / fish / pwsh /
      Docker Shell, probed along PATH, unavailable ones grayed out); the default profile
      is the user's login shell; ssh remotes are user-defined profiles in profiles.json.
      Availability refreshes at runtime — opening the `+` menu or the command palette
      re-probes PATH and merges in newly installed built-in shells, no restart needed
- [x] tmux Control Mode backend: UTF-8 (StringDecoder for multi-byte characters across
      chunks), adaptive sizing, input debounce batching (5 ms/8 KB), process-failure
      fallback (a missing/killed tmux no longer crashes the main process), cleanup of
      tmux servers left behind by crashed instances on startup (socket names embed the
      creator pid for liveness probing)
- [x] Settings page (appearance: font picker / font size, fc-list monospace enumeration,
      applied live + persisted)
- [x] E2E test infrastructure (smoke + 20-tab benchmark + screenshots + keyboard
      injection + input regression [incl. broadcast routing] + two-phase
      session-persistence regression)
- [x] Pinned tabs + tab groups (colored groups in the tab bar: collapse by clicking the
      group head, right-click to rename/recolor/dissolve; pin and group are mutually exclusive)
- [x] Session persistence: exit keeps tmux sessions; relaunch re-attaches and restores
      tabs/pin/group/rename state plus screen replay (covered by `--e2e-session`)
- [x] Per-group broadcast input (tab granularity, beyond Terminator; settings toggle
      off by default, broadcast state does not survive restart, covered by `--e2e-input`)
- [x] electron-builder deb packaging (desktop entry / icons / dependency metadata included)
- [x] Nautilus context-menu integration (open-in-directory + single-instance window reuse,
      shipped with the deb)
- [x] Group sidebar tree view (vertical "group → tab" panel replacing the tab bar; tree
      drag-and-drop for reorder/join/leave, covered by `--e2e-sidebar`)
- [x] Command palette (`Ctrl+Shift+P` fuzzy search & run: tabs/profiles/switching/
      grouping/broadcast/theme/sidebar/settings/quit, in-palette two-step rename,
      covered by `--e2e-palette`)
- [x] GPU rendering (addon-webgl on by default, automatic DOM-renderer fallback on
      creation failure or context loss, settings toggle, covered by `--e2e-webgl` in
      both modes)
- [ ] AppImage, rpm and other package formats

## Notes

- The originally planned node-pty direct backend could not land because an environment
  security hook mis-flagged execvp-style spawns as "command injection"; the tmux backend
  that replaced it turned out to enable session persistence for free. The interface layer
  (TmuxBackend, isomorphic to the original PtyManager) allows both to coexist in the future.
- powerline/Nerd glyphs depend on font coverage: the default font stack prefers Nerd Fonts,
  and you can pick manually in settings; when the selected font lacks a glyph Chromium
  falls back per glyph, though a non-Nerd font may still show placeholder boxes.
