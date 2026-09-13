import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GameSession } from '../assets/scripts/domain/session';
import { AudioEventRouter, audioPlan, captureAudioState } from '../assets/scripts/presentation/AudioEvents';
import { advanceFeedbackTick, feedbackLayers, hitFeedback, VfxEventRouter, visualAssetId, type VfxIntent } from '../assets/scripts/presentation/VfxEvents';

const config = JSON.parse(readFileSync('docs/design/configs/prototype-v0.5.json', 'utf8'));
const recipes = JSON.parse(readFileSync('game/assets/resources/mvp/art/vfx-recipes.json', 'utf8'));
function layers(intent: VfxIntent): any[] { return feedbackLayers(intent, recipes.recipes.find((r: any) => r.id === intent.recipe)?.layers || []); }
function scenario(): GameSession {
  let raw: string | null = null;
  const game = new GameSession(config, { getItem: () => raw, setItem: (_key, value) => { raw = value; } });
  assert.equal(game.dispatch('newRun', { seed: config.sample_seed }), true);
  game.data.run.phase = 'battle'; game.data.run.battle.queue = []; return game;
}

test('v007 feedback: four real ultimate casts have distinct starts, true hits and no replay or state writes', () => {
  const signature: string[] = [];
  for (const skillId of ['K001', 'K002', 'K003', 'K004']) {
    const game = scenario(), router = new VfxEventRouter();
    const enemy = game.battle!.spawn('B001', 2, 300); enemy.hp = 100000;
    router.observe(game.data);
    const def = config.skills.find((skill: any) => skill.id === skillId);
    const target = def.target === 'lane' ? { lane: 2 } : def.target === 'enemy' ? { enemyId: enemy.id } : { x: enemy.x, y: enemy.y };
    assert.ok(game.battle!.invokeSkill(skillId, target));
    const bursts = [...router.observe(game.data).bursts];
    for (let tick = 0; tick < Math.ceil((Math.max(...def.pulse_offsets_seconds) + .5) * 60); tick++) {
      game.advance(1 / 60); bursts.push(...router.observe(game.data).bursts);
    }
    const starts = bursts.filter(intent => intent.recipe === skillId && intent.stage === 'cast');
    assert.equal(starts.length, 1, skillId + ' has one committed launch');
    signature.push(layers(starts[0]).map(layer => layer.texture).join(','));
    assert.ok(bursts.some(intent => intent.recipe === skillId && intent.stage === 'impact'));
    assert.ok(game.battle!.state.stats.damageLog.some(hit => hit.source === skillId && hit.damage > 0));
    assert.ok(layers(starts[0]).every(layer => !layer.sizeBinding?.startsWith('battlefield')), 'no full-field flash');
    for (const intent of bursts) assert.ok(layers(intent).reduce((n, layer) => n + (layer.count || 1), 0) <= 16, intent.recipe + ' respects per-recipe pool cap');
    const before = JSON.stringify(game.data);
    assert.deepEqual(router.observe(game.data).bursts, []);
    assert.equal(JSON.stringify(game.data), before);
  }
  assert.equal(new Set(signature).size, 4);
});

test('v007 feedback: last real kill carries hit, dissolving actor and exact committed income into UI-clock tail once', () => {
  const game = scenario(), router = new VfxEventRouter(), enemy = game.battle!.spawn('M001', 1, 300);
  router.observe(game.data);
  game.battle!.damage(enemy.id, 9999, 'energy', { source: 'H001' }); game.battle!.flushDamage(); game.advance(1 / 60);
  assert.equal(game.data.run.phase, 'cards');
  const frame = router.observe(game.data), death = frame.bursts.find(intent => intent.stage === 'death');
  const income = frame.bursts.find(intent => intent.stage === 'income');
  assert.ok(frame.bursts.some(intent => intent.recipe === 'HIT' && intent.clock === 'ui'));
  assert.equal(death?.clock, 'ui'); assert.equal(death?.bodyTexture, 'M001');
  assert.ok(layers(death!).some(layer => layer.texture === 'M001' && layer.opacity[1] === 0));
  assert.equal(income?.clock, 'ui'); assert.equal(income?.amount, game.battle!.state.stats.energyGained);
  assert.equal(income?.amount, config.monsters.find((m: any) => m.id === 'M001').reward_energy);
  assert.deepEqual(router.observe(game.data).bursts, []);
  router.background(); router.foreground(); assert.deepEqual(router.observe(game.data).bursts, []);
});

test('v007 feedback: calm-wave kill dissolves normally without an invented energy number', () => {
  const game = scenario(), router = new VfxEventRouter(), enemy = game.battle!.spawn('M001', 1, 300);
  game.data.run.calmWave = 1; game.battle!.state.calm = true; router.observe(game.data);
  game.battle!.damage(enemy.id, 9999, 'energy', { source: 'H003' }); game.battle!.flushDamage(); game.advance(1 / 60);
  const frame = router.observe(game.data);
  assert.ok(frame.bursts.some(intent => intent.stage === 'death'));
  assert.ok(!frame.bursts.some(intent => intent.recipe === 'ENERGY'));
  assert.equal(game.battle!.state.stats.energyGained, 0);
});

