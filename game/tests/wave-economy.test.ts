import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Battle, generateWave } from '../assets/scripts/domain/battle';
import { GameSession, type StoragePort } from '../assets/scripts/domain/session';

const current = JSON.parse(readFileSync('docs/design/configs/history/prototype-v0.6.json', 'utf8'));
const previous = JSON.parse(readFileSync('docs/design/configs/history/prototype-v0.5.json', 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const monster = (id: string, config = current): any => config.monsters.find((m: any) => m.id === id);

class MemoryStorage implements StoragePort {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}
function command(s: GameSession, name: string, payload?: any): void {
  assert.equal(s.dispatch(name, payload), true, `${name}: ${s.data.notice}`);
}
function kill(b: Battle, enemy: any): void {
  b.damage(enemy.id, 1_000_000); b.flushDamage();
}
/** Exercise ordinary deaths and child creation against every preallocated root ledger. */
function killEntirePublishedWave(b: Battle): void {
  for (const row of b.state.queue) b.spawn(row.type, row.lane, b.config.world.spawn_y, row.ledgerId);
  b.state.spawnIndex = b.state.queue.length;
  while (b.state.enemies.some(e => !e.terminal)) {
    for (const enemy of b.state.enemies.filter(e => !e.terminal)) kill(b, enemy);
  }
}

test('v0.6 economy: all 20 non-Boss waves yield at least 80 and root counts strictly increase, including wave 20', () => {
  assert.equal(current.design_version, '0.6');
  assert.equal(current.run.summon_cost, 40);
  assert.ok(current.heroes.every((h: any) => h.summon_energy === 40));
  assert.equal(monster('B001').reward_energy, 200, 'Boss body itself pays 200');
  let last = 0, roots = 0, nonBossEnergy = 0, bossEnergy = 0, splitParents = 0;
  for (const w of current.waves) {
    const rows = generateWave(current, current.sample_seed, w.wave);
    const ordinary = rows.filter(r => monster(r.type).control_class !== 'boss');
    const boss = rows.filter(r => monster(r.type).control_class === 'boss');
    const ordinaryBudget = ordinary.reduce((n, r) => n + monster(r.type).reward_energy, 0);
    const bossBudget = boss.reduce((n, r) => n + monster(r.type).reward_energy, 0);
    assert.equal(ordinary.length, 8 + 2 * (w.wave - 1));
    assert.ok(ordinary.length > last, `wave ${w.wave} regressed non-Boss count`);
    assert.ok(ordinaryBudget >= 80, `wave ${w.wave} is short of two summons`);
    assert.equal(w.non_boss_root_count, ordinary.length);
    assert.equal(w.non_boss_energy_budget, ordinaryBudget);
    assert.equal(w.boss_energy_budget, bossBudget);
    assert.equal(w.root_count, rows.length);
    assert.equal(w.energy_budget, ordinaryBudget + bossBudget);
    last = ordinary.length; roots += rows.length; nonBossEnergy += ordinaryBudget; bossEnergy += bossBudget;
    splitParents += rows.filter(r => r.type === 'M004').length;
  }
  assert.equal(current.waves[19].non_boss_energy_budget, 488);
  assert.equal(current.waves[19].energy_budget, 688);
  assert.deepEqual([roots, splitParents, nonBossEnergy, bossEnergy], [541, 23, 5586, 200]);
  assert.equal(roots, current.expected_totals.root_monsters);
  assert.equal(splitParents * 3, current.expected_totals.max_split_children);
  assert.equal(roots + splitParents * 3, current.expected_totals.max_spawned_entities);
  assert.equal(nonBossEnergy + bossEnergy, current.expected_totals.ordinary_energy_budget);
  assert.equal(120 + nonBossEnergy + bossEnergy, current.expected_totals.starting_plus_ordinary_energy);
});

test('v0.6 economy: published CSV matches all actual root spawn rows and per-root rewards', () => {
  const csv = readFileSync('docs/design/configs/history/wave-spawns-seed-20260912-v0.6.csv', 'utf8')
    .trim().split(/\r?\n/).slice(1).map(line => line.split(','));
  const actual = current.waves.flatMap((w: any) => generateWave(current, current.sample_seed, w.wave));
  assert.equal(csv.length, 541); assert.equal(actual.length, csv.length);
  actual.forEach((r: any, i: number) => {
    assert.deepEqual([r.wave, r.index, r.type, r.lane, r.tick, monster(r.type).reward_energy],
      [+csv[i][0], +csv[i][2], csv[i][3], +csv[i][4], +csv[i][5], +csv[i][7]]);
    assert.equal(Number((r.tick / current.clock.tick_hz).toFixed(6)), +csv[i][6]);
  });
});

test('v0.6 economy: all published waves pay their exact budgets through actual death and split ledgers', () => {
  let total = 0, spawned = 0;
  for (const w of current.waves) {
    const b = new Battle(current, { wave: w.wave, seed: current.sample_seed, energy: 0 });
    assert.equal(b.remainingBudget(), w.energy_budget);
    killEntirePublishedWave(b);
    assert.equal(b.state.energy, w.energy_budget, `wave ${w.wave} actual payout`);
    assert.equal(b.state.stats.energyGained, w.energy_budget);
    assert.equal(b.remainingBudget(), 0);
    assert.ok(b.state.ledger.every(e => e.resolved && e.claimed === e.budget && e.voided === 0));
    const before = b.state.energy;
    for (const e of b.state.enemies) kill(b, e);
    assert.equal(b.clearWave(true), 0);
    assert.equal(b.state.energy, before, 'dead entities and repeated clear cannot pay twice');
    total += b.state.energy; spawned += b.state.stats.spawned;
  }
  assert.equal(total, 5786); assert.equal(spawned, 610);
});

test('v0.6 economy: split parent pays zero; killed, leaked, rescued child shares sum to one family budget', () => {
  const parentDef = monster('M004'), childDef = monster(parentDef.split.child_id);
  assert.equal(parentDef.reward_energy, 12);
  assert.equal(parentDef.split.reward_budget_shared, parentDef.reward_energy);
  assert.equal(parentDef.split.normal_parent_death_reward, 0);
  assert.equal(childDef.reward_energy * parentDef.split.count, parentDef.reward_energy);
  const b = new Battle(current, { wave: 9, energy: 0, baseHp: 1000 });
  b.state.queue = []; b.state.ledger = [];
  const parent = b.spawn('M004', 1, 300); kill(b, parent);
  assert.equal(b.state.energy, 0);
  const children = b.state.enemies.filter(e => e.type === 'M004-S');
  assert.equal(children.length, 3); assert.ok(children.every(e => e.budgetShare === 4));
  kill(b, children[0]); assert.equal(b.state.energy, 4);
  children[1].y = current.world.base_y - 0.01; b.step();
  assert.equal(children[1].terminal, 'leaked'); assert.equal(b.remainingBudget(), 4);
  assert.equal(b.clearWave(true), 4); assert.equal(b.state.energy, 8);
  assert.deepEqual(b.state.ledger.map(e => [e.budget, e.claimed, e.voided, e.resolved]), [[12, 8, 4, true]]);
  assert.equal(b.clearWave(true), 0); assert.equal(b.state.energy, 8);
});

test('v0.6 economy: Boss ordinary death pays exactly 200, while a calm wave pays nothing including Boss and split children', () => {
  const b = new Battle(current, { wave: 20, energy: 0 }); b.state.queue = []; b.state.ledger = [];
  const boss = b.spawn('B001', 2, 300); kill(b, boss);
  assert.equal(b.state.energy, 200); kill(b, boss); assert.equal(b.state.energy, 200);
  const calm = new Battle(current, { wave: 20, energy: 37, calm: true });
  killEntirePublishedWave(calm);
  assert.equal(calm.state.energy, 37); assert.equal(calm.state.stats.energyGained, 0);
  assert.ok(calm.state.ledger.every(e => e.claimed === 0 && e.voided === e.budget && e.resolved));
});

test('v0.6 economy: grandpa advances the actual Boss-wave budget and the entire next wave remains calm', () => {
  const s = new GameSession(current, new MemoryStorage()); command(s, 'newRun', { seed: current.sample_seed });
  s.battle!.beginWave(19); s.data.run.phase = 'firstFailure'; s.data.run.battle.baseHp = 0;
  const energy = s.data.run.battle.energy;
  command(s, 'grandpa');
  assert.deepEqual(s.data.run.lastRescue, { type: 'grandpa', wave: 19, remaining: 468, advance: 688 });
  assert.equal(s.data.run.battle.energy - energy, 468 + 688);
  assert.equal(s.data.run.calmWave, 20);
  assert.equal(s.forecast().budget, 0);
  assert.equal(s.dispatch('grandpa'), false);
  command(s, 'chooseCard', s.data.run.candidates[0]); command(s, 'startWave');
  const afterRescue = s.data.run.battle.energy;
  killEntirePublishedWave(s.battle!); s.advance(1 / current.clock.tick_hz);
  assert.equal(s.data.run.battle.energy, afterRescue);
  assert.equal(s.data.run.phase, 'victory'); assert.equal(s.data.run.calmWave, null);
  assert.equal(s.data.profile.trainingXp, 2, 'calm wave retains training XP');
});

test('v0.6 economy: updating the application preserves a v0.5 run snapshot and only a confirmed new run takes v0.6', () => {
  const storage = new MemoryStorage(), old = new GameSession(previous, storage);
  command(old, 'newRun', { seed: previous.sample_seed });
  old.battle!.step(); kill(old.battle!, old.data.run.battle.enemies[0]);
  assert.equal(old.data.run.battle.energy, 122);
  command(old, 'setting', { key: 'music', value: 0.6 });
  const stored = clone(old.data.run);
  const updated = new GameSession(current, storage);
  assert.doesNotMatch(updated.data.notice, /读取失败/);
  assert.equal(updated.data.run.configVersion, '0.5');
  assert.deepEqual(updated.data.run.config, stored.config);
  assert.deepEqual(updated.data.run.battle, stored.battle);
  assert.equal(updated.battle!.remainingBudget(), 14);
  assert.equal(updated.restoreRun(stored), true, 'supported old snapshots remain restorable');
  command(updated, 'newRun'); assert.equal(updated.data.overlay, 'replace');
  assert.deepEqual(updated.data.run.battle, stored.battle, 'opening confirmation does not mutate the old run');
  command(updated, 'newRun', { confirm: true, seed: current.sample_seed });
  assert.equal(updated.data.run.configVersion, '0.6');
  assert.equal(updated.data.run.battle.energy, 120);
  assert.equal(updated.battle!.remainingBudget(), 80);
  updated.battle!.step(); kill(updated.battle!, updated.data.run.battle.enemies[0]);
  assert.equal(updated.data.run.battle.energy, 130);
});

test('v0.6 economy: reward changes do not silently increase HP, speed, damage or rescue limits', () => {
  for (const old of previous.monsters) {
    const next = clone(monster(old.id)), before = clone(old);
    delete next.reward_energy; delete before.reward_energy;
    if (next.split) { delete next.split.reward_budget_shared; delete before.split.reward_budget_shared; }
    assert.deepEqual(next, before, `${old.id} has a non-economy change`);
  }
  assert.deepEqual(current.rescue, previous.rescue);
  assert.deepEqual(current.run, previous.run);
  assert.deepEqual(current.waves.map((w: any) => [w.hp_multiplier, w.target_combat_seconds]),
    previous.waves.map((w: any) => [w.hp_multiplier, w.target_combat_seconds]));
});
