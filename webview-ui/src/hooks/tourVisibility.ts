/** Every competing surface enters through one policy. */
export function canShowTour(openSurfaces: Readonly<Record<string, boolean>>): boolean {
  return !Object.values(openSurfaces).some(Boolean);
}
