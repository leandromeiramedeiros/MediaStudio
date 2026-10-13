# Media Studio

Local capture library + Nexus GIFs, image compression, tiny video editor, exporter. One static page (`index.html` + `app/`): offline, no server, no build, no AI.
When reporting to me, be extremely concise and sacrifice grammar for sake of concision.

## Invariants

- Library = the folder the user picks (File System Access API). Nothing is copied into it except exports, which go to `<library>/Exports` or a custom folder.
- Never overwrite: a name clash becomes `name (2).gif`.
- Every output goes through the Exporter queue (`MS.queue.add`), never written straight to disk. The queue survives reloads (IDB).
- Offline: no network, no CDN. Fonts are bundled in `app/fonts/`.
- `file://` rules (details in `app/CLAUDE.md`): classic scripts on `window.MS`, IIFEs, load order = `<script>` order in `index.html`; workers from Blob URLs; no OPFS, no ES modules, no `fetch()` of local files.
- No app data in the repo.

## Layout

- `index.html`: shell markup and every `<script>` in load order.
- `MediaStudio.vbs`: launcher (Chrome or Edge `--app`, own profile).
- `app/`: style, core, tabs, gif, video. Architecture and the `MS` API contract: `app/CLAUDE.md`.

## Run

- Double-click `MediaStudio.vbs`, or open `index.html` in Chrome or Edge.

## Check

- Open the page: no console errors. Reload after every JS edit (a hash-only navigation keeps old scripts).
- Test over http with any static server: OPFS only works there, not on `file://`.

## Pitfalls

- Folder permission is lost on restart (`MS.lib.status` = `denied`): re-grant needs a click (`MS.lib.reconnect()` inside a click handler).
- File pickers need a user gesture.
- A `type="module"` script or `import` fails silently on `file://`.
- Adding a file: add its `<script>` to `index.html` before `app/core/shell.js` (shell boots last).

## Git

Work on `main`. Push only when asked. Remote: private `leandromeiramedeiros/MediaStudio`.
