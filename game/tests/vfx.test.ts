import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GameSession } from '../assets/scripts/domain/session';
import { VfxEventRouter, captureVfxState, chooseVfxSlot, type VfxFrame } from '../assets/scripts/presentation/VfxEvents';
const config = JSON.parse(readFileSync('docs/design/configs/prototype-v0.5.json', 'utf8'));
const recipes = JSON.parse(readFileSync('game/assets/resources/mvp/art/vfx-recipes.json', 'utf8'));
function game(): GameSession {
  let save: string | null = null;
  const g = new GameSession(config, { getItem: () => save, setItem: (_key, value) => { save = value; } });
  assert.ok(g.dispatch('newRun', { seed: config.sample_seed })); return g;
}
function act(router: VfxEventRouter, g: GameSession, name: string, payload?: any): VfxFrame {
  const before = captureVfxState(g.data), success = g.dispatch(name, payload);
  return router.command(name, payload, success, before, captureVfxState(g.data));
}
function failedSecond(): GameSession {
  const g = game(), r = g.data.run;
  // Explicit technical condition: an actual second-failure transition after a committed wave prefix.
  g.battle!.beginWave(8, true); r.grandpaUsed = true; r.calmWave = 8;
  g.battle!.spawn('M001', 1, 610); r.battle.baseHp = 0; r.battle.result = 'failed'; r.phase = 'battle'; g.advance(1 / 60);
  assert.equal(r.phase, 'secondFailure'); return g;
}

test('P6 VFX: free protection never composes CLEAR; actual ad completed/fallback clears once; cancel/unknown stays quiet', () => {
  for (const branch of ['free', 'completed', 'failed', 'cancelled', 'unknown']) {
    const g = failedSecond(), router = new VfxEventRouter(); router.observe(g.data);
    let frame: VfxFrame;
    if (branch === 'free') frame = act(router, g, 'freeRevive');
    else { act(router, g, 'adRequest'); frame = act(router, g, 'adResult', { id: g.data.run.ad.id, result: branch }); }
    const ids = frame.bursts.map(e => e.recipe);
    assert.equal(ids.includes('REVIVE'), !['cancelled', 'unknown'].includes(branch));
    assert.equal(ids.includes('CLEAR'), ['completed', 'failed'].includes(branch));
    if (branch === 'free') {
      assert.ok(frame.persistent.some(e => e.key.endsWith('base-protection')));
      const tick = g.data.run.battle.tick; router.observe(g.data); assert.equal(g.data.run.battle.tick, tick);
    }
    assert.deepEqual(router.observe(g.data).bursts, []);
    if (!['cancelled', 'unknown'].includes(branch))
      assert.deepEqual(act(router, g, 'adResult', { id: g.data.run.ad.id, result: 'completed' }).bursts, []);
    const restored = new VfxEventRouter(); assert.deepEqual(restored.observe(g.data).bursts, []);
  }
});

test('P6 VFX: current projectile ID/retarget path survives observation, while historic effects are not replayed', () => {
  const g = game(), r = g.data.run;
  // Technical hero/card arrangement; attacks and retargeting execute the real domain implementation.
  r.battle.heroes = [{ id: g.battle!.allocateId(), type: 'H004', star: 1, slot: 'L2-B', nextAttackTick: 0, releasedCount: 0 }];
  r.battle.cards.C007 = 1; r.battle.queue = []; r.phase = 'battle';
  const first = g.battle!.spawn('M001', 2, 350), second = g.battle!.spawn('M001', 2, 320);
  const router = new VfxEventRouter(); assert.deepEqual(router.observe(g.data).bursts, []);
  for (let i = 0; i < 12; i++) g.advance(1 / 60);
  const f = router.observe(g.data), projectile = f.persistent.find(e => e.recipe === 'BASIC_H004' && e.emitters?.includes('projectile'))!;
  assert.ok(projectile); assert.ok(projectile.endTick! > projectile.tick);
  g.battle!.damage(first.id, 100000); g.battle!.flushDamage(); g.advance(1 / 60);
  const retarget = router.observe(g.data), next = retarget.persistent.find(e => e.key === projectile.key)!;
  assert.ok(next); assert.ok(next.tick > projectile.tick); assert.equal(next.to?.x, second.x);
  assert.ok(retarget.bursts.some(e => e.recipe === 'BASIC_H004' && e.emitters?.includes('projectileTail')));
  const before = JSON.stringify(g.data); router.observe(g.data); assert.equal(JSON.stringify(g.data), before);
  router.background(); for (let i = 0; i < 4; i++) g.advance(1 / 60); router.foreground();
  assert.deepEqual(router.observe(g.data).bursts, []);
  const restored = new VfxEventRouter(); assert.deepEqual(restored.observe(g.data).bursts, []);
});

