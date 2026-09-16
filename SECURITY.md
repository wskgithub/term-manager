# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| latest `master` / 0.1.x | ✅ |
| anything older | ❌ |

There are no stable tagged releases yet; fixes land on `master` and are shipped with the
next deb build.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting**:

1. Open <https://github.com/wskgithub/term-manager/security/advisories/new>
   (or repo page → *Security* tab → *Report a vulnerability*).

This keeps the report private to the maintainer and allows coordinating a fix and a
GitHub security advisory / CVE before public disclosure. Please do **not** open a public
issue for security problems.

When reporting, ideally include: affected component (main process, renderer, tmux control
protocol, packaging scripts), reproduction steps, and impact assessment.

### Scope notes

The audit-relevant attack surface of this project:

- **Process/command execution**: all subprocess calls (tmux spawn, `xprop`, `fc-list`)
  use argument-array form without a shell and without string concatenation.
- **tmux control protocol**: output payloads are treated as untrusted data; the pane→
  control-frame trust boundary relies on tmux's mandatory octagonal escaping of newlines
  in `%output` payloads.
- **Profile/config files** (`profiles.json`, `settings.json`) are field-validated before
  use; malformed entries are dropped with a console warning rather than reaching the
  command assembly layer.
- **Electron hardening**: `sandbox: true` on the renderer, `contextBridge`-only preload,
  `setWindowOpenHandler` restricts `openExternal` to http/https.

Out of scope: vulnerabilities in Electron/Chromium itself (report upstream), and
compromise of the user's own shell environment inside a terminal.
