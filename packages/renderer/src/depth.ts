/**
 * Shapes and text are drawn in separate passes, so paint order across passes is
 * kept with the depth buffer: slot `i` (z order) gets depth `1 - (i + 1) * STEP`,
 * and an element's text sits half a step in front of its own shape. Text of a
 * lower element is therefore hidden by any shape above it, without re-sorting.
 *
 * STEP = 2^-20 supports ~1M slots and stays well above 24-bit depth precision.
 */
export const DEPTH_STEP = 1 / (1 << 20);

export const shapeDepth = (slot: number): number => Math.max(0, 1 - (slot + 1) * DEPTH_STEP);
export const textDepth = (slot: number): number => Math.max(0, shapeDepth(slot) - DEPTH_STEP / 2);