test('P6 VFX: grandpa and actual merge produce UI-clock bursts across paused page transitions; empty-field ad still clears queue', () => {
  const g = game(), router = new VfxEventRouter(); router.observe(g.data);
  act(router, g, 'summon', { heroId: 'H001', slot: 'L1-A' });
  act(router, g, 'summon', { heroId: 'H001', slot: 'L1-B' });
  const merged = act(router, g, 'move', { id: g.data.run.battle.heroes[1].id, slot: 'L1-A' });
  assert.ok(merged.bursts.some(e => e.recipe === 'MERGE' && e.clock === 'ui'));
  assert.equal(g.data.run.battle.heroes[0].star, 2);
  g.data.run.battle.baseHp = 0; g.data.run.battle.result = 'failed'; g.data.run.phase = 'battle'; g.advance(1 / 60); router.observe(g.data);
  const rescue = act(router, g, 'grandpa');
  assert.equal(g.data.run.phase, 'cards');
  assert.ok(rescue.bursts.some(e => e.recipe === 'GRANDPA' && e.clock === 'ui'));
  assert.ok(rescue.bursts.some(e => e.recipe === 'CLEAR' && e.clock === 'ui'));
  assert.deepEqual(router.observe(g.data).bursts, []);
  const empty = failedSecond(); empty.data.run.battle.enemies = [];
  const emptyRouter = new VfxEventRouter(); emptyRouter.observe(empty.data);
  act(emptyRouter, empty, 'adRequest');
  const clear = act(emptyRouter, empty, 'adResult', { id: empty.data.run.ad.id, result: 'completed' });
  assert.ok(clear.bursts.some(e => e.recipe === 'CLEAR' && e.positions?.length === 0));
});

test('P6 VFX: seven skill routes use actual pulses, P001 fall is distinct from K004 chase, and boss cancellation produces no impact', () => {
  for (const skill of config.skills) {
    const g = game(), r = g.data.run; r.phase = 'battle'; r.battle.queue = [];
    const enemy = g.battle!.spawn('B001', 2, 300); const router = new VfxEventRouter(); router.observe(g.data);
    const target = skill.target === 'area' ? { x: 360, y: 300 } : skill.target === 'enemy' ? { enemyId: enemy.id } : skill.target === 'lane' ? { lane: 2 } : { confirm: true };
    assert.ok(g.battle!.invokeSkill(skill.id, target));
    const frames = [router.observe(g.data)];
    for (let i = 0; i < 60; i++) { g.advance(1 / 60); frames.push(router.observe(g.data)); }
    const routed = frames.flatMap(f => [...f.bursts, ...f.persistent]).filter(e => e.recipe === skill.id);
    assert.ok(routed.length, skill.id + ' must reference its production recipe');
    if (skill.id === 'P001') assert.ok(routed.some(e => e.emitters?.includes('fallToSelectedArea')));
    if (skill.id === 'K004') assert.ok(routed.some(e => e.from && e.to && !e.emitters?.includes('fallToSelectedArea')));
  }
  const g = game(); g.data.run.phase = 'battle'; const boss = g.battle!.spawn('B001', 2, 300);
  const router = new VfxEventRouter(); router.observe(g.data); boss.bossWindupUntil = 30;
  assert.ok(router.observe(g.data).persistent.some(e => e.recipe === 'GOOSE_TELL'));
  g.battle!.hardControl(boss, .5);
  assert.ok(!router.observe(g.data).persistent.some(e => e.recipe === 'GOOSE_TELL'));
  for (let i = 0; i < 35; i++) g.advance(1 / 60);
  assert.ok(!router.observe(g.data).bursts.some(e => e.key.includes('boss-impact')));
});

test('P6 VFX: marker cap is two per enemy, base shield uses authoritative end tick, and priority cannot evict warnings', () => {
  const g = game(), r = g.data.run; r.phase = 'battle'; const enemy = g.battle!.spawn('M001', 1, 250);
  g.battle!.hardControl(enemy, 1); g.battle!.slow(enemy, 'H003', .25, 2);
  enemy.vulnerabilities.push({ source: 'H003', value: .2, endTick: 120 });
  enemy.mark = { endTick: 300 } as any; r.battle.protectionUntil = 180;
  const frame = new VfxEventRouter().observe(g.data);
  const marks = frame.persistent.filter(e => ['STATE', 'K001'].includes(e.recipe)); assert.equal(marks.length, 2);
  assert.equal(frame.persistent.find(e => e.recipe === 'REVIVE')?.endTick, 180);
  const slots = Array.from({ length: 96 }, (_, i) => ({ active: true, priority: i < 10 ? 0 : 3, serial: i }));
  assert.equal(chooseVfxSlot(slots, 3), -1); assert.equal(chooseVfxSlot(slots, 0), 10);
  assert.equal(recipes.particleBudget.maxActiveTexturedQuads, 96);
});
