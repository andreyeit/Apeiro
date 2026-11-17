import {
  isConnector,
  validateElement,
  type BoardElement,
  type ElementPatch,
  type Scene,
  type SceneChanges,
} from '@apeiro/core';
import * as Y from 'yjs';
import { textBlockFromYMap, updateTextBlock, writeTextBlock } from './text-block';

/** Scene origin of the batches that apply changes received through Yjs. */
export const YJS_ORIGIN = 'yjs';

/** Default name of the Y.Map that holds the board's elements. */
export const DEFAULT_MAP_NAME = 'board';

export interface SceneBindingOptions {
  /**
   * Where the elements live: a Y.Map, or the name of a top-level map of the doc
   * (default `board`). Use different maps to keep several boards in one doc.
   */
  map?: Y.Map<unknown> | string;
  /**
   * What to do when binding a scene and a doc that both have elements:
   * `doc` (default) replaces the scene's content with the doc's; `scene` writes the scene's
   * elements into the doc. When only one side has elements, it is copied to the other.
   *
   * Bind once the provider has synced (e.g. y-websocket's `synced` event) if the scene has
   * content of its own: otherwise it is merged into the shared board.
   */
  prefer?: 'doc' | 'scene';
  /** An element received from the doc is invalid and was skipped. */
  onInvalid?: (id: string, problem: string) => void;
}

const ELEMENT_KEY_ID = 'id';

/**
 * Keeps a Scene and a Y.Map of elements in sync, both ways.
 *
 * Layout: `map[id]` is a Y.Map per element with one entry per field, so concurrent edits of
 * different fields of one element (one person moves a shape while another recolors it) both
 * survive. Element text is a nested Y.Map with a Y.Text (see `text.ts`), merged per
 * character. Other values (connector ends, pen points, media) are stored as plain JSON
 * and are last-writer-wins.
 *
 * Local scene batches are written to the doc in one Y transaction each, with `localOrigin`
 * for edits the user can undo (untagged batches) and `systemOrigin` for the rest; changes
 * from elsewhere are applied to the scene in one batch tagged `YJS_ORIGIN`.
 */
export class SceneBinding {
  readonly map: Y.Map<unknown>;
  readonly doc: Y.Doc;
  /** Y transaction origin of local user edits; an undo manager tracks only this origin. */
  readonly localOrigin = { binding: 'apeiro', kind: 'local' };
  /** Y transaction origin of local batches that are not user edits (loading, history of another kind…). */
  readonly systemOrigin = { binding: 'apeiro', kind: 'system' };
  private readonly unsubscribe: () => void;
  private readonly onInvalid: (id: string, problem: string) => void;
  private destroyed = false;

  constructor(
    readonly scene: Scene,
    doc: Y.Doc,
    options: SceneBindingOptions = {},
  ) {
    this.doc = doc;
    this.map =
      options.map instanceof Y.Map
        ? options.map
        : doc.getMap<unknown>(options.map ?? DEFAULT_MAP_NAME);
    this.onInvalid =
      options.onInvalid ??
      ((id, problem) => console.warn(`apeiro: skipped element ${id} from Yjs: ${problem}`));

    const docHas = this.map.size > 0;
    const sceneHas = !scene.all().next().done;
    if (docHas && (options.prefer !== 'scene' || !sceneHas)) this.loadFromDoc();
    else if (sceneHas) this.writeAll();

    this.map.observeDeep(this.onDocChange);
    const off = scene.subscribe(this.onSceneChange);
    this.unsubscribe = () => {
      off();
      this.map.unobserveDeep(this.onDocChange);
    };
  }

  /** Is this Y transaction origin one of the binding's own (local) writes? */
  isLocalOrigin(origin: unknown): boolean {
    return origin === this.localOrigin || origin === this.systemOrigin;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe();
  }

  // --- Scene → doc -----------------------------------------------------------------

  private readonly onSceneChange = (c: SceneChanges): void => {
    if (c.origin === YJS_ORIGIN) return;
    if (c.previous.size === 0 && c.removed.length === 0) return; // only re-routed connectors
    const origin = c.origin === undefined ? this.localOrigin : this.systemOrigin;
    this.doc.transact(() => {
      for (const id of c.removed) this.map.delete(id);
      for (const [id, before] of c.previous) {
        const el = this.scene.get(id);
        if (el) this.writeElement(el, before);
      }
    }, origin);
  };

  /** Writes every scene element into the doc (untracked). */
  private writeAll(): void {
    this.doc.transact(() => {
      for (const el of this.scene.all()) this.writeElement(el, undefined);
    }, this.systemOrigin);
  }

