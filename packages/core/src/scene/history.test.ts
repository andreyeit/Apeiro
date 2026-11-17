import { describe, expect, it } from 'vitest';
import type { ConnectorElement } from '../connectors';
import type { ShapeElement } from '../elements/element';
import { History } from './history';
import { Scene, type SceneChanges } from './scene';
import { makeRect } from '../test-utils';

const shape = (scene: Scene, id: string) => scene.get(id) as ShapeElement;

function link(id: string, from: string, to: string): ConnectorElement {
  return {
    id,
    type: 'connector',
    z: 10,
    start: { kind: 'element', id: from },
    end: { kind: 'element', id: to },
    route: 'straight',
    stroke: 0,
    strokeWidth: 2,
    dash: 'solid',
    startCap: 'none',
    endCap: 'arrow',
  };
}

describe('History', () => {
  it('undoes and redoes adds, updates and removals', () => {
    const scene = new Scene();
    const history = new History(scene);
    scene.add(makeRect('a'));
    scene.update('a', { x: 50 });
    scene.remove('a');
    expect(scene.has('a')).toBe(false);

    history.undo();
    expect(shape(scene, 'a').x).toBe(50);
    history.undo();
    expect(shape(scene, 'a').x).toBe(0);
    history.undo();
    expect(scene.has('a')).toBe(false);
    expect(history.canUndo).toBe(false);

    history.redo();
    history.redo();
    expect(shape(scene, 'a').x).toBe(50);
    history.redo();
    expect(scene.has('a')).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('records one step per batch', () => {
    const scene = new Scene();
    const history = new History(scene);
    scene.transact(() => {
      scene.add(makeRect('a'));
      scene.add(makeRect('b', { x: 200 }));
    });
    history.undo();
    expect(scene.size).toBe(0);
  });

  it('merges a gesture into one step and drops a group that changed nothing', () => {
    const scene = new Scene();
    scene.add(makeRect('a'));
    const history = new History(scene);
    history.beginGroup();
    for (let x = 1; x <= 20; x++) scene.update('a', { x });
    history.endGroup();
    history.undo();
    expect(shape(scene, 'a').x).toBe(0);
    expect(history.canUndo).toBe(false);

    history.redo();
    history.beginGroup(); // e.g. a drag cancelled with Esc: moved and put back
    scene.update('a', { x: 99 });
    scene.update('a', { x: 20 });
    history.endGroup();
    history.undo();
    expect(shape(scene, 'a').x).toBe(0); // the cancelled drag left no step behind
  });

  it('restores deleted shapes with their connectors and z order', () => {
    const scene = new Scene();
    scene.add(makeRect('a', { z: 1 }));
    scene.add(makeRect('b', { x: 300, z: 2 }));
    scene.add(link('c', 'a', 'b'));
    const history = new History(scene);
    scene.removeWithConnectors(['a']);
    expect(scene.has('c')).toBe(false);
    const ids = history.undo();
    expect(ids.sort()).toEqual(['a', 'c']);
    expect(scene.connectorGeometry('c')).not.toBeNull();
    expect(shape(scene, 'a').z).toBe(1);
  });

  it('reports z changes made by undo as a paint order change', () => {
    const scene = new Scene();
    scene.add(makeRect('a', { z: 1 }));
    const history = new History(scene);
    scene.update('a', { z: 5 });
    let last: SceneChanges | undefined;
    scene.subscribe((c) => (last = c));
    history.undo();
    expect(shape(scene, 'a').z).toBe(1);
    expect(last!.orderChanged).toBe(true);
    expect(last!.origin).toBe('history');
  });

  it('ignores tagged batches (remote edits, loading) and clears redo on a new edit', () => {
    const scene = new Scene();
    const history = new History(scene);
    scene.transact(() => scene.add(makeRect('remote')), 'remote');
    expect(history.canUndo).toBe(false);
    scene.add(makeRect('a'));
    history.undo();
    expect(history.canRedo).toBe(true);
    scene.add(makeRect('b'));
    expect(history.canRedo).toBe(false);
  });

  it('keeps optional fields exactly as they were', () => {
    const scene = new Scene();
    scene.add(link('c', 'a', 'b'));
    const history = new History(scene);
    scene.update('c', { curve: { along: 0, across: 0.3 } });
    history.undo();
    expect('curve' in scene.get('c')!).toBe(false);
  });

  it('notifies subscribers and respects the limit', () => {
    const scene = new Scene();
    const history = new History(scene, { limit: 3 });
    let calls = 0;
    history.subscribe(() => calls++);
    scene.add(makeRect('a'));
    for (let x = 1; x <= 5; x++) scene.update('a', { x });
    expect(calls).toBe(6);
    let steps = 0;
    while (history.canUndo) {
      history.undo();
      steps++;
    }
    expect(steps).toBe(3);
    expect(shape(scene, 'a').x).toBe(2);
  });
});
