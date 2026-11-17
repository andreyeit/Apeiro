import {
  Scene,
  textBlock,
  type ConnectorElement,
  type ShapeElement,
  type TextBlock,
} from '@apeiro/core';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bindScene, DEFAULT_MAP_NAME, YJS_ORIGIN } from './scene-binding';
import { YjsHistory } from './history';

const rect = (id: string, patch: Partial<ShapeElement> = {}): ShapeElement => ({
  id,
  type: 'rect',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0x000000ff,
  strokeWidth: 1,
  radius: 0,
  ...patch,
});

/** Two docs exchanging updates as a provider would; `pause` holds them back (offline). */
function connected() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  let online = true;
  const queue: Array<() => void> = [];
  const relay = (to: Y.Doc) => (update: Uint8Array, origin: unknown) => {
    if (origin === 'relay') return;
    const send = () => Y.applyUpdate(to, update, 'relay');
    if (online) send();
    else queue.push(send);
  };
  a.on('update', relay(b));
  b.on('update', relay(a));
  return {
    a,
    b,
    pause: () => (online = false),
    resume: () => {
      online = true;
      for (const send of queue.splice(0)) send();
    },
  };
}

function pair() {
  const net = connected();
  const sa = new Scene({ freeze: true });
  const sb = new Scene({ freeze: true });
  const ba = bindScene(sa, net.a);
  const bb = bindScene(sb, net.b);
  return { ...net, sa, sb, ba, bb };
}

const runs = (block: TextBlock | undefined) => block?.runs;

describe('SceneBinding', () => {
  it('copies added, updated and removed elements to the other scene', () => {
    const { sa, sb } = pair();
    sa.add(rect('r1', { x: 10 }));
    expect(sb.get('r1')).toMatchObject({ type: 'rect', x: 10 });
    sa.update('r1', { x: 50, fill: 0xff0000ff });
    expect(sb.get('r1')).toMatchObject({ x: 50, fill: 0xff0000ff });
    sa.remove('r1');
    expect(sb.has('r1')).toBe(false);
  });

  it('tags remote batches so the local history ignores them', () => {
    const { sa, sb } = pair();
    const origins: Array<string | undefined> = [];
    sb.subscribe((c) => origins.push(c.origin));
    sa.add(rect('r1'));
    expect(origins).toEqual([YJS_ORIGIN]);
  });

  it('merges concurrent edits of different fields of one element', () => {
    const { sa, sb, pause, resume } = pair();
    sa.add(rect('r1'));
    pause();
    sa.update('r1', { x: 200 });
    sb.update('r1', { fill: 0x00ff00ff });
    resume();
    for (const s of [sa, sb]) expect(s.get('r1')).toMatchObject({ x: 200, fill: 0x00ff00ff });
  });

  it('removes fields that were removed (e.g. leaving a group)', () => {
    const { sa, sb } = pair();
    sa.add(rect('r1', { groupId: 'g' }));
    expect(sb.groupMembers('g')).toEqual(['r1']);
    sa.update('r1', { groupId: undefined });
    expect(sb.get('r1')?.groupId).toBeUndefined();
    expect(sb.groupMembers('g')).toEqual([]);
  });

  it('syncs connectors and routes them against the synced shapes', () => {
    const { sa, sb } = pair();
    const c: ConnectorElement = {
      id: 'c1',
      type: 'connector',
      z: 2,
      start: { kind: 'element', id: 'r1' },
      end: { kind: 'element', id: 'r2' },
      route: 'straight',
      startCap: 'none',
      endCap: 'arrow',
      dash: 'solid',
      stroke: 0x000000ff,
      strokeWidth: 2,
    };
    sa.transact(() => {
      sa.add(c);
      sa.add(rect('r1'));
      sa.add(rect('r2', { x: 400 }));
    });
    expect(sb.connectorGeometry('c1')).not.toBeNull();
    expect(sb.connectorsOf('r2')).toEqual(['c1']);
  });

  it('keeps the text object when only geometry changes remotely (renderer caches by it)', () => {
    const { sa, sb } = pair();
    sa.add(rect('r1', { text: textBlock('hello') }));
    const before = (sb.get('r1') as ShapeElement).text;
    sa.update('r1', { x: 30 });
    expect((sb.get('r1') as ShapeElement).text).toBe(before);
  });

  it('merges concurrent typing in one text character by character', () => {
    const { sa, sb, pause, resume } = pair();
    sa.add(rect('r1', { text: textBlock('hello world') }));
    pause();
    const ta = (sa.get('r1') as ShapeElement).text!;
    const tb = (sb.get('r1') as ShapeElement).text!;
    sa.update('r1', { text: { ...ta, runs: [{ text: 'Hello world' }] } });
    sb.update('r1', { text: { ...tb, runs: [{ text: 'hello world!' }] } });
    resume();
    for (const s of [sa, sb])
      expect(runs((s.get('r1') as ShapeElement).text)).toEqual([{ text: 'Hello world!' }]);
  });

  it('syncs run formatting and block settings', () => {
    const { sa, sb } = pair();
    sa.add(rect('r1', { text: textBlock('bold plain') }));
    const t = (sa.get('r1') as ShapeElement).text!;
    sa.update('r1', {
      text: {
        ...t,
        align: 'left',
        runs: [{ text: 'bold', bold: true, color: 0xff0000ff }, { text: ' plain' }],
        paragraphs: [{ list: 'bullet' }],
      },
    });
    const got = (sb.get('r1') as ShapeElement).text!;
    expect(got.runs).toEqual([{ text: 'bold', bold: true, color: 0xff0000ff }, { text: ' plain' }]);
    expect(got.align).toBe('left');
    expect(got.paragraphs).toEqual([{ list: 'bullet' }]);
    // Removing the formatting again.
    sa.update('r1', { text: { ...t, runs: [{ text: 'bold plain' }] } });
    expect((sb.get('r1') as ShapeElement).text!.runs).toEqual([{ text: 'bold plain' }]);
  });

  it('does not let typed text inherit the formatting of its neighbour', () => {
    const { sa, sb } = pair();
    sa.add(rect('r1', { text: { ...textBlock(''), runs: [{ text: 'ab', bold: true }] } }));
    const t = (sa.get('r1') as ShapeElement).text!;
    sa.update('r1', { text: { ...t, runs: [{ text: 'ab', bold: true }, { text: 'c' }] } });
    expect((sb.get('r1') as ShapeElement).text!.runs).toEqual([
      { text: 'ab', bold: true },
      { text: 'c' },
    ]);
  });

  it('loads an existing doc into the scene, replacing its content', () => {
    const doc = new Y.Doc();
    const s1 = new Scene();
    bindScene(s1, doc);
    s1.add(rect('a'));
    const s2 = new Scene();
    s2.add(rect('local'));
    bindScene(s2, doc);
    expect([...s2.all()].map((e) => e.id)).toEqual(['a']);
  });

  it('writes the scene into an empty doc', () => {
    const doc = new Y.Doc();
    const s = new Scene();
    s.add(rect('a'));
    bindScene(s, doc);
    const map = doc.getMap(DEFAULT_MAP_NAME);
    expect((map.get('a') as Y.Map<unknown>).get('type')).toBe('rect');
  });

  it('skips invalid elements from the doc', () => {
    const doc = new Y.Doc();
    const onInvalid = vi.fn();
    const s = new Scene();
    bindScene(s, doc, { onInvalid });
    const bad = new Y.Map<unknown>();
    doc.getMap(DEFAULT_MAP_NAME).set('bad', bad);
    doc.transact(() => {
      for (const [k, v] of Object.entries(rect('bad', { w: Number.NaN })))
        if (k !== 'id') bad.set(k, v);
    });
    expect(s.has('bad')).toBe(false);
    expect(onInvalid).toHaveBeenCalled();
  });

  it('stops syncing after destroy', () => {
    const { sa, sb, ba } = pair();
    ba.destroy();
    sa.add(rect('r1'));
    expect(sb.has('r1')).toBe(false);
  });
});

