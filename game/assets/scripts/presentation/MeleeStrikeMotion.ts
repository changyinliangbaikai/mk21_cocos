/** Cosmetic propagation during the existing basic-attack windup. No damage or time changes. */
export const MELEE_STYLES: Record<string, { width: number; bridge: number; tail: number }> = {
  RH01: { width: 195, bridge: 150, tail: .18 },
  RH05: { width: 138, bridge: 88, tail: .2 },
  RH06: { width: 235, bridge: 190, tail: .2 },
};
export interface MeleePart {
  at: number; frame: number; width: number; height: number; opacity: number; anchorY: number; upright?: boolean;
}
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export const meleeWindupProgress = (remaining: number, duration: number): number => duration > 0 ? clamp(1 - remaining / duration) : 1;
/** Route fractions remain between source and target, with one shared endpoint at contact. */
export function meleeParts(id: string, progress: number, distance: number, tailAge = 0): MeleePart[] {
  const style = MELEE_STYLES[id]; if (!style || distance < 1 || tailAge >= style.tail) return [];
  const p = clamp(progress), reach = Math.sin(p * Math.PI / 2), fade = 1 - clamp(tailAge / style.tail);
  if (reach <= 0) return [];
  const parts: MeleePart[] = [{ at: reach / 2, frame: tailAge ? Math.min(8, 7 + Math.floor(tailAge / .1)) : 6,
    width: style.bridge, height: Math.max(20, distance * reach), opacity: (id === 'RH05' ? .4 : .68) * fade, anchorY: .5 }];
  if (id === 'RH05') {
    for (let i = 0; i < 5; i++) {
      const at = .12 + i * .17; if (reach < at) continue;
      const local = clamp((p - i * .14) / .6 + tailAge * 2), width = Math.min(style.width, Math.max(65, distance * .36));
      parts.push({ at, frame: Math.min(5, Math.floor(local * 6)), width, height: width,
        opacity: Math.min(1, local * 5 + .2) * fade, anchorY: .12, upright: true });
    }
  } else {
    const frame = tailAge ? 5 : Math.min(5, Math.floor(p * 5));
    if (id === 'RH06') for (let i = 2; i >= 1; i--) {
      const at = reach - i * .16; if (at <= 0) continue;
      parts.push({ at, frame: Math.max(0, frame - i), width: style.width * (1 - i * .18), height: style.width * .76,
        opacity: (.55 - i * .15) * fade, anchorY: .35 });
    }
    parts.push({ at: reach, frame, width: style.width * (.65 + .35 * reach), height: style.width * .8,
      opacity: fade, anchorY: id === 'RH01' ? .45 : .35 });
  }
  return parts;
}
