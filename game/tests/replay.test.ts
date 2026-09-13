import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GameSession } from '../assets/scripts/domain/session';

// These recordings were produced with 0.5. Their commands, ticks, IDs and results
// remain historical evidence; v0.6 economy is exercised by wave-economy.test.ts.
const config = JSON.parse(readFileSync('docs/design/configs/history/prototype-v0.5.json', 'utf8'));
const report = JSON.parse(readFileSync('game/tests/fixtures/lv1-automated-runs.json', 'utf8'));
assert.equal(config.design_version, '0.5');
assert.equal(report.configVersion, config.design_version);
assert.equal(report.summaries[0].seed, 20260912);
assert.equal(report.summaries[0].seed, config.sample_seed);

/** Replay recorded domain commands exactly, including card choice and wave setup.
 * UI gestures/animation and platform callbacks remain separate integration checks. */
function replay(summary: any, speed: number, restoreAtTick?: number): any {
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  let game = new GameSession(config, storage);
  const cmd = (type: string, payload?: any) => assert.equal(game.dispatch(type, payload), true, `${type}: ${game.data.notice}`);
  cmd('hero', 'H004'); cmd('praise', 'H004'); cmd('ackUnlock', 'H004'); cmd('back');
  cmd('open', 'roster'); cmd('rosterToggle', 'H004'); cmd('saveRoster');
  cmd('newRun', { seed: summary.seed });
  assert.equal(game.data.run.configVersion, '0.5');
  assert.deepEqual(game.data.run.config, config, 'replay uses the exact archived config');
  let cursor = 0, restored = false, iterations = 0;
  while (game.data.run.phase !== 'victory') {
    const r = game.data.run, s = r.battle;
    assert.ok(++iterations < summary.ticks + config.run.waves * 5, 'Replay stalled');
    assert.ok(!['defeat', 'firstFailure', 'secondFailure'].includes(r.phase), `Unexpected failure at wave ${s.wave}`);
    while (cursor < summary.commands.length && summary.commands[cursor].tick === s.tick && summary.commands[cursor].wave === s.wave) {
      const recorded = summary.commands[cursor++];
      if (recorded.type === 'cast') {
        cmd('aim', recorded.payload.id); cmd('cast', recorded.payload.target);
      } else cmd(recorded.type, recorded.type === 'setSpeed' ? speed : recorded.payload);
    }
    assert.equal(r.phase, 'battle', `Recorded commands did not start wave ${s.wave} at tick ${s.tick}`);
    if (!restored && restoreAtTick !== undefined && s.tick === restoreAtTick) {
      // An explicit pause persists the exact live state before replacing the process object.
      cmd('pauseBackground'); game = new GameSession(config, storage); cmd('continueRun'); restored = true;
    }
    game.advance(1 / (config.clock.tick_hz * speed));
  }
  const r = game.data.run, s = r.battle;
  assert.equal(cursor, summary.commands.length, 'Every recorded command was consumed');
  assert.equal(r.cardHistory.length, config.run.waves - 1);
  assert.equal(s.tick, summary.ticks);
  assert.equal(s.baseHp, summary.baseHp); assert.equal(s.energy, summary.energy);
  assert.equal(s.stats.spawned, summary.spawned); assert.equal(s.stats.killed, summary.killed);
  assert.equal(s.stats.leaked, summary.leaked); assert.equal(s.stats.damage, summary.damage);
  assert.equal(game.data.profile.trainingXp, summary.trainingXp);
  assert.deepEqual(r.cardHistory, summary.cardHistory); assert.deepEqual(r.snapshots, summary.snapshots);
  assert.deepEqual(r.waveReports, summary.waveReports);
  assert.deepEqual(r.commands, summary.commands.map((entry: any) => entry.type === 'setSpeed' ? { ...entry, payload: speed } : entry));
  return { game, battle: s, skills: r.skills, equipped: r.equipped, cards: r.cards, wall: r.timings.wall };
}

test('T01/T13/T21/T27: archived v0.5 legal Lv1 run replays all 20 waves and 499 terminal monsters', () => {
  assert.equal(report.kind, 'automated_legal_commands_not_human_playtest');
  replay(report.summaries[0], 1);
});

test('T01/T02/T24/T25: same recorded run at 2x with process restoration has identical battle state and half combat wall time', () => {
  const one = replay(report.summaries[0], 1);
  const two = replay(report.summaries[0], 2, 6000);
  assert.deepEqual(two.battle, one.battle);
  assert.deepEqual(two.skills, one.skills); assert.deepEqual(two.equipped, one.equipped); assert.deepEqual(two.cards, one.cards);
  assert.ok(Math.abs(two.wall * 2 - one.wall) < 1e-8);
});

test('P5: replayed victory flows to camp, spends earned XP on Lv2, and starts a fresh run with permanent growth', () => {
  const { game, battle } = replay(report.summaries[0], 1);
  const previousId = game.data.run.id;
  const cmd = (type: string, payload?: any) => assert.equal(game.dispatch(type, payload), true, `${type}: ${game.data.notice}`);
  assert.equal(game.data.profile.trainingXp, 20);
  cmd('camp'); cmd('hero', 'H004'); cmd('upgrade', { heroId: 'H004', expectedLevel: 1, transactionId: 'replay-victory-upgrade' });
  assert.equal(game.data.profile.trainingXp, 10); assert.equal(game.data.profile.heroes.H004.level, 2);
  cmd('back'); cmd('open', 'camp'); cmd('newRun', { seed: report.summaries[0].seed });
  assert.notEqual(game.data.run.id, previousId); assert.equal(game.data.run.phase, 'deploy');
  assert.equal(game.data.run.battle.wave, 1); assert.equal(game.data.run.battle.heroes.length, 0);
  assert.equal(game.data.run.snapshots.H004.level, 2); assert.equal(battle.snapshots.H004.level, 1);
  assert.equal(game.data.profile.trainingXp, 10); assert.equal(game.data.profile.completedWaves, 20);
  assert.deepEqual(game.data.run.skills, {}); assert.deepEqual(game.data.run.cardHistory, []);
  assert.equal(game.data.run.grandpaUsed, false); assert.equal(game.data.run.secondUsed, false);
});

test('P6: archived v0.5 native UI 99-command victory keeps identical rules and final state at 1x/2x', () => {
  const saved = JSON.parse(readFileSync('game/tests/fixtures/actual-lv1-victory-save.json', 'utf8'));
  const r = saved.run, b = r.battle;
  assert.equal(r.configVersion, '0.5');
  assert.equal(r.seed, 3841433793);
  assert.deepEqual(r.config, config, 'native recording is bound to the exact old snapshot');
  const summary = { seed:r.seed, commands:r.commands, ticks:b.tick, baseHp:b.baseHp, energy:b.energy,
    spawned:b.stats.spawned, killed:b.stats.killed, leaked:b.stats.leaked, damage:b.stats.damage,
    trainingXp:saved.profile.trainingXp, cardHistory:r.cardHistory, snapshots:r.snapshots, waveReports:r.waveReports };
  assert.equal(summary.commands.length, 99);
  const one = replay(summary, 1);
  const two = replay(summary, 2, 6000);
  // The browser evidence is a JSON save, so optional undefined event fields are absent.
  assert.deepEqual(JSON.parse(JSON.stringify(one.battle)), b);
  assert.deepEqual(JSON.parse(JSON.stringify(two.battle)), b);
  assert.deepEqual(two.skills, r.skills);
  assert.deepEqual(two.cards, r.cards);
});
