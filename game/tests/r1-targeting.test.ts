import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, stepBattle } from '../assets/scripts/domain/r1/battle';
import { deployHero } from '../assets/scripts/domain/r1/cards';
import { castHeroSkill, damageAlly, enemyTarget, heroTargets, updateHeroes, updateProjectiles, updateSummons } from '../assets/scripts/domain/r1/combat';
import { copy, Projectile, Run } from '../assets/scripts/domain/r1/model';
import { freshProfile } from '../assets/scripts/domain/r1/rewards';
import { spawnEnemy } from '../assets/scripts/domain/r1/waves';
import { R1Session, R1_SAVE_KEY } from '../assets/scripts/domain/r1/session';
import { attackFamily, friendlyImpactVisual, friendlyProjectileVisual } from '../assets/scripts/presentation/R1CombatVisuals';

function field(...heroes: string[]): Run {
  const r = createRun(freshProfile(), 1, 301, 'targeting'); r.candidates = []; r.drawQueue = []; r.wave = 1; r.released = 30;
  heroes.forEach((id, i) => deployHero(r, id, i === 1 ? 3 : i)); return r;
}
function enemy(r: Run, x: number, y: number, hp = 1000, id = 'RM01') {
  const e = spawnEnemy(r, { id, x, trait: null }, 1); e.y = y; e.hp = e.maxHp = hp; return e;
}
function shot(r: Run, target: number, damage = 25, overrides: Partial<Projectile> = {}): Projectile {
  const p: Projectile = { uid: ++r.nextUid, x: .5, y: .8, target, damage, side: 'hero', role: 'ranged', effect: 'RH02-S1', weakSeconds: 0, radius: 0, speed: 650, ...overrides };
  r.projectiles.push(p); return p;
}

