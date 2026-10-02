import type { Point } from './model';

const depth = 800 / 656;
/** Width-normalized geometry, shared by hit tests and visual endpoints. */
export function beamEnd(origin: Point, aim: Point): Point {
  const dx = aim.x - origin.x, dy = Math.min(-.001, aim.y - origin.y);
  let t = -origin.y / dy;
  if (dx > 0) t = Math.min(t, (1 - origin.x) / dx);
  if (dx < 0) t = Math.min(t, -origin.x / dx);
  return { x: Math.max(0, Math.min(1, origin.x + dx * t)), y: Math.max(0, origin.y + dy * t) };
}
export function inBeam(point: Point, origin: Point, end: Point, halfWidth: number): boolean {
  const dx = end.x - origin.x, dy = (end.y - origin.y) * depth, length = Math.hypot(dx, dy);
  if (!length) return false;
  const px = point.x - origin.x, py = (point.y - origin.y) * depth, along = (px * dx + py * dy) / length;
  return along >= 0 && along <= length + halfWidth && Math.abs(px * dy - py * dx) / length <= halfWidth;
}
export function inCone(point: Point, origin: Point, aim: Point, radius: number, halfAngle: number): boolean {
  const dx = aim.x - origin.x, dy = (aim.y - origin.y) * depth, px = point.x - origin.x, py = (point.y - origin.y) * depth;
  const len = Math.hypot(px, py), aimLen = Math.hypot(dx, dy);
  return len <= radius && len > 0 && aimLen > 0 && (px * dx + py * dy) / (len * aimLen) >= Math.cos(halfAngle * Math.PI / 180) - 1e-8;
}
