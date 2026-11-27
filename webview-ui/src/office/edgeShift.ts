/** Horizontal shift that keeps [left, right] inside [min, max]; 0 when it already fits. */
export function edgeShift(left: number, right: number, min: number, max: number): number {
  if (right - left > max - min) return min - left;
  if (left < min) return min - left;
  if (right > max) return max - right;
  return 0;
}
