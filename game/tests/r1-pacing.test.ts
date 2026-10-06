import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, reconcileBattle, stepBattle } from '../assets/scripts/domain/r1/battle';
import { chooseCard, deployHero } from '../assets/scripts/domain/r1/cards';
import { damageEnemy } from '../assets/scripts/domain/r1/combat';
import { enemyDef } from '../assets/scripts/domain/r1/config';
import { Run, copy } from '../assets/scripts/domain/r1/model';
import { freshProfile } from '../assets/scripts/domain/r1/rewards';
import { R1Session, R1_SAVE_KEY, validateSave } from '../assets/scripts/domain/r1/session';
import { advanceWaves, spawnEnemy } from '../assets/scripts/domain/r1/waves';

function field() {
  const r = createRun(freshProfile(), 1, 3801, 'pacing');
  r.drawQueue = []; r.candidates = []; deployHero(r, 'RH02', 0);
  return r;
}
function kill(r: Run, wave = 1, id = 'RM01') {
  const e = spawnEnemy(r, { id, x: .5, trait: null }, wave);
  damageEnemy(r, e, 999999, 'global', 'test');
  r.enemies = r.enemies.filter(e => e.hp > 0);
}
function storage() {
  const entries = new Map<string, string>();
  return { getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string, v: string) => { entries.set(k, v); } };
}

function legacyQuota(r: Run, quota: number) {
  delete r.tuning!.minionsPerWave;
  if (quota === 30) delete r.tuning!.minionEnergy; else r.tuning!.minionEnergy = 100 / quota;
  r.tuning!.version = quota === 30 ? 'R1.2.3' : quota === 50 ? 'R1.2.4' : 'R1.2.5';
  r.tuning!.crowd = {throughWave:15,batchSize:quota===60?20:10,interval:quota===60?.1:1/6,period:quota===30?9:quota===50?6:3,clearDelay:quota===30?1:2};
  r.plans = r.plans.map(w => w.slice(0, quota));
}

test('C040 each wave releases three visible groups of forty and only then starts the five-second transition', () => {
  const r = field(), times: number[] = [];
  for (let tick = 0; tick <= 477; tick++) {
    const before = r.spawnedMinions; advanceWaves(r, 1 / 60);
    if (r.spawnedMinions > before) times.push(tick / 60);
  }
  assert.equal(times.length, 120);
  assert.deepEqual([0, 40, 80].map(i => times[i]), [0, 3, 6]);
  assert.deepEqual([39, 79, 119].map(i => times[i]), [1.95, 4.95, 7.95]);
  for (let n = 0; n < 299; n++) advanceWaves(r, 1 / 60);
  assert.equal(r.wave, 1); advanceWaves(r, 1 / 60); assert.equal(r.wave, 2);
  assert.equal(r.enemies.length, 120); // Transition never discards an earlier group.
});

test('C040 clearing a batch keeps the three-second start spacing and never skips an unreleased minion', () => {
  const r = field();
  for (let n = 0; n <= 117; n++) advanceWaves(r, 1 / 60);
  assert.equal(r.released, 40); r.enemies = [];
  for (let n = 0; n < 62; n++) advanceWaves(r, 1 / 60);
  assert.equal(r.released, 40); advanceWaves(r, 1 / 60); assert.equal(r.released, 41);
  for (let n = 0; n < 3000 && r.released < 120; n++) { r.enemies = []; advanceWaves(r, 1 / 60); }
  assert.equal(r.wave, 1); assert.equal(r.spawnedMinions, 120);
  r.enemies = []; advanceWaves(r, 1 / 60); assert.equal(r.wave, 2);
});

test('C040 a complete stage funds exactly 18 energy draws and leaves boss cards independent', () => {
  const r = field();
  for (let wave = 1; wave <= 15; wave++) {
    for (const entry of r.plans[wave - 1]) kill(r, wave, entry.id);
    assert.equal(r.energy, wave * 120 % 100);
    assert.equal(r.drawQueue.filter(q => q === 'energy').length, Math.floor(wave * 120 / 100));
    if ([5, 10, 15].includes(wave)) kill(r, wave, wave === 15 ? 'RL01' : 'RS01');
  }
  assert.equal(r.kills, 1803);
  assert.equal(r.drawQueue.filter(q => q === 'boss').length, 3);
  assert.equal(r.incentive!.checkpoint, 10);
  const s = new R1Session(storage()); s.data.run = r; validateSave(s.data);
});

test('C040 rescue debt consumes 300 energy while boss rewards remain selectable', () => {
  const r = field(); r.drawDebt = 3;
  for (let wave = 1; wave <= 4; wave++) {
    for (const entry of r.plans[wave - 1]) kill(r, wave, entry.id);
    if (wave === 1) kill(r, wave, 'RS01');
    assert.equal(r.drawDebt, Math.max(0, 3 - Math.floor(wave * 120 / 100)));
    assert.equal(r.drawQueue.filter(q => q === 'energy').length, Math.max(0, Math.floor(wave * 120 / 100) - 3));
  }
  assert.deepEqual(r.drawQueue, ['boss', 'energy']);
});

