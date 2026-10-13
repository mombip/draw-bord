# Draw Board

Infinite whiteboard: TypeScript canvas frontend (Vite) + Node.js TypeScript backend that serves the app and stores the board. Same backend runs inside Electron.

```bash
npm install
npm run build && npm start   # browser: http://localhost:3000 (PORT, HOST, BOARD_FILE env vars)
npm run dev                  # Vite dev server with /api proxied to the backend
npm run electron             # desktop app (board in Electron userData/board.json)
npm run dist:electron        # package to release/ (AppImage / nsis / dmg)
npm run deploy              # static build to Netlify (board saved in browser localStorage)
npm test
```

| Action | Input |
|---|---|
| Pen / select / eraser | `P` / `V` / `E` or toolbar |
| Pen presets (color + thickness) | `1`–`6` or toolbar; custom color/width pickers |
| Erase (any tool) | right-click, or right-drag across objects: they grey out, release deletes. `Esc` cancels |
| Select | click, Shift+click, drag a marquee, `Ctrl+A` |
| Move / resize | drag selection / drag corner handle (Shift = free aspect) |
| Copy / cut / paste | `Ctrl+C` / `Ctrl+X` / `Ctrl+V` — pastes at the cursor, pasted objects stay selected |
| Paste image | `Ctrl+V` with an image on the clipboard |
| Delete | `Del` / `Backspace` |
| Save / Save as / Open file | `Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+O` or toolbar — saved as `.svg`, viewable anywhere. Open reads the drawing itself, so edits made in Inkscape etc. come back (paths/shapes → strokes, embedded images → images; text, clones and linked images are skipped). Old `.drawboard` files still open. Chromium & Electron write back to the same file; other browsers download a copy |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Zoom / pan | wheel or pinch / middle-drag, Space+drag, Shift+wheel |
