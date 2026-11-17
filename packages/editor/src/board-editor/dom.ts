/** The DOM of a mounted board, created by `createBoardDom`. */
export interface BoardDom {
  /** `.ap-board`: fills the container; carries the theme. */
  root: HTMLDivElement;
  /** `.ap-stage`: the canvases; receives pointer input. */
  stage: HTMLDivElement;
  /** The board, drawn by the GPU renderer. */
  canvas: HTMLCanvasElement;
  /** Between the board and the overlay: a draft being previewed (see `showPreview`). */
  previewCanvas: HTMLCanvasElement;
  /** Selection, handles, guides and cursors (2D). */
  overlayCanvas: HTMLCanvasElement;
  /** Holds the text editor's DOM over the board. */
  editorLayer: HTMLDivElement;
}

const div = (className: string): HTMLDivElement => {
  const el = document.createElement('div');
  el.className = className;
  return el;
};

const canvas = (className: string): HTMLCanvasElement => {
  const el = document.createElement('canvas');
  el.className = className;
  return el;
};

/** Builds the board's elements (see `styles.css`) and appends them to `container`. */
export function createBoardDom(
  container: HTMLElement,
  options: { theme: string; textToolbar: boolean },
): BoardDom {
  const root = div('ap-board');
  root.dataset.apTheme = options.theme;
  if (!options.textToolbar) root.dataset.apTextToolbar = 'off';
  const stage = div('ap-stage');
  const board = canvas('ap-canvas');
  const previewCanvas = canvas('ap-preview');
  previewCanvas.hidden = true;
  const overlayCanvas = canvas('ap-overlay');
  stage.append(board, previewCanvas, overlayCanvas);
  const editorLayer = div('ap-editor-layer');
  root.append(stage, editorLayer);
  container.append(root);
  return { root, stage, canvas: board, previewCanvas, overlayCanvas, editorLayer };
}

/**
 * Calls `onChange` when the device pixel ratio changes (the window moved to another
 * screen, or the page zoom changed): the CSS size stays the same, so a ResizeObserver
 * doesn't notice. Returns the function that stops watching.
 */
export function watchPixelRatio(onChange: () => void): () => void {
  let query: MediaQueryList | null = null;
  const onRatio = () => {
    onChange();
    watch();
  };
  const watch = () => {
    query?.removeEventListener('change', onRatio);
    query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener('change', onRatio);
  };
  watch();
  return () => query?.removeEventListener('change', onRatio);
}
