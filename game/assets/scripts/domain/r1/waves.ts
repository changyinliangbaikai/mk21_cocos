import { enemyDef, legacyStageTuning, stageDef } from './config';
import { Enemy, Run, Spawn, event, now } from './model';
import { random, shuffle } from './random';
import { CONTRACTS, EXPEDITION_HP, EXPEDITION_ATTACK } from './incentives';

export const runTuning = (r: Run) => r.tuning || legacyStageTuning(r.stage);
export function enemyScale(r: Run, wave = r.wave): number {
  const tuning = runTuning(r); return tuning.baseScale * tuning.waveScales[Math.max(0, Math.min(14, wave - 1))];
}

export function wavePlans(run: Run): Spawn[][] {
  const stage = stageDef(run.stage);
  const contract=run.incentive?.expedition?CONTRACTS.find(c=>c.id===run.incentive!.expedition!.contract):undefined;
  return Array.from({ length: 15 }, (_, wave) => {
    const ids = Object.entries(contract?.composition||stage.minionCompositionEachWave).flatMap(([id, count]) => Array<string>(count).fill(id));
    const result = shuffle(ids, run.rng, 'spawn').map(id => ({ id, trait: null as string | null, x: .06 + random(run.rng, 'spawn') * .88 }));
    const indices = shuffle(result.map((_, i) => i), run.rng, 'spawn');
    let n = 0;
    const quotas=contract?.traits||Object.fromEntries(stage.traitPool.map(t=>[t,stage.eachTraitQuota]));
    for (const [trait,count] of Object.entries(quotas)) for (let i = 0; i < count; i++) {
      const at=indices.findIndex(j=>!result[j].trait&&enemyDef(result[j].id).allowedBirthTraits.includes(trait));
      if(at<0)throw new Error('特性配额无法匹配');result[indices.splice(at,1)[0]].trait=trait;n++;
    }
    const crowd = runTuning(run).crowd;
    if (crowd && wave < crowd.throughWave) result.forEach((entry, i) => {
      // Use the already-generated spawn jitter, leaving the independent card/reward RNG untouched.
      const batch = Math.floor(i / crowd.batchSize), j = i % crowd.batchSize;
      const pattern = (wave + batch) % 3, jitter = (entry.x - .5) * .018;
      entry.x = pattern === 0 ? .29 + (j % 5) * .105 + Math.floor(j / 5) * .022 + jitter
        : pattern === 1 ? (j < 5 ? .25 : .64) + (j % 5) * .027 + jitter
        : .30 + (j % 5) * .09 + Math.floor(j / 5) * .025 + jitter;
    });
    return result;
  });
}
export function spawnEnemy(r: Run, entry: Spawn, wave = r.wave): Enemy {
  const d = enemyDef(entry.id), scale = enemyScale(r, wave);
  const expedition=r.incentive?.expedition,hpScale=expedition?EXPEDITION_HP[expedition.tier-1]:1,attackScale=expedition?EXPEDITION_ATTACK[expedition.tier-1]:1;
  if (entry.trait && !d.allowedBirthTraits.includes(entry.trait)) throw new Error(`Illegal trait ${entry.trait} on ${d.id}`);
  const e: Enemy = { uid: ++r.nextUid, id: d.id, wave, x: entry.x, y: 0, hp: d.baseHp * scale, maxHp: d.baseHp * scale,
    attack: d.baseAttack * scale, defense: d.baseDefense, trait: entry.trait, shield: 0, shieldTriggered: false, residual: false,
    commandUntil: 0, slowUntil: 0, slowFraction: 0, rootUntil: 0, stunUntil: 0, markUntil: 0, markDamage: 0, markRole: 'ranged',
    cooldown: d.attackIntervalSeconds, skillCooldown: d.tier === 'minion' ? 0 : d.id === 'RS01' ? 10 : d.id === 'RS02' ? 12 : 14,
    commandCooldown: 8, born: now(r), windup: null };
  e.hp*=hpScale;e.maxHp*=hpScale;e.attack*=attackScale;
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
    const tuning = runTuning(r), crowd = tuning.crowd && r.wave <= tuning.crowd.throughWave ? tuning.crowd : undefined;
    if (crowd && r.released > 0 && r.released % crowd.batchSize === 0
      && !r.enemies.some(e => e.hp > 0 && enemyDef(e.id).tier === 'minion') && !r.explosions.length)
      r.spawnTimer = Math.min(r.spawnTimer, crowd.clearDelay);
    r.spawnTimer -= dt;
    if (r.spawnTimer <= 1e-8) {
      spawnEnemy(r, r.plans[r.wave - 1][r.released++]);
      r.spawnTimer = crowd ? r.released % crowd.batchSize === 0 ? crowd.period - (crowd.batchSize - 1) * crowd.interval : crowd.interval : tuning.spawnIntervals[r.wave - 1];
    }
    return; // No transition on the release tick; each plan always releases all 30 minions.
  }
  r.nextWaveTimer += dt;
  if (r.wave < 15 && ((!r.enemies.some(e => e.hp > 0) && !r.explosions.length) || r.nextWaveTimer >= runTuning(r).nextWaveDelay - 1e-8)) startWave(r);
}
