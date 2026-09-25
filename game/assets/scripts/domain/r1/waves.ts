import { enemyDef, legacyStageTuning, stageDef } from './config';
import { Enemy, Run, Spawn, event, now } from './model';
import { random, shuffle } from './random';

export const runTuning = (r: Run) => r.tuning || legacyStageTuning(r.stage);
export function enemyScale(r: Run, wave = r.wave): number {
  const tuning = runTuning(r); return tuning.baseScale * tuning.waveScales[Math.max(0, Math.min(14, wave - 1))];
}

export function wavePlans(run: Run): Spawn[][] {
  const stage = stageDef(run.stage);
  return Array.from({ length: 15 }, () => {
    const ids = Object.entries(stage.minionCompositionEachWave).flatMap(([id, count]) => Array<string>(count).fill(id));
    const result = shuffle(ids, run.rng, 'spawn').map(id => ({ id, trait: null as string | null, x: .06 + random(run.rng, 'spawn') * .88 }));
    const indices = shuffle(result.map((_, i) => i), run.rng, 'spawn');
    let n = 0;
    for (const trait of stage.traitPool) for (let i = 0; i < stage.eachTraitQuota; i++) result[indices[n++]].trait = trait;
    return result;
  });
}
export function spawnEnemy(r: Run, entry: Spawn, wave = r.wave): Enemy {
  const d = enemyDef(entry.id), scale = enemyScale(r, wave);
  if (entry.trait && !d.allowedBirthTraits.includes(entry.trait)) throw new Error(`Illegal trait ${entry.trait} on ${d.id}`);
  const e: Enemy = { uid: ++r.nextUid, id: d.id, wave, x: entry.x, y: 0, hp: d.baseHp * scale, maxHp: d.baseHp * scale,
    attack: d.baseAttack * scale, defense: d.baseDefense, trait: entry.trait, shield: 0, shieldTriggered: false, residual: false,
    commandUntil: 0, slowUntil: 0, slowFraction: 0, rootUntil: 0, stunUntil: 0, markUntil: 0, markDamage: 0, markRole: 'ranged',
    cooldown: d.attackIntervalSeconds, skillCooldown: d.tier === 'minion' ? 0 : d.id === 'RS01' ? 10 : d.id === 'RS02' ? 12 : 14,
    commandCooldown: 8, born: now(r), windup: null };
  r.enemies.push(e); if (d.tier === 'minion') r.spawnedMinions++; else r.spawnedBosses++;
  event(r, 'spawn', d.id, e); return e;
}
function startWave(r: Run): void {
  r.wave++; r.released = 0; r.spawnTimer = 0; r.nextWaveTimer = 0;
  const s = stageDef(r.stage), bosses = r.wave === 15 ? [s.finalBoss] : s.miniBosses[String(r.wave)] || [];
  bosses.forEach((id, i) => spawnEnemy(r, { id, trait: null, x: bosses.length === 1 ? .5 : .35 + i * .3 }));
  event(r, 'wave', String(r.wave), { x: .5, y: 0 });
}
export function advanceWaves(r: Run, dt: number): void {
  if (!r.wave) startWave(r);
  if (r.released < 30) {
    r.spawnTimer -= dt;
    if (r.spawnTimer <= 1e-8) { spawnEnemy(r, r.plans[r.wave - 1][r.released++]); r.spawnTimer = runTuning(r).spawnIntervals[r.wave - 1]; }
    return; // No transition on the release tick; each plan always releases all 30 minions.
  }
  r.nextWaveTimer += dt;
  if (r.wave < 15 && ((!r.enemies.some(e => e.hp > 0) && !r.explosions.length) || r.nextWaveTimer >= runTuning(r).nextWaveDelay - 1e-8)) startWave(r);
}
