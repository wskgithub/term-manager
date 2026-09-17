# Term Manager Plugin Development Guide

For community plugin authors: from your first plugin to the complete reference — manifest
fields, the code-level API, validation rules and debugging. Targets plugin API v1
(`termManager.version === '1'`).

The [“Declarative plugins”](../README.md#declarative-plugins) and
[“Code-level plugins”](../README.md#code-level-plugins-experimental) sections of the main
README are feature overviews; this document is the full reference.

## Contents

1. [Plugin model at a glance](#plugin-model-at-a-glance)
2. [Quick start: a plugin in five minutes](#quick-start-a-plugin-in-five-minutes)
3. [Install, refresh, uninstall](#install-refresh-uninstall)
4. [manifest.json field reference](#manifestjson-field-reference)
5. [Profile field reference](#profile-field-reference)
6. [Palette commands and the action vocabulary](#palette-commands-and-the-action-vocabulary)
7. [Theme format reference](#theme-format-reference)
8. [Code-level plugins: entry and runtime model](#code-level-plugins-entry-and-runtime-model)
9. [termManager API reference](#termmanager-api-reference)
10. [Limits and validation rules summary](#limits-and-validation-rules-summary)
11. [Debugging guide](#debugging-guide)
12. [Security model (read before installing)](#security-model-read-before-installing)
13. [Known limitations and roadmap](#known-limitations-and-roadmap)
14. [Examples index](#examples-index)

## Plugin model at a glance

A plugin = **one folder** under the `plugins/` directory containing a `manifest.json`.
Two tiers:

| | Declarative (data) | Code-level (behavior) |
| --- | --- | --- |
| Contents | manifest.json + optional themes/ | same + an `entry` script |
| Can contribute | profiles, palette commands, theme packs | all of that + runtime commands/themes, events, tab operations, terminal read/write, status-bar items |
| Has code | No — pure data | Yes — an ES module running in its own sandboxed iframe (isolated host) |
| Good for | new terminal types, quick actions, color schemes | reacting to output, automation, status display |

Rule of thumb: **prefer declarative when it suffices** (zero code means zero audit cost
for your users and no security questions). Reach for code only when you need to *listen*
or *react*. Both tiers can coexist in one plugin (declarative profiles + code extras).

## Quick start: a plugin in five minutes

```bash
mkdir -p ~/.config/term-manager/plugins/hello
cat > ~/.config/term-manager/plugins/hello/manifest.json <<'EOF'
{
  "id": "hello",
  "name": "Hello",
  "version": "1.0.0",
  "profiles": [
    { "id": "py", "name": "Python REPL", "command": "python3", "color": "#f9e2af" }
  ],
  "commands": [
    { "id": "greet", "label": "Hello: open settings", "keywords": "hello settings",
      "action": { "type": "open-settings" } }
  ]
}
EOF
```

Then open the command palette with `Ctrl+Shift+P` (or the `+` menu, or the settings page)
— **the directory is rescanned at that moment**, so the new plugin takes effect without a
restart:

- “Python REPL” appears in the `+` menu (requires `python3` on PATH; otherwise grayed out);
- “Hello: open settings” is searchable in the palette.

That's a complete declarative plugin. To add code, see
[Code-level plugins](#code-level-plugins-entry-and-runtime-model).

## Install, refresh, uninstall

| Question | Answer |
| --- | --- |
| Where do plugins live | `<userData>/plugins/<folder>/` — on an installed Linux build that is `~/.config/term-manager/plugins/` (running from source uses a different userData, see [Debugging](#debugging-guide)) |
| How to install | Copy the folder (or `git clone` / symlink) there; the app creates the plugins directory automatically |
| When does it take effect | Loaded at startup; afterwards **every open of the command palette / `+` menu / settings page rescans**, new plugins appear immediately |
| How to uninstall | Delete the folder. Declarative contributions vanish on the next rescan; a code plugin's registrations (commands/themes/status-bar items/event & data subscriptions) are torn down **immediately** |
| Is there an enable toggle | No — the folder existing is the whole truth. A management UI is a later-stage item |
| How to distribute | Git repo, zip, anything — this project deliberately ships no marketplace (see the end of the README “Declarative plugins” section) |

Three semantics specific to code plugins:

- **Unloading actually unloads**: after you delete the plugin folder, everything it
  registered disappears immediately and the sandboxed iframe carrying it is destroyed
  with it (closures, timers, open connections all end with the frame) — no restart needed.
- **How to re-execute changed code**: the plugin frame is created once per
  `pluginId@version`. After editing `main.mjs`, bump the manifest `version`
  (e.g. `1.0.0` → `1.0.1`) and the next rescan rebuilds the frame; or restart the app.
- **Network permissions need approval**: a plugin declaring `permissions.connect` shows
  an approval dialog on first load (allow / deny; Esc counts as deny); the decision
  persists and does not nag again — until the declared list changes. See
  [runtime model](#code-level-plugins-entry-and-runtime-model).

## manifest.json field reference

| Field | Required | Type | Validation | On violation |
| --- | --- | --- | --- | --- |
| `id` | ✅ | string | `[a-z0-9-]{1,64}` (all lowercase) | whole plugin skipped |
| `name` | ✅ | string | non-empty, truncated at 80 chars | whole plugin skipped |
| `version` | — | string | non-empty, ≤32 chars | field ignored |
| `entry` | — | string | see “entry validation” below | field dropped; plugin degrades to purely declarative |
| `permissions` | — | object | see “permissions validation” below | bad origins dropped individually; all-bad drops the field |
| `profiles` | — | array | each per [profile fields](#profile-field-reference), max 50 | bad entries dropped individually |
| `commands` | — | array | each per the [action vocabulary](#palette-commands-and-the-action-vocabulary), max 100 | bad entries dropped individually |
| (subdir) `themes/` | — | dir | `themes/*.json`, one theme per file, max 50 | bad files dropped whole |

`id` is the namespace root; these global identifiers derive from it (pick a collision-free
name when distributing):

- profile global id: `pluginId:localId` (e.g. `hello:py`)
- theme id: `pluginId/stem` (e.g. `hello/night`)
- code command palette key: `code:pluginId:commandId`

**entry validation** (all must pass, otherwise the field is dropped + a main-process log):

- a relative path matching `^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}` with no `..` segment;
- ends with `.js` or `.mjs`;
- the file exists and is ≤ 1MB.

**permissions validation** (the v1 vocabulary has only `connect`, a network-allow list):

```json
"permissions": { "connect": ["https://api.github.com", "http://127.0.0.1:8080"] }
```

- each origin looks like `scheme://host[:port]` (no path): `https://` any host; `http://`
  only `localhost` / `127.0.0.1`;
- ≤200 chars each, deduplicated in order, max 8 entries;
- meaningful only for plugins with an `entry` (purely declarative plugins have no code
  and no network needs);
- first load after declaring shows an approval dialog; approved origins enter the plugin
  frame CSP's `connect-src`. Changing the declared list re-prompts (old approvals never
  cover new addresses).

**Validation culture** (inherited from profiles.json — expect these behaviors while
developing):

- bad JSON, missing id/name, invalid id → **whole plugin skipped**, logged main-side;
- bad entries inside profiles / commands / themes are **dropped individually** — they don't
  take down good entries of the same plugin;
- duplicate plugin ids → sorted by folder name, **first wins**, the rest are skipped with
  a log (when debugging locally, rename your folder to sort earlier).

## Profile field reference

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `id` | ✅ | string | local id, `[A-Za-z0-9_-]{1,64}`; exposed as `pluginId:localId` |
| `name` | ✅ | string | display name (`+` menu / palette / sidebar) |
| `command` | — | string | executable name, probed on PATH; grayed out in menus when not found. Missing = always available |
| `args` | — | string[] | arguments to command (list-form, never shell-joined) |
| `env` | — | object | extra environment variables (all values strings) |
| `cwd` | — | string | working directory (absolute) |
| `color` | — | string | tab color dot (`#rrggbb`) |

Profiles join the `+` menu / sidebar / palette / default-terminal picker with the same
standing as built-in shells. The renderer **never sends command bodies** — `term:create`
accepts ids only and commands are resolved main-side, so plugin profiles share the same
security boundary as the user's profiles.json.

## Palette commands and the action vocabulary

Each manifest `commands` entry: `{ id, label, keywords?, hint?, action }` (`id`/`label`/
`action` required; `label` ≤120, `keywords` ≤200, `hint` ≤80 chars). Actions are a
**closed vocabulary** of five:

| action | fields | effect |
| --- | --- | --- |
| `{ "type": "launch", "profile": "py" }` | profile = a local profile id of **your own** plugin | open a new tab with that profile. Referencing a non-existent own profile drops the whole command |
| `{ "type": "open-settings" }` | — | open the settings page |
| `{ "type": "toggle-sidebar" }` | — | toggle the group sidebar |
| `{ "type": "set-theme", "mode": "dark" }` | mode = `dark` / `light` / `system` | switch the theme tri-state |
| `{ "type": "set-scheme", "id": "hello/night" }` | id matching `[A-Za-z0-9/_-]{1,80}` | switch color scheme (any theme: built-in `mocha`/`latte`, global themes, `pluginId/stem`). Unknown at runtime → grayed out in the palette, not dropped |

Palette search matches `label` and `keywords` (fuzzy subsequence, case-insensitive);
`hint` is display-only. The palette shows at most 60 matches — use a more specific query
when many tabs are open.

## Theme format reference

A theme is either a JSON file in the plugin's `themes/` directory (a theme pack, active
declaratively) or registered dynamically by a code plugin via `registerTheme`. **Both use
the same data format**:

```json
{
  "name": "Night (example)",
  "type": "dark",
  "ui": { "bg": "#0b0d12", "accent": "#7aa2f7" },
  "terminal": { "background": "#0b0d12", "foreground": "#a9b1d6" }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | ✅ | display name (settings selects), non-empty, ≤80 chars |
| `type` | ✅ | `dark` or `light` — which side's select it belongs to (“follow system” applies each side independently) |
| `ui` | — | UI CSS variable overrides, keys below |
| `terminal` | — | terminal xterm color overrides, keys below |

Invalid `name` or `type` → the whole theme is dropped; inside `ui`/`terminal` **bad keys
are dropped individually** (one typo'd color doesn't void the scheme); if everything is
dropped the section counts as absent.

**Color value formats** (anything else is dropped):

- `#hex`: 3 / 4 / 6 / 8 digits (`#abc`, `#abcd`, `#aabbcc`, `#aabbccdd`)
- `rgba(R, G, B, A)`: components 0–255, alpha a 0–1 decimal

**Inheritance**: `ui` / `terminal` may be absent or partially declared — undeclared fields
**inherit from the builtin of the same side** (UI via CSS cascade fallback, terminal via an
explicit merge at parse time). A minimal theme that only sets the background is legal.

### ui keys (17)

| Key | Affects |
| --- | --- |
| `bg` | global background (tab bar, content area) |
| `bg-deep` | deeper background (terminal well, sidebar, settings nav column) |
| `bg-inset` | inset panel background (preview boxes) |
| `surface` | control surfaces (settings rows, inputs, button fills) |
| `surface-hover` | control hover surface |
| `text` | regular text |
| `text-bright` | emphasized text (hover, headings) |
| `accent` | accent color (selection, focus, active toggles) |
| `warn` | warning color (error banner, broadcast high-risk state) |
| `hairline` | thin separators |
| `hover-wash` | hover tint on interactive items |
| `menu-bg` | popup menu background |
| `kbd` | palette keybinding hint text |
| `kbd-strong` | keybinding hint emphasis on hover |
| `thumb` | scrollbar thumb |
| `thumb-hover` | thumb hover |
| `thumb-active` | thumb pressed |

### terminal keys (22)

`background`, `foreground`, `cursor`, `cursorAccent`, `selectionBackground`,
`selectionForeground`, plus the ANSI 16 colors: `black` `red` `green` `yellow` `blue`
`magenta` `cyan` `white` `brightBlack` `brightRed` `brightGreen` `brightYellow` `brightBlue`
`brightMagenta` `brightCyan` `brightWhite`.

> Keys align with xterm's ITheme; reference palettes (Catppuccin Mocha / Latte) live in
> `src/shared/themes.ts` — copy one and tweak.

### Theme packs and the global themes directory

- Plugin theme pack: `<plugin folder>/themes/<stem>.json`, stem matching
  `[A-Za-z0-9_-]{1,64}`, registered as `pluginId/stem`;
- Global themes directory: `~/.config/term-manager/themes/<stem>.json` (no namespace, the
  stem is the id); `mocha` / `latte` are reserved;
- both feed the settings “Dark scheme / Light scheme” selects, split by `type`.

## Code-level plugins: entry and runtime model

Add `"entry": "main.mjs"` to the manifest to become a code-level plugin:

```
plugins/my-tools/
├─ manifest.json      { "id": "my-tools", "name": "My Tools", "version": "1.0.0", "entry": "main.mjs" }
├─ main.mjs           entry (ES module)
└─ lib/…              optional: other files imported relatively by main.mjs
```

Runtime model essentials:

1. **Loading (isolated host)**: the app creates one **sandboxed iframe** per code plugin,
   loading a host page synthesized by the main process at
   `tmplug://<pluginId>/__tmplug_host__?entry=main.mjs` (a unique origin per plugin),
   which then loads your entry as a `<script type="module">`. The frame is **cross-origin
   to the UI** — it cannot touch the UI DOM or `window.api`; the only channel is the
   `termManager` API exposed by the in-frame bridge (postMessage RPC: value-returning
   methods are async, see below). The sandbox attribute is
   `allow-scripts allow-same-origin`; the frame gets localStorage on its own origin.
2. **Boilerplate**: the first line obtains the namespaced API — the argument must exactly
   match the manifest `id`:

   ```js
   const tm = termManager.init('my-tools')
   ```

   `init` is idempotent (repeated calls with the same id return the same object); a
   mismatched id or an entry dropped by validation throws (check main-process logs, see
   [Debugging](#debugging-guide)).
3. **Multiple files**: `main.mjs` may relatively import other files inside the plugin
   folder (`import './lib/util.js'`) and use dynamic `import()`. `tmplug://` serves only
   whitelisted file types inside the plugin folder: `.js` `.mjs` `.css` `.json` `.png`
   `.svg` — referencing other types (e.g. `.txt`) returns 403 and fails the module load.
4. **The runtime is the renderer, not Node**: no `require` / `fs` / `process`, and no npm
   package-name resolution — a bare `import 'lodash'` cannot resolve. Bundle third-party
   libraries (e.g. with esbuild) into a single entry file; there is intentionally no API
   for reading local files.
5. **Persistence**: v1 has no plugin storage API. `localStorage` works and is
   **naturally isolated** — the plugin frame's origin is `tmplug://<pluginId>/`, distinct
   from the app and from every other plugin (no key prefixing needed); deleting and
   reinstalling the plugin starts from clean storage.
6. **Error isolation**: if your command run, event listener, data subscription or
   status-bar click callback throws, the app catches it and logs a console error without
   crashing or affecting sibling plugins. Failed loads are **not retried** (see refresh
   semantics).

## termManager API reference

Full type definitions live in `TmScopedApi` in [`src/shared/types.ts`](../src/shared/types.ts)
(point your IDE there for completions). Grouped walkthrough below.

### General

```ts
tm.version            // '1'
tm.info               // { id, name, version? } — from the manifest
```

> **Async semantics under the isolated host**: the API travels over postMessage RPC, so
> value-returning methods — `registerCommand`, `registerTheme`, `tabs.list`,
> `tabs.active` — resolve **Promises** (e.g. `const ok = await tm.registerCommand(…)`,
> `const tabs = await tm.tabs.list()`). Ignoring the return value is fine, semantics are
> unchanged; the unsubscribe functions returned by event/data subscriptions stay
> synchronous.

### Commands: into the palette

```ts
const ok = tm.registerCommand({
  id: 'build',                       // local id: [A-Za-z0-9_-]{1,64}
  label: 'My Tools: run build',      // required non-empty, ≤120 chars
  keywords: 'build make',            // optional, feeds palette fuzzy search, ≤200 chars
  hint: 'runs in the current tab',   // optional, display-only, ≤80 chars
  run: () => { /* sync or async */ } // required function
})
tm.unregisterCommand('build')
```

- Returns `boolean`: `false` on invalid input or over the cap (silent, doesn't break the script);
- the palette key is `code:my-tools:build`; users search `label` and `keywords`;
- re-registering the **same id overwrites** the old definition (the supported way to
  refresh labels/callbacks).

### Themes: dynamic registration

```ts
tm.registerTheme({
  id: 'midnight',        // local id; registered globally as my-tools/midnight
  name: 'Midnight',
  type: 'dark',
  ui: { bg: '#0b0d12' },
  terminal: { background: '#0b0d12', foreground: '#a9b1d6' }
})
tm.unregisterTheme('midnight')   // takes the local id
```

The data format is identical to [theme files](#theme-format-reference) (same validation);
registered themes appear immediately in the settings select of their side. Returns
`boolean`; invalid `name`/`type` rejects the whole theme, bad color fields drop
individually.

### Events: subscribing to app changes

```ts
const off = tm.on('tab-created', (e) => console.log(e.id, e.profileId))
off()   // unsubscribe (optional — everything is torn down on plugin removal anyway)
```

| Event | Payload | When |
| --- | --- | --- |
| `tab-created` | `{ id, profileId? }` | a tab was created |
| `tab-closed` | `{ id }` | a tab was closed |
| `tab-activated` | `{ id }` | active tab switched (incl. Ctrl+Tab) |
| `tab-renamed` | `{ id, title }` | tab renamed (incl. double-click rename) |
| `theme-changed` | `{ theme }` where `theme` is `dark`/`light`/`system` | theme tri-state switched |
| `scheme-changed` | `{ schemeId }` | active color scheme changed (either side) |

Throwing listeners are caught; the app and other listeners are unaffected.

### Tabs: query and operate

```ts
tm.tabs.list()      // TermInfo[]: { id, profileId, title, color?, pinned?, groupId? } (copies, mutate freely)
tm.tabs.active()    // active tab id (undefined when no tabs)
tm.tabs.activate(id)     // switch (silently ignored for unknown ids)
const info = await tm.tabs.create()            // new tab: default terminal (default profile → first available)
const info2 = await tm.tabs.create('my-tools:sh', '/tmp')  // explicit profile (global id) and cwd
```

`create` resolves to `Promise<TermInfo | undefined>` — `undefined` when the backend is
unavailable (e.g. tmux missing). Note `profileId` uses the **global id** form: your own
profiles are `pluginId:localId`; built-in/user profiles use their original ids.

### UI: same effects as the manifest action vocabulary

```ts
tm.ui.setTheme('dark')      // 'dark' | 'light' | 'system'
tm.ui.setScheme('my-tools/midnight')  // only ids present in the current theme list (builtin/global/packs/dynamic)
tm.ui.toggleSidebar()
tm.ui.openSettings()
```

`setScheme` lands on the dark or light settings side per the theme's `type`; unknown ids
are silently ignored.

### Terminals: reading output and writing input

```ts
// Read: subscribe to a tab's live output (from subscription time, no history replay;
// data is decoded text with multi-byte characters kept whole)
const off = tm.terminals.subscribe(tabId, (data) => {
  if (data.includes('DONE')) tm.statusbar.setItem('done', { text: '✓ DONE' })
})

// Write: inject input into a tab (straight to tmux, not the broadcast fan-out)
tm.terminals.write(tabId, 'make -j4\n')
```

`write` constraints (violations are **silently no-op**): `tabId` must exist in
`tabs.list()`; payload ≤ 16384 chars; empty strings are ignored.

> ⚠️ `write` can inject arbitrary shell commands into terminals — that is the v1
> capability surface, see [Security model](#security-model-read-before-installing).
> Declare what you write in your plugin's README.

### Status bar: the bottom strip

```ts
tm.statusbar.setItem('clock', { text: '⏳', color: '#a6e3a1', tooltip: 'current task', onClick: () => {} })
tm.statusbar.setItem('clock', null)   // remove the item
```

- `itemId`: `[A-Za-z0-9_-]{1,64}`; setting the **same id updates** it (the right way to
  refresh your status — doesn't accumulate against the cap);
- `text` required non-empty ≤200; `color`/`tooltip` optional (same formats as
  [theme colors](#theme-format-reference)); an `onClick` makes the item render clickable,
  and the app returns keyboard focus to the terminal after the click;
- the bottom status bar **renders only when at least one plugin item exists** — without
  plugin items the app looks exactly as before;
- tooltips are automatically prefixed with the plugin name, so users always see which
  plugin an item belongs to.

## Limits and validation rules summary

Per-plugin caps against pathological plugins (over-cap registrations silently return
`false` / no-op):

| Registration | Cap | Other constraints |
| --- | --- | --- |
| manifest profiles | 50 | — |
| manifest commands | 100 | — |
| manifest theme-pack files | 50 | — |
| `registerCommand` | 50 | label≤120 / keywords≤200 / hint≤80 |
| `registerTheme` | 20 | — |
| `statusbar.setItem` | 8 | text≤200 / tooltip≤200 |
| event listeners (`on`, across all events) | 64 | — |
| terminal data subscriptions (`subscribe`, across all tabs) | 32 | — |
| `terminals.write` per call | ≤ 16384 chars | target tab must exist |
| entry file | ≤ 1MB | `.js` / `.mjs` |

Character-set rules in one place:

| Identifier | Rule |
| --- | --- |
| plugin id (manifest) | `[a-z0-9-]{1,64}` |
| local ids (command/theme/statusbar/profile/theme filename) | `[A-Za-z0-9_-]{1,64}` |
| entry relative path | `^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}` with no `..` segment |
| `set-scheme` referenced id | `[A-Za-z0-9/_-]{1,80}` |

## Debugging guide

**Logs go to two places**:

| Log | Where | How to view |
| --- | --- | --- |
| manifest validation (`[plugins] …` / `[themes] …`), profile probing | main-process console | start the app from a terminal: `npx electron .` from source, `term-manager` installed |
| plugin script runtime (console.error, uncaught promises, load failures `[plugin-host] …`) | renderer console | use the Chromium debug channel: start with `term-manager --remote-debugging-port=9222` (`npx electron . --remote-debugging-port=9222` from source), then open `http://127.0.0.1:9222` in any Chromium browser and pick the page for DevTools (CDP is a separate debug channel, unaffected by the production CSP). `npm run dev` also works when developing from source |

> Watch the userData path: running from source (`npx electron .` or `npm run dev`) uses
> `~/.config/term-manager`; `npx electron out/main/index.js` uses `~/.config/Electron`
> (and the plugins directory follows). Debug plugins with the former so paths match the
> installed app.

**Symptom quick reference**:

| Symptom | Check |
| --- | --- |
| `termManager.init: unknown plugin id` | argument doesn't match the manifest `id`; or entry validation dropped the field (main-process `[plugins]` log: bad path / missing file / over 1MB) |
| script doesn't run, no error | no entry at all (purely declarative); or the `id@version` frame already exists — bump the version and retry; or network permissions are declared but not yet approved (the dialog may have gone unnoticed — reopening the palette/settings page re-prompts) |
| `[plugin-host] script load failed / in-frame error: tmplug://…` | wrong path; imported a non-whitelisted type (`.txt` etc.); import escaped the plugin folder; the `in-frame error` prefix forwards plugin runtime exceptions (with stack) |
| `registerCommand` returns false | id charset / empty label / over the per-plugin cap (see summary) |
| command not findable in the palette | type a more specific query first (the palette caps at 60 matches); confirm registration returned true |
| `terminals.write` does nothing | tab id not in `tabs.list()`; payload over 16KB; empty string |
| theme missing from the select | `name`/`type` missing or invalid — whole theme dropped (main-process `[themes]` log); or `type` doesn't match the select you're looking at |
| profile grayed out | `command` not found on PATH — use a more portable command name, or accept the graying |

**Reference implementation**: the e2e suites `--e2e-plugins` / `--e2e-code-plugins` (see
the README “E2E tests” section) ship good/broken plugin fixtures and assert most behaviors
described here — readable as an executable spec.

## Security model (read before installing)

The Tier 2 isolated-host trust model, in four sentences:

1. **Sandbox isolation is structural**: plugin frames are
   `sandbox="allow-scripts allow-same-origin"` and cross-origin to the UI (a unique
   `tmplug://` origin per plugin) — the DOM, `window.api` and the app's localStorage are
   all unreachable; only data and callback tokens cross the bridge. The `termManager`
   API is the **entire** capability surface.
2. **Zero network by default, declared opt-in**: each plugin frame carries its own CSP
   (`default-src 'none'`) whose `connect-src` contains only origins declared in the
   manifest *and* approved by you — the “phone home” path is closed at the browser
   layer, and changing the declaration re-prompts. The app page's own CSP stays
   `connect-src 'none'`.
3. **Writing to terminals = shell command injection**: `terminals.write` can silently
   inject input, and the shell itself has network access. Granting network permission
   and allowing terminal writes are two stacking grants of trust — only install code
   plugins you trust; as an author, state honestly in your README which origins you
   declare and what you write to terminals.
4. **Permission decisions are yours**: the approval dialog is a binary allow/deny
   (Esc = deny); denying does not disable the plugin (code runs, network does not).
   Decisions persist in `userData/plugin-permissions.json` and may be hand-edited
   (grants never exceed the declared list — undeclared origins are silently stripped).

## Known limitations and roadmap

- The palette shows at most 60 matching commands (may crowd out with many tabs — narrow
  the query) — existing interaction behavior;
- no enable toggle / plugin management UI (folder add/remove is the entire semantics;
  re-deciding permissions requires changing the declared list or hand-editing
  `plugin-permissions.json`);
- no plugin storage API (in-frame localStorage is isolated per plugin origin — enough
  for v1);
- the permission vocabulary currently covers network `connect` only; local file reads,
  system notifications etc. will be added on demand.

## Examples index

| Example | Contents |
| --- | --- |
| [`docs/examples/declarative-plugin/`](examples/declarative-plugin/) | declarative plugin: profiles + palette commands (launch/open-settings) + a theme pack, zero code |
| [`docs/examples/code-plugin/`](examples/code-plugin/) | code-level plugin: commands / dynamic theme / events / status bar (incl. clickable) across every API group |
| main README “Declarative plugins” / “Code-level plugins” sections | feature overview and security model |