  private writeElement(el: BoardElement, before: BoardElement | undefined): void {
    let ymap = this.map.get(el.id);
    const fresh = !(ymap instanceof Y.Map) || ymap.get('type') !== el.type;
    if (fresh) {
      ymap = new Y.Map<unknown>();
      this.map.set(el.id, ymap);
    }
    const target = ymap as Y.Map<unknown>;
    const fields = el as unknown as Record<string, unknown>;
    const prev = (fresh ? undefined : before) as Record<string, unknown> | undefined;
    for (const key of Object.keys(fields)) {
      if (key === ELEMENT_KEY_ID) continue;
      const value = fields[key];
      if (prev && prev[key] === value) continue;
      if (key === 'text') {
        this.writeText(target, value);
        continue;
      }
      if (value === undefined) target.delete(key);
      else target.set(key, value);
    }
    if (prev) {
      for (const key of Object.keys(prev)) if (!(key in fields)) target.delete(key);
    } else if (!fresh) {
      // No previous state to compare with: drop fields the element no longer has.
      for (const key of [...target.keys()]) if (!(key in fields)) target.delete(key);
    }
  }

  private writeText(target: Y.Map<unknown>, block: unknown): void {
    if (!block) {
      target.delete('text');
      return;
    }
    const existing = target.get('text');
    if (existing instanceof Y.Map) {
      updateTextBlock(existing, block as Parameters<typeof updateTextBlock>[1]);
    } else {
      const tmap = new Y.Map<unknown>();
      target.set('text', tmap);
      writeTextBlock(tmap, block as Parameters<typeof writeTextBlock>[1]);
    }
  }

  // --- Doc → scene -----------------------------------------------------------------

  private readonly onDocChange = (
    events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
    tr: Y.Transaction,
  ): void => {
    if (this.isLocalOrigin(tr.origin)) return;
    const touched = new Set<string>();
    const textTouched = new Set<string>();
    for (const ev of events) {
      if (ev.target === this.map) {
        if (ev instanceof Y.YMapEvent) for (const key of ev.keysChanged) touched.add(key as string);
        continue;
      }
      const id = ev.path[0];
      if (typeof id !== 'string') continue;
      touched.add(id);
      if (ev.path.length > 1 && ev.path[1] === 'text') textTouched.add(id);
      else if (ev instanceof Y.YMapEvent && ev.keysChanged.has('text')) textTouched.add(id);
    }
    if (touched.size > 0) this.apply(touched, textTouched);
  };

  /** Element `id` as stored in the doc, reusing `current`'s text when it didn't change. */
  private readElement(
    id: string,
    ymap: Y.Map<unknown>,
    current: BoardElement | undefined,
    textChanged: boolean,
  ): BoardElement {
    const el: Record<string, unknown> = { id };
    for (const [key, value] of ymap.entries()) {
      if (key === 'text') {
        el.text =
          !textChanged && current && 'text' in current && current.text
            ? current.text
            : value instanceof Y.Map
              ? textBlockFromYMap(value)
              : undefined;
        if (el.text === undefined) delete el.text;
      } else el[key] = value;
    }
    return el as unknown as BoardElement;
  }

  private apply(ids: Iterable<string>, textTouched: ReadonlySet<string>): void {
    const scene = this.scene;
    const upserts: BoardElement[] = [];
    const removals: string[] = [];
    for (const id of ids) {
      const ymap = this.map.get(id);
      if (!(ymap instanceof Y.Map)) {
        if (scene.has(id)) removals.push(id);
        continue;
      }
      const current = scene.get(id);
      const el = this.readElement(id, ymap, current, textTouched.has(id) || !current);
      const problem = validateElement(el);
      if (problem) {
        this.onInvalid(id, problem);
        continue;
      }
      upserts.push(el);
    }
    // Shapes before connectors, so a connector finds the shapes it is attached to.
    upserts.sort((a, b) => Number(isConnector(a)) - Number(isConnector(b)));
    scene.transact(() => {
      for (const id of removals) scene.remove(id);
      for (const el of upserts) {
        const current = scene.get(el.id);
        if (!current) {
          scene.add(el);
        } else if (current.type !== el.type) {
          scene.remove(el.id);
          scene.add(el);
        } else {
          const patch: Record<string, unknown> = {};
          const next = el as unknown as Record<string, unknown>;
          const prev = current as unknown as Record<string, unknown>;
          let changed = false;
          for (const key of Object.keys(next)) {
            if (key === 'id' || key === 'type' || prev[key] === next[key]) continue;
            patch[key] = next[key];
            changed = true;
          }
          for (const key of Object.keys(prev)) {
            if (!(key in next) && prev[key] !== undefined) {
              patch[key] = undefined;
              changed = true;
            }
          }
          if (changed) scene.update(el.id, patch as ElementPatch);
        }
      }
    }, YJS_ORIGIN);
  }

  /** Replaces the scene's content with the doc's. */
  private loadFromDoc(): void {
    this.scene.transact(() => {
      this.scene.clear();
      this.apply([...this.map.keys()], new Set());
    }, YJS_ORIGIN);
  }
}

/** Binds `scene` to `doc` (see `SceneBinding`). Call `destroy()` on the result to stop. */
export function bindScene(scene: Scene, doc: Y.Doc, options?: SceneBindingOptions): SceneBinding {
  return new SceneBinding(scene, doc, options);
}
