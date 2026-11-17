import { describe, expect, it } from 'vitest';
import { cropPan, cropResize, cropScale, enterCrop, fitBox, imageRect, imageUv } from './image-fit';
import { makeRect } from '../test-utils';
import type { ShapeElement } from './element';

// A 400×200 image (2:1).
const SIZE = { w: 400, h: 200 };
const image = (patch: Partial<ShapeElement> = {}): ShapeElement =>
  makeRect('img', { type: 'image', x: 0, y: 0, w: 100, h: 100, ...patch });

describe('image fill modes', () => {
  it('fill covers a square box, cropped evenly left and right', () => {
    expect(imageUv(image(), SIZE)).toEqual({ u: 0.25, v: 0, du: 0.5, dv: 1 });
    // The whole image: 200 wide, centered on the 100 box.
    expect(imageRect(image(), SIZE)).toEqual({ x: -50, y: 0, w: 200, h: 100 });
  });

  it('fit shows the whole image, letterboxed', () => {
    const uv = imageUv(image({ imageFit: 'fit' }), SIZE);
    expect(uv).toEqual({ u: 0, v: -0.5, du: 1, dv: 2 });
    expect(imageRect(image({ imageFit: 'fit' }), SIZE)).toEqual({ x: 0, y: 25, w: 100, h: 50 });
  });

  it('fit makes the frame hug the whole image, centered in the old frame', () => {
    // 2:1 image in a 100×100 frame → 100×50, vertically centered.
    const p = fitBox(image({ imageFit: 'crop', crop: { x: 0, y: 0, w: 0.5, h: 1 } }), SIZE);
    expect(p).toMatchObject({ x: 0, y: 25, w: 100, h: 50, imageFit: 'fit', crop: undefined });
    // Then the whole image fills the frame exactly: no margins.
    expect(imageUv({ ...image(), ...p } as ShapeElement, SIZE)).toEqual({
      u: 0,
      v: 0,
      du: 1,
      dv: 1,
    });
  });

  it('crop shows the stored part', () => {
    const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.6 };
    expect(imageUv(image({ imageFit: 'crop', crop }), SIZE)).toEqual({
      u: 0.1,
      v: 0.2,
      du: 0.5,
      dv: 0.6,
    });
  });
});

describe('crop editing', () => {
  it('entering crop keeps what is shown: fill keeps the box, fit shrinks to the image', () => {
    const fromFill = enterCrop(image(), SIZE);
    expect(fromFill).toMatchObject({ x: 0, y: 0, w: 100, h: 100, imageFit: 'crop' });
    expect(fromFill.crop).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
    const fromFit = enterCrop(image({ imageFit: 'fit' }), SIZE);
    expect(fromFit).toMatchObject({ x: 0, y: 25, w: 100, h: 50 });
    expect(fromFit.crop).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('dragging the right side shows more of the image, which stays in place', () => {
    const el = { ...image(), ...enterCrop(image(), SIZE) } as ShapeElement;
    const p = cropResize(el, SIZE, [1, 0], { x: 30, y: 0 });
    expect(p).toMatchObject({ x: 0, w: 130, h: 100 });
    const after = { ...el, ...p } as ShapeElement;
    expect(imageRect(after, SIZE)).toEqual(imageRect(el, SIZE)); // the image didn't move
  });

  it('the frame stops at the image edges', () => {
    const el = { ...image(), ...enterCrop(image(), SIZE) } as ShapeElement;
    // The image spans x -50..150: the left side can go to -50, not further.
    const p = cropResize(el, SIZE, [-1, 0], { x: -500, y: 0 });
    expect(p).toMatchObject({ x: -50, w: 150 });
    expect(p.crop).toEqual({ x: 0, y: 0, w: 0.75, h: 1 });
  });

  it('dragging inside moves the image under the frame, without a gap', () => {
    const el = { ...image(), ...enterCrop(image(), SIZE) } as ShapeElement;
    expect(cropPan(el, SIZE, { x: 20, y: 0 }).crop).toEqual({ x: 0.15, y: 0, w: 0.5, h: 1 });
    expect(cropPan(el, SIZE, { x: 999, y: 999 }).crop).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
  });

  it('dragging an image corner scales the image around the opposite corner', () => {
    const el = { ...image(), ...enterCrop(image(), SIZE) } as ShapeElement;
    // The image spans -50..150 × 0..100. Pull its bottom-right corner out by 100 (×1.5).
    const p = cropScale(el, SIZE, [1, 1], { x: 100, y: 0 });
    const after = { ...el, ...p } as ShapeElement;
    expect(after).toMatchObject({ x: 0, y: 0, w: 100, h: 100 }); // the frame stays
    const r = imageRect(after, SIZE);
    expect(r.x).toBeCloseTo(-50); // the top-left corner stays
    expect(r.y).toBeCloseTo(0);
    expect(r.w).toBeCloseTo(300);
    expect(r.h).toBeCloseTo(150);
  });

  it('the image never gets smaller than the frame', () => {
    const el = { ...image(), ...enterCrop(image(), SIZE) } as ShapeElement;
    const p = cropScale(el, SIZE, [1, 1], { x: -500, y: -500 });
    const r = imageRect({ ...el, ...p } as ShapeElement, SIZE);
    // From the fixed corner (-50, 0) it must still reach x 100 and y 100: height 100 is
    // the limit (already the frame's height), so the image stays as it was.
    expect(r.h).toBeCloseTo(100);
    expect(r.x + r.w).toBeGreaterThanOrEqual(100 - 1e-9);
    expect(p.crop!.h).toBeCloseTo(1);
  });

  it('works for rotated images (the box moves along its own axes)', () => {
    const el = {
      ...image({ rotation: Math.PI / 2 }),
      ...enterCrop(image({ rotation: Math.PI / 2 }), SIZE),
    } as ShapeElement;
    const p = cropResize(el, SIZE, [1, 0], { x: 20, y: 0 });
    // Growing to the right in the box's frame is growing downwards on the board.
    expect(p.w).toBeCloseTo(120);
    expect((p.x as number) + (p.w as number) / 2).toBeCloseTo(50); // center x unchanged
    expect((p.y as number) + (p.h as number) / 2).toBeCloseTo(60); // center moved down 10
  });

  it('rejects an invalid crop', async () => {
    const { Scene } = await import('../scene/scene');
    const scene = new Scene();
    scene.add(image());
    expect(() => scene.update('img', { crop: { x: 0.8, y: 0, w: 0.5, h: 1 } })).toThrow(/crop/);
    expect(() => scene.update('img', { imageFit: 'tile' as never })).toThrow(/imageFit/);
  });
});
