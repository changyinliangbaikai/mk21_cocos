import { HEROES, Quality, RULES, heroDef, stageDef } from './config';
import { Profile, Reward } from './model';
import { RandomState, pick, random, shuffle, weighted } from './random';

export function freshProfile(): Profile {
  return { clearedStage: 0, levels: Object.fromEntries(HEROES.map(h => [h.id, 1])), fragments: {}, music: true, sound: true, settlementLedger: [], upgradeLedger: [] };
}
export const unlockedHeroes = (p: Profile): string[] => HEROES.filter(h => h.unlockAfterStage <= p.clearedStage).map(h => h.id);
export function rollRewards(stage: number, clearedStage: number, rng: RandomState): Reward[] {
  const normal = stageDef(stage).difficulty === 'normal';
  const pool = (q: Quality) => HEROES.filter(h => h.quality === q && (!normal || h.unlockAfterStage <= clearedStage)).map(h => h.id);
  const specific = (q: Quality) => pick(pool(q), rng, 'reward');
  const slots = Array.from({ length: 5 }, () => normal ? specific('blue') : random(rng, 'reward') < .3 ? 'universal-purple' : specific('purple'));
  const replacementSlots = shuffle([0, 1, 2, 3, 4], rng, 'reward');
  if (normal) {
    if (random(rng, 'reward') < .2 && pool('purple').length) slots[replacementSlots[0]] = specific('purple');
    if (random(rng, 'reward') < .02 && pool('gold').length) slots[replacementSlots[1]] = specific('gold');
  } else {
    const e = weighted(RULES.rewards.hard.goldEvents.map(e => ({ value: e, weight: e.probability })), rng, 'reward');
    for (let i = 0; i < e.quantity; i++) slots[replacementSlots[i]] = e.type === 'universal_gold' ? 'universal-gold' : specific('gold');
  }
  const amounts: Record<string, number> = {};
  for (const key of slots) amounts[key] = (amounts[key] || 0) + (stageDef(stage).difficulty === 'superhard' ? 2 : 1);
  return Object.entries(amounts).map(([key, count]) => ({ key, count }));
}
export function upgradeCost(p: Profile, id: string): { specific: number; universal: number; available: boolean } {
  const h = heroDef(id), specific = Math.min(10, p.fragments[id] || 0), universal = 10 - specific;
  return { specific, universal, available: p.levels[id] < 20 && unlockedHeroes(p).includes(id) && (universal === 0 || h.quality !== 'blue' && (p.fragments[`universal-${h.quality}`] || 0) >= universal) };
}
export function upgradeHero(p: Profile, id: string, transactionId: string): boolean {
  if (!transactionId || p.upgradeLedger.includes(transactionId)) return false;
  const cost = upgradeCost(p, id);
  if (!cost.available) return false;
  p.fragments[id] = (p.fragments[id] || 0) - cost.specific;
  if (cost.universal) p.fragments[`universal-${heroDef(id).quality}`] -= cost.universal;
  p.levels[id]++; p.upgradeLedger.push(transactionId); return true;
}