test('C030 heroes choose by individual distance instead of the globally furthest-forward minion', () => {
  const r = field('RH02', 'RH04'), left = r.slots[0]!, right = r.slots[3]!;
  const a = enemy(r, left.x, .6), b = enemy(r, right.x, .66);
  assert.equal(heroTargets(r, left)[0], a); assert.equal(heroTargets(r, right)[0], b);
  updateHeroes(r, .01); assert.deepEqual(left.windup!.targets, [a.uid]); assert.deepEqual(right.windup!.targets, [b.uid]);
});
test('C030 bosses take priority until a melee enemy threatens the hero line; range still applies', () => {
  const r = field('RH02'), h = r.slots[0]!;
  const small = enemy(r, h.x, .65), boss = enemy(r, .7, .2, 1000, 'RL01');
  assert.equal(heroTargets(r, h)[0], boss);
  small.y = .93; assert.equal(heroTargets(r, h)[0], small);
  const melee = deployHero(r, 'RH01', 1); assert.ok(!heroTargets(r, melee).includes(boss));
  small.y = .65; small.id = 'RM04'; assert.equal(heroTargets(r, h)[0], boss);
});
test('C030 lethal windups and projectiles reserve a minion once, while healthy bosses can be focused', () => {
  const r = field('RH02', 'RH04'), a = enemy(r, .45, .7, 10), b = enemy(r, .7, .6, 10);
  updateHeroes(r, .01); assert.deepEqual(r.slots[0]!.windup!.targets, [a.uid]); assert.deepEqual(r.slots[3]!.windup!.targets, [b.uid]);
  updateHeroes(r, .25); assert.equal(r.projectiles.length, 2); assert.equal(new Set(r.projectiles.map(p => p.target)).size, 2);
  r.slots.forEach(h => { if (h) { h.basicCooldown = 0; h.windup = null; } }); updateHeroes(r, .01);
  assert.ok(r.slots.every(h => !h?.windup)); // In-flight shots already cover both remaining lives.
  const boss = enemy(r, .5, .4, 1000, 'RL01'); updateHeroes(r, .01);
  assert.ok(r.slots.filter(Boolean).every(h => h!.windup!.targets[0] === boss.uid));
});
test('C030 reservations include armor, ranged resistance and a shield that has not triggered', () => {
  for (const trait of [null, 'T02', 'T04']) {
    const r = field('RH02'), e = enemy(r, .5, .5, 40); e.trait = trait;
    shot(r, e.uid, 20); shot(r, e.uid, 20); updateHeroes(r, .01);
    assert.equal(!!r.slots[0]!.windup, trait !== null, String(trait));
  }
  const r = field('RH02'), e = enemy(r, .5, .5, 40); e.defense = 6;
  shot(r, e.uid, 20); shot(r, e.uid, 20); updateHeroes(r, .01); assert.ok(r.slots[0]!.windup);
});
test('C030 a target dying during the windup does not waste the attack', () => {
  const r = field('RH02'), h = r.slots[0]!, a = enemy(r, h.x, .65), b = enemy(r, .6, .5);
  updateHeroes(r, .01); assert.deepEqual(h.windup!.targets, [a.uid]); a.hp = 0;
  updateHeroes(r, .25); assert.equal(r.projectiles.length, 1); assert.equal(r.projectiles[0].target, b.uid);
});
test('C030 orphaned friendly projectiles redirect once, without changing their snapshotted damage', () => {
  const r = field('RH02'), a = enemy(r, .4, .2), b = enemy(r, .6, .3), p = shot(r, a.uid, 19.5); a.hp = 0;
  updateProjectiles(r, .01); assert.equal(p.target, b.uid); assert.equal(p.retargeted, true); assert.equal(p.damage, 19.5);
  const restored = copy(r); for (let i = 0; i < 100; i++) { stepBattle(r); stepBattle(restored); } assert.deepEqual(restored, r);
  const second = field('RH02'), old = enemy(second, .4, .2), next = enemy(second, .5, .3); old.hp = 0;
  shot(second, old.uid, 10, { retargeted: true }); updateProjectiles(second, .01); assert.equal(second.projectiles.length, 0); assert.equal(next.hp, 1000);
  shot(second, 9999, 10, { side: 'enemy' }); updateProjectiles(second, .01); assert.equal(second.projectiles.length, 0);
});
test('C030 retarget reservations never count a shot that has already landed in the same step', () => {
  const r = field(), a = enemy(r, .5, .5, 30), dead = enemy(r, .5, .5, 10); dead.hp = 0;
  shot(r, a.uid, 20, { y: .5 }); shot(r, dead.uid, 20, { y: .5 }); updateProjectiles(r, .01);
  assert.equal(a.hp, 0); assert.equal(r.kills, 1); assert.equal(r.projectiles.length, 0);
});
test('C030 corn cannon cannot be damaged or targeted; it spends exactly 2 through 6 extra shots', () => {
  for (let level = 1; level <= 5; level++) {
    const r = field('RH02'), h = r.slots[0]!; h.skills[2] = level; const e = enemy(r, .5, .7, 1e6);
    castHeroSkill(r, h, 3); const s = r.summons[0], hp = s.hp;
    assert.equal(damageAlly(r, s, 99999, 'test'), 0); assert.equal(s.hp, hp); assert.notEqual(enemyTarget(r, e)?.uid, s.uid);
    for (let i = 0; i < level + 1; i++) updateSummons(r, .65);
    assert.equal(r.summons.length, 0); assert.equal(r.projectiles.length, level + 1);
    assert.equal(r.events.filter(e => e.type === 'summon-spent').length, 1);
    assert.equal(r.events.filter(e => e.type === 'ally-death').length, 0);
    const before = e.hp; updateProjectiles(r, 5); assert.ok(e.hp < before); // Retiring does not erase its last shot.
  }
});
test('C030 a corn cannon waits for unclaimed targets without consuming ammunition', () => {
  const r = field('RH02'), h = r.slots[0]!; h.skills[2] = 1; const e = enemy(r, .5, .6, 1000);
  castHeroSkill(r, h, 3); const s = r.summons[0]; shot(r, e.uid, 2000);
  for (let i = 0; i < 30; i++) updateSummons(r, .1);
  assert.equal(s.shots, 2); assert.equal(s.idleTime, 0); assert.equal(r.summons.length, 1);
  r.enemies = []; for (let i = 0; i < 21; i++) updateSummons(r, .1);
  assert.equal(r.summons.length, 0); assert.equal(r.events[r.events.length - 1].type, 'summon-end');
});
test('C030 shoe cabinet survives a small hit, fires shoes, and emits death only when its HP is depleted', () => {
  const r = field('RH04'), h = r.slots[0]!; h.skills[2] = 1; enemy(r, .5, .6, 1000);
  castHeroSkill(r, h, 3); const s = r.summons[0], hp = s.hp;
  damageAlly(r, s, 12, 'RM01'); updateSummons(r, .9); assert.ok(s.hp > 0 && s.hp < hp); assert.equal(r.summons.length, 1);
  assert.equal(r.projectiles[0].effect, 'SUM-DURABLE'); assert.equal(friendlyProjectileVisual(r.projectiles[0].effect)!.pack, 'FX-RH04');
  damageAlly(r, s, 99999, 'RM01'); updateSummons(r, .1); assert.equal(r.summons.length, 0);
  assert.equal(r.events.filter(e => e.type === 'ally-death' && e.source === 'SUM-DURABLE').length, 1);
});
test('C030 summon projectile and impact families never fall back to the chef by accident', () => {
  for (const [source, owner] of [['SUM-BURST', 'RH02'], ['SUM-DURABLE', 'RH04'], ['SUM-BAG', 'RH06'], ['corn-mark', 'RH02']]) {
    assert.equal(attackFamily(source), owner); assert.equal(friendlyImpactVisual(source)!.pack, 'FX-' + owner);
  }
  assert.equal(friendlyProjectileVisual('SUM-BURST')!.frame, 6);
  assert.equal(friendlyProjectileVisual('SUM-DURABLE')!.size, 54);
  assert.equal(friendlyImpactVisual('SUM-DURABLE')!.frame, 2);
  assert.equal(friendlyProjectileVisual('unknown'), null); assert.equal(friendlyImpactVisual('GLOBAL-gold'), null);
});
test('C030 old projectile snapshots load without a retarget flag; malformed flags preserve the original bytes', () => {
  const map = new Map<string, string>(), storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
  const session = new R1Session(storage); session.data.run = field('RH02'); const r = session.data.run;
  const e = enemy(r, .5, .5); shot(r, e.uid); const raw = JSON.stringify(session.data); storage.setItem(R1_SAVE_KEY, raw);
  assert.equal(new R1Session(storage).error, '');
  const bad = copy(session.data) as any; bad.run.projectiles[0].retargeted = 'yes'; const broken = JSON.stringify(bad); storage.setItem(R1_SAVE_KEY, broken);
  const restored = new R1Session(storage); assert.ok(restored.error); assert.equal(restored.resume(), false); assert.equal(storage.getItem(R1_SAVE_KEY), broken);
});
