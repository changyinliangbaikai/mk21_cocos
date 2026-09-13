import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Battle, generateWave } from '../assets/scripts/domain/battle';

const config = JSON.parse(readFileSync('docs/design/configs/prototype-v0.5.json', 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function isolated(options: any = {}): Battle {
  const b = new Battle(config, { seed: config.sample_seed, ...options });
  b.state.queue = []; b.state.ledger = []; b.state.baseHp = 1000;
  return b;
}
function hero(type: string, star: number, slot = 'L1-A', id = 1): any {
  return { id, type, star, slot, nextAttackTick: 0, releasedCount: 0 };
}
function steps(b: Battle, count: number): void { for (let i = 0; i < count; i++) b.step(); }
function mark(sourceId: number, damage = 52.8): any {
  return { sourceKind: 'auto', sourceId, explosive: true, levelMultiplier: 1, cards: {}, damage, radius: 64, endTick: 9999 };
}

test('T27: all fixed-seed roots match published CSV; budgets and split totals match JSON', () => {
  const csv = readFileSync('docs/design/configs/wave-spawns-seed-20260912-v0.5.csv', 'utf8').trim().split(/\r?\n/).slice(1).map(line => line.split(','));
  const rows = config.waves.flatMap((wave: any) => generateWave(config, config.sample_seed, wave.wave));
  assert.equal(rows.length, config.expected_totals.root_monsters);
  rows.forEach((row: any, i: number) => {
    assert.deepEqual([row.wave, row.index, row.type, row.lane, row.tick], [+csv[i][0], +csv[i][2], csv[i][3], +csv[i][4], +csv[i][5]]);
  });
  assert.equal(config.waves.reduce((sum: number, w: any) => sum + w.energy_budget, 0), config.expected_totals.ordinary_energy_budget);
  assert.equal(rows.filter((r: any) => r.type === 'M004').length * 3, config.expected_totals.max_split_children);
});

test('T27: inclusive center range and stable closest-to-base / elite targeting; reserve never attacks', () => {
  const h = hero('H001', 1), b = isolated({ heroes: [h] });
  const edge = b.spawn('M001', 1, 180 + Math.sqrt(180 ** 2 - 70 ** 2));
  assert.equal(b.targetFor(h)?.id, edge.id);
  edge.y += 0.01; assert.equal(b.targetFor(h), undefined);
  edge.y = 250; const tied = b.spawn('M001', 1, 250);
  assert.equal(b.targetFor(h)?.id, edge.id); assert.ok(edge.id < tied.id);
  h.type = 'H004'; const elite = b.spawn('M002', 1, 170);
  assert.equal(b.targetFor(h)?.id, elite.id);
  b.moveHero(h.id, 'R1'); steps(b, 120); assert.equal(h.releasedCount, 0);
});

for (const type of ['H001', 'H002', 'H003', 'H004']) {
  for (const side of ['upstream', 'past-hero'] as const) {
    test(`360 targeting: ${type} actually hits a moving ${side} enemy before it reaches the base`, () => {
      const h = hero(type, 1, 'L1-B'), b = isolated({ heroes: [h] });
      const pad = config.world.pads.find((p: any) => p.id === h.slot);
      const enemy = b.spawn('M003', pad.lane, pad.y + (side === 'upstream' ? -80 : 80));
      enemy.hp = 1000;
      assert.equal(b.targetFor(h)?.id, enemy.id);

      // Exercise real windup, moving targets, flight/impact and damage queues.
      // No hard control or manual damage can turn this into a target-only check.
      steps(b, b.seconds(0.75));
      assert.equal(h.releasedCount, 1);
      assert.ok(b.state.stats.damageLog.some(hit => hit.enemyId === enemy.id && hit.source === type && hit.damage > 0));
      assert.equal(enemy.terminal, undefined);
      assert.ok(enemy.y < config.world.base_y);
      if (side === 'past-hero') assert.ok(enemy.y > pad.y);
      if (type === 'H002') {
        assert.ok(b.state.stats.effects.some(effect => effect.kind === 'knockback' && effect.enemyId === enemy.id && effect.toY < effect.fromY));
      }
      if (type === 'H003') assert.ok(enemy.slows.length > 0);
    });
  }

  test(`360 targeting: ${type} never starts an attack outside its real circular range on either side`, () => {
    const h = hero(type, 1, 'L1-B'), b = isolated({ heroes: [h] });
    const pad = config.world.pads.find((p: any) => p.id === h.slot);
    const laneX = config.world.lane_centers_x[pad.lane - 1];
    const offsetY = Math.sqrt(b.range(h) ** 2 - (laneX - pad.x) ** 2);
    const enemies = [-1, 1].map(direction => {
      const enemy = b.spawn('M001', pad.lane, pad.y + direction * (offsetY + 0.01));
      enemy.hp = 1000;
      b.hardControl(enemy, 1); // Keep the upstream enemy from walking into range.
      return enemy;
    });
    assert.equal(b.targetFor(h), undefined);
    steps(b, b.seconds(1));
    assert.equal(h.releasedCount, 0);
    assert.equal(h.windupEventId, undefined);
    assert.equal(b.state.stats.effects.filter(effect => effect.kind === 'attack').length, 0);
    assert.deepEqual(enemies.map(enemy => enemy.hp), [1000, 1000]);
  });
}

test('360 targeting: ordinary heroes still choose the closest-to-base enemy across both sides, then stable id', () => {
  for (const type of ['H001', 'H002', 'H003']) {
    const h = hero(type, 1, 'L1-B'), b = isolated({ heroes: [h] });
    const upstream = b.spawn('M001', 1, 270);
    const pastHero = b.spawn('M001', 1, 430);
    const tied = b.spawn('M001', 1, 430);
    assert.ok(upstream.id < pastHero.id && pastHero.id < tied.id);
    assert.equal(b.targetFor(h)?.id, pastHero.id);
  }
});

test('360 targeting: H004 hits an upstream elite before a downstream normal enemy, excluding out-of-range elites', () => {
  const h = hero('H004', 1, 'L1-B'), b = isolated({ heroes: [h] });
  const downstreamNormal = b.spawn('M001', 1, 430);
  const upstreamElite = b.spawn('M002', 1, 270);
  const outOfRangeElite = b.spawn('M002', 1, 590);
  [downstreamNormal, upstreamElite, outOfRangeElite].forEach(enemy => { enemy.hp = 1000; b.hardControl(enemy, 1); });
  assert.equal(b.targetFor(h)?.id, upstreamElite.id);
  steps(b, b.seconds(0.75));
  assert.deepEqual(b.state.stats.damageLog.map(hit => hit.enemyId), [upstreamElite.id]);

  const downstreamElite = b.spawn('M002', 1, 440);
  const tiedElite = b.spawn('M002', 1, 440);
  assert.ok(downstreamElite.id < tiedElite.id);
  assert.equal(b.targetFor(h)?.id, downstreamElite.id);
});

test('T16/T27: moving cancels unreleased attacks but keeps cooldown; airborne corn survives reserve move', () => {
  const h = hero('H001', 1), b = isolated({ heroes: [h] });
  const enemy = b.spawn('M001', 1, 180); enemy.hp = 1000; b.hardControl(enemy, 3);
  b.step(); const next = h.nextAttackTick; assert.ok(h.windupEventId !== undefined);
  b.moveHero(h.id, 'L1-B'); steps(b, 20);
  assert.equal(h.nextAttackTick, next); assert.equal(h.releasedCount, 0);
  h.nextAttackTick = b.state.tick; b.moveHero(h.id, 'L1-A'); steps(b, 14);
  assert.equal(h.releasedCount, 1); assert.ok(b.state.events.some(e => e.kind === 'corn'));
  b.moveHero(h.id, 'R1'); steps(b, 20);
  assert.ok(enemy.hp < 1000); assert.equal(h.releasedCount, 1);
});

test('T29: H003 Lv1 two-star first hit applies its new vulnerability and deals exactly 19.32', () => {
  const b = isolated({ heroes: [hero('H003', 2)] });
  const e = b.spawn('M001', 1, 180); e.hp = 1000; b.hardControl(e, 3);
  steps(b, 10);
  assert.equal(b.state.stats.damageLog[0].damage, 19.32);
  assert.equal(e.vulnerabilities[0].value, 0.15);
});

test('T27/T29: status expiry occurs before same-tick hit; hard control immunity starts and ends exactly', () => {
  const b = isolated(), e = b.spawn('M001', 1, 180); e.hp = 1000;
  e.vulnerabilities.push({ source: 'old', value: 0.3, endTick: 1 });
  b.state.tick = 1;
  b.state.events.push({ id: 900, kind: 'skill', skillId: 'P001', castId: 99, target: { x: e.x, y: e.y }, cards: { C013: 1 }, level: 1, tick: 1 });
  b.step(); assert.equal(b.state.stats.damageLog[0].damage, 180);
  assert.equal(b.hardControl(e, 1), true);
  const end = e.hard!.endTick; b.state.tick = end; b.step();
  assert.equal(e.hard, undefined); assert.equal(e.immuneUntil, end + 30);
  assert.equal(b.hardControl(e, 1), false);
  b.state.tick = e.immuneUntil; b.step(); assert.equal(b.hardControl(e, 1), true);
});

test('T27: class resistance, continuous hard-control caps, knockback interval, rolling budget and boundaries', () => {
  for (const [type, index] of [['M001', 0], ['M002', 1], ['B001', 2]] as const) {
    const b = isolated(), e = b.spawn(type, 1, 600);
    b.hardControl(e, 30);
    assert.equal(e.hard!.endTick, Math.ceil(config.control.hard_control_continuous_cap_seconds[index] * 60));
    b.slow(e, 'slow', 0.5, 1);
    assert.equal(e.slows[0].value, 0.5 * config.control.slow_and_hard_duration_multipliers[index]);
    const first = b.knockback(e, 1000);
    assert.equal(first, config.control.knockback_per_event_caps[index]);
    assert.equal(b.knockback(e, 1000), 0);
    b.state.tick += Math.ceil(config.control.knockback_min_interval_seconds[index] * 60);
    const second = b.knockback(e, 1000);
    assert.equal(first + second, config.control.knockback_window_distance_caps[index]);
    b.state.tick += Math.ceil(config.control.knockback_min_interval_seconds[index] * 60);
    if (b.state.tick < 180) assert.equal(b.knockback(e, 1000), 0);
    e.y = config.world.spawn_y; b.state.tick = 999; assert.equal(b.knockback(e, 1000), 0);
  }
});

test('T27: C009 collision has at most two victims, no recursive knockback, no level/C012 inheritance', () => {
  const b = isolated({ cards: { C009: 2, C012: 19 }, snapshots: { H002: { level: 5 } } });
  const source = b.spawn('M001', 1, 300); source.hp = 1000;
  const a = b.spawn('M002', 1, 270), c = b.spawn('M001', 1, 240), d = b.spawn('M001', 1, 220);
  [a, c, d].forEach(e => { e.hp = 1000; });
  b.knockback(source, 140); b.flushDamage();
  assert.equal(1000 - a.hp, 12); assert.equal(1000 - c.hp, 15); assert.equal(d.hp, 1000);
  assert.equal(a.y, 270); assert.equal(c.y, 240);
});

test('T29: cross-source pre-existing corn marks never reset chain identity; depth eight stops even marked victims', () => {
  const b = isolated();
  const enemies = Array.from({ length: 10 }, (_, i) => b.spawn('M001', 1, 60 + i * 60));
  enemies.forEach((e, i) => { e.hp = 1; b.mark(e, mark(100 + i, i === 0 ? 52.8 : 60)); });
  b.damage(enemies[0].id, 1); b.flushDamage();
  assert.equal(enemies.filter(e => e.terminal === 'killed').length, 9);
  assert.equal(enemies[9].terminal, undefined);
  const logs = b.state.stats.damageLog.filter(log => log.depth);
  assert.equal(Math.max(...logs.map(log => log.depth)), 8);
  assert.equal(new Set(logs.map(log => log.chainId)).size, 1);
});

test('T29: automatic marks inherit C012, K001 direct and derived marks do not', () => {
  const automatic = isolated({ heroes: [hero('H001', 3)], cards: { C012: 2 } });
  const a = automatic.spawn('M001', 1, 180); a.hp = 1000; automatic.hardControl(a, 3); steps(automatic, 30);
  assert.equal(a.mark?.damage, 52.8 * 1.2);
  assert.equal(automatic.state.stats.damageLog[0].damage, 95.04);
  const manual = isolated({ cards: { C012: 2 } });
  const m = manual.spawn('M001', 1, 180); m.hp = 1000; manual.hardControl(m, 3);
  assert.equal(manual.invokeSkill('K001', { x: m.x, y: m.y }), true); steps(manual, 10);
  assert.equal(m.mark?.damage, 52.8); assert.equal(manual.state.stats.damageLog[0].damage, 70);
});

test('T29: mark selection keeps explosive/high-damage/stable-source priority and only extends weaker marks', () => {
  const b = isolated(), e = b.spawn('M001', 1, 180);
  b.mark(e, mark(9, 50)); b.mark(e, { ...mark(1, 100), explosive: false, endTick: 10000 });
  assert.equal(e.mark?.sourceId, 9); assert.equal(e.mark?.endTick, 10000);
  b.mark(e, mark(8, 50)); assert.equal(e.mark?.sourceId, 8);
  b.mark(e, mark(10, 60)); assert.equal(e.mark?.sourceId, 10);
});

test('T06/T29: split children spawn before mark blast, share budget, and clear only unclaimed remainder', () => {
  const split = config.monsters.find((m: any) => m.id === 'M004').split;
  const familyBudget = split.reward_budget_shared, childBudget = familyBudget / split.count;
  const b = isolated(), parent = b.spawn('M004', 1, 250); b.mark(parent, mark(1));
  b.damage(parent.id, 999); b.flushDamage();
  assert.equal(b.state.enemies.filter(e => e.type === 'M004-S').length, split.count);
  assert.equal(b.state.energy, config.run.starting_energy + familyBudget);
  assert.equal(b.remainingBudget(), 0); assert.equal(b.clearWave(true), 0);
  const partial = isolated(), p = partial.spawn('M004', 1, 250);
  partial.damage(p.id, 999); partial.flushDamage();
  const child = partial.state.enemies.find(e => e.type === 'M004-S')!;
  partial.damage(child.id, 999); partial.flushDamage();
  assert.equal(partial.state.energy, config.run.starting_energy + childBudget);
  assert.equal(partial.clearWave(true), familyBudget - childBudget);
  assert.equal(partial.state.energy, config.run.starting_energy + familyBudget);
  assert.equal(partial.state.enemies.length, 1 + split.count);
});

test('T06: parent leakage voids full budget; unspawned roots clear once without creating split children', () => {
  const b = isolated(), parent = b.spawn('M004', 1, config.world.base_y - 0.1);
  b.step(); assert.equal(parent.terminal, 'leaked'); assert.equal(b.remainingBudget(), 0);
  assert.equal(b.state.enemies.length, 1); assert.equal(b.clearWave(true), 0);
  const wave = new Battle(config, { wave: 20, seed: config.sample_seed });
  const budget = config.waves.find((w: any) => w.wave === 20).energy_budget;
  assert.equal(wave.clearWave(true), budget);
  assert.equal(wave.state.energy, config.run.starting_energy + budget);
  assert.equal(wave.state.stats.spawned, 0); assert.equal(wave.clearWave(true), 0);
  assert.equal(wave.state.spawnIndex, wave.state.queue.length);
});

test('T08/T09/T14: calm kills yield zero, protection leaks still terminal, fatal final leak prioritizes failure', () => {
  const calm = isolated({ calm: true }), e = calm.spawn('M001', 1, 100);
  calm.damage(e.id, 999); calm.flushDamage(); assert.equal(calm.state.energy, 120); assert.equal(calm.remainingBudget(), 0);
  const protectedBattle = isolated({ protectionUntil: 180 }); protectedBattle.state.baseHp = 1;
  const p = protectedBattle.spawn('M001', 1, 647.9); protectedBattle.step();
  assert.equal(protectedBattle.state.baseHp, 1); assert.equal(p.terminal, 'leaked'); assert.equal(protectedBattle.state.energy, 120);
  const fatal = isolated(); fatal.state.baseHp = 1; fatal.spawn('M001', 1, 647.9);
  assert.deepEqual(fatal.step(), { energyGained: 0, leaks: 1, failed: true, complete: false });
});

test('T29: H004 followup computes 50 percent before vulnerability/armor once, with release card/level snapshot', () => {
  const b = isolated({ heroes: [hero('H004', 2)], cards: { C007: 1, C008: 1, C012: 2 }, snapshots: { H004: { level: 2 } } });
  const e = b.spawn('M002', 1, 180); e.hp = 1000; b.hardControl(e, 3); steps(b, 10);
  b.state.cards.C012 = 19; steps(b, 30);
  const hits = b.state.stats.damageLog.filter(l => l.source.startsWith('H004'));
  assert.equal(hits.length, 2); assert.equal(hits[0].damage, 56.448); assert.equal(hits[1].damage, 28.224);
});

test('T29: H004 C007 retargets once within release range; followup follows redirected target class', () => {
  const b = isolated({ heroes: [hero('H004', 2)], cards: { C007: 1 } });
  const first = b.spawn('M001', 1, 180); first.hp = 1000; b.hardControl(first, 3); steps(b, 10);
  const target = b.spawn('M002', 1, 190); target.hp = 1000; b.hardControl(target, 3);
  b.damage(first.id, 9999); b.flushDamage(); steps(b, 35);
  const hits = b.state.stats.damageLog.filter(l => l.source.startsWith('H004'));
  assert.equal(hits[0].enemyId, target.id); assert.equal(hits[0].damage, 38.64); assert.equal(hits[1].damage, 19.32);
  assert.equal(b.state.stats.effects.filter(e => e.kind === 'retarget').length, 1);
});

test('T29: target death earlier in the same damage queue still permits the original slipper one redirect', () => {
  const b = isolated({ heroes: [hero('H004', 2)], cards: { C007: 1 } });
  const first = b.spawn('M001', 1, 180); first.hp = 1000; b.hardControl(first, 3); steps(b, 10);
  const target = b.spawn('M002', 1, 190); target.hp = 1000; b.hardControl(target, 3);
  b.state.tick = b.state.events.find(e => e.kind === 'slipper').tick;
  b.damage(first.id, 9999); b.step();
  assert.ok(b.state.events.some(e => e.kind === 'slipper' && e.enemyId === target.id && e.retargets === 1));
  steps(b, 20);
  assert.equal(b.state.stats.damageLog.find(l => l.source === 'H004').enemyId, target.id);
});

test('T29: K004 redirects a strike if another same-tick effect kills its target; no enemies cancels remaining strikes', () => {
  const b = isolated({ cards: { C007: 1, C013: 1 } });
  const first = b.spawn('M001', 1, 180), target = b.spawn('M002', 3, 180); target.hp = 1000;
  b.hardControl(first, 3); b.hardControl(target, 3); b.invokeSkill('P001', { x: first.x, y: first.y });
  steps(b, 15); b.invokeSkill('K004', { enemyId: first.id }); b.step();
  const hit = b.state.stats.damageLog.find(l => l.source === 'K004');
  assert.equal(hit.enemyId, target.id); assert.equal(hit.damage, 64.4);
  const empty = isolated(); const victim = empty.spawn('M001', 1, 180);
  empty.state.queue = [{ wave: 1, index: 1, type: 'M001', lane: 3, tick: 30, ledgerId: 'future' }];
  empty.invokeSkill('K004', { enemyId: victim.id }); steps(empty, 50);
  assert.equal(empty.state.stats.damageLog.filter(l => l.source === 'K004').length, 1);
  assert.equal(empty.state.enemies.find(e => e.ledgerId === 'future')?.hp, 24);
});

test('P2: three-star H002 fourth release replaces its normal punch and hits at most five once', () => {
  const h = hero('H002', 3); h.releasedCount = 3; const b = isolated({ heroes: [h] });
  const enemies = Array.from({ length: 6 }, (_, i) => b.spawn('M001', 1, 225 + i * 4));
  enemies.forEach(e => { e.hp = 1000; b.hardControl(e, 3); }); steps(b, 12);
  assert.equal(h.releasedCount, 4);
  const hits = b.state.stats.damageLog.filter(l => l.source === 'H002');
  assert.equal(hits.length, 5); assert.equal(new Set(hits.map(l => l.enemyId)).size, 5);
  hits.forEach(hit => assert.equal(hit.damage, 70.4));
  const moved = b.state.stats.effects.filter(e => e.kind === 'knockback');
  moved.forEach(e => assert.equal(e.fromY - e.toY, 60));
});

test('P2: three-star H004 third same-elite release adds one pursuit and resets the streak', () => {
  const h = hero('H004', 3); const b = isolated({ heroes: [h] });
  const enemy = b.spawn('M002', 1, 180); enemy.hp = 10000;
  h.streakTargetId = enemy.id; h.streakCount = 2; b.hardControl(enemy, 3); steps(b, 50);
  const hits = b.state.stats.damageLog.filter(l => l.source.startsWith('H004'));
  assert.deepEqual(hits.map(l => l.source), ['H004', 'H004-return', 'H004-pursuit']);
  assert.deepEqual(hits.map(l => l.damage), [70.4, 35.2, 35.2]);
  assert.equal(h.streakCount, 0);
});

test('T23: K damage uses level only, P ignores hero level, invalid area/enemy/lane targets schedule nothing', () => {
  const b = isolated({ snapshots: { H001: { level: 3 }, H004: { level: 5 } }, cards: { C013: 1 } });
  const e = b.spawn('M001', 1, 180); e.hp = 1000; b.hardControl(e, 3);
  assert.equal(b.invokeSkill('K001', { x: -1, y: 2 }), false);
  assert.equal(b.invokeSkill('K004', { enemyId: 999 }), false);
  assert.equal(b.invokeSkill('K002', { lane: 4 }), false); assert.equal(b.state.events.length, 0);
  b.invokeSkill('K001', { x: e.x, y: e.y }); b.invokeSkill('P001', { x: e.x, y: e.y }); steps(b, 16);
  assert.equal(b.state.stats.damageLog.find(l => l.source === 'K001').damage, 77);
  assert.equal(b.state.stats.damageLog.find(l => l.source === 'P001').damage, 180);
});

test('P3: range/period/automatic damage cards compose additively within their declared attribute', () => {
  const h = hero('H001', 2), cards = { C001: 2, C002: 2, C010: 3, C011: 4, C012: 4 };
  const b = isolated({ heroes: [h], cards, snapshots: { H001: { level: 3 } } });
  const e = b.spawn('M001', 1, 180); e.hp = 1000; b.hardControl(e, 3); steps(b, 30);
  assert.equal(b.range(h), 180 * 1.2);
  assert.equal(h.nextAttackTick, Math.ceil(2 * 1.1 * Math.pow(.97, 3) * 60));
  assert.equal(b.state.stats.damageLog[0].damage, 64.8648);
  assert.equal(b.state.stats.effects.find(e => e.kind === 'explosion').radius, 64 * 1.4);
  assert.ok(Math.abs(e.mark!.damage - 110.352) < 1e-10);
  assert.equal(e.mark!.explosive, false);
  assert.equal(b.range(hero('H002', 1), { C003: 2, C011: 4 }), 175 * (1 + .4 + .2));
});

test('P3: C005 expands sound radius/damage; C006 extends slow duration only; P001/P003 tiers use own values', () => {
  const b = isolated({ heroes: [hero('H003', 2)], cards: { C005: 2, C006: 2, C012: 4 }, snapshots: { H003: { level: 3 } } });
  const e = b.spawn('M001', 1, 180); e.hp = 1000; b.hardControl(e, 3); steps(b, 10);
  assert.equal(b.state.stats.damageLog[0].damage, 34.0032);
  assert.equal(b.state.stats.effects.find(e => e.kind === 'sound').radius, 78);
  assert.equal(e.slows[0].value, .25); assert.equal(e.slows[0].endTick - b.state.stats.damageLog[0].tick, 101);
  const p = isolated({ cards: { C013: 3, C015: 3, C012: 19 }, snapshots: { H001: { level: 5 } } });
  const enemy = p.spawn('M001', 1, 180); enemy.hp = 1000; p.hardControl(enemy, 3);
  p.invokeSkill('P001', { x: enemy.x, y: enemy.y }); p.invokeSkill('P003', { x: enemy.x, y: enemy.y - 120 }); steps(p, 16);
  assert.equal(p.state.stats.damageLog.find(l => l.source === 'P001').damage, 234);
  assert.equal(p.state.stats.damageLog.find(l => l.source === 'P003').damage, 0);
  assert.equal(p.state.stats.effects.find(e => e.kind === 'skillPulse' && e.skillId === 'P003').radius, 120);
});

test('T27: boss fixed windup is canceled by hard control and does not release late; aura excludes self', () => {
  const b = isolated(), boss = b.spawn('B001', 2, 100), chicken = b.spawn('M005', 1, 100), other = b.spawn('M001', 1, 110);
  b.step(); assert.ok(Math.abs(chicken.y - 100 - 65 / 60) < 1e-8);
  assert.ok(Math.abs(other.y - 110 - 70 * 1.25 / 60) < 1e-8);
  b.state.tick = 240; b.step(); assert.equal(boss.bossWindupUntil, 300);
  b.hardControl(boss, 3); assert.equal(boss.bossWindupUntil, undefined);
  b.state.tick = 300; b.step(); assert.equal(boss.hastes.length, 0);
  assert.equal(boss.bossNextWindup, 600);
});

test('T01/T02/T25: all twelve forms across three battle stars preserve equal-tick state and restore', () => {
  function simulate(groupSize: number, restore: boolean, form: number, star: number): any {
    let b = new Battle(config, { seed: config.sample_seed, wave: 20, baseHp: 1000,
      heroes: [hero('H001', star, 'L1-B', 1), hero('H002', star, 'L2-B', 2), hero('H003', star, 'L3-B', 3), hero('H004', star, 'L2-C', 4)],
      cards: { C001: 2, C002: 2, C004: 2, C007: 1, C008: 2, C009: 2, C012: 2 },
      snapshots: Object.fromEntries(config.heroes.map((h: any) => [h.id, { level: 5, form: `${h.id}-F0${form}` }])) });
    for (let frame = 0; frame < 2500 / groupSize; frame++) {
      for (let group = 0; group < groupSize; group++) {
        if (b.state.tick === 600) b.invokeSkill('K001', { x: 360, y: 450 });
        if (b.state.tick === 900) b.invokeSkill('K002', { lane: 3 });
        if (b.state.tick === 1000 && restore) b = new Battle(config, { state: clone(b.state) });
        b.step();
      }
    }
    const state = clone(b.state);
    for (const h of config.heroes) delete state.snapshots[h.id].form;
    return state;
  }
  for (const star of [1, 2, 3]) {
    const initial = simulate(1, false, 1, star);
    assert.deepEqual(initial, simulate(2, true, 2, star));
    assert.deepEqual(initial, simulate(2, true, 3, star));
  }
});
