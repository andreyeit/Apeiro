/** Builds 0xRRGGBBAA from components in 0..255 (alpha defaults to opaque). */
export function rgba(r: number, g: number, b: number, a = 255): number {
  return (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0;
}

/** Parses '#rgb', '#rrggbb' or '#rrggbbaa'. */
export function hexColor(hex: string): number {
  let h = hex.startsWith('#') ? hex.slice(1) : hex;
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (h.length === 6) h += 'ff';
  if (h.length !== 8 || !/^[0-9a-f]+$/i.test(h)) throw new Error(`Invalid color: ${hex}`);
  return parseInt(h, 16) >>> 0;
}
