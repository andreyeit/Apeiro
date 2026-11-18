/**
 * apeiro: an infinite canvas board for the web (WebGPU with a WebGL2 fallback).
 *
 * - `apeiro`: the model (Scene, elements, History, Camera…), the renderer and the
 *   interactive `BoardEditor`, framework-free.
 * - `apeiro/react`: `<Board>` and hooks.
 * - `apeiro/yjs`: real-time collaboration through Yjs.
 * - `apeiro/styles.css`: styles of the board and its text editor (import once).
 */
export * from '@apeiro/core';
export * from '@apeiro/editor';
export { BoardRenderer, createRenderer } from '@apeiro/renderer';
export type {
  AudioWidgetStyle,
  BackendKind,
  CreateRendererOptions,
  GridStyle,
  RendererOptions,
  RenderStats,
} from '@apeiro/renderer';
