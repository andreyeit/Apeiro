import {
  isConnector,
  isShape,
  Scene,
  validateElement,
  type BoardElement,
  type ConnectorEnd,
  type ElementPatch,
  type SceneChanges,
  type ShapeElement,
} from '@apeiro/core';
import { newId } from '../ids';

/**
 * Proposed changes to the board, e.g. what an AI assistant suggests: shown as a preview
 * that only this user sees until it is applied (`BoardEditor.showPreview`).
 */
export interface BoardDraft {
  /**
   * New elements. Their ids are their own: ones that clash with the board's get new ids
   * (connector ends and groups among them follow). Connectors may attach to the board's
   * existing shapes by id. Drawn above the board in the order of their `z`.
   */
  add?: readonly BoardElement[];
  /** Changes of existing elements (e.g. stickers rearranged into groups), by id. */
  update?: ReadonlyArray<{ id: string } & ElementPatch>;
  /** Ids of existing elements that would be deleted (outlined in red meanwhile). */
  remove?: readonly string[];
}

/** A draft checked against the board: what applying it does. */
export interface NormalizedDraft {
  /** New elements with the ids they will have and z above the board. */
  add: BoardElement[];
  /** Updates of elements that exist. */
  update: Array<{ id: string } & ElementPatch>;
  /** Existing elements to delete. */
  remove: string[];
}

/**
 * The draft against the board's current content: clashing ids renamed, z placed above
 * everything, updates and removals of missing elements dropped. Throws if an element
 * (new, or existing after its update) is invalid, naming it.
 */
export function normalizeDraft(scene: Scene, draft: BoardDraft): NormalizedDraft {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const el of draft.add ?? []) {
    const id = scene.has(el.id) || taken.has(el.id) ? newId(isConnector(el) ? 'c' : 's') : el.id;
    taken.add(id);
    if (!ids.has(el.id)) ids.set(el.id, id);
  }
  const groups = new Map<string, string>();
  const group = (g: string | undefined) => {
    if (g === undefined) return undefined;
    let id = groups.get(g);
    if (!id) groups.set(g, (id = newId('g')));
    return id;
  };
  const end = (e: ConnectorEnd): ConnectorEnd =>
    e.kind === 'element' && ids.has(e.id) ? { ...e, id: ids.get(e.id)! } : e;
  // New elements go above the board, keeping their order among themselves.
  const base = scene.size > 0 ? scene.maxZ() + 1 : 0;
  const add = [...(draft.add ?? [])]
    .sort((a, b) => a.z - b.z)
    .map((el, i): BoardElement => {
      const next: BoardElement = { ...el, id: ids.get(el.id)!, z: base + i };
      if (el.groupId !== undefined) next.groupId = group(el.groupId);
      if (isConnector(next)) {
        next.start = end(next.start);
        next.end = end(next.end);
      }
      return next;
    });
  for (const el of add) {
    const problem = validateElement(el);
    if (problem) throw new Error(`apeiro: draft element ${el.id}: ${problem}`);
  }
  const update = (draft.update ?? []).filter((u) => {
    const el = scene.get(u.id);
    if (!el) return false;
    const problem = validateElement({ ...el, ...u, id: el.id, type: el.type } as BoardElement);
    if (problem) throw new Error(`apeiro: draft update of ${u.id}: ${problem}`);
    return true;
  });
  const remove = [...new Set(draft.remove ?? [])].filter((id) => scene.has(id));
  return { add, update, remove };
}

/** A copy of a board shape that draws nothing but keeps its outline, for connectors to attach. */
function invisible(el: ShapeElement): ShapeElement {
  const copy: ShapeElement = {
    id: el.id,
    type: el.type === 'ellipse' || el.type === 'polygon' ? el.type : 'rect',
    x: el.x,
    y: el.y,
    w: el.w,
    h: el.h,
    rotation: el.rotation,
    z: el.z,
    fill: 0,
    stroke: 0,
    strokeWidth: 0,
    radius: el.radius,
  };
  if (el.sides !== undefined) copy.sides = el.sides;
  return copy;
}

/**
 * What the preview draws, as a scene of its own: the new elements, updated elements as they
 * would become, and invisible copies of the board's shapes that draft connectors attach to
 * (kept in step with the board, so those lines follow when someone moves the shapes).
 */
export class DraftScene {
  readonly scene = new Scene();
  /** Board shapes copied invisibly, for the draft's connectors. */
  private readonly anchors = new Set<string>();
  private readonly updated = new Map<string, ElementPatch>();

  constructor(
    private readonly board: Scene,
    readonly draft: NormalizedDraft,
  ) {
    const own = new Set(draft.add.map((el) => el.id));
    for (const u of draft.update) this.updated.set(u.id, u);
    for (const el of [...draft.add, ...draft.update.map((u) => board.get(u.id)!)]) {
      if (!isConnector(el)) continue;
      for (const e of [el.start, el.end])
        if (e.kind === 'element' && !own.has(e.id) && !this.updated.has(e.id))
          this.anchors.add(e.id);
    }
    this.scene.transact(() => {
      for (const id of this.anchors) {
        const el = board.get(id);
        if (el && isShape(el)) this.scene.add(invisible(el));
      }
      for (const [id, patch] of this.updated) this.scene.add(this.merged(id, patch)!);
      for (const el of draft.add) this.scene.add(el);
    }, 'load');
  }

  private merged(id: string, patch: ElementPatch): BoardElement | null {
    const el = this.board.get(id);
    return el ? ({ ...el, ...patch, id: el.id, type: el.type } as BoardElement) : null;
  }

  /** Follows changes of the board: shapes the draft attaches to or updates moved or went away. */
  boardChanged(changes: SceneChanges): void {
    const touched = new Set<string>();
    for (const el of changes.updated) touched.add(el.id);
    for (const el of changes.added) touched.add(el.id);
    for (const id of changes.removed) touched.add(id);
    this.scene.transact(() => {
      for (const id of touched) {
        const anchored = this.anchors.has(id);
        const patch = this.updated.get(id);
        if (!anchored && !patch) continue;
        const el = this.board.get(id);
        const next = !el
          ? null
          : patch
            ? this.merged(id, patch)
            : isShape(el)
              ? invisible(el)
              : null;
        // Replaced whole (one batch: an update for the renderer), so dropped fields go too.
        if (this.scene.has(id)) this.scene.remove(id);
        if (next) this.scene.add(next);
      }
    }, 'load');
  }
}
