import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateConfig } from '../assets/scripts/domain/config';
import { GameSession, SAVE_KEY, type StoragePort } from '../assets/scripts/domain/session';

// This is the archived config actually shipped with v005, including its original
// 430 roots / 1214 energy economy. Never relabel the new economy as an old save.
const legacy = JSON.parse(readFileSync('docs/design/configs/history/prototype-v0.5.json', 'utf8'));
const current = JSON.parse(readFileSync('docs/design/configs/history/prototype-v0.6.json', 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
class MemoryStorage implements StoragePort {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}
function command(session: GameSession, name: string, payload?: any): void {
  assert.equal(session.dispatch(name, payload), true, `${name}: ${session.data.notice}`);
}
function make(config = legacy): { session: GameSession; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  return { session: new GameSession(config, storage), storage };
}
function start(session: GameSession): void {
  command(session, 'newRun', { seed: legacy.sample_seed });
}
function savedRun(storage: StoragePort): any { return JSON.parse(storage.getItem(SAVE_KEY)!).run; }
function reload(storage: StoragePort, config = current): GameSession {
  const session = new GameSession(config, storage);
  assert.doesNotMatch(session.data.notice, /读取失败/);
  return session;
}
/** A deterministic kill fixture exercises real spawn/death/reward accounting.
 * It skips combat damage output, not the reward ledger or session transitions. */
function killNextRoot(session: GameSession): { reward: number; type: string } {
  let enemy = session.battle!.state.enemies.find(e => !e.terminal);
  for (let ticks = 0; !enemy && ticks < 1200; ticks++) {
    session.advance(1 / 60);
    enemy = session.battle!.state.enemies.find(e => !e.terminal);
  }
  assert.ok(enemy, 'fixture must reach a real queued root');
  const before = session.battle!.state.energy;
  session.battle!.damage(enemy.id, 99999);
  session.battle!.flushDamage();
  return { reward: session.battle!.state.energy - before, type: enemy.type };
}

test('config versions: archived 0.5 and current 0.6 retain different real economies and both validate fully', () => {
  assert.equal(legacy.design_version, '0.5');
  assert.equal(legacy.expected_totals.root_monsters, 430);
  assert.equal(legacy.expected_totals.ordinary_energy_budget, 1214);
  assert.equal(legacy.monsters.find((m: any) => m.id === 'M001').reward_energy, 2);
  assert.equal(current.design_version, '0.6');
  assert.ok(current.expected_totals.ordinary_energy_budget > legacy.expected_totals.ordinary_energy_budget);
  assert.notDeepEqual(current.waves, legacy.waves);
  for (const config of [legacy, current]) {
    validateConfig(config);
    const wrongBudget = clone(config); wrongBudget.waves[0].energy_budget++;
    assert.throws(() => validateConfig(wrongBudget), /预算/);
    const wrongReference = clone(config); wrongReference.heroes[0].player_skill_id = 'missing';
    assert.throws(() => validateConfig(wrongReference), /引用/);
    const incomplete = clone(config); incomplete.monsters.pop();
    assert.throws(() => validateConfig(incomplete), /monsters数量/);
  }
  const future = clone(current); future.design_version = '0.8';
  assert.throws(() => validateConfig(future), /不支持的设计版本/);
  assert.throws(() => validateConfig(null), /不支持的设计版本/);
});

test('config versions: new client reload preserves the complete old run, already paid kills, queue and remaining budget', () => {
  const { session: old, storage } = make(); start(old);
  command(old, 'summon', { heroId: 'H001', slot: 'R1' });
  command(old, 'startWave');
  assert.equal(killNextRoot(old).reward, 2);
  command(old, 'camp');
  const before = clone(savedRun(storage)), profile = clone(old.data.profile), durable = storage.getItem(SAVE_KEY);
  const resumed = reload(storage);
  assert.equal(resumed.config.design_version, '0.6');
  assert.equal(resumed.activeConfig.design_version, '0.5');
  assert.equal(resumed.battle!.config.design_version, '0.5');
  assert.deepEqual(resumed.data.run, before);
  assert.deepEqual(resumed.data.profile, profile);
  assert.equal(storage.getItem(SAVE_KEY), durable, 'loading alone must not rewrite or migrate an old save');
  assert.equal(resumed.data.notice, '旧局第1波保留原收益；新能量规则开新局生效');
  assert.deepEqual(reload(storage).data.run, before, 'repeated loads cannot grant energy');

  command(resumed, 'continueRun');
  const second = killNextRoot(resumed);
  assert.equal(second.reward, legacy.monsters.find((m: any) => m.id === second.type).reward_energy);
  assert.notEqual(second.reward, current.monsters.find((m: any) => m.id === second.type).reward_energy);
  assert.equal(resumed.battle!.state.stats.energyGained, 4);
  assert.equal(resumed.battle!.remainingBudget(), legacy.waves[0].energy_budget - 4);
  command(resumed, 'camp');
  assert.equal(resumed.data.notice, '旧局第1波保留原收益；新能量规则开新局生效');
  assert.deepEqual(reload(storage).data.run, savedRun(storage));
});

test('config versions: grandpa advance, paid ledger and calm-wave zero rewards survive loading on 0.6', () => {
  const { session: old, storage } = make(); start(old);
  command(old, 'startWave');
  assert.equal(killNextRoot(old).reward, 2);
  // Technical failure fixture reaches the real once-only rescue transaction.
  old.battle!.state.baseHp = 0; old.battle!.state.result = 'failed';
  old.advance(1 / 60);
  assert.equal(old.data.run.phase, 'firstFailure');
  command(old, 'grandpa');
  assert.deepEqual(old.data.run.lastRescue, { type: 'grandpa', wave: 1, remaining: legacy.waves[0].energy_budget - 2, advance: legacy.waves[1].energy_budget });
  command(old, 'chooseCard', old.data.run.candidates[0]);
  command(old, 'camp');
  const before = clone(savedRun(storage)), resumed = reload(storage);
  assert.deepEqual(resumed.data.run, before);
  assert.equal(resumed.data.run.grandpaUsed, true);
  assert.equal(resumed.data.run.calmWave, 2);
  assert.equal(resumed.battle!.state.calm, true);
  assert.equal(resumed.data.notice, '旧局第2波保留原收益；新能量规则开新局生效');
  assert.equal(resumed.forecast().budget, 0);
  assert.equal(resumed.battle!.state.energy, legacy.run.starting_energy + legacy.waves[0].energy_budget + legacy.waves[1].energy_budget);

  command(resumed, 'continueRun'); command(resumed, 'startWave');
  const balance = resumed.battle!.state.energy;
  assert.equal(killNextRoot(resumed).reward, 0);
  assert.equal(resumed.battle!.state.energy, balance);
  command(resumed, 'camp');
  const duringCalm = clone(savedRun(storage)), again = reload(storage);
  assert.deepEqual(again.data.run, duringCalm);
  command(again, 'continueRun');
  again.battle!.clearWave(false); again.advance(1 / 60);
  assert.equal(again.data.run.calmWave, null);
  assert.equal(again.data.run.phase, 'cards');
  assert.equal(again.battle!.state.energy, balance);
  command(again, 'chooseCard', again.data.run.candidates[0]); command(again, 'startWave');
  const afterCalm = killNextRoot(again);
  assert.equal(afterCalm.reward, legacy.monsters.find((m: any) => m.id === afterCalm.type).reward_energy);
  assert.equal(again.data.run.grandpaUsed, true);
});

test('config versions: explicit replacement starts 0.6 while retaining earned levels, forms and profile ledgers', () => {
  const { session: old, storage } = make();
  // Fixture represents experience earned before the current run; the actual
  // upgrade/equip commands still debit it and write their durable transactions.
  old.data.profile.trainingXp = 80;
  command(old, 'hero', 'H001');
  command(old, 'upgrade', { heroId: 'H001', expectedLevel: 1, transactionId: 'legacy-upgrade-1' });
  command(old, 'upgrade', { heroId: 'H001', expectedLevel: 2, transactionId: 'legacy-upgrade-2' });
  command(old, 'equipForm', { heroId: 'H001', formId: 'H001-F02' });
  command(old, 'open', 'camp'); start(old); command(old, 'camp');
  const oldRun = clone(old.data.run), profile = clone(old.data.profile), updated = reload(storage);
  command(updated, 'newRun');
  assert.equal(updated.data.overlay, 'replace');
  assert.deepEqual(updated.data.run, oldRun);
  assert.deepEqual(updated.data.profile, profile);
  command(updated, 'newRun', { confirm: true, seed: legacy.sample_seed + 1 });
  assert.notEqual(updated.data.run.id, oldRun.id);
  assert.deepEqual(updated.data.run.config, current);
  assert.equal(updated.data.run.configVersion, '0.6');
  assert.equal(updated.activeConfig.design_version, '0.6');
  assert.equal(updated.data.run.battle.energy, current.run.starting_energy);
  assert.equal(updated.battle!.remainingBudget(), current.waves[0].energy_budget);
  assert.equal(updated.data.run.grandpaUsed, false);
  assert.equal(updated.data.run.calmWave, null);
  assert.deepEqual(updated.data.run.snapshots.H001, { level: 3, form: 'H001-F02' });
  assert.deepEqual(updated.data.profile, profile);
  const persisted = reload(storage);
  assert.deepEqual(persisted.data.profile, profile);
  assert.equal(persisted.data.run.id, updated.data.run.id);
  assert.deepEqual(persisted.data.run.config, current);
  assert.equal(persisted.data.notice, '已恢复第1波存档，点击继续防守。');
});

test('config versions: restoreRun accepts both real versions and never rolls the account back', () => {
  const { session: target, storage } = make(current);
  target.data.profile.trainingXp = 37;
  command(target, 'setting', { key: 'music', value: 0.25 });
  const profile = clone(target.data.profile);
  for (const config of [legacy, current]) {
    const { session: source } = make(config); start(source);
    const run = clone(source.data.run);
    assert.equal(target.restoreRun(run), true);
    assert.deepEqual(target.data.run, run);
    assert.deepEqual(target.data.profile, profile);
    assert.deepEqual(reload(storage).data.run, run);
    assert.deepEqual(reload(storage).data.profile, profile);
  }
});

test('config versions: restoreRun rejects future, mismatched and incomplete configs atomically', () => {
  const { session: target, storage } = make(current); start(target);
  const existingRun = clone(target.data.run), profile = clone(target.data.profile), durable = storage.getItem(SAVE_KEY);
  for (const config of [legacy, current]) {
    const { session: source } = make(config); start(source);
    const alterations = [
      (run: any) => { run.configVersion = '0.8'; run.config.design_version = '0.8'; },
      (run: any) => { run.configVersion = config.design_version === '0.5' ? '0.6' : '0.5'; },
      (run: any) => { run.config.waves[0].energy_budget++; },
      (run: any) => { run.config.heroes[0].player_skill_id = 'missing'; },
      (run: any) => { run.config.monsters.pop(); },
      (run: any) => { delete run.config; },
      (run: any) => { delete run.battle; },
    ];
    for (const alter of alterations) {
      const invalid = clone(source.data.run); alter(invalid);
      assert.equal(target.restoreRun(invalid), false);
      assert.deepEqual(target.data.run, existingRun);
      assert.deepEqual(target.data.profile, profile);
      assert.equal(storage.getItem(SAVE_KEY), durable, 'failed restore must not commit any partial save');
    }
  }
});

test('config versions: corrupted stored run configs block writes without silently restarting the old run', () => {
  const { session: old, storage } = make(); start(old); command(old, 'camp');
  const original = JSON.parse(storage.getItem(SAVE_KEY)!);
  for (const alter of [
    (run: any) => { run.configVersion = '0.8'; run.config.design_version = '0.8'; },
    (run: any) => { run.configVersion = '0.6'; },
    (run: any) => { run.config.waves[0].energy_budget++; },
  ]) {
    const saved = clone(original); alter(saved.run); const raw = JSON.stringify(saved);
    const broken = new MemoryStorage(); broken.setItem(SAVE_KEY, raw);
    const updated = new GameSession(current, broken);
    assert.match(updated.data.notice, /存档读取失败/);
    assert.equal(updated.dispatch('newRun', { confirm: true }), false);
    assert.equal(broken.getItem(SAVE_KEY), raw);
  }
});

test('config versions: normal same-version and no-active-run recovery notices are unchanged', () => {
  for (const config of [legacy, current]) {
    const { session, storage } = make(config); start(session); command(session, 'camp');
    assert.equal(reload(storage, config).data.notice, '已恢复第1波存档，点击继续防守。');
  }
  const { session: old, storage } = make();
  command(old, 'setting', { key: 'music', value: 0.3 });
  assert.equal(reload(storage).data.notice, '本机进度已恢复。');
  start(old); command(old, 'endRun'); command(old, 'camp');
  assert.equal(reload(storage).data.notice, '本机进度已恢复。');
});
