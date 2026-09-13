import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Battle, generateWave } from '../assets/scripts/domain/battle';
import { validateConfig } from '../assets/scripts/domain/config';
import { GameSession } from '../assets/scripts/domain/session';

const current = JSON.parse(readFileSync('docs/design/configs/prototype-v0.5.json', 'utf8'));
const v006 = JSON.parse(readFileSync('docs/design/configs/history/prototype-v0.6.json', 'utf8'));
const v005 = JSON.parse(readFileSync('docs/design/configs/history/prototype-v0.5.json', 'utf8'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const monster = (id: string, c = current): any => c.monsters.find((m: any) => m.id === id);
const bossWaves = [5, 10, 15, 20];
function kill(b: Battle, e: any): void { b.damage(e.id, 1_000_000); b.flushDamage(); }
function killWave(b: Battle): void {
  for (const row of b.state.queue) b.spawn(row.type, row.lane, b.config.world.spawn_y, row.ledgerId);
  b.state.spawnIndex = b.state.queue.length;
  while (b.state.enemies.some(e => !e.terminal)) for (const e of b.state.enemies.filter(e => !e.terminal)) kill(b, e);
}

test('v0.7 Boss config: current and exact archived versions validate without changing their flow/economy', () => {
  for (const c of [v005, v006, current]) validateConfig(c);
  assert.equal(current.design_version, '0.7');
  assert.equal(v005.design_version, '0.5'); assert.equal(v006.design_version, '0.6');
  assert.equal(v005.flow, undefined); assert.equal(v006.flow, undefined);
  assert.deepEqual(current.flow, { auto_start_after_card: true, auto_wave_countdown_real_seconds: 1.2, placement_combat_scale: 0.2 });
  assert.equal(v005.waves[0].energy_budget, 16); assert.equal(v006.waves[0].energy_budget, 80);
  assert.equal(v006.monsters.some((m: any) => m.id === 'B002'), false);
});

test('v0.7 Boss config: exactly one mini Boss at 5/10/15 and one major at 20, without replacing or strengthening ordinary roots', () => {
  for (const w of current.waves) {
    const rows = generateWave(current, current.sample_seed, w.wave);
    const bosses = rows.filter(r => monster(r.type).control_class === 'boss');
    assert.equal(bosses.length, bossWaves.includes(w.wave) ? 1 : 0);
    if (bosses.length) {
      assert.equal(bosses[0].type, w.wave === 20 ? 'B001' : 'B002');
      assert.equal(bosses[0].lane, 2);
      const window = Math.floor(w.target_combat_seconds * current.spawn_generator.normal_spawn_window_fraction * 60 + 0.5);
      assert.equal(bosses[0].tick, Math.floor(window * current.spawn_generator.boss_spawn_window_fraction + 0.5));
    }
    const ordinary = rows.filter(r => monster(r.type).control_class !== 'boss').map(r => [r.type, r.lane, r.tick]);
    const oldOrdinary = generateWave(v006, v006.sample_seed, w.wave).filter(r => monster(r.type, v006).control_class !== 'boss').map(r => [r.type, r.lane, r.tick]);
    assert.deepEqual(ordinary, oldOrdinary, `wave ${w.wave} ordinary types, lanes and spawn ticks stay unchanged`);
    assert.equal(ordinary.length, 8 + 2 * (w.wave - 1));
    assert.equal(w.non_boss_energy_budget, v006.waves[w.wave - 1].non_boss_energy_budget);
    assert.equal(w.hp_multiplier, v006.waves[w.wave - 1].hp_multiplier);
    assert.equal(w.target_combat_seconds, v006.waves[w.wave - 1].target_combat_seconds);
  }
  for (const m of v006.monsters.filter((m: any) => m.id !== 'B001')) assert.deepEqual(monster(m.id), m);
  const major = clone(monster('B001')); delete major.boss_tier; delete major.ui_title;
  assert.deepEqual(major, monster('B001', v006));
  assert.deepEqual(current.run, v006.run); assert.deepEqual(current.rescue, v006.rescue);
});

test('v0.7 Boss spawning: actual mini HP grows 320/480/720, major stays 1400; every Boss kill pays exactly 200', () => {
  for (const [wave, hp] of [[5,320],[10,480],[15,720],[20,1400]]) {
    const b = new Battle(current, { wave, energy: 0 });
    const row = b.state.queue.find(r => monster(r.type).control_class === 'boss')!;
    const e = b.spawn(row.type, row.lane, 300, row.ledgerId);
    assert.equal(e.hp, hp); assert.equal(e.maxHp, hp);
    assert.equal(e.budgetShare, 200);
    assert.equal(b.hardControl(e, 3), true); assert.equal(e.hard!.endTick, 54, 'mini uses actual Boss control resistance');
    kill(b, e); assert.equal(b.state.energy, 200); kill(b, e); assert.equal(b.state.energy, 200);
    const entry = b.state.ledger.find(l => l.id === row.ledgerId)!;
    assert.deepEqual([entry.budget, entry.claimed, entry.voided, entry.resolved], [200,200,0,true]);
    assert.equal(b.remainingBudget(), current.waves[wave - 1].energy_budget - 200);
  }
});

test('v0.7 Boss economy: all 544 CSV roots and all 613 actual entities account for exactly 6386 energy', () => {
  const csv = readFileSync('docs/design/configs/wave-spawns-seed-20260912-v0.5.csv', 'utf8').trim().split(/\r?\n/).slice(1).map(l => l.split(','));
  const rows = current.waves.flatMap((w: any) => generateWave(current, current.sample_seed, w.wave));
  assert.equal(rows.length, 544); assert.equal(csv.length, rows.length);
  rows.forEach((r: any, i: number) => assert.deepEqual([r.wave,r.index,r.type,r.lane,r.tick,monster(r.type).reward_energy],
    [+csv[i][0],+csv[i][2],csv[i][3],+csv[i][4],+csv[i][5],+csv[i][7]]));
  let total = 0, entities = 0;
  for (const w of current.waves) {
    const b = new Battle(current, { wave: w.wave, energy: 0 });
    assert.equal(b.remainingBudget(), w.energy_budget); killWave(b);
    assert.equal(b.state.energy, w.energy_budget); assert.equal(b.remainingBudget(), 0);
    assert.ok(b.state.ledger.every(l => l.resolved && l.claimed === l.budget && l.voided === 0));
    assert.equal(b.clearWave(true), 0);
    total += b.state.energy; entities += b.state.stats.spawned;
  }
  assert.equal(total, 6386); assert.equal(entities, 613);
  assert.deepEqual(current.waves.filter((w: any) => bossWaves.includes(w.wave)).map((w: any) => w.energy_budget), [366,470,572,688]);
  assert.equal(current.expected_totals.non_boss_energy_budget, 5586);
  assert.equal(current.expected_totals.boss_energy_budget, 800);
  assert.equal(current.expected_totals.boss_root_monsters, 4);
});

test('v0.7 Boss rescue: preceding-wave grandpa advances each actual Boss budget; cold Boss and split rewards stay zero', () => {
  for (const wave of bossWaves) {
    let saved: string | null = null;
    const s = new GameSession(current, { getItem: () => saved, setItem: (_k,v) => { saved=v; } });
    assert.equal(s.dispatch('newRun', { seed: current.sample_seed }), true);
    s.battle!.beginWave(wave - 1); s.data.run.phase = 'firstFailure'; s.data.run.battle.baseHp = 0;
    const before = s.data.run.battle.energy, remaining = current.waves[wave - 2].energy_budget, advance = current.waves[wave - 1].energy_budget;
    assert.equal(s.dispatch('grandpa'), true);
    assert.deepEqual(s.data.run.lastRescue, { type:'grandpa',wave:wave-1,remaining,advance });
    assert.equal(s.data.run.battle.energy-before,remaining+advance);
    assert.equal(s.data.run.calmWave,wave); assert.equal(s.forecast().budget,0);
    const cold = new Battle(current, { wave, energy: 19, calm: true }); killWave(cold);
    assert.equal(cold.state.energy,19); assert.equal(cold.state.stats.energyGained,0);
    assert.ok(cold.state.ledger.every(l=>l.claimed===0&&l.voided===l.budget&&l.resolved));
  }
});

test('v0.7 Boss rescue: partial split shares and unspawned mini Boss clear once, including at wave 15', () => {
  const b = new Battle(current,{wave:15,energy:0,baseHp:1000});
  const row=b.state.queue.find(r=>r.type==='M004')!;
  const p=b.spawn(row.type,row.lane,300,row.ledgerId);kill(b,p);
  assert.equal(b.state.energy,0);
  const children=b.state.enemies.filter(e=>e.type==='M004-S');
  kill(b,children[0]);children[1].y=current.world.base_y-0.01;
  // Retain the published ledger while preventing this one leak step from
  // starting unrelated roots. Their unspawned budgets still belong to clear.
  b.state.spawnIndex=b.state.queue.length;b.step();
  assert.equal(children[1].terminal,'leaked');assert.equal(b.state.energy,4);
  assert.equal(b.remainingBudget(),572-8);
  assert.equal(b.clearWave(true),564);assert.equal(b.state.energy,568);
  assert.equal(b.clearWave(true),0);assert.equal(b.state.energy,568);
  const bossRow=b.state.queue.find(r=>r.type==='B002')!;
  const bossLedger=b.state.ledger.find(l=>l.id===bossRow.ledgerId)!;
  assert.equal(bossLedger.claimed,200);assert.equal(bossLedger.resolved,true);
  assert.equal(b.state.enemies.some(e=>e.type==='B002'),false,'clear does not instantiate an unspawned Boss');
});

test('v0.7 config rejects malformed flow, misplaced Bosses, bad stage HP and duplicated split budgets', () => {
  const mutations: Array<(c: any)=>void> = [
    c=>{delete c.flow;}, c=>{c.flow.placement_combat_scale=1;},c=>{c.flow.auto_wave_countdown_real_seconds=0;},
    c=>{c.flow.auto_start_after_card=false;},c=>{c.flow.extra=true;},
    c=>{monster('B002',c).reward_energy=199;},c=>{monster('B002',c).hp_by_wave['10']=200;},
    c=>{monster('B002',c).hp_by_wave['6']=400;},c=>{monster('B002',c).control_class='elite';},
    c=>{monster('B002',c).ui_title='大Boss';},c=>{monster('M004',c).split.reward_budget_shared=24;},
    c=>{monster('M004-S',c).reward_energy=8;},c=>{c.waves[4].counts.B002=0;},
  ];
  for(const mutate of mutations){const invalid=clone(current);mutate(invalid);assert.throws(()=>validateConfig(invalid),/配置错误/);}
  for(const old of [v005,v006]){const invalid=clone(old);invalid.flow=clone(current.flow);assert.throws(()=>validateConfig(invalid),/旧版快照/);}
});
