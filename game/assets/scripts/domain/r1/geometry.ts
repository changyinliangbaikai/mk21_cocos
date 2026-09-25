import { Quality } from './config';
import { Point } from './model';

export interface SkillArea { quality: Quality; center: Point; radius: number; angle: number; polygon: Point[]; fraction: number }
const W = 656, H = 800;
export function polygonArea(p: Point[]): number {
  return Math.abs(p.reduce((sum, a, i) => { const b = p[(i + 1) % p.length]; return sum + a.x * b.y - b.x * a.y; }, 0)) / 2;
}
function clip(points: Point[]): Point[] {
  for (const [axis, v, greater] of [['x', 0, true], ['x', W, false], ['y', 0, true], ['y', H, false]] as const) {
    const next: Point[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const ai = greater ? a[axis] >= v : a[axis] <= v, bi = greater ? b[axis] >= v : b[axis] <= v;
      if (ai) next.push(a);
      if (ai !== bi) { const t = (v - a[axis]) / (b[axis] - a[axis]); next.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }); }
    }
    points = next;
  }
  return points;
}
/** Match the accepted circle / 90-degree sector / radial-wave geometry, in physical pixels. */
export function skillArea(q: Quality, aimX = .5, aimY = .5, degrees = 0): SkillArea {
  aimX = Math.max(0, Math.min(1, aimX)); aimY = Math.max(0, Math.min(1, aimY));
  if (q === 'blue') {
    const radius = Math.sqrt(W * H * .2 / Math.PI);
    return { quality: q, center: { x: radius + (W - radius * 2) * aimX, y: radius + (H - radius * 2) * aimY }, radius, angle: 0, polygon: [], fraction: .2 };
  }
  if (q === 'gold') return { quality: q, center: { x: W / 2, y: H / 2 }, radius: Math.hypot(W / 2, H / 2), angle: 0, polygon: [], fraction: 1 };
  const angle = (-90 + Math.max(-25, Math.min(25, degrees))) * Math.PI / 180, center = { x: W / 2, y: H };
  const sector = (radius: number) => clip([center, ...Array.from({ length: 361 }, (_, i) => {
    const a = angle - Math.PI / 4 + Math.PI / 2 * i / 360;
    return { x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius };
  })]);
  let lo = 0, hi = Math.hypot(W, H) * 2;
  for (let i = 0; i < 36; i++) { const mid = (lo + hi) / 2; if (polygonArea(sector(mid)) < W * H / 2) lo = mid; else hi = mid; }
  const radius = (lo + hi) / 2, polygon = sector(radius);
  return { quality: q, center, radius, angle, polygon, fraction: polygonArea(polygon) / (W * H) };
}
export function inSkillArea(area: SkillArea, point: Point): boolean {
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return false;
  if (area.quality === 'gold') return true;
  const dx = point.x * W - area.center.x, dy = point.y * H - area.center.y;
  if (Math.hypot(dx, dy) > area.radius + 1e-8) return false;
  if (area.quality === 'blue') return true;
  const delta = Math.atan2(Math.sin(Math.atan2(dy, dx) - area.angle), Math.cos(Math.atan2(dy, dx) - area.angle));
  return Math.abs(delta) <= Math.PI / 4 + 1e-8;
}
