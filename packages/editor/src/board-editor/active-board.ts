/**
 * Which board of the page keyboard and clipboard shortcuts go to: the one pressed last or,
 * before any press, the one under the pointer.
 */
const mounted = new Set<object>();
let active: object | null = null;

export const activeBoard = {
  mounted(board: object): () => void {
    mounted.add(board);
    return () => {
      mounted.delete(board);
      if (active === board) active = null;
    };
  },

  pressed(board: object): void {
    active = board;
  },

  /** Should `board` take a clipboard shortcut now? `pointerInside`: the pointer is over it. */
  accepts(board: object, pointerInside: boolean): boolean {
    return active === board || (active === null && pointerInside);
  },

  /**
   * Should `board` take a keyboard shortcut (Delete, undo, tool keys) now? Like `accepts`,
   * but a board alone on the page takes them even before it was pressed.
   */
  acceptsKeys(board: object, pointerInside: boolean): boolean {
    if (active !== null) return active === board;
    return pointerInside || (mounted.size === 1 && mounted.has(board));
  },
};
