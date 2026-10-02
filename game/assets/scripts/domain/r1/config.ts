import data from './runtime-config.json';

export type Quality = 'blue' | 'purple' | 'gold';
export type Role = 'melee' | 'ranged' | 'support';
export type Stats = { hp: number; attack: number; defense: number };
export interface HeroDefinition {
  id: string; name: string; quality: Quality; role: Role; unlockAfterStage: number;
  legacyIdentity: string | null; maxPermanentLevel: number; fragmentsPerLevel: number;
  level1: Stats; perPermanentLevel: Stats; attackIntervalSeconds: number; verticalRangeFraction: number;
}
export interface SkillDefinition {
  id: string; hero: string; slot: number; name: string; cardQuality: Quality; kind: string;
  cooldownSeconds: number[]; damageAttackMultiplier: number[]; radiusBattleWidthFraction: number[];
  levelEffect: Record<string, number | string | boolean>[];
}
export interface EnemyDefinition {
  id: string; name: string; tier: 'minion' | 'miniboss' | 'boss'; attackType: 'melee' | 'ranged';
  baseHp: number; baseAttack: number; baseDefense: number; baseMoveDesignPixelsPerSecond: number;
  energyOnFinalDeath: number;
  attackIntervalSeconds: number; telegraphSeconds: number; projectileSpeedDesignPixelsPerSecond: number;
  allowedBirthTraits: string[]; bossControlDurationFactor: number; bossDisplacementFactor: number;
}
export interface StageDefinition {
  id: number; difficulty: 'normal' | 'hard' | 'superhard'; stageScale: number; hpAttackDifficultyMultiplier: number;
  waves: number; minionsPerWave: number; minionCompositionEachWave: Record<string, number>;
  spawnIntervalSeconds: number; nextWaveMaxDelaySeconds: number; traitPool: string[];
  traitMinionsPerWave: number; eachTraitQuota: number; miniBosses: Record<string, string[]>; finalBoss: string;
  waveStatScales?: number[]; spawnIntervalsByWave?: number[];
}
export interface CrowdTuning { throughWave: number; batchSize: number; interval: number; period: number; clearDelay: number }
export interface HeroFeelTuning { startingSkill2: number; deployCastDelay: number; cardCastDelay: number; normalCooldownFactor: number; thirdCooldownFactor: number; radiusScale: number; meleeSkillRange: number }
export interface BattleTuning { version: string; baseScale: number; waveScales: number[]; spawnIntervals: number[]; nextWaveDelay: number; crowd?: CrowdTuning; feel?: HeroFeelTuning }
export const RULES = data;
export const HEROES = data.heroes as HeroDefinition[];
export const SKILLS = data.skills as SkillDefinition[];
export const ENEMIES = data.enemies as EnemyDefinition[];
export const STAGES = data.stages as StageDefinition[];
export const heroDef = (id: string): HeroDefinition => required(HEROES.find(h => h.id === id), id);
export const enemyDef = (id: string): EnemyDefinition => required(ENEMIES.find(e => e.id === id), id);
export const skillDef = (hero: string, slot: number): SkillDefinition => required(SKILLS.find(s => s.hero === hero && s.slot === slot), `${hero}-S${slot}`);
export const stageDef = (id: number): StageDefinition => required(STAGES.find(s => s.id === id), `stage ${id}`);
/** Keep the chosen curve with a new run so updates never change a battle halfway through. */
export function stageTuning(id: number): BattleTuning {
  const s = stageDef(id);
  return { version: data.version, baseScale: s.stageScale * s.hpAttackDifficultyMultiplier,
    waveScales: [...(s.waveStatScales || Array.from({ length: 15 }, (_, i) => 1 + .025 * i))],
    spawnIntervals: [...(s.spawnIntervalsByWave || Array(15).fill(s.spawnIntervalSeconds))], nextWaveDelay: s.nextWaveMaxDelaySeconds,
    crowd: { ...data.battle.crowd }, feel: { ...data.battle.feel } };
}
export function autoSkillCooldown(tuning: BattleTuning | undefined, hero: string, slot: number, level: number): number {
  const seconds = skillDef(hero, slot).cooldownSeconds[level - 1], feel = tuning?.feel;
  return seconds * (feel ? (slot === 2 ? feel.normalCooldownFactor : feel.thirdCooldownFactor) * (1 - (level - 1) * .035) : 1);
}
export function autoSkillRadius(tuning: BattleTuning | undefined, hero: string, slot: number, level: number): number {
  return skillDef(hero, slot).radiusBattleWidthFraction[level - 1] * (tuning?.feel && hero !== 'RH03' ? tuning.feel.radiusScale : 1);
}
/** R1.0–R1.0.2 snapshots predate tuning snapshots; their original curve remains stable. */
export function legacyStageTuning(id: number): BattleTuning {
  return { version: 'R1.0.2', baseScale: Number(Math.pow(1.06, id - 1).toFixed(6)) * (id % 10 === 0 ? 1.5 : id % 5 === 0 ? 1.2 : 1),
    waveScales: Array.from({ length: 15 }, (_, i) => 1 + .025 * i), spawnIntervals: Array(15).fill(.5), nextWaveDelay: 5 };
}
function required<T>(value: T | undefined, id: string): T { if (!value) throw new Error(`R1 unknown definition: ${id}`); return value; }
export function permanentStats(id: string, level: number): Stats {
  const h = heroDef(id);
  if (!Number.isInteger(level) || level < 1 || level > h.maxPermanentLevel) throw new Error('Invalid permanent level');
  return { hp: h.level1.hp + (level - 1) * h.perPermanentLevel.hp,
    attack: h.level1.attack + (level - 1) * h.perPermanentLevel.attack,
    defense: h.level1.defense + (level - 1) * h.perPermanentLevel.defense };
}
export function validateR1Config(): void {
  const assert = (ok: boolean, message: string) => { if (!ok) throw new Error(`R1 config: ${message}`); };
  assert(data.schemaVersion === 1 && data.rngVersion === 'xorshift32-v1', 'version');
  assert(Number.isFinite(data.battle.targeting.emergencyMeleeDistancePixels) && data.battle.targeting.emergencyMeleeDistancePixels > 40, 'emergency targeting distance');
  for (const rows of [HEROES, SKILLS, ENEMIES]) assert(new Set(rows.map(x => x.id)).size === rows.length, 'duplicate ID');
  assert(HEROES.length === 10 && SKILLS.length === 30 && STAGES.length === 20, 'roster');
  assert(HEROES.filter(h=>h.quality==='blue').length===3 && HEROES.filter(h=>h.quality==='purple').length===4 && HEROES.filter(h=>h.quality==='gold').length===3, 'quality roster');
  for (const h of HEROES) {
    assert(SKILLS.filter(s => s.hero === h.id).length === 3, h.id + ' skills');
    assert(h.level1.hp > 0 && h.level1.attack > 0 && h.level1.defense >= 0, h.id + ' stats');
    assert(h.unlockAfterStage >= 0 && h.unlockAfterStage <= 20, h.id + ' unlock');
  }
  assert(heroDef('RH01').legacyIdentity === 'H002' && heroDef('RH02').legacyIdentity === 'H001', 'identity migration');
  for (const s of SKILLS) {
    heroDef(s.hero);
    assert([s.cooldownSeconds, s.damageAttackMultiplier, s.radiusBattleWidthFraction, s.levelEffect].every(a => a.length === 5), s.id + ' five levels');
    assert(s.cardQuality === (s.slot === 3 && heroDef(s.hero).quality !== 'blue' ? 'gold' : 'purple'), s.id + ' card quality');
  }
  for (const s of STAGES) {
    assert(s.waves === 15 && s.minionsPerWave === 30 && Object.values(s.minionCompositionEachWave).reduce((a, b) => a + b, 0) === 30, 'wave quota');
    Object.keys(s.minionCompositionEachWave).forEach(enemyDef);
    Object.values(s.miniBosses).flat().concat(s.finalBoss).forEach(enemyDef);
    assert(s.traitPool.length * s.eachTraitQuota === s.traitMinionsPerWave, 'trait quota');
    assert(s.traitPool.every(t => data.firstReleaseEnabledTraits.includes(t)), 'disabled trait');
    assert(s.difficulty === (s.id % 10 === 0 ? 'superhard' : s.id % 5 === 0 ? 'hard' : 'normal'), 'stage difficulty');
    const tuning = stageTuning(s.id);
    assert(Number.isFinite(tuning.baseScale) && tuning.baseScale > 0, 'stage scale');
    assert([tuning.waveScales, tuning.spawnIntervals].every(a => a.length === 15 && a.every(n => Number.isFinite(n) && n > 0)), 'wave tuning');
    assert(tuning.nextWaveDelay === 5, 'next wave delay');
  }
  for (const weights of [data.cards.heroQualityWeights, data.cards.enhancementWeights, data.cards.globalQualityWeights])
    assert(Object.values(weights).reduce((a, b) => a + b, 0) === 100, 'probability sum');
  assert(Math.abs(data.rewards.hard.goldEvents.reduce((n, e) => n + e.probability, 0) - 1) < 1e-10, 'reward probabilities');
}
validateR1Config();
