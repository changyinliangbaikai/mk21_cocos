import test from 'node:test';
import assert from 'node:assert/strict';
import { R1Session, R1_SAVE_KEY } from '../assets/scripts/domain/r1/session';
import { copy } from '../assets/scripts/domain/r1/model';
import { deployHero, showDraft } from '../assets/scripts/domain/r1/cards';

class MemoryStorage {
  data = new Map<string, string>();
  fail = false;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.fail) throw new Error('disk full'); this.data.set(key, value); }
}

for (const opening of [true, false]) test(`C035 ${opening ? 'opening' : 'energy'} draft pauses and resumes without rerolling cards`, () => {
  const storage = new MemoryStorage(), session = new R1Session(storage);
  session.start(1, 3501);
  if (!opening) {
    const run = session.data.run!;
    deployHero(run, 'RH02', 0); deployHero(run, 'RH03', 1); deployHero(run, 'RH01', 2);
    run.drawQueue = ['energy']; run.candidates = []; run.wave = 1; showDraft(run);
  }
  const before = copy(session.data.run!);
  assert.equal(session.pause(true), true);
  const paused = copy(session.data.run!);
  for (let n = 0; n < 60; n++) session.tick(1 / 60);
  assert.deepEqual(session.data.run, paused);
  assert.equal(session.choose(paused.candidates[0].id), false);
  assert.equal(session.pause(false), true);
  assert.deepEqual(session.data.run, before);
  const restored = new R1Session(storage);
  assert.equal(restored.error, '');
  assert.deepEqual(restored.data.run, before);
});

test('C035 end-run removes the active save without defeat reward, advancement or loss of permanent resources', () => {
  const storage = new MemoryStorage(), session = new R1Session(storage);
  session.data.profile.fragments.RH02 = 8;
  session.start(1, 3502);
  const run = session.data.run!;
  run.incentive!.minionDeaths.fill(30, 0, 10);
  run.incentive!.bossDeaths = [...run.incentive!.bossQuota];
  run.incentive!.checkpoint = 10;
  const profile = copy(session.data.profile);
  session.pause(true);
  assert.equal(session.endRun(), true);
  assert.equal(session.inBattle, false);
  assert.equal(session.data.run, null);
  assert.equal(session.data.settlement, null);
  assert.deepEqual(session.data.profile, profile);
  assert.equal(session.resume(), false);
  assert.equal(session.endRun(), false);
  const restored = new R1Session(storage);
  assert.equal(restored.error, '');
  assert.equal(restored.data.run, null);
  assert.deepEqual(restored.data.profile, profile);
  assert.equal(restored.start(1, 3503), true);
  assert.equal(restored.data.run!.drawQueue.length, 3);
});

test('C035 failed end-run keeps the paused battle until retry commits and exits battle', () => {
  const storage = new MemoryStorage(), session = new R1Session(storage);
  session.start(1, 3504); session.pause(true);
  const before = copy(session.data), persisted = storage.getItem(R1_SAVE_KEY);
  storage.fail = true;
  assert.equal(session.endRun(), false);
  assert.deepEqual(session.data, before);
  assert.equal(session.inBattle, true);
  assert.equal(storage.getItem(R1_SAVE_KEY), persisted);
  session.tick(1); assert.deepEqual(session.data, before);
  storage.fail = false;
  assert.equal(session.retrySave(), true);
  assert.equal(session.data.run, null);
  assert.equal(session.inBattle, false);
  assert.deepEqual(session.data.profile, before.profile);
  assert.equal(new R1Session(storage).data.run, null);
});

test('C035 end-run rejects running and settled battles; save-and-camp preserves an opening draft', () => {
  const storage = new MemoryStorage(), session = new R1Session(storage);
  session.start(1, 3505);
  assert.equal(session.endRun(), false);
  session.pause(true);
  const before = copy(session.data.run);
  assert.equal(session.camp(), true);
  assert.deepEqual(session.data.run, before);
  assert.equal(session.resume(), true);
  assert.equal(session.data.run!.paused, true);
  session.pause(false); session.data.run!.status = 'victory'; session.tick(0);
  const finished = copy(session.data);
  assert.equal(session.endRun(), false);
  assert.deepEqual(session.data, finished);
});
