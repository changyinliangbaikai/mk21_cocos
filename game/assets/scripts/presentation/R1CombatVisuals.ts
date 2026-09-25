export interface CombatVisual { pack: string; frame: number; size: number; duration: number }

/** Summons keep their owner's visual family; an unknown source never becomes popcorn. */
export function attackFamily(source: string): string | null {
  if (/^RH0[1-6]-S[1-3]$/.test(source)) return source.slice(0, 4);
  const families: Record<string, string> = { 'SUM-BURST': 'RH02', 'corn-mark': 'RH02', 'SUM-DURABLE': 'RH04', 'SUM-BAG': 'RH06' };
  return families[source] || null;
}
export function friendlyProjectileVisual(source: string): CombatVisual | null {
  const family = attackFamily(source); if (!family) return null;
  return { pack: 'FX-' + family, frame: source === 'SUM-BURST' ? 6 : 0,
    size: source === 'SUM-BURST' ? 64 : source === 'SUM-DURABLE' ? 54 : family === 'RH03' ? 80 : 34, duration: 0 };
}
export function friendlyImpactVisual(source: string): CombatVisual | null {
  const family = attackFamily(source); if (!family) return null;
  const size = source === 'SUM-BURST' ? 110 : source === 'SUM-DURABLE' ? 85 : family === 'RH01' ? 130 : family === 'RH03' ? 105 : 55;
  return { pack: 'FX-' + family, frame: source === 'SUM-BURST' ? 7 : 2, size,
    duration: family === 'RH01' || family === 'RH03' || source.startsWith('SUM-') ? .36 : .25 };
}
