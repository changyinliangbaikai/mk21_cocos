/** Source-art layout only. Domain positions, distances, collision and time stay unchanged.
 * Each axis is strictly monotonic, so native touches have one unambiguous inverse.
 * B pads retain the domain's right-of-road placement; moving them onto A/C's column
 * would fold the coordinate plane and misrepresent targeting and projectile origins.
 */
export interface BattlePoint { x: number; y: number }
const SOURCE_WIDTH = 941, SOURCE_HEIGHT = 1672;
const xWorld = [0, 70, 140, 210, 290, 360, 430, 510, 580, 650, 720];
const xSource = [0, 150, 250, 350, 435, 480, 560, 666, 730, 835, 941];
// One scale over the whole road: equal world movement must look equally fast
// before and after a hero. The old row-by-row fit made the entrance ~3.8x faster.
const yWorld = [32, 648];
const ySource = [235, 1055];

function interpolate(value: number, from: number[], to: number[]): number {
  let index = 0;
  while (index < from.length - 2 && value > from[index + 1]) index++;
  const t = (value - from[index]) / (from[index + 1] - from[index]);
  return to[index] + (to[index + 1] - to[index]) * t;
}
export function worldToBattleScreen(point: BattlePoint): BattlePoint {
  return { x: interpolate(point.x, xWorld, xSource) * 720 / SOURCE_WIDTH,
    y: interpolate(point.y, yWorld, ySource) * 1280 / SOURCE_HEIGHT };
}
export function battleScreenToWorld(point: BattlePoint): BattlePoint {
  return { x: interpolate(point.x * SOURCE_WIDTH / 720, xSource, xWorld),
    y: interpolate(point.y * SOURCE_HEIGHT / 1280, ySource, yWorld) };
}
export function battleReserveScreen(index: number): BattlePoint {
  return { x: [80, 192, 303][index] * 720 / SOURCE_WIDTH, y: 1310 * 1280 / SOURCE_HEIGHT };
}
/** Transform a real world radius point by point. A screen-space circle would lie
 * about the authoritative hit area under a nonuniform presentation projection. */
export function battleCircleScreen(center: BattlePoint, radius: number, samples = 64): BattlePoint[] {
  return Array.from({ length: samples + 1 }, (_, index) => {
    const angle = index / samples * Math.PI * 2;
    return worldToBattleScreen({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  });
}

/** Dashes follow the authoritative circular range, including X projection bends. */
export function battleRangeDashes(center: BattlePoint, radius: number): BattlePoint[][] {
  return Array.from({ length: 48 }, (_, index) => [0, .3, .6].map(fraction => {
    const angle = (index + fraction) / 48 * Math.PI * 2;
    return worldToBattleScreen({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  }));
}

export const battleProjectionContract = { sourceCanvas: [SOURCE_WIDTH, SOURCE_HEIGHT], designCanvas: [720, 1280],
  xWorld, xSource, yWorld, ySource, verticalScale: (1055-235)/(648-32)*1280/SOURCE_HEIGHT,
  difference: 'Linear road height keeps travel speed constant. B pads remain right of each lane; displayed ranges follow authoritative world geometry.' };
