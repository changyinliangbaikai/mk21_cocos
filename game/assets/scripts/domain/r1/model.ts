import { BattleTuning, Quality, Role, Stats } from './config';
import { RandomState } from './random';
import type { IncentiveProfile, IncentiveRun, RewardReceipt, CastRef } from './incentives';

export interface Point { x: number; y: number }
export type DrawSource = 'opening' | 'energy' | 'boss' | 'grandpa';
// Individual names remain readable for drafts saved before C-028.
export type Attribute = 'all' | 'attack' | 'hp' | 'defense';
export interface Card {
  id: string; kind: 'hero' | 'attribute' | 'skill' | 'global'; quality: Quality;
  heroId?: string; attribute?: Attribute; skillSlot?: number; level?: number;
}
export interface Hero extends Point {
  uid: number; id: string; slot: number; level: number; base: Stats; hp: number; maxHp: number;
  attack: number; defense: number; skills: number[]; cooldowns: number[]; basicCooldown: number;
  deathTick: number | null; protectionUntil: number; weakUntil: number; shield: number;
  buffUntil: number; attackBonus: number; cooldownFactor: number;
  buffs?: Record<string, { until: number; attack: number; cooldown: number; basic: number }>;
  windup: { remaining: number; targets: number[] } | null;
  skillWindup?: { remaining: number; slot: number; center: Point } | null;
}
export interface Enemy extends Point {
  uid: number; id: string; wave: number; hp: number; maxHp: number; attack: number; defense: number;
  trait: string | null; shield: number; shieldTriggered: boolean; residual: boolean;
  commandUntil: number; slowUntil: number; slowFraction: number; rootUntil: number; stunUntil: number;
  markUntil: number; markDamage: number; markRole: Role; cooldown: number; skillCooldown: number;
  commandCooldown: number; born: number;
  pulledBy?: { owner: number; until: number };
  pushUntil?: number;
  windup: { remaining: number; kind: 'basic' | 'skill' | 'command'; targets: number[]; center: Point } | null;
}
export interface Summon extends Point {
  uid: number; id: string; owner: number; role: Role; hp: number; maxHp: number; baseHp: number;
  attack: number; defense: number; radius: number; taunt: boolean; slow: number; ends: number;
  cooldown: number; interval: number; shots: number; weakUntil: number; idleTime: number;
  fortressUntil: number; attackFactor: number;
  splashRadius?: number;
  cast?: CastRef;
}
export interface Projectile extends Point {
  uid: number; target: number; side: 'hero' | 'enemy'; damage: number; role: Role;
  speed: number; effect: string; weakSeconds: number;
  radius: number;
  retargeted?: boolean;
  chain?: { remaining: number; visited: number[]; kills: number; bossBonus: number; last?: Point };
  launch?: Point;
  cast?: CastRef;
  chainLaterFactor?: number;
  /** A basic/summon area shot preserves its legal damage band after the owner dies. */
  group?: { minY: number };
}
export interface Explosion extends Point { uid: number; at: number; damage: number; radius: number }
export interface SkillBurst extends Point { owner: number; source: string; at: number; damage: number; radius: number; level: number; index: number; kind: 'pulse' | 'rocket'; target?: number; cast?: CastRef; echo?: boolean }
export interface BattleEvent extends Point { seq: number; tick: number; type: string; source: string; target?: number; amount?: number; radius?: number; from?: Point }
export interface Spawn { id: string; trait: string | null; x: number }
export interface Run {
  version: 1; id: string; seed: number; rng: RandomState; stage: number; tick: number; nextUid: number;
  tuning?: BattleTuning;
  status: 'active' | 'victory' | 'defeat'; rate: 1 | 1.5 | 2; paused: boolean; aiming: boolean;
  slots: (Hero | null)[]; levels: Record<string, number>; unlocked: string[];
  enemies: Enemy[]; summons: Summon[]; projectiles: Projectile[]; explosions: Explosion[];
  skillBursts?: SkillBurst[];
  wave: number; plans: Spawn[][]; released: number; spawnTimer: number; nextWaveTimer: number;
  spawnedMinions: number; spawnedBosses: number; kills: number; energy: number;
  /** Fractional minion energy, in 1 / wave quota units; kept through save/restore. */
  energyRemainder?: number;
  drawQueue: DrawSource[]; candidates: Card[]; cardSequence: number; globalSkill: Quality | null;
  grandpaUsed: boolean; freeReviveUsed: boolean; drawDebt: number; rescue: 'grandpa' | 'wipe' | null;
  events: BattleEvent[]; eventSequence: number;
  incentive?: IncentiveRun;
}
export interface Profile {
  clearedStage: number; levels: Record<string, number>; fragments: Record<string, number>;
  music: boolean; sound: boolean; settlementLedger: string[]; upgradeLedger: string[];
  incentive?: IncentiveProfile;
}
export interface Reward { key: string; count: number }
export interface Save {
  rosterSize?: number;
  schemaVersion: 1; revision: number; profile: Profile; run: Run | null;
  settlement: { runId: string; stage: number; rewards: Reward[]; receipt?: RewardReceipt } | null;
  incentiveBackup?: string;
  legacyBackup: string | null; migration: 'fresh' | 'imported';
}
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const aliveHeroes = (run: Run): Hero[] => run.slots.filter((h): h is Hero => !!h && h.hp > 0);
export const deployed = (run: Run): Hero[] => run.slots.filter((h): h is Hero => !!h);
export const now = (run: Run): number => run.tick / 60;
/** Saved plans retain their original quota when an older battle is resumed. */
export const waveMinionQuota = (run: Run, wave = run.wave): number => run.plans[Math.max(0, wave - 1)].length;
/** R1.0–R1.2.3 saves predate the energy snapshot and paid nine per final kill. */
export const minionEnergy = (run: Run): number => run.tuning?.minionEnergy ?? 9;
/** Distances use battle width as the unit; positions are normalized on each axis. */
export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, (a.y - b.y) * 800 / 656);
export function event(run: Run, type: string, source: string, at: Point, target?: number, amount?: number, radius?: number, from?: Point): void {
  const value: BattleEvent = { seq: ++run.eventSequence, tick: run.tick, type, source, x: at.x, y: at.y };
  if (target !== undefined) value.target = target;
  if (amount !== undefined) value.amount = amount;
  if (radius !== undefined) value.radius = radius;
  if (from) value.from = {x:from.x,y:from.y};
  run.events.push(value);
  // Cosmetic history is bounded; logic never reads it to determine outcomes.
  if (run.events.length > 160) run.events.splice(0, run.events.length - 160);
}
