import { RULES, Quality, stageDef, stageTuning } from './config';
import { Profile, Run, aliveHeroes, copy, deployed, event, waveMinionQuota } from './model';
import { streams } from './random';
import { repairDraft, showDraft } from './cards';
import { advanceWaves, enemyScale, wavePlans } from './waves';
import { damageEnemy, updateEnemies, updateExplosions, updateHeroes, updateProjectiles, updateSummons, updateSkillBursts } from './combat';
import { inSkillArea, skillArea } from './geometry';
import { unlockedHeroes } from './rewards';
import { Expedition, createIncentiveRun } from './incentives';

export function createRun(profile: Profile, stage: number, seed: number, id: string, expedition?: Expedition): Run {
  if (!id || !Number.isSafeInteger(seed) || stage > profile.clearedStage + 1) throw new Error('Run is not available');
  stageDef(stage);
  const run: Run = { version: 1, id, seed: seed >>> 0, rng: streams(seed), stage, tuning: stageTuning(stage), tick: 0, nextUid: 0,
    status: 'active', rate: 1, paused: false, aiming: false, slots: [null, null, null, null], levels: copy(profile.levels), unlocked: unlockedHeroes(profile),
    enemies: [], summons: [], projectiles: [], explosions: [], skillBursts: [], wave: 0, plans: [], released: 0, spawnTimer: 0, nextWaveTimer: 0,
    spawnedMinions: 0, spawnedBosses: 0, kills: 0, energy: 0, drawQueue: ['opening', 'opening', 'opening'], candidates: [], cardSequence: 0,
    globalSkill: null, grandpaUsed: false, freeReviveUsed: false, drawDebt: 0, rescue: null, events: [], eventSequence: 0 };
  if(expedition&&stage!==20)throw new Error('远征使用第20关基础');
  run.incentive=createIncentiveRun(profile,stage,expedition);
  run.plans = wavePlans(run); showDraft(run); return run;
}
export function reconcileBattle(r: Run): void {
  if (r.status !== 'active') return;
  const dead = deployed(r).filter(h => h.hp <= 0);
  if (dead.length >= 3 && !r.grandpaUsed) { r.rescue = 'grandpa'; r.aiming = false; return; }
  if (deployed(r).length && !aliveHeroes(r).length) { r.rescue = 'wipe'; r.aiming = false; return; }
  if (r.wave === 15 && r.released === waveMinionQuota(r) && !r.enemies.some(e => e.hp > 0) && !r.explosions.length && aliveHeroes(r).length) {
    r.status = 'victory'; r.rescue = null; r.candidates = []; r.drawQueue = []; r.aiming = false;
    r.summons = []; r.projectiles = []; r.skillBursts = []; event(r, 'victory', String(r.stage), { x: .5, y: .5 }); return;
  }
  repairDraft(r); showDraft(r);
}
export function effectiveRate(r: Run): number {
  if (r.status !== 'active' || r.paused || r.rescue || r.drawQueue[0] === 'opening') return 0;
  return r.rate * (r.candidates.length || r.aiming ? .1 : 1);
}
/** One battle tick, independent of graphics, wall time, and the user's chosen speed. */
export function stepBattle(r: Run): void {
  if (!effectiveRate(r)) return;
  r.tick++;
  const dt = 1 / 60;
  advanceWaves(r, dt);
  updateHeroes(r, dt); updateSkillBursts(r); updateSummons(r, dt); updateEnemies(r, dt);
  updateProjectiles(r, dt); updateExplosions(r);
  r.enemies = r.enemies.filter(e => e.hp > 0);
  reconcileBattle(r);
}
export function aimGlobal(r: Run): boolean {
  if (!r.globalSkill || r.status !== 'active' || r.rescue || r.candidates.length || r.paused) return false;
  r.aiming = true; return true;
}
export function cancelGlobal(r: Run): void { r.aiming = false; }
export function castGlobal(r: Run, x = .5, y = .5, degrees = 0): boolean {
  if (!r.aiming || !r.globalSkill || r.status !== 'active' || r.rescue || r.candidates.length || r.paused || ![x, y, degrees].every(Number.isFinite)) return false;
  const q: Quality = r.globalSkill, area = skillArea(q, x, y, degrees);
  const damage = RULES.globalSkills[q].baseDamage * enemyScale(r);
  for (const e of r.enemies.filter(e => e.hp > 0 && inSkillArea(area, e))) damageEnemy(r, e, damage * (e.id.startsWith('RM') ? 1 : .35), 'global', `GLOBAL-${q}`);
  r.globalSkill = null; r.aiming = false;
  event(r, 'global-cast', q, { x: area.center.x / 656, y: area.center.y / 800 }, undefined, undefined, area.radius / 656);
  reconcileBattle(r); return true;
}
/** No wall-clock catch-up on resume. A long frame is bounded, not simulated as background time. */
export class BattleClock {
  private remaining = 0;
  advance(run: Run, realSeconds: number): number {
    if (!Number.isFinite(realSeconds) || realSeconds < 0) return 0;
    if (!effectiveRate(run)) { this.remaining = 0; return 0; }
    this.remaining += Math.min(.25, realSeconds);
    let steps = 0;
    while (effectiveRate(run) && this.remaining + 1e-10 >= 1 / (60 * effectiveRate(run))) {
      const slice = 1 / (60 * effectiveRate(run)); this.remaining -= slice;
      stepBattle(run); steps++;
    }
    if (!effectiveRate(run)) this.remaining = 0;
    return steps;
  }
  reset(): void { this.remaining = 0; }
}
