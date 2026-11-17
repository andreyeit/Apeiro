import { boxIntersects, type Box } from './math';

/** Cells are addressed in ±2^20 range per axis; packed into one safe integer key. */
const CELL_OFFSET = 1 << 20;
const CELL_SPAN = 1 << 21;
const cellKey = (cx: number, cy: number): number =>
  (cx + CELL_OFFSET) * CELL_SPAN + (cy + CELL_OFFSET);

interface CellRange {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Outside this range packed keys collide, and very large coordinates cannot be incremented. */
function canPack(range: CellRange): boolean {
  return (
    range.x0 >= -CELL_OFFSET &&
    range.y0 >= -CELL_OFFSET &&
    range.x1 < CELL_OFFSET &&
    range.y1 < CELL_OFFSET
  );
}

function validateBox(box: Box): void {
  if (
    !Number.isFinite(box.minX) ||
    !Number.isFinite(box.minY) ||
    !Number.isFinite(box.maxX) ||
    !Number.isFinite(box.maxY) ||
    box.minX > box.maxX ||
    box.minY > box.maxY
  )
    throw new RangeError('Bounds must be finite and ordered');
}

interface Entry {
  box: Box;
  /** Cell range the entry is registered in, or null if it lives in `large`. */
  cells: CellRange | null;
}

export interface SpatialIndexOptions {
  /** Cell size in world units. Should be close to a typical element size. */
  cellSize?: number;
  /** Entries spanning more cells than this go to a separate linear list. */
  maxCellsPerEntry?: number;
}

/**
 * Uniform grid hash. Chosen over an R-tree because board content is edited
 * constantly (drag = update every frame) and grid insert/remove is O(cells),
 * with no rebalancing. Very large elements are kept in a flat list so they
 * don't pollute thousands of cells.
 */
export class SpatialIndex<Id = string> {
  private readonly cellSize: number;
  private readonly maxCells: number;
  private cells = new Map<number, Set<Id>>();
  private entries = new Map<Id, Entry>();
  private large = new Set<Id>();

  constructor(options: SpatialIndexOptions = {}) {
    this.cellSize = options.cellSize ?? 256;
    this.maxCells = options.maxCellsPerEntry ?? 64;
    if (!Number.isFinite(this.cellSize) || this.cellSize <= 0)
      throw new RangeError('cellSize must be finite and positive');
    if (!Number.isSafeInteger(this.maxCells) || this.maxCells < 1)
      throw new RangeError('maxCellsPerEntry must be a positive safe integer');
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: Id): boolean {
    return this.entries.has(id);
  }

  getBox(id: Id): Box | undefined {
    return this.entries.get(id)?.box;
  }

  /** Inserts or moves an entry. */
  set(id: Id, box: Box): void {
    validateBox(box);
    const prev = this.entries.get(id);
    const range = this.cellRange(box);
    const isLarge =
      !canPack(range) || (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1) > this.maxCells;
    const nextCells = isLarge ? null : range;

    if (prev) {
      const same =
        (prev.cells === null && nextCells === null) ||
        (prev.cells !== null &&
          nextCells !== null &&
          prev.cells.x0 === nextCells.x0 &&
          prev.cells.y0 === nextCells.y0 &&
          prev.cells.x1 === nextCells.x1 &&
          prev.cells.y1 === nextCells.y1);
      if (same) {
        prev.box = box; // still in the same cells: cheap path for small moves
        return;
      }
      this.unregister(id, prev);
    }

    const entry: Entry = { box, cells: nextCells };
    this.entries.set(id, entry);
    if (nextCells === null) {
      this.large.add(id);
      return;
    }
    for (let cx = nextCells.x0; cx <= nextCells.x1; cx++) {
      for (let cy = nextCells.y0; cy <= nextCells.y1; cy++) {
        const key = cellKey(cx, cy);
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = new Set();
          this.cells.set(key, bucket);
        }
        bucket.add(id);
      }
    }
  }

  delete(id: Id): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.unregister(id, entry);
    this.entries.delete(id);
    return true;
  }

  clear(): void {
    this.cells.clear();
    this.entries.clear();
    this.large.clear();
  }

  /** Ids whose boxes intersect `box`. Each id is reported once. */
  query(box: Box): Id[] {
    validateBox(box);
    const out: Id[] = [];
    const range = this.cellRange(box);
    const cellCount = (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);

    if (!canPack(range) || cellCount > this.cells.size) {
      // Query covers more cells than exist (zoomed far out): scan entries instead.
      for (const [id, entry] of this.entries) if (boxIntersects(entry.box, box)) out.push(id);
      return out;
    }

    for (let cx = range.x0; cx <= range.x1; cx++) {
      for (let cy = range.y0; cy <= range.y1; cy++) {
        const bucket = this.cells.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const id of bucket) {
          const entry = this.entries.get(id)!;
          const c = entry.cells!; // bucketed entries always have cells
          // An entry sits in every cell of its range: report it only from the first cell that
          // range shares with the query, so it is reported once without a `seen` set.
          if (Math.max(c.x0, range.x0) !== cx || Math.max(c.y0, range.y0) !== cy) continue;
          if (boxIntersects(entry.box, box)) out.push(id);
        }
      }
    }
    for (const id of this.large) {
      if (boxIntersects(this.entries.get(id)!.box, box)) out.push(id);
    }
    return out;
  }

  queryPoint(x: number, y: number): Id[] {
    return this.query({ minX: x, minY: y, maxX: x, maxY: y });
  }

  private cellRange(box: Box) {
    const s = this.cellSize;
    return {
      x0: Math.floor(box.minX / s),
      y0: Math.floor(box.minY / s),
      x1: Math.floor(box.maxX / s),
      y1: Math.floor(box.maxY / s),
    };
  }

  private unregister(id: Id, entry: Entry): void {
    if (entry.cells === null) {
      this.large.delete(id);
      return;
    }
    const c = entry.cells;
    for (let cx = c.x0; cx <= c.x1; cx++) {
      for (let cy = c.y0; cy <= c.y1; cy++) {
        const key = cellKey(cx, cy);
        const bucket = this.cells.get(key);
        if (!bucket) continue;
        bucket.delete(id);
        if (bucket.size === 0) this.cells.delete(key);
      }
    }
  }
}