test('v007 feedback: reduced flash retains signatures; recoil rebounds once and uses the supplied visual clock', () => {
  assert.ok(hitFeedback(0).flash > 0);
  assert.ok(hitFeedback(.025).scaleX > 1 && hitFeedback(.025).scaleY < 1);
  assert.ok(hitFeedback(.13).scaleX < 1 && hitFeedback(.13).scaleY > 1);
  assert.equal(hitFeedback(.025, 1.5, false).flash, 0);
  assert.ok(hitFeedback(.025, 1.5, false).active);
  assert.deepEqual(hitFeedback(.3, 1.5), { active: false, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, flash: 0 });
  for (const recipe of ['BASIC_H001', 'BASIC_H002', 'BASIC_H003', 'BASIC_H004', 'K001', 'K002', 'K003', 'K004']) {
    const intent: VfxIntent = { key: recipe, recipe, tick: 0, clock: 'battle', point: { x: 300, y: 300 }, priority: 1, stage: 'impact', flash: false };
    const kept = layers(intent).filter(layer => !layer.flashOnly);
    assert.ok(kept.length >= 2, recipe + ' remains legible with flash disabled');
  }
  assert.equal(visualAssetId('B002'), 'B001'); assert.equal(visualAssetId('B001'), 'B001');
});

test('v007 feedback: interpolation does not scale authoritative time twice and freezes with paused combat', () => {
  assert.equal(advanceFeedbackTick(120, 120, 1 / 60, 60, .2), 120.2);
  assert.equal(advanceFeedbackTick(120.2, 120, 1 / 60, 60, 0), 120.2);
  assert.equal(advanceFeedbackTick(120, 122, 1 / 60, 60, 2), 122.999);
  assert.equal(advanceFeedbackTick(120, 120, 2, 60, .2), 120.999, 'interpolation never invents future logic ticks');
});

test('v007 chef contrast: opaque popcorn core replaces thin clutter without extending attack or ultimate lifetimes', () => {
  const make = (recipe: string): VfxIntent => ({ key: recipe, recipe, tick: 0, clock: 'battle', point: { x: 300, y: 300 }, priority: 1, stage: 'impact' });
  const basic = layers(make('BASIC_H001')), ultimate = layers(make('K001'));
  for (const composed of [basic, ultimate]) {
    const core = composed.find(layer => layer.graphic === 'popcornCore');
    const semantic = composed.find(layer => layer.texture === 'VFX_POPCORN' && !layer.count);
    assert.ok(core && semantic, 'filled silhouette and real popcorn illustration both exist');
    assert.ok(core.opacityHold >= .45 && semantic.opacityHold >= .45, 'core remains readable before its short fade');
    assert.equal(core.flashOnly, undefined, 'turning flash off retains the semantic core');
    assert.ok(composed.some(layer => layer.graphic === 'cornShock'));
    assert.ok(!composed.some(layer => layer.graphic === 'shards' || layer.graphic === 'ring'));
    assert.ok(composed.reduce((n, layer) => n + (layer.count || 1), 0) <= 16);
  }
  assert.ok(ultimate.find(layer => layer.graphic === 'popcornCore').logicalSize[0] >= basic.find(layer => layer.graphic === 'popcornCore').logicalSize[0] * 1.45);
  assert.ok(Math.max(...basic.map(layer => layer.lifetimeSeconds)) <= .32);
  assert.ok(Math.max(...ultimate.map(layer => layer.lifetimeSeconds)) <= .5);
  assert.ok(layers(make('BASIC_H002')).every(layer => layer.opacityHold === undefined), 'other families keep their original opacity response');
});

test('v007 audio: summon/move slow selection preserves actual attack cues while settings and legacy overlays pause', () => {
  const game = scenario(), router = new AudioEventRouter();
  const hero = { id: game.battle!.allocateId(), type: 'H002', star: 1, slot: 'L1-B', nextAttackTick: 0, releasedCount: 0 };
  game.battle!.state.heroes = [hero]; game.battle!.spawn('M001', 1, 350); router.observe(game.data);
  for (const overlay of ['summon', 'move']) {
    game.data.overlay = overlay;
    const captured = captureAudioState(game.data);
    assert.equal(audioPlan(captured).combatPaused, false);
    assert.equal(audioPlan({ ...captured, configVersion: '0.5' }).combatPaused, true);
    assert.equal(audioPlan({ ...captured, configVersion: '0.6' }).combatPaused, true);
  }
  game.data.overlay = 'summon';
  const intents = [];
  for (let frame = 0; frame < 150; frame++) { game.advance(1 / 60); intents.push(...router.observe(game.data)); }
  assert.ok(intents.some(intent => intent.id === 'AUD_SFX_015'), 'real slowed punch launch remains audible');
  game.data.overlay = 'settings'; assert.equal(audioPlan(captureAudioState(game.data)).combatPaused, true);
  assert.equal(audioPlan(captureAudioState(game.data), true).suspended, true);
});
