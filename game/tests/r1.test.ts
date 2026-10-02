import test from 'node:test';
import assert from 'node:assert/strict';
import { ENEMIES, HEROES, RULES, SKILLS, STAGES, enemyDef, legacyStageTuning, permanentStats, stageTuning, validateR1Config } from '../assets/scripts/domain/r1/config';
import { BattleClock, aimGlobal, cancelGlobal, castGlobal, createRun, effectiveRate, reconcileBattle, stepBattle } from '../assets/scripts/domain/r1/battle';
import { attributeBonuses, cardText, chooseCard, deployHero, gainEnergy, repairDraft, resolveRescue, showDraft } from '../assets/scripts/domain/r1/cards';
import { castHeroSkill, controlEnemy, damageAlly, damageEnemy, enemyTarget, heroTargets, updateHeroes, updateSummons, updateProjectiles } from '../assets/scripts/domain/r1/combat';
import { skillArea, inSkillArea } from '../assets/scripts/domain/r1/geometry';
import { Run, copy } from '../assets/scripts/domain/r1/model';
import { freshProfile, rollRewards, upgradeHero } from '../assets/scripts/domain/r1/rewards';
import { streams } from '../assets/scripts/domain/r1/random';
import { R1Session, R1_SAVE_KEY, LEGACY_SAVE_KEY, validateSave } from '../assets/scripts/domain/r1/session';
import { advanceWaves, enemyScale, runTuning, spawnEnemy } from '../assets/scripts/domain/r1/waves';

