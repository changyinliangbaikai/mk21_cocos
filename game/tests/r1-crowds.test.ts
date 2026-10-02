import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, stepBattle } from '../assets/scripts/domain/r1/battle';
import { deployHero } from '../assets/scripts/domain/r1/cards';
import { castHeroSkill, damageAlly, heroSkillCenter, updateHeroes } from '../assets/scripts/domain/r1/combat';
import { copy, distance, Run } from '../assets/scripts/domain/r1/model';
import { freshProfile } from '../assets/scripts/domain/r1/rewards';
import { R1Session, R1_SAVE_KEY } from '../assets/scripts/domain/r1/session';
import { advanceWaves, spawnEnemy } from '../assets/scripts/domain/r1/waves';

function field(hero = 'RH02') {
  const r = createRun(freshProfile(), 1, 1031, 'crowd'); r.drawQueue = []; r.candidates = [];
  delete r.tuning!.feel; r.tuning!.crowd!.throughWave = 5; // C-031 saved-run compatibility fixtures.
  const h = deployHero(r, hero, 0); h.basicCooldown = 3600; return { r, h };
}
function enemy(r: Run, x: number, y: number, id = 'RM01', hp = 1000) {
  const e = spawnEnemy(r, { id, x, trait: null }, 1); e.y = y; e.hp = e.maxHp = hp; return e;
}
test('C031 first five waves release three groups of ten, without changing quotas or the five-second transition', () => {
  const { r } = field(); const released: number[] = [];
  for (let tick = 0; tick <= 19.5 * 60; tick++) {
    const n = r.spawnedMinions; advanceWaves(r, 1 / 60);
    if (n !== r.spawnedMinions) released.push(tick / 60);
  }
  assert.equal(released.length, 30);
  assert.deepEqual([released[0], released[9], released[10], released[19], released[20], released[29]], [0, 1.5, 9, 10.5, 18, 19.5]);
  for (let i = 0; i < 299; i++) advanceWaves(r, 1 / 60);
  assert.equal(r.wave, 1); advanceWaves(r, 1 / 60); assert.equal(r.wave, 2);
  assert.equal(r.enemies.length, 30); // Surviving enemies aren't removed or used to block the next wave.
  r.wave = 6; r.released = 0; r.spawnTimer = 0; advanceWaves(r, 1 / 60);
  assert.equal(r.spawnTimer, r.tuning!.spawnIntervals[5]);
});
test('C031 clearing a group advances the next group, but never discards unreleased minions', () => {
  const { r } = field();
  for (let i = 0; i <= 90; i++) advanceWaves(r, 1 / 60);
  assert.equal(r.released, 10); r.enemies = [];
  for (let i = 0; i < 59; i++) advanceWaves(r, 1 / 60);
  assert.equal(r.released, 10); advanceWaves(r, 1 / 60); assert.equal(r.released, 11);
  while (r.released < 30) advanceWaves(r, 1 / 60);
  assert.equal(r.spawnedMinions, 30); assert.equal(r.wave, 1);
});
test('C031 circles can offset from a mandatory boss to cover nearby minions, with honest range checks', () => {
  const { r, h } = field(); const boss = enemy(r, .32, .6, 'RL01');
  const pack = [enemy(r, .51, .60), enemy(r, .52, .62), enemy(r, .53, .59)];
  const center = heroSkillCenter(r, h, .12)!;
  assert.ok(distance(center, boss) <= .12 + 1e-8);
  assert.ok(pack.every(e => distance(center, e) <= .12 + 1e-8));
  h.skills[1] = 1; castHeroSkill(r, h, 2);
  assert.ok([boss, ...pack].every(e => e.hp < 1000));
});
test('C031 an urgent minion stays covered before a remote boss; melee skills never reach beyond their legal band', () => {
  const { r, h } = field('RH01');
  const urgent = enemy(r, h.x, .95), boss = enemy(r, .6, .6, 'RL01'), outside = enemy(r, .5, .45);
  const center = heroSkillCenter(r, h, .16)!;
  assert.ok(distance(center, urgent) <= .16 + 1e-8);
  h.skills[2] = 1; castHeroSkill(r, h, 3);
  assert.ok(urgent.hp < 1000); assert.equal(boss.hp, 1000); assert.equal(outside.hp, 1000);
});
test('C031 without mandatory targets an offensive circle chooses a crowd over an isolated nearest enemy', () => {
  const { r, h } = field(); const isolated = enemy(r, h.x, .7);
  const pack = [enemy(r, .7, .45), enemy(r, .75, .46), enemy(r, .72, .5)];
  const center = heroSkillCenter(r, h, .12)!;
  assert.ok(distance(center, isolated) > .12); assert.ok(pack.every(e => distance(center, e) <= .12 + 1e-8));
});
test('C031 a second area skill waits when a pending skill already covers the entire cluster lethally', () => {
  const { r, h } = field('RH01'); h.skills[1] = 3;
  const chef = deployHero(r, 'RH02', 1); chef.skills[1] = 3; chef.basicCooldown = 3600;
  for (let i = 0; i < 5; i++) enemy(r, .35 + i * .025, .65, 'RM01', 20);
  updateHeroes(r, 1 / 60); assert.ok(h.skillWindup); assert.equal(chef.skillWindup, undefined);
  assert.equal(chef.cooldowns[1], 0); // Waiting does not consume the chef's cooldown.
  const distant = enemy(r, .85, .3, 'RM01', 20);
  updateHeroes(r, 1 / 60); assert.ok(chef.skillWindup);
  assert.ok(distance(r.slots[1]!.skillWindup!.center, distant) <= .16 + 1e-8);
});
test('C031 damage lands once after the visible windup; save/restore preserves its timing and locked position', () => {
  const { r, h } = field(); r.wave = 15; r.released = 30; h.skills[1] = 1;
  const e = enemy(r, .5, .7); e.rootUntil = 3600;
  updateHeroes(r, 1 / 60); assert.ok(h.skillWindup); assert.equal(e.hp, 1000);
  const saved = copy(r); for (let i = 0; i < 30; i++) { stepBattle(r); stepBattle(saved); }
  assert.deepEqual(r, saved); assert.ok(e.hp < 1000); assert.equal(r.events.filter(e => e.type === 'hero-skill').length, 1);
  assert.equal(r.events.filter(e => e.type === 'hero-skill-windup').length, 1);
});
test('C031 a killed caster cancels the pending hit and invalid crowd/pending snapshots preserve original bytes', () => {
  const { r, h } = field(); h.skills[1] = 1; enemy(r, .5, .5); updateHeroes(r, .01);
  damageAlly(r, h, 9999, 'test'); assert.equal(h.skillWindup, null);
  updateHeroes(r, 1); assert.equal(r.events.filter(e => e.type === 'hero-skill').length, 0);
  const map = new Map<string, string>(), storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
  const s = new R1Session(storage); s.data.run = r;
  for (const bad of [null, { ...r.tuning!.crowd, batchSize: 7 }, { ...r.tuning!.crowd, interval: -1 }]) {
    const value = copy(s.data) as any; value.run.tuning.crowd = bad;
    const raw = JSON.stringify(value); map.set(R1_SAVE_KEY, raw); assert.ok(new R1Session(storage).error); assert.equal(map.get(R1_SAVE_KEY), raw);
  }
});
test('C031 a level-three attack skill clears an eight-minion cluster with exact energy, without cosmetic extra damage', () => {
  for (const hero of ['RH01', 'RH02']) {
    const { r, h } = field(hero); r.wave = 5; h.skills[1] = 3;
    for (let i = 0; i < 8; i++) {
      const e = spawnEnemy(r, { id: 'RM01', trait: null, x: .34 + i % 4 * .045 }, 5);
      e.y = .61 + Math.floor(i / 4) * .045;
    }
    assert.equal(castHeroSkill(r, h, 2), true);
    assert.equal(r.kills, 8); assert.equal(r.energy, 72);
    assert.equal(r.events.filter(e => e.type === 'enemy-death').reduce((n,e) => n + (e.amount || 0), 0), 72);
    assert.equal(r.events.filter(e => e.type === 'enemy-hit').length, 8);
    assert.equal(r.events.find(e => e.type === 'hero-skill')?.amount, 8);
  }
});
test('C031 a save without crowd tuning loads and retains the old release interval', () => {
  const { r } = field(); delete r.tuning!.crowd;
  const map = new Map<string, string>(), storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
  const session = new R1Session(storage); session.data.run = r; map.set(R1_SAVE_KEY, JSON.stringify(session.data));
  const restored = new R1Session(storage); assert.equal(restored.error, '');
  advanceWaves(restored.data.run!, 1 / 60); assert.equal(restored.data.run!.spawnTimer, .85);
  const invalid = copy(session.data); invalid.run!.slots[0]!.skillWindup = { remaining: -1, slot: 2, center: {x:.5,y:.5} };
  const raw = JSON.stringify(invalid); map.set(R1_SAVE_KEY, raw); assert.ok(new R1Session(storage).error); assert.equal(map.get(R1_SAVE_KEY), raw);
});
