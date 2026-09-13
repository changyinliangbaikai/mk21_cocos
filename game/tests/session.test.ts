import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GameSession, SAVE_KEY, type StoragePort } from '../assets/scripts/domain/session';
import { eligibleCards } from '../assets/scripts/domain/config';

const config = JSON.parse(readFileSync('docs/design/configs/prototype-v0.5.json', 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
class MemoryStorage implements StoragePort {
  values = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('test storage interrupted');
    this.values.set(key, value);
  }
}
function make(): { s: GameSession; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  return { s: new GameSession(config, storage), storage };
}
function ok(s: GameSession, command: string, payload?: any): void {
  assert.equal(s.dispatch(command, payload), true, `${command}: ${s.data.notice}`);
}
function reject(s: GameSession, command: string, payload?: any): void {
  assert.equal(s.dispatch(command, payload), false, `${command} should be rejected`);
}
function checkpoint(s: GameSession): void { ok(s, 'setting', { key: 'music', value: 0.6 }); }
function start(s: GameSession): void { ok(s, 'newRun', { seed: config.sample_seed }); }
function reload(storage: MemoryStorage): GameSession {
  const s = new GameSession(config, storage);
  assert.doesNotMatch(s.data.notice, /读取失败/);
  return s;
}
function unlockAll(s: GameSession): void {
  ok(s, 'hero', 'H004'); ok(s, 'openPraise', 'H004'); ok(s, 'praise', 'H004');
  ok(s, 'ackUnlock', 'H004'); ok(s, 'open', 'camp');
}
function configureRoster(s: GameSession, roster: string[]): void {
  ok(s, 'open', 'roster');
  for (const id of [...s.data.rosterDraft]) ok(s, 'rosterToggle', id);
  for (const id of roster) ok(s, 'rosterToggle', id);
  ok(s, 'saveRoster');
}

test('P6: master mute restores legacy saves and preserves individual volume preferences', () => {
  const { s, storage } = make();
  ok(s, 'setting', { key: 'music', value: 0.4 });
  const legacy = JSON.parse(storage.getItem(SAVE_KEY)!);
  delete legacy.profile.settings.muted;
  storage.setItem(SAVE_KEY, JSON.stringify(legacy));
  const restored = reload(storage);
  assert.equal(restored.data.profile.settings.muted, false);
  ok(restored, 'setting', { key: 'muted', value: true });
  reject(restored, 'setting', { key: 'muted', value: 1 });
  const muted = reload(storage);
  assert.equal(muted.data.profile.settings.muted, true);
  assert.equal(muted.data.profile.settings.music, 0.4);
  assert.equal(muted.data.profile.settings.sfx, 0.7);
  assert.equal(muted.data.profile.settings.voice, 0.8);
  ok(muted, 'setting', { key: 'muted', value: false });
  assert.equal(reload(storage).data.profile.settings.music, 0.4);
});
function summon(s: GameSession, heroId: string, slot: string): number {
  ok(s, 'summon', { heroId, slot });
  return s.data.run.battle.heroes.find((h: any) => h.slot === slot).id;
}
function addHero(s: GameSession, type: string, star: number, slot: string, nextAttackTick = 0): number {
  const r = s.data.run, id = r.nextHeroId++;
  r.battle.heroes.push({ id, type, star, slot, nextAttackTick, releasedCount: 3 });
  return id;
}
/** Technical fixture: skip combat to exercise actual completion/ledger/card commands.
 * These tests are never evidence of ordinary player combat, win rate or elapsed play time.
 */
function completeFixture(s: GameSession, grantEnergy = false): void {
  s.battle!.clearWave(grantEnergy); s.data.run.phase = 'battle'; s.data.screen = 'battle'; s.data.overlay = null;
  s.advance(1 / 60);
  assert.ok(['cards', 'victory'].includes(s.data.run.phase), s.data.notice);
}
function failFixture(s: GameSession, wave: number, grandpaUsed = false, secondUsed = false, calm = false): void {
  s.battle!.beginWave(wave, calm);
  const r = s.data.run;
  r.grandpaUsed = grandpaUsed; r.secondUsed = secondUsed; r.calmWave = calm ? wave : null;
  r.battle.baseHp = 0; r.battle.result = 'failed'; r.phase = 'battle'; s.data.screen = 'battle'; s.data.overlay = null;
  s.advance(1 / 60);
}
function setSkills(s: GameSession, ids: string[]): void {
  for (const id of ids) s.data.run.skills[id] = { readyTick: 0, casts: 0, availableTicks: 0 };
}

test('T03/T16: summon charges only once, cancellation is free, merge preserves later cooldown and stale drags reject', () => {
  const { s } = make(); start(s);
  ok(s, 'beginSummon'); ok(s, 'cancelSummon');
  assert.equal(s.data.run.battle.energy, 120);
  const first = summon(s, 'H001', 'L1-A'), second = summon(s, 'H001', 'R1');
  assert.equal(s.data.run.battle.energy, 40);
  reject(s, 'summon', { heroId: 'H001', slot: 'R1' });
  reject(s, 'summon', { heroId: 'H004', slot: 'L2-A' });
  assert.equal(s.data.run.battle.energy, 40);
  s.data.run.battle.heroes.find((h: any) => h.id === first).nextAttackTick = 220;
  s.data.run.battle.heroes.find((h: any) => h.id === second).nextAttackTick = 180;
  ok(s, 'move', { id: first, slot: 'R1' });
  assert.equal(s.data.run.battle.heroes.length, 1);
  assert.deepEqual(s.data.run.battle.heroes.map((h: any) => [h.type, h.star, h.slot, h.nextAttackTick, h.releasedCount]), [['H001', 2, 'R1', 220, 0]]);
  reject(s, 'move', { id: first, slot: 'R1' });
  assert.equal(s.data.run.battle.heroes.length, 1);
  assert.equal(s.data.run.battle.energy, 40);
});

test('T03/T04/T16: reserve three-star merge unlocks once; highest stars swap without loss or cooldown refresh', () => {
  const { s } = make(); start(s);
  const a = addHero(s, 'H001', 2, 'R1', 100); addHero(s, 'H001', 2, 'R2', 200);
  ok(s, 'move', { id: a, slot: 'R2' });
  assert.equal(s.data.run.battle.heroes[0].star, 3);
  assert.equal(s.data.run.battle.heroes[0].slot, 'R2');
  assert.deepEqual(Object.keys(s.data.run.skills), ['K001']);
  s.data.run.skills.K001.readyTick = 900;
  const c = addHero(s, 'H001', 2, 'L1-A'); addHero(s, 'H001', 2, 'L2-A');
  ok(s, 'move', { id: c, slot: 'L2-A' });
  assert.equal(s.data.run.skills.K001.readyTick, 900);
  const stars = s.data.run.battle.heroes;
  const saved = stars.map((h: any) => ({ id: h.id, tick: h.nextAttackTick }));
  ok(s, 'move', { id: stars[0].id, slot: 'L2-A' });
  assert.equal(s.data.run.battle.heroes.length, 2);
  assert.ok(s.data.run.battle.heroes.every((h: any) => h.star === 3));
  for (const h of s.data.run.battle.heroes) assert.equal(h.nextAttackTick, saved.find((v: any) => v.id === h.id).tick);
});

test('T17: all twelve slots with four types at 1/2/3 stars reject summons yet permit swapping and starting', () => {
  const { s } = make(); unlockAll(s); configureRoster(s, config.heroes.map((h: any) => h.id)); start(s);
  const slots = [...config.world.pads.map((p: any) => p.id), ...config.world.reserve_ids];
  let i = 0;
  for (const h of config.heroes) for (const star of [1, 2, 3]) addHero(s, h.id, star, slots[i++]);
  s.data.run.battle.energy = 400;
  reject(s, 'summon', { heroId: 'H001', slot: 'L1-A' });
  assert.equal(s.data.run.battle.energy, 400);
  assert.equal(s.data.run.battle.heroes.length, 12);
  const source = s.data.run.battle.heroes[0];
  ok(s, 'move', { id: source.id, slot: 'R3' });
  assert.equal(s.data.run.battle.heroes.find((h: any) => h.id === source.id).slot, 'R3');
  assert.equal(new Set(s.data.run.battle.heroes.map((h: any) => h.slot)).size, 12);
  ok(s, 'startWave'); assert.equal(s.data.run.phase, 'battle');
});

test('T04/T28: two unique skill slots, battle library is read-only and re-equipping never resets cooldown', () => {
  const { s } = make(); start(s); setSkills(s, ['K001', 'K002', 'K003']);
  s.data.run.skills.K001.readyTick = 700;
  ok(s, 'equipSkill', { id: 'K001', slot: 0 });
  reject(s, 'equipSkill', { id: 'K001', slot: 1 });
  reject(s, 'equipSkill', { id: 'K002', slot: 2 });
  ok(s, 'equipSkill', { id: 'K002', slot: 0 });
  ok(s, 'equipSkill', { id: 'K001', slot: 0 });
  assert.equal(s.data.run.skills.K001.readyTick, 700);
  ok(s, 'startWave');
  ok(s, 'equipSkill', { id: 'K002', slot: 1 });
  reject(s, 'equipSkill', { id: 'K003', slot: 1 });
  ok(s, 'openSkills');
  reject(s, 'equipSkill', { id: 'K003', slot: 0 });
  const tick = s.data.run.battle.tick; s.advance(3);
  assert.equal(s.data.run.battle.tick, tick);
  ok(s, 'closeOverlay'); assert.equal(s.data.run.phase, 'battle');
  assert.equal(s.data.run.skills.K001.readyTick, 700);
});

test('T28: aim/invalid targets cancel without cost and a legal confirmed skill uses exactly one cooldown', () => {
  const { s } = make(); start(s); setSkills(s, ['P001', 'K004']);
  ok(s, 'equipSkill', { id: 'P001', slot: 0 }); ok(s, 'equipSkill', { id: 'K004', slot: 1 }); ok(s, 'startWave');
  ok(s, 'aim', 'P001'); const energy = s.data.run.battle.energy;
  const tick = s.data.run.battle.tick; s.advance(5); assert.equal(s.data.run.battle.tick, tick);
  reject(s, 'cast', { x: -1, y: 100 }); assert.equal(s.data.overlay, 'aim');
  assert.equal(s.data.run.skills.P001.readyTick, 0);
  ok(s, 'cancelAim'); assert.equal(s.data.run.battle.energy, energy);
  ok(s, 'aim', 'K004'); reject(s, 'cast', { enemyId: 99999 });
  assert.equal(s.data.run.skills.K004.casts, 0); ok(s, 'cancelAim');
  ok(s, 'aim', 'P001'); ok(s, 'cast', { x: 100, y: 100 });
  assert.equal(s.data.run.skills.P001.readyTick, tick + 35 * 60);
  assert.equal(s.data.run.skills.P001.casts, 1);
  assert.equal(s.data.run.battle.events.filter((e: any) => e.skillId === 'P001').length, 1);
  reject(s, 'cast', { x: 100, y: 100 }); reject(s, 'aim', 'P001');
  assert.equal(s.data.run.skills.P001.casts, 1);
});

test('T05/T18/T21: wave 7 remaining 30 plus actual next-wave advance; calm wave 8 has zero energy and still one XP', () => {
  const { s } = make(); start(s); failFixture(s, 7);
  const remaining = 30, advance = config.waves[7].energy_budget;
  let spent = config.waves[6].energy_budget - remaining;
  for (const l of s.data.run.battle.ledger.filter((l: any) => l.wave === 7)) {
    const amount = Math.min(l.budget, spent); l.claimed = amount; l.resolved = amount === l.budget; spent -= amount;
  }
  assert.equal(spent, 0);
  assert.equal(s.battle!.remainingBudget(), remaining);
  const before = s.data.run.battle.energy; ok(s, 'grandpa');
  assert.equal(s.data.run.battle.energy - before, remaining + advance);
  assert.deepEqual(s.data.run.lastRescue, { type: 'grandpa', wave: 7, remaining, advance });
  assert.equal(s.data.profile.trainingXp, 1);
  assert.equal(s.data.run.calmWave, 8);
  assert.equal(s.forecast().wave, 8); assert.equal(s.forecast().budget, 0);
  ok(s, 'chooseCard', s.data.run.candidates[0]);
  const calmEnergy = s.data.run.battle.energy;
  completeFixture(s, true);
  assert.equal(s.data.run.battle.energy, calmEnergy);
  assert.equal(s.data.profile.trainingXp, 2);
  assert.equal(s.data.run.calmWave, null);
  assert.equal(s.forecast().wave, 9);
  assert.equal(s.forecast().budget, config.waves[8].energy_budget);
});

test('T06: grandpa counts split-family partial budget once, excludes leaked shares and cancels future spawns', () => {
  const { s } = make(); start(s);
  const wave = config.waves.find((w: any) => w.counts.M004 > 0).wave;
  failFixture(s, wave);
  const row = s.data.run.battle.queue.find((q: any) => q.type === 'M004');
  const family = s.data.run.battle.ledger.find((l: any) => l.id === row.ledgerId);
  const split = config.monsters.find((m: any) => m.id === 'M004').split;
  const share = split.reward_budget_shared / split.count;
  assert.equal(family.budget, split.reward_budget_shared);
  family.claimed = share; family.voided = share;
  const child = s.battle!.spawn('M004-S', row.lane, 300, family.id, share);
  const u = config.waves[wave - 1].energy_budget - 2 * share, energy = s.data.run.battle.energy;
  const spawned = s.data.run.battle.stats.spawned; ok(s, 'grandpa');
  assert.equal(s.data.run.lastRescue.remaining, u);
  assert.equal(s.data.run.battle.energy - energy, u + config.waves[wave].energy_budget);
  assert.equal(s.data.run.battle.enemies.find((e: any) => e.id === child.id).terminal, 'cleared');
  assert.equal(s.data.run.battle.spawnIndex, s.data.run.battle.queue.length);
  assert.equal(s.data.run.battle.events.length, 0);
  s.advance(30); assert.equal(s.data.run.battle.stats.spawned, spawned);
  const awarded = s.data.run.battle.energy; reject(s, 'grandpa'); assert.equal(s.data.run.battle.energy, awarded);
});

test('T07/T18: wave 20 grandpa grants no advance, ends in victory with no wave 21 or extra card', () => {
  const { s, storage } = make(); start(s); failFixture(s, 20);
  const energy = s.data.run.battle.energy; ok(s, 'grandpa');
  assert.equal(s.data.run.battle.energy - energy, config.waves[19].energy_budget);
  assert.equal(s.data.run.lastRescue.advance, 0); assert.equal(s.data.run.calmWave, null);
  assert.equal(s.data.run.phase, 'victory'); assert.equal(s.data.screen, 'result');
  assert.equal(s.data.run.candidates.length, 0); assert.equal(s.forecast(), null);
  assert.equal(s.data.profile.trainingXp, 1);
  const recovered = reload(storage); assert.equal(recovered.data.profile.trainingXp, 1);
  reject(recovered, 'continueRun');
});

for (const kind of ['free', 'completed', 'failed'] as const) {
  test(`T08/T10/T21: calm-wave second rescue ${kind} grants exactly 80; only cleared branches complete the wave`, () => {
    const { s } = make(); start(s); failFixture(s, 8, true, false, true);
    const e = s.battle!.spawn('M001', 1, 600); const energy = s.data.run.battle.energy;
    if (kind === 'free') ok(s, 'freeRevive');
    else { ok(s, 'adRequest'); ok(s, 'adResult', { id: s.data.run.ad.id, result: kind }); }
    assert.equal(s.data.run.battle.energy - energy, 80);
    assert.equal(s.data.run.secondUsed, true);
    const afterEnemy = s.data.run.battle.enemies.find((v: any) => v.id === e.id);
    if (kind === 'free') {
      assert.equal(afterEnemy.terminal, undefined); assert.equal(s.data.run.phase, 'freeDeploy');
      assert.equal(s.data.run.calmWave, 8); assert.equal(s.data.profile.trainingXp, 0);
    } else {
      assert.equal(afterEnemy.terminal, 'cleared'); assert.equal(s.data.run.phase, 'cards');
      assert.equal(s.data.run.calmWave, null); assert.equal(s.data.profile.trainingXp, 1);
      assert.equal(s.data.run.ad.result, kind === 'failed' ? 'fallback' : 'ad');
    }
  });
}

test('T09: free deployment pauses enemies, then gives exactly three combat seconds of leak protection', () => {
  const { s } = make(); start(s); failFixture(s, 8, true);
  const e = s.battle!.spawn('M001', 1, 647.9); const energy = s.data.run.battle.energy;
  ok(s, 'freeRevive'); const tick = s.data.run.battle.tick, hp = s.data.run.battle.baseHp;
  s.advance(20); assert.equal(s.data.run.battle.tick, tick);
  assert.equal(s.data.run.battle.enemies.find((v: any) => v.id === e.id).y, 647.9);
  ok(s, 'startWave'); assert.equal(s.data.run.battle.protectionUntil, tick + 180);
  s.advance(1 / 60); assert.equal(s.data.run.battle.baseHp, hp);
  assert.equal(s.data.run.battle.enemies.find((v: any) => v.id === e.id).terminal, 'leaked');
  assert.equal(s.data.run.battle.energy, energy + 80);
  s.data.run.battle.tick = tick + 180;
  s.battle!.spawn('M001', 1, 647.9);
  s.advance(1 / 60); assert.ok(s.data.run.battle.baseHp < hp);
});

test('T10/T11: cancellation keeps choice, unknown remains paused across restart, free result rejects late callbacks', () => {
  const { s, storage } = make(); start(s); failFixture(s, 8, true);
  const energy = s.data.run.battle.energy;
  ok(s, 'adRequest'); const cancelledId = s.data.run.ad.id;
  ok(s, 'adResult', { id: cancelledId, result: 'cancelled' });
  assert.equal(s.data.run.phase, 'secondFailure'); assert.equal(s.data.run.secondUsed, false);
  assert.equal(s.data.run.battle.energy, energy);
  ok(s, 'adRequest'); const unknownId = s.data.run.ad.id; assert.notEqual(unknownId, cancelledId);
  reject(s, 'adResult', { id: cancelledId, result: 'completed' });
  ok(s, 'adResult', { id: unknownId, result: 'unknown' });
  const tick = s.data.run.battle.tick; s.advance(60); assert.equal(s.data.run.battle.tick, tick);
  const recovered = reload(storage); ok(recovered, 'continueRun');
  assert.equal(recovered.data.run.phase, 'adPending'); assert.equal(recovered.data.run.ad.status, 'unknown');
  assert.equal(recovered.data.run.secondUsed, false);
  ok(recovered, 'freeRevive');
  reject(recovered, 'adResult', { id: unknownId, result: 'completed' });
  assert.equal(recovered.data.run.phase, 'freeDeploy');
  assert.equal(recovered.data.run.battle.energy, energy + 80);
  assert.equal(recovered.data.profile.trainingXp, 0);
});

test('T11: duplicate completed callback and interruption cannot double rescue energy or wave XP', () => {
  const { s, storage } = make(); start(s); failFixture(s, 11, true);
  const energy = s.data.run.battle.energy; ok(s, 'adRequest'); const id = s.data.run.ad.id;
  ok(s, 'adResult', { id, result: 'completed' });
  reject(s, 'adResult', { id, result: 'completed' });
  const recovered = reload(storage); ok(recovered, 'continueRun');
  reject(recovered, 'adResult', { id, result: 'completed' });
  assert.equal(recovered.data.run.battle.energy, energy + 80);
  assert.equal(recovered.data.profile.trainingXp, 1);
  assert.equal(recovered.data.run.phase, 'cards');
});

test('T12/T14: third failure settles; lethal result beats exhausted queue and cannot award XP', () => {
  const { s } = make(); start(s);
  failFixture(s, 8, true, true);
  assert.equal(s.data.run.phase, 'defeat'); assert.equal(s.data.screen, 'result');
  assert.equal(s.data.profile.trainingXp, 0);
  for (const command of ['grandpa', 'freeRevive', 'adRequest', 'startWave']) reject(s, command);
  const { s: other } = make(); start(other); ok(other, 'startWave');
  other.data.run.battle.queue = []; other.data.run.battle.baseHp = 0;
  other.advance(1 / 60);
  assert.equal(other.data.run.phase, 'firstFailure'); assert.equal(other.data.profile.trainingXp, 0);
});

test('T15: praise permanently unlocks once, preserves upgraded state and normal progression remains active', () => {
  const { s, storage } = make(); unlockAll(s);
  assert.equal(s.data.profile.heroes.H004.owned, true);
  s.data.profile.trainingXp = 10; checkpoint(s); ok(s, 'hero', 'H004');
  ok(s, 'upgrade', { heroId: 'H004', expectedLevel: 1, transactionId: 'praise-upgrade' });
  ok(s, 'praise', 'H004'); reject(s, 'praise', 'H004');
  assert.equal(s.data.profile.heroes.H004.level, 2);
  ok(s, 'ackUnlock', 'H004'); ok(s, 'open', 'camp'); start(s); completeFixture(s);
  assert.equal(s.data.profile.completedWaves, 1);
  assert.equal(s.data.profile.trainingXp, 1);
  const recovered = reload(storage);
  assert.equal(recovered.data.profile.heroes.H004.owned, true);
  assert.equal(recovered.data.profile.heroes.H004.level, 2);
});

test('T19: first-event tutorials are persistent, skippable, and do not demand merge or ad decisions', () => {
  const { s, storage } = make(); start(s);
  assert.equal(s.data.tutorial.key, 'deploy');
  ok(s, 'tutorialDismiss', 'deploy');
  summon(s, 'H001', 'R1'); assert.equal(s.data.tutorial.key, 'reserve');
  ok(s, 'tutorialDismiss', 'reserve');
  const recovered = reload(storage); ok(recovered, 'continueRun');
  summon(recovered, 'H002', 'R2'); assert.equal(recovered.data.tutorial, null);
  ok(recovered, 'startWave'); assert.equal(recovered.data.run.phase, 'battle');
  assert.equal(recovered.data.run.grandpaUsed, false); assert.equal(recovered.data.run.secondUsed, false);
});

test('T20: result recap uses actual leaks and records only skills genuinely available in the current wave', () => {
  const { s } = make(); start(s);
  setSkills(s, ['K001', 'P001']);
  s.data.run.skillWaveStats = { '1:K001': { id: 'K001', wave: 1, availableTicks: 0, casts: 0 } };
  assert.deepEqual(s.recap(), []);
  s.data.run.battle.stats.leaks = [{ lane: 3 }, { lane: 3 }, { lane: 1 }];
  s.data.run.skillWaveStats['1:P001'] = { id: 'P001', wave: 1, availableTicks: 10, casts: 0 };
  assert.deepEqual(s.recap(), ['右路本局漏过2只怪物。', '本波技能P001曾可用但未施放。']);
  s.data.run.skillWaveStats['1:P001'].casts = 1;
  assert.deepEqual(s.recap(), ['右路本局漏过2只怪物。']);
});

test('T21: old run restoration cannot rewind account XP, consumed upgrades, or completed-wave grant identities', () => {
  const { s, storage } = make(); start(s); const earlyRun = clone(s.data.run);
  completeFixture(s); assert.equal(s.data.profile.trainingXp, 1);
  ok(s, 'camp'); s.data.profile.trainingXp += 47; s.data.profile.heroes.H001.level = 2; checkpoint(s);
  ok(s, 'hero', 'H001');
  ok(s, 'upgrade', { heroId: 'H001', expectedLevel: 2, transactionId: 'restore-upgrade' });
  assert.equal(s.data.profile.trainingXp, 28);
  assert.equal(s.restoreRun(earlyRun), true); ok(s, 'continueRun'); completeFixture(s);
  assert.equal(s.data.profile.trainingXp, 28);
  assert.equal(s.data.profile.heroes.H001.level, 3);
  assert.equal(s.data.profile.completedWaves, 1);
  assert.equal(Object.keys(s.data.profile.xpGrants).length, 1);
  assert.equal(s.data.profile.upgradeTransactions['restore-upgrade'].cost, 20);
  const recovered = reload(storage);
  assert.equal(recovered.data.profile.trainingXp, 28);
  assert.equal(recovered.data.profile.heroes.H001.level, 3);
});

test('T21: 20 technical wave completions yield exactly 20 XP; settlement does not regrant and a new run can grant', () => {
  const { s, storage } = make(); start(s);
  const firstId = s.data.run.id;
  for (let wave = 1; wave <= 20; wave++) {
    completeFixture(s);
    assert.equal(s.data.profile.trainingXp, wave);
    if (wave < 20) ok(s, 'chooseCard', s.data.run.candidates[0]);
  }
  assert.equal(s.data.run.cardHistory.length, 19);
  assert.equal(s.data.run.phase, 'victory');
  assert.equal(s.data.profile.completedWaves, 20);
  assert.equal(s.data.profile.heroes.H004.owned, true);
  const recovered = reload(storage); assert.equal(recovered.data.profile.trainingXp, 20);
  ok(recovered, 'newRun', { seed: config.sample_seed }); assert.notEqual(recovered.data.run.id, firstId);
  completeFixture(recovered); assert.equal(recovered.data.profile.trainingXp, 21);
});

test('T21: an unfinished eighth wave retains seven granted XP, free revival never invents the eighth grant', () => {
  const { s, storage } = make(); start(s);
  for (let w = 1; w <= 7; w++) { completeFixture(s); ok(s, 'chooseCard', s.data.run.candidates[0]); }
  failFixture(s, 8, true); ok(s, 'freeRevive');
  assert.equal(s.data.profile.trainingXp, 7); assert.equal(s.data.profile.completedWaves, 7);
  ok(s, 'endRun'); assert.equal(reload(storage).data.profile.trainingXp, 7);
});

test('T13/T21: restoring a pre-victory wave 20 snapshot does not count the same run victory twice', () => {
  const { s } = make(); start(s); s.battle!.beginWave(20);
  const beforeVictory = clone(s.data.run);
  completeFixture(s); assert.equal(s.data.profile.victories, 1);
  assert.equal(s.restoreRun(beforeVictory), true); ok(s, 'continueRun'); completeFixture(s);
  assert.equal(s.data.profile.trainingXp, 1);
  assert.equal(s.data.profile.victories, 1, 'run ID must be counted once outside the restorable run snapshot');
});

test('T22: 48 minus 20 becomes 28 atomically, repeated click rejects and Lv3 form is owned but not auto-equipped', () => {
  const { s, storage } = make(); s.data.profile.heroes.H001.level = 2; s.data.profile.trainingXp = 48;
  s.data.profile.completedWaves = 48; checkpoint(s); ok(s, 'hero', 'H001');
  const form = s.data.profile.heroes.H001.equippedForm;
  const payload = { heroId: 'H001', expectedLevel: 2, transactionId: 'exact-48-20' };
  ok(s, 'upgrade', payload); reject(s, 'upgrade', payload);
  assert.equal(s.data.profile.trainingXp, 28);
  assert.equal(s.data.profile.completedWaves, 48);
  assert.equal(s.data.profile.heroes.H001.level, 3);
  assert.deepEqual(s.data.profile.heroes.H001.ownedForms, ['H001-F01', 'H001-F02']);
  assert.equal(s.data.profile.heroes.H001.equippedForm, form);
  assert.equal(config.progression.damage_multipliers_by_level[2], 1.1);
  const recovered = reload(storage);
  assert.equal(recovered.data.profile.trainingXp, 28);
  assert.equal(recovered.data.profile.heroes.H001.equippedForm, form);
  ok(recovered, 'hero', 'H001'); reject(recovered, 'upgrade', payload);
  assert.equal(recovered.data.profile.trainingXp, 28);
});

test('T22: insufficient, unowned, maximum, stale-level and interrupted upgrades never partially charge or unlock', () => {
  const { s, storage } = make(); ok(s, 'hero', 'H001');
  reject(s, 'upgrade', { heroId: 'H001', expectedLevel: 1 });
  assert.equal(s.data.profile.trainingXp, 0);
  s.data.profile.trainingXp = 100; checkpoint(s);
  reject(s, 'upgrade', { heroId: 'H004', expectedLevel: 1 });
  reject(s, 'upgrade', { heroId: 'H001', expectedLevel: 2 });
  s.data.profile.heroes.H001.level = 5; checkpoint(s);
  reject(s, 'upgrade', { heroId: 'H001', expectedLevel: 5 });
  assert.equal(s.data.profile.trainingXp, 100);
  s.data.profile.heroes.H001.level = 2; checkpoint(s);
  storage.failWrites = true;
  reject(s, 'upgrade', { heroId: 'H001', expectedLevel: 2, transactionId: 'interrupted' });
  assert.equal(s.data.profile.trainingXp, 100);
  assert.equal(s.data.profile.heroes.H001.level, 2);
  assert.deepEqual(s.data.profile.heroes.H001.ownedForms, ['H001-F01']);
  storage.failWrites = false;
  const recovered = reload(storage); ok(recovered, 'hero', 'H001');
  ok(recovered, 'upgrade', { heroId: 'H001', expectedLevel: 2, transactionId: 'interrupted' });
  assert.equal(recovered.data.profile.trainingXp, 80);
});

test('T23/T24: permanent Lv3 still summons one-star without K; old/new run snapshots and forms stay separate', () => {
  const { s } = make();
  s.data.profile.heroes.H001.level = 2; s.data.profile.trainingXp = 48; checkpoint(s); start(s);
  const original = clone(s.data.run.snapshots), firstId = s.data.run.id;
  ok(s, 'camp'); ok(s, 'hero', 'H001'); ok(s, 'upgrade', { heroId: 'H001', expectedLevel: 2 });
  ok(s, 'equipForm', { heroId: 'H001', formId: 'H001-F02' });
  ok(s, 'open', 'camp'); configureRoster(s, ['H001']);
  ok(s, 'continueRun'); assert.deepEqual(s.data.run.snapshots, original);
  assert.deepEqual(s.data.run.battle.snapshots, original);
  assert.equal(s.data.run.snapshots.H001.form, 'H001-F01');
  summon(s, 'H001', 'L1-A'); assert.equal(s.data.run.battle.heroes[0].star, 1);
  assert.deepEqual(Object.keys(s.data.run.skills), []);
  ok(s, 'camp'); ok(s, 'newRun'); assert.equal(s.data.overlay, 'replace');
  assert.equal(s.data.run.id, firstId); ok(s, 'cancelReplace'); assert.equal(s.data.run.id, firstId);
  ok(s, 'newRun'); ok(s, 'newRun', { confirm: true, seed: config.sample_seed });
  assert.notEqual(s.data.run.id, firstId);
  assert.deepEqual(s.data.run.snapshots, { H001: { level: 3, form: 'H001-F02' } });
  assert.equal(s.data.profile.trainingXp, 28); assert.equal(s.data.run.battle.heroes.length, 0);
  summon(s, 'H001', 'L1-A'); assert.equal(s.data.run.battle.heroes[0].star, 1);
  assert.deepEqual(Object.keys(s.data.run.skills), []);
});

test('T24/T28: roster drafts reject empty/unowned teams, preserve order and require discard without altering current run', () => {
  const { s } = make(); start(s); const snapshots = clone(s.data.run.snapshots); ok(s, 'camp');
  ok(s, 'open', 'roster'); const roster = [...s.data.profile.roster];
  reject(s, 'rosterToggle', 'H004');
  for (const id of roster) ok(s, 'rosterToggle', id);
  reject(s, 'saveRoster'); assert.deepEqual(s.data.profile.roster, roster);
  ok(s, 'back'); assert.equal(s.data.overlay, 'discardRoster'); ok(s, 'discardRoster');
  assert.deepEqual(s.data.profile.roster, roster);
  ok(s, 'open', 'roster'); ok(s, 'rosterMove', { id: roster[1], direction: -1 }); ok(s, 'saveRoster');
  assert.deepEqual(s.data.profile.roster.slice(0, 2), [roster[1], roster[0]]);
  assert.deepEqual(s.data.run.snapshots, snapshots);
});

test('T13/T26: every legal 1–4 hero roster survives 19 selections with unique valid cards and persisted candidates', () => {
  const ids = config.heroes.map((h: any) => h.id);
  for (let mask = 1; mask < 16; mask++) {
    for (const seed of [1, config.sample_seed, 0x13579bdf]) {
      const fixture = make(); let s = fixture.s; unlockAll(s);
      const roster = ids.filter((_id: string, i: number) => mask & (1 << i)); configureRoster(s, roster);
      ok(s, 'newRun', { seed });
      for (let pick = 1; pick <= 19; pick++) {
        completeFixture(s);
        const cards = [...s.data.run.candidates], rng = s.data.run.rng;
        assert.equal(cards.length, 3, `mask ${mask} pick ${pick}`); assert.equal(new Set(cards).size, 3);
        const valid = eligibleCards(s.activeConfig, roster, s.data.run.cards, s.data.run.skills);
        assert.ok(valid.length >= 3); assert.ok(cards.every(id => valid.some(c => c.id === id)));
        s = reload(fixture.storage); ok(s, 'continueRun');
        assert.deepEqual(s.data.run.candidates, cards); assert.equal(s.data.run.rng, rng);
        const chosen = cards.find(id => config.cards.find((c: any) => c.id === id).max_picks !== null) || cards[0];
        ok(s, 'chooseCard', chosen);
        const count = s.data.run.cards[chosen], xp = s.data.profile.trainingXp;
        reject(s, 'chooseCard', chosen);
        assert.equal(s.data.run.cards[chosen], count); assert.equal(s.data.profile.trainingXp, xp);
        assert.equal(s.data.run.battle.wave, pick + 1);
      }
      assert.equal(s.data.run.cardHistory.length, 19);
      for (const c of config.cards.filter((c: any) => c.max_picks !== null)) s.data.run.cards[c.id] = c.max_picks;
      assert.deepEqual(eligibleCards(config, roster, s.data.run.cards, s.data.run.skills).map(c => c.id), ['C010', 'C011', 'C012']);
      completeFixture(s); assert.equal(s.data.run.phase, 'victory'); assert.equal(s.data.run.candidates.length, 0);
    }
  }
});

test('T28: overlays, background and camp pause the clock and returning restores the exact source state', () => {
  const { s, storage } = make(); start(s);
  ok(s, 'settings'); reject(s, 'startWave'); ok(s, 'closeOverlay'); assert.equal(s.data.run.phase, 'deploy');
  ok(s, 'startWave'); s.advance(1 / 60); const tick = s.data.run.battle.tick;
  ok(s, 'settings'); s.advance(30); assert.equal(s.data.run.battle.tick, tick);
  ok(s, 'camp'); s.advance(30); assert.equal(s.data.run.battle.tick, tick);
  const recovered = reload(storage); ok(recovered, 'continueRun');
  assert.equal(recovered.data.run.phase, 'battle'); assert.equal(recovered.data.overlay, null);
  assert.equal(recovered.data.run.battle.tick, tick);
  ok(recovered, 'pauseBackground'); recovered.advance(30);
  reject(recovered, 'summon', { heroId: 'H001', slot: 'L1-A' });
  assert.equal(recovered.data.run.battle.tick, tick);
  ok(recovered, 'resumeBackground'); recovered.advance(1 / 60); assert.equal(recovered.data.run.battle.tick, tick + 1);
  completeFixture(recovered); const candidates = [...recovered.data.run.candidates];
  ok(recovered, 'settings'); reject(recovered, 'chooseCard', candidates[0]);
  recovered.advance(20); ok(recovered, 'closeOverlay');
  assert.equal(recovered.data.run.phase, 'cards'); assert.deepEqual(recovered.data.run.candidates, candidates);
  reject(recovered, 'summon', { heroId: 'H001', slot: 'L1-A' });
  reject(recovered, 'startWave');
});

test('T11/T22: competing windows and storage interruption preserve the last complete durable transaction', () => {
  const { s, storage } = make(); checkpoint(s);
  const other = reload(storage);
  ok(s, 'setting', { key: 'music', value: 0.2 });
  reject(other, 'setting', { key: 'music', value: 0.9 });
  assert.equal(reload(storage).data.profile.settings.music, 0.2);
  const fresh = reload(storage); start(fresh); failFixture(fresh, 8, true); ok(fresh, 'adRequest');
  const id = fresh.data.run.ad.id, energy = fresh.data.run.battle.energy;
  storage.failWrites = true; reject(fresh, 'adResult', { id, result: 'completed' });
  assert.equal(fresh.data.run.phase, 'adPending'); assert.equal(fresh.data.run.secondUsed, false);
  assert.equal(fresh.data.run.battle.energy, energy);
  storage.failWrites = false;
  const restored = reload(storage); ok(restored, 'continueRun');
  assert.equal(restored.data.run.phase, 'adPending');
  ok(restored, 'adResult', { id, result: 'completed' });
  assert.equal(restored.data.run.battle.energy, energy + 80);
  assert.equal(restored.data.profile.trainingXp, 1);
});
