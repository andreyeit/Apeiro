import type { ShapeElement } from '@apeiro/core';
import { BoardEditor } from '@apeiro/editor';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardProvider } from './board';
import { useBoard } from './board-api';
import {
  shallowEqual,
  useBoardState,
  useElement,
  useElementCount,
  useHistory,
  useSelectedIds,
  useTool,
} from './hooks';

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

describe('React hooks', () => {
  let editor: BoardEditor;
  let container: HTMLElement;
  let root: Root;

  const render = (node: ReactNode) =>
    act(() => root.render(<BoardProvider editor={editor}>{node}</BoardProvider>));

  beforeEach(() => {
    editor = new BoardEditor();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    editor.destroy();
  });

  it('follow the tool, the selection and the element count', () => {
    const seen: string[] = [];
    function Probe() {
      const [tool] = useTool();
      const ids = useSelectedIds();
      const count = useElementCount();
      seen.push(`${tool}:${ids.join(',')}:${count}`);
      return null;
    }
    render(<Probe />);
    act(() => editor.setTool('rect'));
    act(() => editor.addElements([box('a'), box('b', 200)]));
    act(() => editor.select(['b']));
    expect(seen.at(-1)).toBe('rect:b:2');
  });

  it('re-render a component only when what it picked changes', () => {
    let renders = 0;
    function Probe() {
      renders++;
      useElement('a');
      return null;
    }
    editor.addElements([box('a'), box('b', 200)], { select: false });
    render(<Probe />);
    const before = renders;
    act(() => editor.updateElements(['b'], { x: 500 })); // another element
    expect(renders).toBe(before);
    act(() => editor.updateElements(['a'], { x: 50 }));
    expect(renders).toBe(before + 1);
  });

  it('useBoardState tracks what the selector reads', () => {
    const values: number[] = [];
    function Probe() {
      values.push(useBoardState((b) => b.view.zoom));
      return null;
    }
    render(<Probe />);
    act(() => editor.select([])); // not read by the selector
    expect(values).toHaveLength(1);
    act(() => editor.camera.set({ zoom: 2 }));
    expect(values.at(-1)).toBe(2);
  });

  it('useHistory and useBoard drive undo', () => {
    let api: ReturnType<typeof useBoard> | null = null;
    let canUndo = false;
    function Probe() {
      api = useBoard();
      canUndo = useHistory().canUndo;
      return null;
    }
    render(<Probe />);
    expect(canUndo).toBe(false);
    act(() => editor.addElements([box('a')]));
    expect(canUndo).toBe(true);
    act(() => api!.history.undo());
    expect(editor.scene.has('a')).toBe(false);
  });
});

describe('shallowEqual', () => {
  it('compares arrays and plain objects item by item', () => {
    expect(shallowEqual([1, 'a'], [1, 'a'])).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(shallowEqual([{}], [{}])).toBe(false);
  });
});
