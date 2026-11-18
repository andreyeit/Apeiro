// Compiled against a copy of the built package, without workspace aliases.
import { BoardEditor, Scene, rgba, type BoardElement, type SyncState } from 'apeiro';
import {
  Board,
  BoardProvider,
  useEditor,
  useElement,
  useBoard,
  useBoardState,
  useHistory,
  useSyncState,
  type BoardApi,
  type BoardProps,
  type BoardProviderProps,
} from 'apeiro/react';
import {
  BOARD_EVENTS,
  createSync,
  type BoardJoinReply,
  type BoardSocket,
  type BoardUpdateReply,
  type YjsBoardSync,
} from 'apeiro/sync';
import type * as Y from 'yjs';

const element: BoardElement = {
  id: 'example',
  type: 'rect',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  z: 0,
  fill: rgba(255, 255, 255),
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
};
const editor = new BoardEditor({ scene: new Scene() });
editor.load([element]);

const props: BoardProviderProps = {
  initialElements: [element],
  onChange(elements, changes) {
    localStorage.setItem('board-example', JSON.stringify({ elements, changes }));
  },
};

export function SharedBoard({ sync }: { sync: YjsBoardSync }) {
  return (
    <BoardProvider editor={editor} sync={sync} {...props}>
      <Board style={{ height: 400 }}>
        <Status />
      </Board>
    </BoardProvider>
  );
}

export function ComposedBoard() {
  return (
    <BoardProvider initialElements={[element]} theme="system">
      <Toolbar />
      <Board style={{ height: 400 }} fallback="Loading…" />
    </BoardProvider>
  );
}

export function StandaloneBoard(props: BoardProps) {
  return <Board {...props} theme="dark" onReady={(e) => e.zoomTo('fit')} />;
}

function Toolbar() {
  const board: BoardApi = useBoard();
  const { canUndo } = useHistory();
  void board.exportImage({ scale: 1 });
  board.elements.remove(['example']);
  const tool = useBoardState((state) => state.tool);
  board.tools.getDefaults('rect');
  return (
    <button
      disabled={!canUndo}
      aria-pressed={tool === 'rect'}
      onClick={() => {
        board.tools.setDefaults('rect', { fill: rgba(255, 0, 0) });
        board.tools.activate('rect', { repeat: true });
      }}
    >
      Rectangle
    </button>
  );
}

function Status() {
  const board = useEditor();
  const element = useElement('example');
  const state: SyncState | null = useSyncState();
  return (
    <span>
      {state?.status}: {element?.id} ({board.scene.size})
    </span>
  );
}

export function openBoard(socket: BoardSocket): YjsBoardSync {
  return createSync({
    socket,
    boardId: 'example',
    user: { name: 'Ann', color: '#e11d48' },
    events: { join: 'board:sync' },
    initialContent: 'discard',
  });
}

export function openDoc(doc: Y.Doc): YjsBoardSync {
  return createSync({ doc, awareness: null, lock: false });
}

export function connect(socket: BoardSocket) {
  const sync = openBoard(socket);
  const detach = sync.attach(editor);
  const off = sync.subscribe(() => console.log(sync.getState().status, sync.doc.clientID));
  const replies: [BoardJoinReply, BoardUpdateReply] = [
    { update: new Uint8Array(), role: 'view' },
    { error: 'limit' },
  ];
  console.log(BOARD_EVENTS.join, replies.length);
  return () => {
    off();
    detach();
    sync.destroy();
  };
}
