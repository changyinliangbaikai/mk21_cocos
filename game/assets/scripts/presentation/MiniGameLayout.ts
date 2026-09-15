export type LayoutRect = { x: number; y: number; width: number; height: number };

/** Fit the complete 720×1280 UI below the native menu, in Cocos view units. */
export function fitMiniGameStage(visible: LayoutRect, safe = visible, menuLowerEdgeY?: number): { x: number; y: number; scale: number } {
  let left = Math.max(visible.x, safe.x), right = Math.min(visible.x + visible.width, safe.x + safe.width);
  let bottom = Math.max(visible.y, safe.y), top = Math.min(visible.y + visible.height, safe.y + safe.height);
  if (Number.isFinite(menuLowerEdgeY)) top = Math.min(top, menuLowerEdgeY!);
  if (![left, right, bottom, top].every(Number.isFinite) || right <= left || top <= bottom) {
    left = visible.x; right = left + visible.width; bottom = visible.y; top = bottom + visible.height;
  }
  return { x: (left + right) / 2 - (visible.x + visible.width / 2),
    y: (bottom + top) / 2 - (visible.y + visible.height / 2),
    scale: Math.min((right - left) / 720, (top - bottom) / 1280) };
}

/** Platform menu coordinates are CSS pixels measured from the screen top. */
export function menuLowerEdgeInView(menuBottom: number, windowHeight: number, pixelHeight: number, viewportY: number, scaleY: number): number | undefined {
  if (![menuBottom, windowHeight, pixelHeight, viewportY, scaleY].every(Number.isFinite)
    || menuBottom <= 0 || windowHeight <= 0 || pixelHeight <= 0 || scaleY <= 0) return undefined;
  const ratio = pixelHeight / windowHeight;
  return (pixelHeight - (menuBottom + 8) * ratio - viewportY) / scaleY;
}
