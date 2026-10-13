# app/ conventions

Media Studio is one static page: `index.html` (repo root) opened from disk (`file://`) in Chrome or Edge, through
`MediaStudio.vbs` (an `--app` window). No server, no build step, no network, no Python. Everything runs in the page.

## Hard rules of `file://`

- **Classic scripts only.** ES modules, `import`, `fetch()` of local files and `new Worker('file.js')` are blocked on
  `file://`. Every file is a classic `<script src>` in `index.html` that attaches to the global `window.MS`, wrapped in an
  IIFE: `(() => { const { $, h } = MS.util; ... MS.thing = {...}; })();`. Load order is the `<script>` order in `index.html`.
- **Workers come from Blob URLs**: a script defines the worker body as a function, and the caller does
  `new Worker(URL.createObjectURL(new Blob(['(' + fn + ')()'], { type: 'text/javascript' })))`.
- **Files come from the File System Access API** (`showDirectoryPicker`, `showOpenFilePicker`, handles stored in IndexedDB).
  OPFS (`navigator.storage.getDirectory`) is NOT available on `file://`: never rely on it in app code.
- Media elements get `blob:` URLs (`URL.createObjectURL(file)`): same origin, so canvas reads are never tainted.
- Available and verified on `file://` in Chrome: IndexedDB (handles + Blobs), localStorage, `FileSystemObserver`,
  `VideoEncoder` (`avc1.640028` etc., `avc: {format: 'avc'}`), `AudioEncoder` (`mp4a.40.2` AAC and `opus`), `VideoDecoder`, `AudioDecoder`.
- Nothing loads from a CDN; fonts are bundled in `app/fonts/`.

## Layout

```
index.html               shell markup + every <script> in load order
MediaStudio.vbs          opens Chrome/Edge --app=file:///…/index.html with its own profile
app/style.css            the whole design system (ported from the old app: skins, tokens, motion kit)
app/fonts/ app/icon.svg app/icon.ico
app/core/util.js         MS.util
app/core/sfx.js          MS.sound
app/core/ui.js           MS.ui
app/core/db.js           MS.db
app/core/lib.js          MS.lib      (the library = the folder the user set; nothing is copied)
app/core/src.js          MS.src      (media refs: library items, external picks, pasted files)
app/core/queue.js        MS.queue    (the export queue; every tool hands its work to it)
app/gif/worker.js        MS.gifWorker (function: GIF encoder worker body)
app/gif/nexus.js         MS.nexus    (makeNexusGif, NEXUS limits)
app/video/mp4.js         MS.mp4      (MP4 demuxer + muxer)
app/video/render.js      MS.render   (editor project -> MP4 Blob with WebCodecs)
app/tabs/library.js      tab "library"
app/tabs/gif.js          tab "gif"
app/tabs/compress.js     tab "compress"
app/tabs/editor.js       tab "editor"
app/tabs/export.js       tab "export"
app/core/shell.js        header, tabs, keys, hotkey badges, settings, welcome screen; boots the app (loads LAST)
```

## Core API (the contract every tab codes against)

### MS.util
`$(sel, root)`, `$$(sel, root)` (array), `h(html)` (first element of an HTML string), `esc(s)`, `clamp(v, a, b)`,
`fmtTime(s)` (`m:ss.cc`), `fmtBytes(n)`, `baseName(path)`, `stem(name)` (no extension), `ext(name)` (lower, no dot),
`pref(key, fallback)` / `setPref(key, v)` (localStorage `ms.<key>`, JSON), `on(kind, fn)` -> off fn, `emit(kind, data)`,
`debounce(fn, ms)`, `sleep(ms)`, `uid()` (short unique id), `kindOf(name)` -> `'video'|'image'|'gif'|'audio'|null`
(video: mp4 mkv mov webm m4v avi; image: png jpg jpeg webp bmp avif; gif: gif; audio: mp3 wav flac ogg m4a aac opus).

### MS.sound(name)
Synth UI sounds (no files): tap tick on off open pop send receive notify success complete error cancel trash.
`MS.sound.isMuted()` / `MS.sound.setMuted(bool)`.

### MS.ui
`toast(msg, err, action?)` (action `{label, fn}`), `modal(title, bodyElOrHtml, buttons)` -> Promise (buttons
`{label, value?, get?, primary?, danger?}`), `confirmBox(title, text, okLabel, danger)`, `promptBox(title, label, value)` -> string|null,
`reduced()` (motion off), `collapse(el)`, `flash(el)`, `selection(container, itemSel, {onChange, key})` (Ctrl/Shift click, `all()`,
`clear()`, `keys`, `size`, `has`, `click(e, el)`), `zoomable(frame, target, opts)`, `mediaViewer(url, kind, opts)` -> element
(image/gif/video with zoom, pan, Fit, fullscreen; video gets its own control bar), `sortable(container, itemSel, onOrder(keys))` (keys = `data-k` or `data-id`; the container also gets a `reorder` event while dragging),
`seg(el, options [[label, value]], current, onPick)` (segmented control; sets `aria-pressed`), `progressBar()` -> `.pbar` el (`.bar > i` + caption) with `.set(frac|null, text)` (null = busy sheen),
`tile(ref|item, {onClick(e, el), caption, selected})` -> `.tile` element for a media ref or library item (thumb filled async, badge with duration / size, caption = name).

