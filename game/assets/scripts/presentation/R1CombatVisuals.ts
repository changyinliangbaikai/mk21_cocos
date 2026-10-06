import { FLIGHT_STYLES } from './ProjectileMotion';
export interface CombatVisual { pack: string; frame: number; size: number; duration: number }
/** Impacts retain a readable tail at 2x. Windups/projectiles still follow authoritative battle time. */
export function feedbackRate(effective: number, base: number, readable: boolean): number {
  return readable && base > 0 ? effective / base * Math.min(base, 1.2) : effective;
}
export const HERO_COLORS: Record<string,string> = { RH01: '#ff9747', RH02: '#ffd153', RH03: '#75ec86', RH04: '#dd99ff', RH05: '#a8d34d', RH06: '#ffe08b', RH07:'#2bdcff',RH08:'#5aacef',RH09:'#ff7342',RH10:'#d364b2' };

/** Summons keep their owner's visual family; an unknown source never becomes popcorn. */
export function attackFamily(source: string): string | null {
  if (/^RH(?:0[1-9]|10)-S[1-3]$/.test(source)) return source.slice(0, 4);
  const families: Record<string, string> = { 'SUM-BURST': 'RH02', 'corn-mark': 'RH02', 'SUM-DURABLE': 'RH04', 'SUM-BAG': 'RH06' };
  return families[source] || null;
}
export function friendlyProjectileVisual(source: string, group = false): CombatVisual | null {
  const family = attackFamily(source); if (!family) return null;
  if (FLIGHT_STYLES[family]) return { pack: 'FX-FLIGHT-' + family, frame: 0, size: FLIGHT_STYLES[family].size, duration: 0 };
  if (group) return { pack: 'FX-AREA-' + family, frame: 0, size: family === 'RH03' || family === 'RH09' ? 104 : 94, duration: 0 };
  return { pack: 'FX-' + family, frame: source === 'SUM-BURST' ? 6 : source === 'RH09-S2' ? 4 : 0,
    size: source === 'RH04-S2' ? 82 : source === 'RH09-S2' ? 85 : source === 'SUM-BURST' ? 64 : source === 'SUM-DURABLE' ? 54 : family === 'RH03' ? 80 : Number(family.slice(2))>=7 ? 52 : 34, duration: 0 };
}
export function friendlyImpactVisual(source: string, group = false): CombatVisual | null {
  const family = attackFamily(source); if (!family) return null;
  if (group && (/-S1$/.test(source) || source === 'SUM-DURABLE' || source === 'SUM-BAG')) return null;
  // The full footprint has one choreographed burst; per-victim sparks must not stack giant decals.
  if (/^RH(?:0[12789]|10)-S[23]$/.test(source) || source === 'SUM-BURST') return { pack: 'FX-' + family, frame: 2, size: 42, duration: .18 };
  const size = source === 'SUM-BURST' ? 110 : source === 'SUM-DURABLE' ? 85 : family === 'RH01' ? 130 : family === 'RH03' ? 105 : 55;
  return { pack: 'FX-' + family, frame: source === 'SUM-BURST' ? 7 : 2, size,
    duration: family === 'RH01' || family === 'RH03' || source.startsWith('SUM-') ? .36 : .25 };
}
