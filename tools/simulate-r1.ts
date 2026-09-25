import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { R1Session, validateSave } from '../game/assets/scripts/domain/r1/session';
import { Card, DrawSource } from '../game/assets/scripts/domain/r1/model';
import { RULES } from '../game/assets/scripts/domain/r1/config';

// A deterministic smoke strategy, not a difficulty or player-skill benchmark.
class MemoryStorage {
  entries = new Map<string, string>();
  getItem(key: string): string | null { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string): void { this.entries.set(key, value); }
}
const rank = (card: Card): number => card.kind === 'hero' ? 100 + ({ RH06: 6, RH04: 5, RH02: 4, RH01: 3, RH05: 2, RH03: 1 }[card.heroId!] || 0)
  : card.kind === 'global' ? 80 : card.kind === 'skill' ? (card.skillSlot === 1 ? 70 : 60) : 50; // All blue cards now strengthen every attribute.
const results = [];
for (const [stage, level] of [[1, 1], [5, 5], [10, 10], [20, 20], [1, 20], [5, 20]]) for (const seed of [42, 765, 909]) {
  const storage = new MemoryStorage(); let session = new R1Session(storage);
  // Later stages use an explicit test account; no player's save is touched.
  session.data.profile.clearedStage = stage - 1;
  for (const id in session.data.profile.levels) session.data.profile.levels[id] = level;
  session.start(stage, seed); let frames = 0, peak = 0, restored = false, choices = 0; const start = performance.now();
  const choicesBySource: Record<DrawSource, number> = { opening: 0, energy: 0, boss: 0, grandpa: 0 };
  let firstEnergyDraw: { seconds: number; wave: number; kills: number } | null = null;
  let firstHeroDeathSeconds: number | null = null;
  while (session.data.run!.status === 'active' && frames < 90000) {
    const r = session.data.run!;
    if (session.error) throw new Error(`stage ${stage} seed ${seed}: ${session.error}`);
    if (r.rescue) session.rescue(r.rescue === 'grandpa' || !r.freeReviveUsed);
    else if (r.candidates.length) {
      const source = r.drawQueue[0];
      if (source === 'energy' && !firstEnergyDraw) firstEnergyDraw = { seconds: r.tick / 60, wave: r.wave, kills: r.kills };
      const c = [...r.candidates].sort((a, b) => rank(b) - rank(a))[0];
      if (session.choose(c.id)) { choices++; choicesBySource[source]++; }
    }
    else if (r.globalSkill && r.enemies.length >= 12) { session.aim(); session.cast(.5, .55, 0); }
    session.tick(1 / 30); frames++; peak = Math.max(peak, session.data.run!.enemies.length);
    if (firstHeroDeathSeconds === null && session.data.run!.slots.some(h => h && h.hp <= 0)) firstHeroDeathSeconds = session.data.run!.tick / 60;
    if (!restored && session.data.run!.wave >= 3) {
      session.hide(); session = new R1Session(storage); session.resume(); restored = true;
      if (session.error) throw new Error(session.error);
    }
    if (frames % 300 === 0) validateSave(session.data);
  }
  const r = session.data.run!;
  if (r.status === 'active') throw new Error(`Simulation did not settle: ${stage}/${seed}`);
  validateSave(session.data);
  results.push({ stage, seed, level, status: r.status, wave: r.wave, seconds: r.tick / 60, choices,
    spawned: r.spawnedMinions, bosses: r.spawnedBosses, kills: r.kills, peakEnemies: peak, restored, choicesBySource, firstEnergyDraw, firstHeroDeathSeconds,
    rewards: session.data.settlement?.rewards || [], computeMs: Math.round(performance.now() - start) });
}
mkdirSync('artifacts/r1', { recursive: true });
writeFileSync('artifacts/r1/simulation.json', JSON.stringify({ generatedAt: new Date().toISOString(), runtimeVersion: RULES.version, limitations: ['synthetic strategy', 'desktop CPU', 'not a device frame-rate measurement'], results }, null, 2) + '\n');
console.table(results.map(({ rewards, choicesBySource, firstEnergyDraw, firstHeroDeathSeconds, ...r }) => ({ ...r, energyDraws: choicesBySource.energy, firstEnergySeconds: firstEnergyDraw?.seconds, firstHeroDeathSeconds, fragments: rewards.reduce((n, v) => n + v.count, 0) })));
