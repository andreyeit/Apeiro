# Apeiro

An infinite canvas whiteboard for the web on WebGPU/WebGL2: sticky notes, shapes,
connectors, text, pen, images, undo/redo. React bindings and collaboration over Yjs or
Socket.IO.

## Install

```sh
npm install apeiro
npm install yjs y-protocols   # only for collaboration
```

## Quick start

```tsx
// app/layout.tsx
import "apeiro/styles.css";
```

```tsx
// app/page.tsx
import { Board } from "apeiro/react";

export default function Page() {
  return <Board style={{ height: "100vh" }} />;
}
```

Your own toolbar and saving:

```tsx
"use client";
import { Board, useBoard, useHistory, useTool } from "apeiro/react";

export function Whiteboard({ saved }) {
  return (
    <Board style={{ height: "100vh" }} initialElements={saved} onChange={save}>
      <Toolbar />
    </Board>
  );
}

function Toolbar() {
  const board = useBoard();
  const [tool, setTool] = useTool();
  const { canUndo } = useHistory();
  return (
    <div style={{ position: "absolute", left: 12, top: 12 }}>
      <button
        aria-pressed={tool === "sticky"}
        onClick={() => setTool("sticky")}
      >
        Sticky
      </button>
      <button disabled={!canUndo} onClick={board.history.undo}>
        Undo
      </button>
    </div>
  );
}
```

Children of `<Board>` are drawn over the canvas.

## Components

- `<Board>` — the canvas.
- `<BoardProvider>` — for UI outside the canvas:

```tsx
<BoardProvider initialElements={saved} onChange={save}>
  <Sidebar />
  <Board style={{ flex: 1 }} />
</BoardProvider>
```

Settings (`<Board>` or `<BoardProvider>`):

| Setting           | Default         |                                   |
| ----------------- | --------------- | --------------------------------- |
| `initialElements` |                 | Initial content                   |
| `onChange`        |                 | `(elements, changes) => void`     |
| `theme`           | `'light'`       | `'light'`, `'dark'`, `'system'`   |
| `readOnly`        | `false`         | View only                         |
| `onError`         | `console.error` | No WebGPU/WebGL2, or a file error |
| `grid`            | `'lines'`       | `'lines'`, `'dots'`, `'none'`     |
| `labels`          | English         | UI texts, e.g. `RU_LABELS`        |
| `upload`          | object URLs     | `(file) => Promise<url>`          |

## Commands

`useBoard()`:

| Group       | Commands                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------- |
| `tools`     | `activate(tool, { repeat })`, `setDefaults(kind, style)`, `register(name, customTool)`        |
| `selection` | `set`, `clear`, `all`, `update(patch)`, `delete`, `reorder('front')`, `group`, `ungroup`      |
| `elements`  | `create(kind, { at })`, `createText`, `add`, `addFiles`, `update`, `remove`, `load`, `getAll` |
| `text`      | `edit(id)`, `stop()`                                                                          |
| `history`   | `undo`, `redo`, `batch(fn)`                                                                   |
| `camera`    | `zoomTo('in' \| 'out' \| 'fit' \| 'selection' \| 'reset' \| zoom)`                            |
| `clipboard` | `copy`, `cut`, `paste`, `duplicate`                                                           |
| `preview`   | `show(draft)`, `apply`, `discard`                                                             |
|             | `exportImage({ scale, ids, area })` → PNG `Blob`                                              |

## Hooks

| Hook                                                       | Returns                    |
| ---------------------------------------------------------- | -------------------------- |
| `useBoardState((b) => …)`                                  | Any state                  |
| `useTool()`, `useBoardTheme()`                             | `[value, setValue]`        |
| `useSelectedIds()`, `useSelectedElements()`                | Selection                  |
| `useElement(id)`, `useElementCount()`                      | Content                    |
| `useHistory()`, `useClipboard()`, `usePreview()`           | State and actions          |
| `useZoom()`, `useCamera()`                                 | Zoom and camera            |
| `useSelectionScreenBounds()`, `useElementScreenBounds(id)` | Boxes on screen            |
| `usePeers()`, `useLockedBy(id)`                            | Participants               |
| `useBoardChange(fn)`, `useBoardEvent(event, fn)`           | Callbacks, no re-rendering |
| `useEditor()`                                              | `BoardEditor`              |

## Without React

```ts
import { BoardEditor } from "apeiro";
import "apeiro/styles.css";

const editor = new BoardEditor();
await editor.mount(document.getElementById("board")!);
editor.load(saved);
editor.on("selection", () => console.log(editor.selection));
// editor.getElements() to save, editor.destroy() to remove
```

## Collaboration

### Socket.IO

```tsx
import { io } from "socket.io-client";
import { useSocketSync } from "apeiro/yjs/react";

const socket = io();

function Sync({ boardId }) {
  const { status, saving } = useSocketSync(socket, boardId, {
    user: { name: "Ann", color: "#e11d48" },
  });
  return (
    <span>
      {status === "offline" ? "Offline" : saving ? "Saving…" : "Saved"}
    </span>
  );
}

<Board>
  <Sync boardId="b1" />
</Board>;
```

Without React: `syncBoard(editor, socket, boardId, options)` from `apeiro/yjs`.

Server events (payloads are Yjs bytes):

| Event             | Payload                | Reply                                          |
| ----------------- | ---------------------- | ---------------------------------------------- |
| `board:join`      | `boardId, stateVector` | `{ update, stateVector, role }` or `{ error }` |
| `board:update`    | `boardId, update`      | `{ ok: true }` or `{ error }`                  |
| `board:awareness` | `boardId, update`      | Forward to the room                            |
| `board:leave`     | `boardId`              | Leave the room                                 |

`update` in the `board:join` reply is `Y.encodeStateAsUpdate(serverDoc, stateVector)`;
`role: 'view'` makes a viewer. The server saves a `board:update` and sends it to the room.

### Any Yjs provider

```tsx
import { useCollaboration } from "apeiro/yjs/react";

useCollaboration(doc, { awareness: provider.awareness, user });
```

Without React: `collaborate(editor, doc, { awareness, user })`.

## Data

A board is an array of `BoardElement`: shapes (`rect`, `ellipse`, `polygon`, `sticky`,
`text`, `image`, `audio`, `ink`) and `connector`. Fields: `x, y, w, h, rotation, z`; colors
are `0xRRGGBBAA` (`hexColor('#ff0000')`).

## Styling

CSS custom properties on `.ap-board`: `--ap-accent`, `--ap-surface`, `--ap-foreground`,
`--ap-border`, `--ap-muted`, `--ap-font`, `--ap-radius-sm`, `--ap-radius-md`, `--ap-shadow`.

## Fonts

Board text can use Geist (the default), Inter, PT Serif, JetBrains Mono and Caveat
(`FONT_FAMILIES`); the text toolbar offers all of them. Load the font files yourself
(`@font-face`, e.g. from Google Fonts), otherwise the system fallbacks are drawn.
`--ap-font` is the font of the board's own UI, not of its text.
