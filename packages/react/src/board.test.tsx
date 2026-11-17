import type { BoardElement, ShapeElement } from '@apeiro/core';
import { BoardEditor } from '@apeiro/editor';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Board, BoardProvider } from './board';
import { useBoard } from './board-api';
import { useEditor } from './editor-context';
import { useHistory, useIsReadOnly } from './hooks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const box = (id: string, x = 0): ShapeElement => ({
  id,
  type: 'rect',
  x,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
});

/** Flushes microtasks (onChange is reported in one) and timers of effects. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('<BoardProvider> and <Board>', () => {
  let container: HTMLElement;
  let root: Root;
  const render = (node: ReactNode) => act(() => root.render(node));

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('the provider owns the board: initial content, live readOnly and onChange', async () => {
    let editor: BoardEditor | null = null;
    let readOnly: boolean | null = null;
    function Probe() {
      editor = useEditor();
      readOnly = useIsReadOnly();
      return null;
    }
    const onChange = vi.fn<(elements: BoardElement[]) => void>();
    const tree = (ro: boolean) => (
      <BoardProvider initialElements={[box('a')]} readOnly={ro} onChange={onChange}>
        <Probe />
      </BoardProvider>
    );
    render(tree(false));
    expect(editor!.scene.has('a')).toBe(true);
    expect(onChange).not.toHaveBeenCalled(); // not for the initial content

    act(() => editor!.addElements([box('b', 200)]));
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].map((el) => el.id)).toEqual(['a', 'b']);

    render(tree(true));
    expect(readOnly).toBe(true);
    expect(editor!.readOnly).toBe(true);
  });

  it('<Board> on its own is a provider too; a failed start goes to onError', async () => {
    const onError = vi.fn();
    let found: BoardEditor | null = null;
    function Probe() {
      found = useEditor();
      return null;
    }
    render(
      <Board initialElements={[box('a')]} onError={onError}>
        <Probe />
      </Board>,
    );
    await settle();
    // happy-dom has neither WebGPU nor WebGL2: the renderer can't start.
    expect(onError).toHaveBeenCalled();
    // Children render in the browser only, over the board, with its editor.
    expect(found!.scene.has('a')).toBe(true);
  });

  it('<Board> under a provider shows the provider’s board and warns about settings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onError = vi.fn();
    const editor = new BoardEditor();
    render(
      <BoardProvider editor={editor} onError={onError}>
        <Board grid="dots" style={{ height: 100 }} />
      </BoardProvider>,
    );
    await settle();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('<Board grid>'));
    expect(onError).toHaveBeenCalled(); // the canvas reports to the provider
    editor.destroy();
  });

  it('commands are stable and never re-render', () => {
    const seen: Array<ReturnType<typeof useBoard>> = [];
    const undos: Array<() => void> = [];
    let editor: BoardEditor | null = null;
    function Probe() {
      seen.push(useBoard());
      undos.push(useHistory().undo);
      editor = useEditor();
      return null;
    }
    render(
      <BoardProvider>
        <Probe />
      </BoardProvider>,
    );
    const board = seen[0]!;
    act(() => board.elements.add([box('a'), box('b', 200)]));
    act(() => board.elements.remove(['a']));
    expect(editor!.scene.has('a')).toBe(false);
    expect(editor!.selection).toEqual(['b']);
    act(() => board.history.undo());
    expect(editor!.scene.has('a')).toBe(true);
    expect(new Set(seen).size).toBe(1);
    expect(new Set(undos).size).toBe(1);
  });
});