describe('YjsHistory', () => {
  it("undoes only this user's change, keeping a concurrent edit of another field", () => {
    const { sa, sb, ba } = pair();
    const history = new YjsHistory(ba);
    sb.add(rect('r1'));
    sa.update('r1', { x: 300 });
    sb.update('r1', { fill: 0x00ff00ff });
    expect(history.canUndo).toBe(true);
    expect(history.undo()).toEqual(['r1']);
    for (const s of [sa, sb]) expect(s.get('r1')).toMatchObject({ x: 0, fill: 0x00ff00ff });
    history.redo();
    expect(sb.get('r1')).toMatchObject({ x: 300 });
  });

  it("never undoes someone else's element", () => {
    const { sa, sb, ba } = pair();
    const history = new YjsHistory(ba);
    sb.add(rect('theirs'));
    expect(history.canUndo).toBe(false);
    expect(history.undo()).toEqual([]);
    expect(sa.has('theirs')).toBe(true);
  });

  it('makes a group of batches one step, and separate batches separate steps', () => {
    const { sa, ba } = pair();
    const history = new YjsHistory(ba);
    sa.add(rect('r1'));
    history.beginGroup();
    for (let x = 1; x <= 5; x++) sa.update('r1', { x });
    history.endGroup();
    sa.update('r1', { y: 9 });
    history.undo();
    expect(sa.get('r1')).toMatchObject({ x: 5, y: 0 });
    history.undo();
    expect(sa.get('r1')).toMatchObject({ x: 0 });
    history.undo();
    expect(sa.has('r1')).toBe(false);
  });

  it('does not record batches with an origin (loading, animations)', () => {
    const { sa, ba } = pair();
    const history = new YjsHistory(ba);
    sa.transact(() => sa.add(rect('r1')), 'load');
    expect(history.canUndo).toBe(false);
  });

  it('notifies listeners when undo becomes possible', () => {
    const { sa, ba } = pair();
    const history = new YjsHistory(ba);
    const l = vi.fn();
    history.subscribe(l);
    sa.add(rect('r1'));
    expect(l).toHaveBeenCalled();
  });

  it('undoes typing without losing what someone else typed', () => {
    const { sa, sb, ba } = pair();
    const history = new YjsHistory(ba);
    sb.add(rect('r1', { text: textBlock('abc') }));
    const t = (sa.get('r1') as ShapeElement).text!;
    sa.update('r1', { text: { ...t, runs: [{ text: 'Xabc' }] } });
    const tb = (sb.get('r1') as ShapeElement).text!;
    sb.update('r1', { text: { ...tb, runs: [{ text: 'Xabc!' }] } });
    history.undo();
    for (const s of [sa, sb])
      expect(runs((s.get('r1') as ShapeElement).text)).toEqual([{ text: 'abc!' }]);
  });
});
