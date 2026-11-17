import type { ConnectorElement, ConnectorEnd } from '../connectors/types';
import { isConnector, type BoardElement } from '../elements/element';
import { validateElement } from '../elements/validation';
import type { Box, Vec2 } from '../geometry/math';
import { compareZ, type Scene } from './scene';
import { plainText } from '../text/text-block';

/** Elements copied from a board: plain JSON, safe to store, send or put on the system clipboard. */
export interface BoardClipboard {
  kind: 'apeiro/elements';
  version: 1;
  /** In paint order. Connector ends refer to copied shapes by their original ids. */
  elements: BoardElement[];
  /** World bounds of the copied elements when they were copied. */
  bounds: Box;
}

const KIND = 'apeiro/elements';

/**
 * Copies elements `ids` (and the connectors running between them) as clipboard data.
 * A connector end attached to a shape that isn't copied becomes a free end where it is
 * now, so the pasted line looks the same. Returns null if none of the ids exist.
 */
export function copyElements(scene: Scene, ids: Iterable<string>): BoardClipboard | null {
  const picked = new Set<string>();
  for (const id of ids) if (scene.has(id)) picked.add(id);
  if (picked.size === 0) return null;
  // Lines between copied shapes come along (duplicating a diagram keeps its arrows).
  for (const id of [...picked]) {
    for (const c of scene.connectorsOf(id)) {
      const el = scene.get(c);
      if (el && isConnector(el) && endIn(el.start, picked) && endIn(el.end, picked)) picked.add(c);
    }
  }
  const elements: BoardElement[] = [];
  for (const id of picked) {
    const el = scene.get(id)!;
    if (!isConnector(el)) {
      elements.push(structuredClone(el));
      continue;
    }
    const g = scene.connectorGeometry(id);
    const free = (end: ConnectorEnd, at: Vec2 | undefined): ConnectorEnd =>
      end.kind === 'element' && !picked.has(end.id) && at
        ? { kind: 'point', x: at.x, y: at.y }
        : end;
    elements.push(
      structuredClone({
        ...el,
        start: free(el.start, g?.points[0]),
        end: free(el.end, g?.points[g.points.length - 1]),
      }),
    );
  }
  elements.sort(compareZ);
  const bounds = scene.bounds(picked);
  if (!bounds) return null;
  return { kind: KIND, version: 1, elements, bounds };
}

const endIn = (end: ConnectorEnd, ids: ReadonlySet<string>) =>
  end.kind === 'element' && ids.has(end.id);

export interface PasteOptions {
  /** Moves the copy by this much (world units) from where it was copied. */
  offset?: Vec2;
  /** Centers the copy on this world point instead (wins over `offset`). */
  at?: Vec2;
  /** New element id; the default makes random ids. */
  newId?: (old: BoardElement) => string;
}

/**
 * Adds a copy of `data` to the scene, on top of everything, with new ids (connectors and
 * groups are rewired to the copies). Invalid elements are skipped. Returns the new ids.
 * One scene batch, so one undo step.
 */
export function pasteElements(
  scene: Scene,
  data: BoardClipboard,
  options: PasteOptions = {},
): string[] {
  const b = data.bounds;
  const delta = options.at
    ? { x: options.at.x - (b.minX + b.maxX) / 2, y: options.at.y - (b.minY + b.maxY) / 2 }
    : (options.offset ?? { x: 0, y: 0 });
  const makeId =
    options.newId ?? ((el: BoardElement) => randomId(el.type === 'connector' ? 'c' : 's'));

  const ids = new Map<string, string>();
  for (const el of data.elements) ids.set(el.id, makeId(el));
  // A group survives only if at least two of its members are pasted.
  const groupSizes = new Map<string, number>();
  for (const el of data.elements)
    if (el.groupId) groupSizes.set(el.groupId, (groupSizes.get(el.groupId) ?? 0) + 1);
  const groups = new Map<string, string>();
  const groupOf = (g: string | undefined) => {
    if (!g || (groupSizes.get(g) ?? 0) < 2) return undefined;
    let id = groups.get(g);
    if (!id) groups.set(g, (id = randomId('g')));
    return id;
  };
  const moveEnd = (end: ConnectorEnd): ConnectorEnd => {
    if (end.kind === 'point') return { kind: 'point', x: end.x + delta.x, y: end.y + delta.y };
    const id = ids.get(end.id);
    return id ? { ...end, id } : end;
  };

  const out: string[] = [];
  let z = scene.maxZ();
  scene.transact(() => {
    for (const src of data.elements) {
      const copy = structuredClone(src) as BoardElement;
      copy.id = ids.get(src.id)!;
      copy.z = ++z;
      const groupId = groupOf(src.groupId);
      if (groupId) copy.groupId = groupId;
      else delete copy.groupId;
      if (isConnector(copy)) {
        const c = copy as ConnectorElement;
        c.start = moveEnd(c.start);
        c.end = moveEnd(c.end);
      } else {
        copy.x += delta.x;
        copy.y += delta.y;
      }
      if (validateElement(copy) || scene.has(copy.id)) continue;
      scene.add(copy);
      out.push(copy.id);
    }
  });
  return out;
}

/** Copies the elements and adds the copy right away, moved by `offset`. Returns the new ids. */
export function duplicateElements(scene: Scene, ids: Iterable<string>, offset: Vec2): string[] {
  const data = copyElements(scene, ids);
  return data ? pasteElements(scene, data, { offset }) : [];
}

/** Whether `value` looks like clipboard data (e.g. parsed from the system clipboard). */
export function isBoardClipboard(value: unknown): value is BoardClipboard {
  const v = value as Partial<BoardClipboard> | null;
  return (
    !!v &&
    typeof v === 'object' &&
    v.kind === KIND &&
    v.version === 1 &&
    Array.isArray(v.elements) &&
    !!v.bounds &&
    [v.bounds.minX, v.bounds.minY, v.bounds.maxX, v.bounds.maxY].every(Number.isFinite)
  );
}

/** The text of the copied elements, one per line (what a text editor gets when pasted there). */
export function clipboardText(data: BoardClipboard): string {
  return data.elements
    .map((el) => ('text' in el && el.text ? plainText(el.text).trim() : ''))
    .filter(Boolean)
    .join('\n');
}

/** Clipboard data as HTML: other apps paste the text, boards read the data back. */
export function clipboardToHtml(data: BoardClipboard): string {
  const json = encodeURIComponent(JSON.stringify(data));
  const text = clipboardText(data)
    .split('\n')
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
  return `<meta charset="utf-8"><div data-apeiro="${json}">${text}</div>`;
}

/** Clipboard data embedded by `clipboardToHtml`, or null. */
export function clipboardFromHtml(html: string): BoardClipboard | null {
  const m = /data-apeiro="([^"]*)"/.exec(html);
  if (!m) return null;
  try {
    const data: unknown = JSON.parse(decodeURIComponent(m[1]!));
    return isBoardClipboard(data) ? data : null;
  } catch {
    return null;
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function randomId(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}
