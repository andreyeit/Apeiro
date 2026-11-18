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
import 'apeiro/styles.css';
```

```tsx
// app/page.tsx
import { Board } from 'apeiro/react';

export default function Page() {
  return <Board style={{ height: '100vh' }} />;
}
```

Your own toolbar and saving:

```tsx
'use client';
import { Board, useBoard, useHistory, useTool } from 'apeiro/react';

export function Whiteboard({ saved }) {
  return (
    <Board style={{ height: '100vh' }} initialElements={saved} onChange={save}>
      <Toolbar />
    </Board>
  );
}

function Toolbar() {
  const board = useBoard();
  const [tool, setTool] = useTool();
  const { canUndo } = useHistory();
  return (
    <div style={{ position: 'absolute', left: 12, top: 12 }}>
      <button aria-pressed={tool === 'sticky'} onClick={() => setTool('sticky')}>
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
| `sync`            |                 | Shared board, see Collaboration   |

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
| `useSyncState()`                                           | Sync status                |
| `useBoardChange(fn)`, `useBoardEvent(event, fn)`           | Callbacks, no re-rendering |
| `useEditor()`                                              | `BoardEditor`              |

## Without React

```ts
import { BoardEditor } from 'apeiro';
import 'apeiro/styles.css';

const editor = new BoardEditor();
await editor.mount(document.getElementById('board')!);
editor.load(saved);
editor.on('selection', () => console.log(editor.selection));
// editor.getElements() to save, editor.destroy() to remove
```

## Collaboration

The sync is logic, the board is UI. Create a sync with `createSync` from `apeiro/sync`
(no React), and show it with `<Board sync={sync}>`.

```ts
// board-sync.ts
import { io } from 'socket.io-client';
import { createSync } from 'apeiro/sync';

const socket = io({ transports: ['websocket'] }); // one per tab

export const openBoard = (boardId: string, user: { name: string; color: string }) =>
  createSync({ socket, boardId, user });
```

```tsx
// Whiteboard.tsx
'use client';
import { useEffect, useState } from 'react';
import { Board, useSyncState } from 'apeiro/react';
import { openBoard } from './board-sync';

export function Whiteboard({ boardId, me }) {
  const [sync, setSync] = useState(null);
  useEffect(() => {
    const s = openBoard(boardId, me);
    setSync(s);
    return () => s.destroy();
  }, [boardId]);
  return (
    <Board style={{ height: '100vh' }} sync={sync}>
      <SyncStatus />
    </Board>
  );
}

function SyncStatus() {
  const state = useSyncState(); // { status, saving, readOnly, role, loaded, error }
  if (!state) return null;
  return <span>{state.status === 'offline' ? 'Offline' : state.saving ? 'Saving…' : 'Saved'}</span>;
}
```

The board is read-only until it arrives, and for viewers. Undo touches only this user's
edits; others' cursors and selections show on the board. Without React:
`const detach = sync.attach(editor)`.

Any Yjs provider (y-websocket, Hocuspocus…) instead of socket.io:

```ts
createSync({ doc, awareness: provider.awareness, user });
```

### Server

Events (payloads are Yjs bytes, `BOARD_EVENTS` in `apeiro/sync`):

| Event             | Payload                | Reply                                          |
| ----------------- | ---------------------- | ---------------------------------------------- |
| `board:join`      | `boardId, stateVector` | `{ update, stateVector, role }` or `{ error }` |
| `board:update`    | `boardId, update`      | `{ ok: true }` or `{ error }`                  |
| `board:awareness` | `boardId, update`      | Forward to the room                            |
| `board:leave`     | `boardId`              | Leave the room                                 |

```ts
import { Server } from 'socket.io';
import * as Y from 'yjs';

const io = new Server(3001);
const docs = new Map<string, Y.Doc>(); // load from and save to your database

const docOf = (id: string) => {
  if (!docs.has(id)) docs.set(id, new Y.Doc());
  return docs.get(id)!;
};

io.on('connection', (socket) => {
  socket.on('board:join', (boardId, stateVector, ack) => {
    // check access: ack({ error: "forbidden" })
    const doc = docOf(boardId);
    socket.join(boardId);
    ack({
      update: Y.encodeStateAsUpdate(doc, new Uint8Array(stateVector)),
      stateVector: Y.encodeStateVector(doc),
      role: 'edit', // "view": read-only
    });
  });
  socket.on('board:update', (boardId, update, ack) => {
    if (!socket.rooms.has(boardId)) return ack({ error: 'not joined' });
    const bytes = new Uint8Array(update);
    try {
      Y.applyUpdate(docOf(boardId), bytes);
    } catch {
      return ack({ error: 'invalid update' }); // the client loads the board anew
    }
    socket.to(boardId).emit('board:update', boardId, bytes);
    ack({ ok: true });
  });
  socket.on('board:awareness', (boardId, update) => {
    if (socket.rooms.has(boardId)) socket.to(boardId).emit('board:awareness', boardId, update);
  });
  socket.on('board:leave', (boardId) => socket.leave(boardId));
});
```

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