### MS.db (IndexedDB "mediastudio")
`get(key)`, `set(key, value)`, `del(key)`, `keys(prefix)` -> array: the `kv` store; values are structured-cloned
(handles and Blobs are fine). `thumbGet(key)` / `thumbSet(key, blob)`: the `thumbs` store. Extras: `thumbKeys(prefix)`, `thumbDel(key)`, `clear(keepKeys)` (wipes kv except the keys, and all thumbs). Keys in use are listed here:
`lib.dir` (library handle), `out.dir` (custom export folder handle), `src.<id>` (external/pasted refs), `queue` (export jobs),
`lib.seen` (fresh tracking), `gif.<libName>` (GIF tab state), `editor.projects` (list) and `editor.p.<id>` (projects), `compress.state`.

### MS.lib (the library = the chosen folder; nothing is ever copied into it except exports)
- `MS.lib.status`: `'none'` (no folder chosen) | `'denied'` (handle stored, permission must be re-granted with a click) | `'ready'`.
- `MS.lib.name` (folder name), `MS.lib.dir` (handle), `MS.lib.items` (newest first).
- `pick()` (folder picker, `mode: 'readwrite'`), `reconnect()` (re-grant; call from a click), `useHandle(dirHandle)` (also the test hook).
- Item: `{ id, name, path, kind, ext, size, mtime, handle, fresh, exported }` where `id` = `path` = relative path with `/`
  (`sub/clip.mp4`), `fresh` = arrived since the app last looked, `exported` = lives in the export folder.
- Scans subfolders (`pref('lib.depth', 3)`), skips dot-folders and files the browser cannot show. Watches with
  `FileSystemObserver` when present, else polls every 4 s while the page is visible, and rescans on focus.
  Emits `emit('library', { items, added, removed })`; a new capture also plays `notify` and toasts.
- `file(item)` -> Promise<File>, `url(item)` -> Promise<cached blob URL> (revoked when the file changes or goes away),
  `thumb(item)` -> Promise<url> (320 px JPEG cached in IDB by `id|size|mtime`; videos: a frame at 10 %),
  `meta(item)` -> Promise<{ w, h, dur }> (cached in memory).
- Extras: `init()`, `rescan()`, `useLibraryOut()`, `thumbBlob(file, kind)`, `metaOf(file, kind)`, `limit(fn)` (max 2 concurrent heavy reads), `saveSeen()`, `EXPORTS`, `outLabel`; events `library`, `libstatus`, `outdir`.
- Export folder: `outDir()` -> handle: `pref('out.mode', 'sub')` = `<library>/Exports` (created on first use) or `'custom'`
  (`out.dir` handle). `pickOut()`. `write(dirHandle, fileName, blob)` -> `{ name, size, handle }`, never overwrites
  (`name (2).gif`).

### MS.src (media refs: what a tool works on)
A ref is a plain cloneable object `{ ref, name, kind, size }` where `ref` is `'lib:<item id>'` or `'ext:<id>'`.
- `fromLib(item)` -> ref. `fromFiles(files|handles)` -> Promise<ref[]> (external file handles or pasted Blobs are stored in IDB
  `src.<id>` so a reload keeps them). `pick({ kinds, multiple })` -> Promise<ref[]> via `showOpenFilePicker` ("From disk").
- `choose({ title, kinds, multiple })` -> Promise<ref[]|null>: one modal with the library grid filtered by kinds, a
  "From disk…" button and a paste hint (Ctrl+V inside the modal adds pasted files). This is THE picker every tool uses.
- `file(ref)` -> Promise<File>, `url(ref)` -> Promise<blob url> (cached), `thumb(ref)` -> Promise<url>, `meta(ref)` -> Promise<{w,h,dur}>.
- `forget(ref)` drops an external ref. Extras: `item(ref)`, `isLib(ref)`, `filesOf(dataTransfer)` (media files of a paste/drop).
- Paste: the shell listens for `paste` and calls the active tab's `onPaste(files)`
  (images, and video files copied in Explorer). Tabs turn them into refs with `fromFiles`.

### MS.queue (the Exporter's engine)
- `runner(type, async (job, ctx) => ({ blob, ext, label }))` registers how a job type renders. `ctx.progress(frac, text)`,
  `ctx.check()` throws `'cancelled'` once cancelled, `ctx.signal.cancelled`. Types: `gif`, `image`, `video`.
- `add({ type, name, title, params, ref })` -> job. `params` must be structured-cloneable (refs, numbers, project JSON: no URLs, no elements).
  Job: `{ id, type, name, title, params, ref, status: 'queued'|'running'|'done'|'error'|'cancelled', progress, text,
  out: { file, size, label, dir }, error, at, ended }`.
