# Google Drive integration — design

## Goal

Keep the board on Google Drive from the web version: it auto-syncs as you draw, so the same
board shows up in any browser you connect from, and you can save/open separate drawings on
Drive. One user, several devices. Web only; the Electron app keeps local files.

## Decisions

| Topic | Decision |
|---|---|
| Platforms | Web (Netlify and `npm start`). Drive UI hidden in Electron and when no client ID is configured. |
| Permission | `drive.file` only: the app sees just the files it created. No Google verification, no warning screen. |
| Sign-in | Google Identity Services token client in the page + plain `fetch` to Drive REST v3. No backend, no secret, no `gapi`. |
| Folder | Everything in `draw_board_files/` at the Drive root, created on first connect (reused if the app already created one). |
| Synced board | `draw_board_files/board.svg`, same SVG format as local saves (`toSvg` / `svgToObjects`). |
| Conflicts | Pull on focus, last write wins. Every replacement of the board goes through `edit()`, so Ctrl+Z restores what was replaced. |
| Open list | `.svg` files in `draw_board_files` that the app created, newest first; `board.svg` shown on top as "Synced board". |

## Behaviour

**Connect.** The ☁ toolbar button is grey when disconnected. Clicking it requests a token
(popup; needs the click as user activation). Browsers block the popup without a click, so each
new tab needs one click on ☁; that is the accepted cost of having no backend.

**Token expiry.** Tokens last ~1 h. When one is within 5 min of expiry, the next pointerdown
on the board requests a fresh one silently (`prompt: ''`). If a Drive call returns 401 anyway,
Drive goes to "disconnected", the status says `Drive: click ☁ to reconnect`, and the board
keeps saving to local storage; reconnecting pushes the current board.

**Auto-sync.** localStorage (or the Node backend) stays the working copy, unchanged. When
connected, `save()` also schedules an upload of `board.svg`, debounced so uploads are at least
2 s apart, chained on the existing `saving` promise so an older snapshot never overwrites a
newer one.

**Pull.** On connect and on window `focus`, fetch `board.svg` metadata. If its `version` is
not the one this tab last wrote or read, download it and replace the board via `edit()`.
On first connect only: if `board.svg` doesn't exist yet, upload the local board; if it
exists, the newer of (Drive `modifiedTime`, local last-change time kept in localStorage) wins.

**Save to Drive…** (☁ menu) asks for a name (`prompt`), creates `<name>.svg` in the folder,
and remembers it as the current file: Ctrl+S then writes back to that Drive file, like the
existing local file handle. Ctrl+Shift+S keeps meaning "Save as" (local). Opening or saving a
local file clears the Drive file binding and vice versa.

**Open from Drive…** shows a native `<dialog>` listing the files (name, modified date). Picking
one downloads it, parses it with `svgToObjects` (a parse error leaves the board untouched), and
replaces the board via `edit()`.

**Disconnect** revokes the token and goes back to local-only.

## Changes

- `src/drive.ts` (new): token client, `ensureFolder`, `list`, `download`, `create`, `update`
  (multipart upload), plus the pure helpers `newer(a, b)` and `multipart(meta, text)`.
- `src/main.ts`: ☁ button + menu, hooks in `save()`, `saveFile()`, `openFile()`, `focus`, pointerdown.
- `index.html`: ☁ button, `<dialog>` for the file list, CSP allowing
  `https://accounts.google.com/gsi/client` (script), `https://accounts.google.com` (frame, style),
  `https://www.googleapis.com` (connect).
- `.env`: `VITE_GOOGLE_CLIENT_ID=...` (a client ID is public; committed).
- `README.md`: "Google Drive" section with the Google Cloud setup: new project → enable Drive
  API → OAuth consent screen (External, Testing, add yourself as test user) → OAuth client ID
  (Web) with JavaScript origins `https://draw-board-mp.netlify.app`, `http://localhost:5173`,
  `http://localhost:3000`, `http://localhost:4173`.

## Testing

- `src/drive.test.ts` (node:test): `newer()` and `multipart()` body/boundary format.
- Manual, with a real account in the browser: connect → draw → `board.svg` updates in Drive;
  second tab edits → first tab refocused pulls it, Ctrl+Z restores; Save to Drive → Ctrl+S
  updates the same file; Open from Drive lists and opens; Disconnect; reconnect after a 401.

## Out of scope

Electron Drive support, Google Picker / files added to the folder by hand, conflict copies,
sharing, offline queueing beyond "push the current board on reconnect".
