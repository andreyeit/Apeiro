import { hexColor } from '@apeiro/core';
import type { AudioWidgetStyle } from '@apeiro/renderer';

export type BoardThemeName = 'light' | 'dark';

/**
 * Colors drawn in place of stored ones in the dark theme: [stored, drawn] pairs of 0xRRGGBB.
 * The stored colors (and so the document shared with others) stay the same; sticky notes
 * keep their colors.
 */
export const DARK_BOARD_COLORS: ReadonlyArray<readonly [number, number]> = [
  [0xffffff, 0x0e0e10],
  [0x18181b, 0xf4f4f5],
  [0xf4f4f5, 0x1c1c1f],
  [0x71717a, 0xa1a1aa],
  [0x1f2937, 0xf4f4f5],
];

/** Element types drawn with their stored colors in every theme. */
export const THEME_KEEP_TYPES = ['sticky'] as const;

/** Opacity of the board grid, 0..1. */
const GRID_ALPHA = 0.5;

const withAlpha = (rgba: number, alpha: number) =>
  ((rgba & 0xffffff00) | Math.round(alpha * 255)) >>> 0;

export interface BoardThemeColors {
  background: number;
  gridColor: number;
  audio: Partial<AudioWidgetStyle>;
}

/** Backdrop, grid and audio player colors of a theme (the same as the default CSS tokens). */
export function boardThemeColors(theme: BoardThemeName): BoardThemeColors {
  const dark = theme === 'dark';
  return {
    background: hexColor(dark ? '#121214' : '#f6f6f7'),
    gridColor: withAlpha(hexColor(dark ? '#2a2a2e' : '#e4e4e7'), GRID_ALPHA),
    audio: {
      primary: dark ? '#fafafa' : '#18181b',
      primaryForeground: dark ? '#18181b' : '#fafafa',
      track: dark ? '#3f3f46' : '#d4d4d8',
      ink: dark ? '#a1a1aa' : '#71717a',
    },
  };
}