function run(stage = 1, seed = 42): Run {
  const p = freshProfile(); p.clearedStage = 20;
  const r = createRun(p, stage, seed, `test-${seed}`);
  delete r.tuning!.feel; // Historical rule fixtures; current onboarding is covered in r1-feel.test.ts.
  r.drawQueue = []; r.candidates = []; return r;
}
function combat(hero = 'RH02'): Run {
  const r = run(); deployHero(r, hero, 0); r.wave = 1; r.released = 30; return r;
}
function monster(r: Run, id = 'RM01', trait: string | null = null, x = .5, y = .75) {
  const e = spawnEnemy(r, { id, trait, x }, Math.max(1, r.wave)); e.y = y; return e;
}
class MemoryStorage {
  map = new Map<string, string>(); fail = false;
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { if (this.fail) throw new Error('disk full'); this.map.set(k, v); }
}
test('R1 configuration references, caps, probabilities and identity mapping validate', () => {
  validateR1Config(); assert.equal(HEROES.length, 10); assert.equal(SKILLS.length, 30);
  assert.equal(permanentStats('RH04', 2).attack, 30.25);
});
test('AC01 three choices contain exactly min(empty,3) distinct recruit cards; dead slots stay occupied', () => {
  for (let filled = 0; filled <= 4; filled++) {
    const r = run(); HEROES.slice(0, filled).forEach((h, i) => deployHero(r, h.id, i));
    if (filled) r.slots[0]!.hp = 0;
    r.drawQueue = ['energy']; showDraft(r);
    assert.equal(r.candidates.length, 3); assert.equal(r.candidates.filter(c => c.kind === 'hero').length, Math.min(4 - filled, 3));
    if (filled < 4) assert.ok(r.candidates.every(c => c.kind !== 'global'));
    assert.equal(new Set(r.candidates.map(c => [c.kind, c.heroId, c.attribute, c.skillSlot].join(':'))).size, 3);
  }
});
test('AC02/AC17 opening is frozen until three selections; two heroes can start', () => {
  const r = createRun(freshProfile(), 1, 88, 'opening'); stepBattle(r); assert.equal(r.tick, 0);
  for (let i = 0; i < 2; i++) assert.equal(chooseCard(r, r.candidates.find(c => c.kind === 'hero')!.id), true);
  const upgrade = r.candidates.find(c => c.kind !== 'hero')!; assert.ok(upgrade);
  assert.equal(chooseCard(r, upgrade.id), true); assert.equal(r.slots.filter(Boolean).length, 2);
  stepBattle(r); assert.equal(r.wave, 1); assert.equal(r.spawnedMinions, 1);
});
test('AC03 early empty field never skips unreleased minions; clearing after all releases advances immediately', () => {
  const r = combat(); r.wave = 0; r.released = 0;
  for (let i = 0; i < 3000 && r.spawnedMinions < 29; i++) { advanceWaves(r, 1 / 60); r.enemies = []; }
  assert.equal(r.wave, 1); assert.equal(r.spawnedMinions, 29);
  while (r.spawnedMinions < 30) advanceWaves(r, 1 / 60); assert.equal(r.spawnedMinions, 30); r.enemies = [];
  advanceWaves(r, 1 / 60); assert.equal(r.wave, 2);
});
test('AC03/AC04 full 15-wave release retains old enemies and produces exactly 450 + 3/5 bosses', () => {
  for (const stage of [1, 5, 10, 20]) {
    const r = run(stage);
    const maxTicks = Math.ceil((runTuning(r).spawnIntervals.reduce((a, b) => a + b * 29, 0) + 15 * 5 + 1) * 60);
    for (let i = 0; i < maxTicks && (r.wave < 15 || r.released < 30); i++) advanceWaves(r, 1 / 60);
    assert.equal(r.spawnedMinions, 450); assert.equal(r.spawnedBosses, stage % 10 === 0 ? 5 : 3);
    assert.equal(r.enemies.length, r.spawnedMinions + r.spawnedBosses);
  }
});
test('C029 second-stage opening is gentler and relaxes toward the full late-wave strength', () => {
  const r = run(2), tuning = runTuning(r);
  assert.equal(tuning.version, RULES.version); assert.equal(tuning.baseScale, 1.025);
  assert.deepEqual(tuning.waveScales.slice(0, 5), [.72, .8, .88, .96, 1.04]);
  assert.deepEqual(tuning.spawnIntervals.slice(0, 5), [.85, .8, .75, .7, .7]);
  const e = spawnEnemy(r, { id: 'RM01', trait: null, x: .5 }, 1);
  assert.equal(e.maxHp, 32 * 1.025 * .72); assert.equal(e.attack, 12 * 1.025 * .72);
  assert.ok(enemyScale(r, 15) > enemyScale(r, 1));
  assert.equal(stageTuning(5).baseScale, 1.1 * 1.2); assert.equal(stageTuning(10).baseScale, 1.225 * 1.5);
  assert.deepEqual(stageTuning(5).spawnIntervals.slice(0, 4), [.9, .85, .8, .75]);
  assert.deepEqual(stageTuning(10).spawnIntervals.slice(0, 4), [1.05, 1, .95, .9]);
  assert.deepEqual(stageTuning(11).spawnIntervals, stageTuning(1).spawnIntervals);
});
test('C029 release spacing changes by wave but the five-second maximum gap never waits for a clear', () => {
  const r = run(2); delete r.tuning!.crowd; // An R1.0.4 saved battle retains its uniform release pacing.
  advanceWaves(r, 1 / 60); const first = r.enemies[0];
  for (let i = 0; i < 50; i++) advanceWaves(r, 1 / 60);
  assert.equal(r.released, 1); advanceWaves(r, 1 / 60); assert.equal(r.released, 2);
  while (r.released < 30) advanceWaves(r, 1 / 60);
  for (let i = 0; i < 299; i++) advanceWaves(r, 1 / 60);
  assert.equal(r.wave, 1); advanceWaves(r, 1 / 60); assert.equal(r.wave, 2);
  assert.ok(r.enemies.includes(first)); advanceWaves(r, 1 / 60);
  assert.equal(r.spawnTimer, .8);
});
test('C029 old snapshots without tuning keep the original enemy stats, release interval and global damage', () => {
  const r = run(2); delete r.tuning;
  const e = spawnEnemy(r, { id: 'RM01', trait: null, x: .5 }, 1);
  assert.equal(e.maxHp, 32 * 1.06); assert.equal(e.attack, 12 * 1.06);
  r.enemies = []; advanceWaves(r, 1 / 60); assert.equal(r.spawnTimer, .5);
  for (let i = 0; i < 30; i++) advanceWaves(r, 1 / 60);
  assert.equal(r.released, 2); r.enemies = [e]; e.y = .5; e.hp = e.maxHp = 10000;
  r.globalSkill = 'blue'; aimGlobal(r); castGlobal(r, .5, .5);
  assert.equal(10000 - e.hp, Math.ceil(RULES.globalSkills.blue.baseDamage * 1.06));
  const storage = new MemoryStorage(), session = new R1Session(storage); session.data.run = r;
  storage.setItem(R1_SAVE_KEY, JSON.stringify(session.data));
  const restored = new R1Session(storage); assert.equal(restored.error, ''); assert.deepEqual(restored.data.run, r);
});
test('C029 new runs own their tuning snapshot across save restore and later config changes', () => {
  const r = run(2), before = copy(r), stage = STAGES[1], original = copy(stage);
  try {
    stage.stageScale = 3; stage.waveStatScales![0] = 4; stage.spawnIntervalsByWave![0] = 2;
    assert.deepEqual(runTuning(r), before.tuning);
    const storage = new MemoryStorage(), session = new R1Session(storage); session.data.run = r;
    storage.setItem(R1_SAVE_KEY, JSON.stringify(session.data));
    const restored = new R1Session(storage).data.run!;
    assert.deepEqual(restored, before);
    const e = spawnEnemy(restored, { id: 'RM01', trait: null, x: .5 }, 1); e.y = .5; e.hp = e.maxHp = 10000;
    restored.wave = 1; restored.released = 30; restored.globalSkill = 'blue'; aimGlobal(restored); castGlobal(restored, .5, .5);
    assert.equal(10000 - e.hp, Math.ceil(RULES.globalSkills.blue.baseDamage * 1.025 * .72));
    assert.notDeepEqual(runTuning(run(2)), before.tuning);
  } finally { Object.assign(stage, original); }
});
test('C029 invalid difficulty snapshots are rejected without overwriting the saved bytes', () => {
  const storage = new MemoryStorage(), session = new R1Session(storage); session.start(1, 71);
  const valid = copy(session.data);
  for (const tuning of [null, { ...valid.run!.tuning, baseScale: 0 }, { ...valid.run!.tuning, waveScales: [1] },
    { ...valid.run!.tuning, spawnIntervals: Array(15).fill(-1) }, { ...valid.run!.tuning, nextWaveDelay: 0 }]) {
    const broken = { ...valid, run: { ...valid.run, tuning } }, raw = JSON.stringify(broken);
    storage.setItem(R1_SAVE_KEY, raw); const restored = new R1Session(storage);
    assert.ok(restored.error); assert.equal(restored.resume(), false); assert.equal(storage.getItem(R1_SAVE_KEY), raw);
  }
});
test('C029 level-one stage-two attribute-first regression reaches the first boss before any rescue', () => {
  function openingToBoss() {
    const p = freshProfile(); p.clearedStage = 1;
    const r = createRun(p, 2, 42, 'early-curve');
    let opening = 0, energyDraws = 0, firstEnergy = 0;
    const rank = (c: Run['candidates'][number]) => c.kind === 'hero' ? 100 : c.kind === 'attribute' ? 90 : c.kind === 'skill' ? 70 : 50;
    for (let i = 0; i < 9000 && r.wave < 5 && !r.rescue; i++) {
      if (r.candidates.length) {
        const source = r.drawQueue[0];
        const card = source === 'opening'
          ? r.candidates.find(c => c.kind === 'hero' && c.heroId === ['RH01', 'RH02', 'RH03'][opening++]) || r.candidates.find(c => c.kind === 'hero')!
          : [...r.candidates].sort((a, b) => rank(b) - rank(a))[0];
        if (source === 'energy') { energyDraws++; if (!firstEnergy) firstEnergy = r.tick / 60; }
        assert.equal(chooseCard(r, card.id), true);
      }
      stepBattle(r);
    }
    return { r, energyDraws, firstEnergy };
  }
  // The historical failure is kept in C029 evidence; later combat fixes also improve the old curve.
  const after = openingToBoss();
  assert.equal(after.r.wave, 5); assert.equal(after.r.rescue, null);
  assert.ok(after.r.slots.every(h => !h || h.hp > 0)); assert.ok(after.energyDraws >= 5);
  assert.ok(after.firstEnergy > 0 && after.firstEnergy < 25);
});
test('all stage plans assign exact quotas of enabled traits', () => {
  for (const s of STAGES) for (const wave of run(s.id).plans) {
    assert.equal(wave.filter(e => e.trait).length, s.traitMinionsPerWave);
    for (const trait of s.traitPool) assert.equal(wave.filter(e => e.trait === trait).length, 3);
  }
});
test('C027 stages 1 through 5 keep 30 melee minions per wave; stage 6 restores ranged minions', () => {
  for (const stage of [1, 2, 3, 4, 5]) for (const wave of run(stage).plans) {
    assert.equal(wave.length, 30);
    assert.ok(wave.every(e => enemyDef(e.id).attackType === 'melee'));
    assert.equal(wave.filter(e => e.id === 'RM01').length, 22);
    assert.equal(wave.filter(e => e.id === 'RM02').length, 8);
  }
  for (const wave of run(6).plans) assert.equal(wave.filter(e => enemyDef(e.id).attackType === 'ranged').length, 8);
});
test('C027 every minion pays 9 energy once, and the twelfth kill opens a regular draft', () => {
  for (const d of ENEMIES.filter(e => e.tier === 'minion')) {
    const r = combat();
    for (let i = 1; i <= 12; i++) {
      const e = monster(r, d.id); damageEnemy(r, e, 9999, 'global', 'test');
      damageEnemy(r, e, 9999, 'global', 'duplicate hit'); reconcileBattle(r);
      if (i < 12) { assert.equal(r.energy, i * 9); assert.equal(r.candidates.length, 0); }
    }
    assert.equal(r.energy, 8); assert.deepEqual(r.drawQueue, ['energy']);
    assert.equal(r.candidates.length, 3); assert.equal(r.kills, 12);
  }
});
test('C027 boss rewards stay a direct card without minion energy', () => {
  for (const d of ENEMIES.filter(e => e.tier !== 'minion')) {
    const r = combat(), e = monster(r, d.id); damageEnemy(r, e, 99999, 'global', 'test');
    assert.equal(r.energy, 0); assert.deepEqual(r.drawQueue, ['boss']);
  }
});
test('AC05 prepaid debt consumes only energy, preserves overflow and boss draws', () => {
  const r = combat(); r.drawDebt = 3; r.drawQueue = ['boss']; gainEnergy(r, 457);
  assert.equal(r.drawDebt, 0); assert.equal(r.energy, 57); assert.deepEqual(r.drawQueue, ['boss', 'energy']);
});
test('AC06 simultaneous four deaths offer grandpa first, revive oldest three, and retain fourth occupied slot', () => {
  const r = run(); HEROES.slice(0, 4).forEach((h, i) => { const a = deployHero(r, h.id, i); a.hp = 0; a.deathTick = 10 - i; });
  reconcileBattle(r); assert.equal(r.rescue, 'grandpa'); const tick = r.tick; stepBattle(r); assert.equal(r.tick, tick);
  assert.equal(resolveRescue(r, true), true); assert.equal(r.slots[0]!.hp, 0);
  assert.equal(r.slots.filter(h => h!.hp > 0).length, 3); assert.equal(r.drawDebt, 3);
  assert.equal(r.drawQueue.length, 3); assert.equal(r.freeReviveUsed, false); assert.equal(resolveRescue(r, true), false);
});
test('AC06 grandpa decline consumes opportunity; AC07 two-hero wipe has independent one-time revival', () => {
  const r = run(); HEROES.slice(0, 3).forEach((h, i) => { deployHero(r, h.id, i).hp = 0; });
  reconcileBattle(r); resolveRescue(r, false); assert.equal(r.grandpaUsed, true); assert.equal(r.drawDebt, 0); assert.equal(r.rescue, 'wipe');
  resolveRescue(r, true); assert.equal(r.freeReviveUsed, true); r.slots.forEach(h => { if (h) h.hp = 0; }); reconcileBattle(r);
  assert.equal(resolveRescue(r, true), false); resolveRescue(r, false); assert.equal(r.status, 'defeat');
  const two = run(); deployHero(two, 'RH01', 0).hp = 0; deployHero(two, 'RH02', 1).hp = 0;
  reconcileBattle(two); assert.equal(two.rescue, 'wipe'); resolveRescue(two, true); assert.equal(two.grandpaUsed, false);
});
test('AC08 target invalidation repairs only invalid choices and is stable across repeated reconciliation', () => {
  const r = combat(); deployHero(r, 'RH01', 1); deployHero(r, 'RH03', 2); deployHero(r, 'RH04', 3);
  r.drawQueue = ['energy']; r.candidates = [
    { id: 'a', kind: 'attribute', quality: 'blue', heroId: 'RH02', attribute: 'attack' },
    { id: 'b', kind: 'attribute', quality: 'blue', heroId: 'RH01', attribute: 'attack' },
    { id: 'c', kind: 'skill', quality: 'purple', heroId: 'RH03', skillSlot: 2, level: 1 },
  ];
  const valid = copy(r.candidates.slice(1)), cardRng = r.rng.card; r.slots[0]!.hp = 0; repairDraft(r);
  assert.notEqual(r.candidates[0].heroId, 'RH02'); assert.deepEqual(r.candidates.slice(1), valid); assert.equal(r.rng.card, cardRng);
  const saved = copy(r); repairDraft(r); assert.deepEqual(r, saved);
});
test('AC09 S1 Lv5 hits a single boss once; multiple targets are distinct', () => {
  const r = combat('RH01'), h = r.slots[0]!; h.skills[0] = 5;
  const e = monster(r, 'RL01'); const before = e.hp;
  updateHeroes(r, 1 / 60); assert.deepEqual(h.windup!.targets, [e.uid]);
  updateHeroes(r, .25); assert.equal(before - e.hp, Math.ceil(h.attack * 1.8));
});
test('C028 comprehensive blue card upgrades all stats additively and heals only the HP delta', () => {
  const r = combat('RH01'), h = r.slots[0]!, base = copy(h.base), delta = attributeBonuses(h);
  h.hp -= 100;
  for (const attribute of ['all', 'attack', 'hp', 'defense'] as const) {
    r.drawQueue = ['energy']; r.candidates = [{ id: attribute, kind: 'attribute', quality: 'blue', heroId: h.id, attribute }];
    const previous = { attack: h.attack, hp: h.hp, maxHp: h.maxHp, defense: h.defense };
    assert.equal(cardText(r.candidates[0]).title, '全面强化');
    assert.equal(chooseCard(r, attribute), true);
    assert.equal(h.attack, previous.attack + delta.attack); assert.equal(h.defense, previous.defense + delta.defense);
    assert.equal(h.maxHp, previous.maxHp + delta.hp); assert.equal(h.hp, previous.hp + delta.hp);
    assert.deepEqual(h.base, base); assert.equal(h.level, 1);
  }
});
test('C028 distinct drafts avoid duplicate comprehensive cards; exhausted survivor pool remains playable', () => {
  const r = run(); HEROES.slice(0, 4).forEach((h, i) => deployHero(r, h.id, i));
  for (let i = 0; i < 100; i++) {
    r.candidates = []; r.drawQueue = ['energy']; showDraft(r);
    const cards = r.candidates.filter(c => c.kind === 'attribute');
    assert.ok(cards.every(c => c.attribute === 'all')); assert.equal(new Set(cards.map(c => c.heroId)).size, cards.length);
  }
  r.slots.forEach((h, i) => { h!.skills = [5, 5, 5]; if (i) h!.hp = 0; }); r.globalSkill = 'blue';
  r.candidates = []; r.drawQueue = ['energy']; showDraft(r);
  assert.equal(r.candidates.length, 3); assert.ok(r.candidates.every(c => c.kind === 'attribute' && c.heroId === 'RH01'));
  const saved = copy(r); repairDraft(r); assert.deepEqual(r, saved); assert.equal(chooseCard(r, r.candidates[2].id), true);
});
test('C028 legacy single-stat draft IDs survive deterministic deduplication and restoration', () => {
  const r = run(); HEROES.slice(0, 4).forEach((h, i) => deployHero(r, h.id, i)); r.drawQueue = ['energy'];
  r.candidates = (['attack', 'hp', 'defense'] as const).map(attribute => ({ id: attribute, kind: 'attribute', heroId: 'RH01', quality: 'blue', attribute }));
  const restored = copy(r); repairDraft(r); repairDraft(restored); assert.deepEqual(restored, r);
  assert.deepEqual(r.candidates.map(c => c.id), ['attack', 'hp', 'defense']);
  assert.equal(new Set(r.candidates.map(c => c.heroId)).size, 3);
  assert.equal(chooseCard(r, 'hp'), true);
});
test('AC10 skills begin full cooldown; an unlocked skill waits for a legal target', () => {
  const r = combat('RH01'), h = r.slots[0]!;
  r.drawQueue = ['energy']; r.candidates = [{ id: 's', kind: 'skill', heroId: h.id, quality: 'purple', skillSlot: 2, level: 1 }];
  chooseCard(r, 's'); assert.equal(h.skills[1], 1); assert.equal(h.cooldowns[1], 10);
  h.cooldowns[1] = 0; updateHeroes(r, 1); assert.equal(h.cooldowns[1], 0);
  monster(r); updateHeroes(r, 1 / 60); assert.equal(h.skillWindup?.slot, 2);
  updateHeroes(r, .24); assert.equal(h.cooldowns[1], 10);
});
test('AC10 summon replacement, owner death, fixed extra shots, and fortress non-compounding', () => {
  const r = combat('RH06'), h = r.slots[0]!; h.skills = [1, 3, 5]; const e = monster(r, 'RL01'); e.hp = e.maxHp = 1e6;
  castHeroSkill(r, h, 2); const original = r.summons[0]; castHeroSkill(r, h, 2);
  assert.equal(r.summons.length, 1); assert.notEqual(r.summons[0].uid, original.uid);
  castHeroSkill(r, h, 3); const hp = r.summons[0].maxHp; castHeroSkill(r, h, 3); assert.equal(r.summons[0].maxHp, hp);
  h.hp = 0; updateSummons(r, .1); assert.equal(r.summons.length, 1);
  const burst = combat('RH02'), b = burst.slots[0]!; b.skills[2] = 1; monster(burst, 'RL01'); castHeroSkill(burst, b, 3);
  updateSummons(burst, .65); assert.equal(burst.summons[0].shots, 1); updateSummons(burst, .65); assert.equal(burst.summons.length, 0);
});
test('AC11 shape area is 20/50/100 percent; fan can rotate without becoming rectangular', () => {
  for (const degree of [-25, 0, 25]) assert.ok(Math.abs(skillArea('purple', .5, .5, degree).fraction - .5) < 1e-7);
  const blue = skillArea('blue', 0, 0); assert.equal(blue.fraction, .2); assert.equal(inSkillArea(blue, { x: 0, y: 0 }), false);
  assert.equal(inSkillArea(skillArea('gold'), { x: .99, y: .99 }), true);
});
test('AC11 cancel preserves card; confirmed cast consumes exactly once and bypasses ranged resistance', () => {
  const r = combat(); const e = monster(r, 'RM02', 'T02'); r.globalSkill = 'gold';
  assert.equal(aimGlobal(r), true); cancelGlobal(r); assert.equal(r.globalSkill, 'gold');
  aimGlobal(r); assert.equal(castGlobal(r), true); assert.equal(e.hp, 0); assert.equal(r.globalSkill, null); assert.equal(castGlobal(r), false);
});
test('AC12 shield triggers before damage once, command never refills spent shields', () => {
  const r = combat(), e = monster(r, 'RM02', 'T04'); e.hp = e.maxHp = 60; const hp = e.hp;
  damageEnemy(r, e, 5, 'ranged', 'test'); assert.equal(e.hp, hp); assert.equal(e.shield, hp * .2 - 5);
  e.commandUntil = 99; damageEnemy(r, e, 50, 'ranged', 'test'); assert.equal(e.shield, 0); const after = e.hp;
  damageEnemy(r, e, 1, 'ranged', 'test'); assert.equal(e.hp, after - 1);
});
test('AC12 residual only rewards final death and can be reached by all-melee after final release', () => {
  const r = combat('RH01'); r.wave = 15; const e = monster(r, 'RM01', 'T06', .5, .1);
  damageEnemy(r, e, 999, 'melee', 'test'); assert.equal(e.residual, true); assert.equal(r.energy, 0); assert.equal(r.kills, 0);
  assert.equal(heroTargets(r, r.slots[0]!)[0], e); damageEnemy(r, e, 999, 'melee', 'test'); assert.equal(r.energy, 9); assert.equal(r.kills, 1);
});
test('AC12 pending explosion prevents premature victory', () => {
  const r = combat(); r.wave = 15; const e = monster(r, 'RM01', 'T08', .8, .8);
  damageEnemy(r, e, 999, 'ranged', 'test'); reconcileBattle(r); assert.equal(r.status, 'active'); assert.equal(r.explosions.length, 1);
  for (let i = 0; i < 40; i++) stepBattle(r); assert.equal(r.status, 'victory'); assert.equal(r.drawQueue.length, 0); assert.equal(r.summons.length, 0);
});
test('target selection, taunt and boss control resistance are deterministic', () => {
  const r = combat('RH05'); const h = r.slots[0]!; h.skills[1] = 1; const e = monster(r, 'RM01', 'T09'); castHeroSkill(r, h, 2);
  assert.equal(enemyTarget(r, e)?.uid, r.summons[0].uid);
  r.summons[0].taunt = false; assert.equal(enemyTarget(r, e)?.uid, h.uid);
  const b = monster(r, 'RL01'); controlEnemy(r, b, 'root', 10); assert.equal(b.rootUntil, 6);
  const resistant = monster(r, 'RM01', 'T03'); controlEnemy(r, resistant, 'root', 10); assert.equal(resistant.rootUntil, 8);
});
test('revive immunity and damage defense have a minimum of one', () => {
  const r = combat(), h = r.slots[0]!, hp = h.hp; damageAlly(r, h, 0, 'test'); assert.equal(h.hp, hp - 1);
  h.protectionUntil = 2; damageAlly(r, h, 999, 'test'); assert.equal(h.hp, hp - 1);
});
test('expired slow does not strengthen a later weaker slow', () => {
  const r = combat(), e = monster(r);
  controlEnemy(r, e, 'slow', 1, .6); r.tick = 120;
  controlEnemy(r, e, 'slow', 2, .2);
  assert.equal(e.slowFraction, .2); assert.equal(e.slowUntil, 4);
});
test('AC13 reward totals are 5/5/10 across seeds; normal can replace both purple and gold', () => {
  let both = false, fiveGold = false, universal = false;
  for (let seed = 1; seed <= 3000; seed++) {
    for (const stage of [1, 5, 10]) {
      const rewards = rollRewards(stage, 20, streams(seed));
      assert.equal(rewards.reduce((n, r) => n + r.count, 0), stage === 10 ? 10 : 5);
      if (stage === 1 && rewards.some(r => ['RH04', 'RH05'].includes(r.key)) && rewards.some(r => r.key === 'RH06')) both = true;
      if (stage === 5 && rewards.some(r => r.key === 'RH06' && r.count === 5)) fiveGold = true;
      if (rewards.some(r => r.key === 'universal-gold')) universal = true;
    }
  }
  assert.ok(both && fiveGold && universal);
});
test('AC14 specific fragments are consumed before same-quality universal; run levels remain a snapshot', () => {
  const p = freshProfile(); p.fragments.RH04 = 7; p.fragments['universal-purple'] = 3;
  const r = createRun(p, 1, 23, 'upgrade'); assert.equal(upgradeHero(p, 'RH04', 'one'), true);
  assert.equal(p.levels.RH04, 2); assert.equal(p.fragments.RH04, 0); assert.equal(p.fragments['universal-purple'], 0); assert.equal(r.levels.RH04, 1);
  assert.equal(upgradeHero(p, 'RH04', 'one'), false); assert.equal(upgradeHero(p, 'RH04', 'two'), false);
});
test('legacy migration matches identities, preserves original bytes, and restarts progression at stage 1', () => {
  const storage = new MemoryStorage(); const raw = JSON.stringify({ schema: 1, profile: { heroes: { H001: { level: 8 }, H002: { level: 3 }, H003: { level: 2 }, H004: { level: 24 } } } }); storage.map.set(LEGACY_SAVE_KEY, raw);
  const session = new R1Session(storage); assert.equal(session.data.profile.levels.RH01, 3); assert.equal(session.data.profile.levels.RH02, 8);
  assert.equal(session.data.profile.levels.RH04, 20); assert.equal(session.data.profile.clearedStage, 0);
  session.start(1, 12); assert.equal(storage.getItem(LEGACY_SAVE_KEY), raw); assert.equal(session.data.legacyBackup, raw);
});
test('AC15 failed card save rolls back and retry persists the exact precomputed result', () => {
  const storage = new MemoryStorage(), session = new R1Session(storage); session.start(1, 765);
  const before = copy(session.data), c = session.data.run!.candidates[0]; storage.fail = true;
  assert.equal(session.choose(c.id), false); assert.deepEqual(session.data, before); assert.ok(session.error);
  const same = new R1Session(new MemoryStorage()); same.data = copy(before); // expected deterministic domain result
  const expectedRun = copy(before.run!); chooseCard(expectedRun, c.id);
  storage.fail = false; assert.equal(session.retrySave(), true); assert.deepEqual(session.data.run, expectedRun);
  assert.equal(session.choose(c.id), false);
});
test('AC15 stale writers and unknown/corrupt saves stop writing', () => {
  const storage = new MemoryStorage(), a = new R1Session(storage); a.start(1, 1); const b = new R1Session(storage);
  a.settings('music', false); const durable = storage.getItem(R1_SAVE_KEY);
  assert.equal(b.settings('sound', false), false); assert.equal(storage.getItem(R1_SAVE_KEY), durable);
  storage.map.set(R1_SAVE_KEY, '{bad'); const corrupt = new R1Session(storage); assert.ok(corrupt.error); assert.equal(corrupt.start(1, 1), false); assert.equal(storage.getItem(R1_SAVE_KEY), '{bad');
});
test('AC15 victory settlement is atomic, idempotent, and failure grants nothing', () => {
  const storage = new MemoryStorage(), session = new R1Session(storage); session.start(1, 90);
  const r = session.data.run!; r.drawQueue = []; r.candidates = []; deployHero(r, 'RH01', 0); r.wave = 15; r.released = 30;
  session.tick(1 / 60); assert.equal(session.data.run!.status, 'victory'); const fragments = copy(session.data.profile.fragments);
  assert.equal(Object.values(fragments).reduce((a, b) => a + b, 0), 5);
  session.tick(1); const restored = new R1Session(storage); restored.resume(); restored.tick(1); assert.deepEqual(restored.data.profile.fragments, fragments);
  assert.equal(restored.data.profile.settlementLedger.length, 1);
});
test('AC17 speed, draft/aim slow motion and pause share one fixed clock', () => {
  const r = combat(); r.wave = 0; r.released = 0; const clock = new BattleClock();
  assert.equal(clock.advance(r, .1), 6); r.rate = 2; assert.equal(clock.advance(r, .1), 12);
  r.aiming = true; assert.equal(effectiveRate(r), .2); assert.equal(clock.advance(r, .25), 3);
  r.paused = true; assert.equal(clock.advance(r, 100), 0);
});
test('AC17 background does not advance or catch up; restored candidates and RNG are unchanged', () => {
  const storage = new MemoryStorage(), session = new R1Session(storage); session.start(1, 909);
  const before = copy(session.data.run!); session.hide(); session.tick(30); session.show();
  const restored = new R1Session(storage); assert.equal(restored.inBattle, false); assert.deepEqual(restored.data.run, before);
  validateSave(restored.data); assert.equal(restored.data.run!.tick, 0);
});
test('seeded battles replay identically after JSON roundtrip', () => {
  const a = combat(); deployHero(a, 'RH01', 1); a.wave = 0; a.released = 0; const b = copy(a);
  for (let i = 0; i < 2400; i++) { stepBattle(a); stepBattle(b); }
  assert.deepEqual(a, b);
});
test('all twelve automatic skills operate at all five levels with legal targets', () => {
  for (const id of HEROES.map(h => h.id)) for (const slot of [2, 3]) for (let level = 1; level <= 5; level++) {
    const r = combat(id), h = r.slots[0]!; h.skills[slot - 1] = level; h.hp *= .5;
    const target = monster(r, 'RL01'); target.maxHp = target.hp = 100000;
    assert.equal(castHeroSkill(r, h, slot), true, `${id}-S${slot} Lv${level}`);
    assert.ok(h.cooldowns[slot - 1] > 0);
    assert.ok(r.enemies.every(e => Number.isFinite(e.hp)) && r.summons.every(s => Number.isFinite(s.hp)));
  }
});
test('frog buff may activate between waves and new attacks snapshot power on release', () => {
  const buff = combat('RH03'), frog = buff.slots[0]!; frog.skills[2] = 1;
  assert.equal(castHeroSkill(buff, frog, 3), true);
  const r = combat('RH01'), h = r.slots[0]!, e = monster(r, 'RL01'), hp = e.hp;
  updateHeroes(r, 1 / 60); h.attack *= 2; updateHeroes(r, .25);
  assert.equal(hp - e.hp, Math.ceil(h.attack));
});
test('corn additional shots deal area damage and ranged summons respect enemy resistance', () => {
  const r = combat('RH02'), h = r.slots[0]!; h.skills[2] = 1;
  const a = monster(r, 'RM02', null, .5, .8), b = monster(r, 'RM02', 'T02', .52, .8);
  a.hp = a.maxHp = b.hp = b.maxHp = 10000;
  castHeroSkill(r, h, 3); const hpA = a.hp, hpB = b.hp;
  updateSummons(r, .65); updateProjectiles(r, 5);
  assert.equal(hpA - a.hp, Math.ceil(h.attack * 1.2)); assert.equal(hpB - b.hp, Math.ceil(h.attack * 1.2 * .8));
});
test('saved battle snapshots reject missing unit combat fields before any write', () => {
  const storage = new MemoryStorage(), session = new R1Session(storage); session.start(1, 912);
  const r = session.data.run!; r.drawQueue = []; r.candidates = []; deployHero(r, 'RH02', 0); r.wave = 1; monster(r);
  const damaged = copy(session.data) as any; delete damaged.run.enemies[0].cooldown; storage.map.set(R1_SAVE_KEY, JSON.stringify(damaged));
  const restarted = new R1Session(storage); assert.ok(restarted.error); assert.equal(restarted.resume(), false);
  assert.equal(storage.getItem(R1_SAVE_KEY), JSON.stringify(damaged));
});
