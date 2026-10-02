import { HEROES, Quality, RULES, SKILLS, heroDef, permanentStats, skillDef } from './config';
import { Card, Hero, Run, aliveHeroes, event, now } from './model';
import { Stream, pick, random, weighted } from './random';
import { goalProgress } from './incentives';

const qualities: Quality[] = ['blue', 'purple', 'gold'];
export const emptySlots = (r: Run): number => r.slots.filter(h => !h).length;
const keyOf = (c: Omit<Card, 'id'>) => [c.kind, c.heroId, c.kind === 'attribute' ? 'all' : c.attribute, c.skillSlot, c.quality].join(':');
export function attributeBonuses(h: Hero): { attack: number; hp: number; defense: number } {
  const effects = RULES.cards.blueEffects;
  return { attack: h.base.attack * effects.attack.additiveBaseFraction, hp: h.base.hp * effects.maxHp.additiveBaseFraction, defense: h.base.defense * effects.defense.additiveBaseFraction };
}
function heroPool(r: Run): Omit<Card, 'id'>[] {
  return HEROES.filter(h => r.unlocked.includes(h.id) && !r.slots.some(x => x?.id === h.id))
    .map(h => ({ kind: 'hero', quality: h.quality, heroId: h.id }));
}
function enhancementPool(r: Run): Omit<Card, 'id'>[] {
  const result: Omit<Card, 'id'>[] = [];
  for (const h of aliveHeroes(r)) {
    result.push({ kind: 'attribute', quality: 'blue', heroId: h.id, attribute: 'all' });
    for (const s of SKILLS.filter(s => s.hero === h.id && h.skills[s.slot - 1] < 5))
      result.push({ kind: 'skill', quality: s.cardQuality, heroId: h.id, skillSlot: s.slot, level: h.skills[s.slot - 1] + 1 });
  }
  return result;
}
function sample(r: Run, pool: Omit<Card, 'id'>[], weights: Record<Quality, number>, stream: Stream): Omit<Card, 'id'> {
  const q = weighted(qualities.filter(q => pool.some(c => c.quality === q)).map(q => ({ value: q, weight: weights[q] })), r.rng, stream);
  return pick(pool.filter(c => c.quality === q), r.rng, stream);
}
export function showDraft(r: Run): void {
  if (r.candidates.length || !r.drawQueue.length || r.rescue || r.status !== 'active') return;
  const cards: Omit<Card, 'id'>[] = [], heroes = heroPool(r);
  if(r.incentive&&r.cardSequence===0&&r.drawQueue[0]==='opening'){
    const captain=heroes.find(c=>c.heroId===r.incentive!.captain);if(captain)cards.push(captain);
  }
  for (let i = cards.length; i < Math.min(emptySlots(r), 3); i++) {
    const selected = sample(r, heroes.filter(c => !cards.some(a => a.heroId === c.heroId)), RULES.cards.heroQualityWeights, 'card');
    cards.push(selected);
  }
  if (!emptySlots(r) && !r.globalSkill && random(r.rng, 'card') < .1) {
    cards.push({ kind: 'global', quality: weighted(qualities.map(q => ({ value: q, weight: RULES.cards.globalQualityWeights[q] })), r.rng, 'card') });
  }
  while (cards.length < 3) {
    const available = enhancementPool(r);
    let pool = available.filter(c => !cards.some(a => keyOf(c) === keyOf(a)));
    // A lone survivor with maxed skills still gets a usable three-choice draft.
    if (!pool.length) pool = available.filter(c => c.kind === 'attribute');
    if (!pool.length) return; // A wipe is resolved before the suspended draft can resume.
    cards.push(sample(r, pool, RULES.cards.enhancementWeights, 'card'));
  }
  r.candidates = cards.map(c => ({ ...c, id: `${r.id}:card:${++r.cardSequence}` }));
  r.aiming = false;
  event(r, 'draft', r.drawQueue[0], { x: .5, y: .5 });
}
export function validCard(r: Run, card: Card): boolean {
  if (card.kind === 'hero') return emptySlots(r) > 0 && heroPool(r).some(c => c.heroId === card.heroId);
  if (card.kind === 'global') return !emptySlots(r) && !r.globalSkill;
  return enhancementPool(r).some(c => keyOf(c) === keyOf(card) && (card.kind !== 'skill' || c.level === card.level));
}
/** Preserve shown IDs and unaffected choices. Replacements use their own saved stream. */
export function repairDraft(r: Run): void {
  if (r.rescue || !aliveHeroes(r).length) return;
  for (let i = 0; i < r.candidates.length; i++) {
    const old = r.candidates[i];
    const repeated = r.candidates.slice(0, i).some(c => keyOf(c) === keyOf(old));
    if (validCard(r, old) && !repeated) continue;
    const used = r.candidates.filter((_, j) => j !== i).map(keyOf);
    const available = enhancementPool(r);
    let pool = available.filter(c => !used.includes(keyOf(c)));
    if (!pool.length && validCard(r, old)) continue;
    if (!pool.length) pool = available.filter(c => c.kind === 'attribute');
    const sameQuality = pool.filter(c => c.quality === old.quality);
    if (sameQuality.length) pool = sameQuality;
    if (pool.length) r.candidates[i] = { ...sample(r, pool, RULES.cards.enhancementWeights, 'replacement'), id: old.id };
  }
}
export function deployHero(r: Run, id: string, slot: number): Hero {
  if (!Number.isInteger(slot) || slot < 0 || slot >= 4 || r.slots[slot] || r.slots.some(h => h?.id === id) || !r.unlocked.includes(id)) throw new Error('Invalid hero slot');
  const level = r.levels[id], base = permanentStats(id, level);
  const h: Hero = { uid: ++r.nextUid, id, slot, level, base, hp: base.hp, maxHp: base.hp, attack: base.attack, defense: base.defense,
    x: RULES.screen.heroCentersX[slot], y: 1, skills: [1, r.tuning?.feel?.startingSkill2 || 0, 0],
    cooldowns: [0, r.tuning?.feel ? r.tuning.feel.deployCastDelay + slot * .35 : 0, 0], basicCooldown: 0,
    deathTick: null, protectionUntil: 0, weakUntil: 0, shield: 0, buffUntil: 0, attackBonus: 0, cooldownFactor: 1, windup: null };
  r.slots[slot] = h;
  if(r.incentive){r.incentive.stats.heroBaseHp+=base.hp;if(heroDef(id).unlockAfterStage>0)goalProgress(r,'first-trial');}
  event(r, 'deploy', id, h); return h;
}
export function chooseCard(r: Run, id: string, slot?: number): boolean {
  if (r.status !== 'active' || r.rescue || r.paused) return false;
  repairDraft(r);
  const c = r.candidates.find(c => c.id === id);
  if (!c || !validCard(r, c)) return false;
  if (c.kind === 'hero') {
    const target = slot ?? r.slots.findIndex(h => !h);
    if (target < 0 || target >= 4 || !Number.isInteger(target) || r.slots[target]) return false;
    deployHero(r, c.heroId!, target);
  } else if (c.kind === 'global') r.globalSkill = c.quality;
  else {
    const h = aliveHeroes(r).find(h => h.id === c.heroId)!;
    if (c.kind === 'attribute') {
      const delta = attributeBonuses(h);
      h.attack += delta.attack; h.defense += delta.defense; h.maxHp += delta.hp; h.hp += delta.hp;
    } else {
      const index = c.skillSlot! - 1, unlocking = h.skills[index] === 0;
      h.skills[index]++;
      if (r.tuning?.feel) {
        if (index) h.cooldowns[index] = Math.min(h.cooldowns[index] || Infinity, r.tuning.feel.cardCastDelay);
        else h.basicCooldown = Math.min(h.basicCooldown, r.tuning.feel.cardCastDelay);
      } else if (unlocking) h.cooldowns[index] = skillDef(h.id, index + 1).cooldownSeconds[0];
      event(r, 'skill-upgraded', `${h.id}-S${index + 1}`, h, h.uid, h.skills[index]);
    }
  }
  r.drawQueue.shift(); r.candidates = [];
  event(r, 'card-picked', c.kind, { x: .5, y: .5 });
  showDraft(r); return true;
}
export function gainEnergy(r: Run, energy: number): void {
  if (!Number.isInteger(energy) || energy < 0) throw new Error('Invalid energy');
  r.energy += energy;
  while (r.energy >= 100) { r.energy -= 100; if (r.drawDebt) r.drawDebt--; else r.drawQueue.push('energy'); }
}
export function resolveRescue(r: Run, accept: boolean): boolean {
  if (!r.rescue || r.status !== 'active') return false;
  const kind = r.rescue, dead = r.slots.filter((h): h is Hero => !!h && h.hp <= 0)
    .sort((a, b) => (a.deathTick ?? 0) - (b.deathTick ?? 0) || a.slot - b.slot);
  if (kind === 'grandpa') {
    r.grandpaUsed = true;
    if (accept) { dead.splice(3); r.drawDebt += 3; r.drawQueue.push('grandpa', 'grandpa', 'grandpa'); }
  } else {
    if (accept && r.freeReviveUsed) return false;
    if (accept) r.freeReviveUsed = true;
    else { r.status = 'defeat'; r.drawQueue = []; r.candidates = []; r.summons = []; r.projectiles = []; r.explosions = []; }
  }
  if (accept) for (const h of dead) {
    h.hp = h.maxHp; h.deathTick = null; h.protectionUntil = now(r) + 2;
    h.weakUntil = 0; event(r, 'revive', h.id, h);
  }
  r.rescue = null;
  if (r.status === 'active' && !aliveHeroes(r).length) r.rescue = 'wipe';
  repairDraft(r); showDraft(r); return true;
}
export function cardText(c: Card): { title: string; subtitle: string; body: string } {
  const q = { blue: '蓝色', purple: '紫色', gold: '金色' }[c.quality];
  if (c.kind === 'hero') { const h = heroDef(c.heroId!); return { title: h.name, subtitle: `${q} · ${ { melee: '近战', ranged: '远程', support: '辅助' }[h.role] }`, body: '上阵一名英雄\n固定槽位自动攻击\n永久培养属性带入本局' }; }
  if (c.kind === 'global') return { title: RULES.globalSkills[c.quality].displayName, subtitle: `${q} · 主动技能`, body: `覆盖${Math.round(RULES.globalSkills[c.quality].coverageAreaFraction * 100)}%战场\n点击中央技能槽瞄准\n确认释放后消耗一次` };
  if (c.kind === 'attribute') return { title: '全面强化', subtitle: heroDef(c.heroId!).name,
    body: '攻击增加基础值的20%\n生命与防御增加基础值的15%\n同时补充新增生命，可叠加' };
  const s = skillDef(c.heroId!, c.skillSlot!);
  return { title: s.name, subtitle: `${heroDef(c.heroId!).name} · ${s.kind === 'ultimate' ? '终极' : '普通'}技能`, body: `${c.level === 1 ? '解锁' : '升级至'} Lv.${c.level}\n${s.slot === 1 ? `普攻攻击${c.level}个不同目标` : `伤害与范围提升\n冷却后自动释放`}` };
}