test('C040 a legacy 60-minion boss reward preserves the fractional energy carry', () => {
  const r = field(); legacyQuota(r, 60);
  for (let n = 0; n < 20; n++) kill(r);
  assert.equal(r.energy, 33); assert.equal(r.energyRemainder, 20);
  kill(r, 1, 'RS01');
  assert.equal(r.energy, 33); assert.equal(r.energyRemainder, 20); assert.deepEqual(r.drawQueue, ['boss']);
  for (let n = 20; n < 59; n++) kill(r);
  assert.equal(r.energy, 98); assert.equal(r.energyRemainder, 20); assert.deepEqual(r.drawQueue, ['boss']);
  kill(r); assert.equal(r.energy, 0); assert.equal(r.energyRemainder, 0);
  assert.deepEqual(r.drawQueue, ['boss', 'energy']);
});

test('C040 a forty-unit split formation keeps twenty enemies on each side inside the battlefield', () => {
  const r = field(), split = r.plans[0].slice(40, 80);
  assert.equal(split.filter(e => e.x < .5).length, 20);
  assert.equal(split.filter(e => e.x > .5).length, 20);
  assert.ok(r.plans.flat().every(e => e.x >= .06 && e.x <= .94));
});

test('C040 checkpoint waits for all 120 minions per wave, and final victory waits beyond the old 30 limit', () => {
  const r = field();
  for (let wave = 1; wave <= 5; wave++) for (let n = 0; n < 30; n++) kill(r, wave);
  kill(r, 5, 'RS01'); assert.equal(r.incentive!.checkpoint, 0);
  for (let wave = 1; wave <= 5; wave++) for (let n = 30; n < 120; n++) kill(r, wave);
  assert.equal(r.incentive!.checkpoint, 5);
  r.wave = 15; r.released = 30; reconcileBattle(r); assert.equal(r.status, 'active');
  r.released = 120; reconcileBattle(r); assert.equal(r.status, 'victory');
});

for (const quota of [30, 50, 60, 120]) test(`C040 ${quota}-minion mid-wave snapshot restores its exact energy and next batch`, () => {
  const mem = storage(), session = new R1Session(mem); session.start(1, 3902);
  const r = session.data.run!; r.drawQueue = []; r.candidates = [];
  deployHero(r, 'RH02', 0); r.wave = 1; r.released = 23; r.spawnTimer = .1;
  if (quota < 120) legacyQuota(r, quota);
  for (let n = 0; n < 23; n++) kill(r);
  validateSave(session.data);
  const original = JSON.stringify(session.data); mem.setItem(R1_SAVE_KEY, original);
  const resumed = new R1Session(mem); assert.equal(resumed.error, '');
  assert.equal(mem.getItem(R1_SAVE_KEY), original); assert.deepEqual(resumed.data, session.data);
  assert.equal(r.energy, quota === 30 ? 7 : quota === 50 ? 46 : quota === 60 ? 38 : 23);
  assert.equal(r.energyRemainder, quota === 60 ? 20 : undefined);
  assert.equal(r.drawQueue.length, quota === 30 ? 2 : 0);
  for (let n = 0; n < 200; n++) {
    for (const run of [r, resumed.data.run!]) {
      if (run.candidates.length) chooseCard(run, run.candidates[0].id);
      stepBattle(run);
    }
  }
  assert.deepEqual(resumed.data.run, r); validateSave(resumed.data);
  assert.equal(r.plans[0].length, quota);
});

test('C040 legacy energy and checkpoint quotas remain nine and thirty on restored battles', () => {
  const r = field(); legacyQuota(r, 30);
  for (let wave = 1; wave <= 5; wave++) for (let n = 0; n < 30; n++) kill(r, wave);
  kill(r, 5, 'RS01');
  assert.equal(r.incentive!.checkpoint, 5); assert.equal(r.energy, 50);
  assert.equal(r.drawQueue.filter(q => q === 'energy').length, 13);
  const s = new R1Session(storage()); s.data.run = r; validateSave(s.data);
  assert.equal(enemyDef('RM01').energyOnFinalDeath, 1); // New config cannot change this saved run.
});

test('C040 malformed energy or mixed old/new quotas preserve stored bytes and refuse writes', () => {
  for (const change of [
    (r: Run) => { r.tuning!.minionEnergy = 0; },
    (r: Run) => { delete r.tuning!.minionsPerWave; r.tuning!.minionEnergy = 7; },
    (r: Run) => { r.tuning!.minionsPerWave = 120.5; },
    (r: Run) => { delete r.tuning!.minionEnergy; },
    (r: Run) => { r.energyRemainder = 60; },
    (r: Run) => { r.energyRemainder = .5; },
    (r: Run) => { r.plans[0].length = 30; },
    (r: Run) => { r.released = 121; },
    (r: Run) => { r.incentive!.minionDeaths[0] = 121; },
  ]) {
    const mem = storage(), s = new R1Session(mem); s.start(1, 3803);
    const broken = copy(s.data); change(broken.run!);
    const raw = JSON.stringify(broken); mem.setItem(R1_SAVE_KEY, raw);
    const read = new R1Session(mem); assert.ok(read.error); assert.equal(read.start(1, 3804), false);
    assert.equal(mem.getItem(R1_SAVE_KEY), raw);
  }
});
