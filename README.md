# Draw Board

A whiteboard where your hand never leaves the drawing to visit a toolbar.

Most drawing apps make you switch tools for every small thing: pick the eraser, erase,
pick the pen again; grab the hand tool to move around; come back. Draw Board puts the
everyday actions on the mouse itself, so you can **draw, navigate and erase without
changing tools**:

| You want to | Do this |
|---|---|
| Draw | left-drag |
| Erase | right-click a stroke, or right-drag across strokes: they grey out, releasing deletes them (`Esc` cancels) |
| Draw a straight line | hold `Shift` while drawing: the pen snaps to the dot grid |
| Zoom | mouse wheel (pinch on a trackpad) |
| Move around | middle-drag, Space+drag or Shift+wheel; the canvas is infinite |
| Change pen | `1`–`6`: OneNote-style color + thickness presets |

Everything else is there when you need it: select and move/resize (`V`), copy/paste at
the cursor (`Ctrl+C`/`Ctrl+V`), paste images, undo (`Ctrl+Z`), and save/open (`Ctrl+S`/`Ctrl+O`)
as plain `.svg` files that open anywhere and can be edited in Inkscape and opened again.

Runs in the browser and as a desktop app (Electron); the board is saved automatically.

## Run

```bash
npm install
npm run build && npm start    # browser: http://localhost:3000
npm run electron              # desktop app
npm run dist:electron         # package the desktop app into release/
npm run deploy                # publish the web version to Netlify
npm test
```

## Acknowledgments

- Built together with [Claude](https://claude.ai) (Anthropic's Claude Opus 5.5 in [Claude Code](https://claude.com/claude-code)), which wrote most of the code from my requirements.
- [TypeScript](https://www.typescriptlang.org/), [Vite](https://vite.dev/) and [Node.js](https://nodejs.org/) for the app and its small backend.
- [Electron](https://www.electronjs.org/) and [electron-builder](https://www.electron.build/) for the desktop app.