- Runs one job at a time, automatically, in order; persisted in IDB (`queue`) so a reload keeps the queue (a job that was
  running when the page closed goes back to `queued`). `cancel(id)`, `retry(id)`, `remove(id)`, `clearDone()`, `jobs()`,
  `pause(bool)`. Writes the result with `MS.lib.write(await MS.lib.outDir(), name + '.' + ext, blob)`; file name from
  `pref('out.pattern', '{name}')` (tokens `{name}` `{date}` `{time}` `{type}`).
- Emits `emit('queue', job)` on every change (`job.removed` on removal, `null` = refresh). Extras: `init()`, `paused()`, `fileStem(job)`; `job.out.handle` = the written file's handle. Sounds: `complete`, `error`, `cancel`.

### MS.mp4 / MS.render (video engine; `mp4.js` must load before `render.js`; both work standalone)
- `MS.mp4.open(fileOrBlob)` -> `{ duration, tracks: [{ id, type, codec, description, width, height, sampleRate, channels, timescale, duration, samples: [{ offset, size, dts, cts, dur, key }] }] }`
  (seconds; reads only `moov` via `slice`; initial edit list applied, so captures that start on an earlier keyframe have negative `dts/cts` for the lead-in; fragmented MP4 throws).
  `read(file, sample)`, `readMany(file, samples)` (coalesced slices, order kept), `isMp4(file)` (sniffs the header).
  `muxer({ video: { codec, width, height, timescale? }, audio?: { codec, sampleRate, channels } })` -> `{ addVideo, addAudio, finish() -> Blob }` (faststart, interleaved ~1 s).
- `MS.render.project(project, { files, onProgress, signal, quality })` -> `{ blob, label, fps }` (`fps` = render speed in frames/s; `label` lists warnings such as skipped audio).
  `layout(project)` -> `{ clips: [{ c, start, d, xf }], total }`, `probe(file)` -> `{ dur, w, h, hasAudio }` (also images, audio).
  MP4/MOV sources use demuxer + `VideoDecoder`; anything else (or an unsupported codec) falls back to a hidden `<video>`. Audio mix is one `OfflineAudioContext` (RAM ~ 0.4 MB per second of project).

### Tabs: `MS.tab(def)`
`MS.tab` / `MS.tabs` (the registry) live in `util.js` because tab scripts load before `shell.js`, which defines `MS.go`. `mount(el)` runs once, then `show(arg)` on every visit (including the first, with `arg`).
`def = { id, label, icon (inner SVG markup, or a path `d`), order, mount(el), show(arg), hide(), onKey(e), keys: [{k, d}], claims: [keys],
hotkeys: [{sel, k}], onPaste(files) }`. `MS.go(id, arg)` switches tab (URL hash `#id`); `arg` passes work between tabs, e.g.
`MS.go('gif', { ref })`, `MS.go('compress', { refs })`, `MS.go('editor', { refs })`.
Tabs in order: Library (1), GIF (2), Compress (3), Editor (4), Export (5).
`keys` feed the `?` sheet; `claims` = keys the global handler leaves to the tab once the user engaged it (clicked/focused inside);
`hotkeys` = badges drawn when hotkey badges are on (`H`). `onKey` gets every keydown not taken by the shell; Ctrl+Enter reaches it
even while typing.

## Design

- Same look as the old app: skins `html[data-skin="neon|glass|classic"]` (Neon default), light/dark theme
  (`data-theme`), motion toggle (`data-motion`), sounds, hotkey badges. Components read CSS tokens only.
- Reuse the component classes: `page-head`, `split`, `card`, `grid`, `tile` (+ `badge`, `cap`, `scrub`, `cur`, `sel`, `msel`),
  `viewer`, `transport`, `timeline-mini`, `seg`, `list`, `item`, `bar`, `field`, `lab`, `input`, `check`, `empty`, `hint`, `lead`,
  `btn [primary|ghost|danger] [sm|lg]`, `pill`, `kbd`, spacing utilities (`mt-*`, `mb-*`, `gap-*`, `row`, `grow`, `small`, `dim`, `num`, `mono`).
  Inline styles only for data-driven values. Icons are inline SVG strokes (no emoji).
- Every long task shows progress (`MS.ui.progressBar`) and can be stopped.

## Shell notes (core/shell.js)

- Paste and window file drops both call `onPaste(files)`; dropped items are File System handles when the browser gives them
  (`getAsFileSystemHandle`), else `File`s; `MS.src.fromFiles` takes both.
- The welcome hero (no library / reconnect) covers every tab except Export; the tab mounts underneath and `show()` is called again when the library becomes ready.
- `MS.exportConfig(box)` (defined in `tabs/export.js`) draws destination + file-name rows; used by the Export tab and Settings > Export.
- Prefs in use: `tab`, `tabOrder`, `hk`, `set.tab`, `lib.depth`, `out.mode`, `out.pattern`, `queue.paused`. Skin/theme/motion are raw localStorage `ms.skin|theme|motion` (the inline script in `index.html` reads them before first paint).
- Header: `#libpill` (opens Settings > Library), `#qpill` (opens Export, shows count + progress), `#hk #motion #mute #theme #settings`.
