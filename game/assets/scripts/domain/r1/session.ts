import { ENEMIES, HEROES, heroDef, stageDef } from './config';
import { Run, Save, copy } from './model';
import { BattleClock, aimGlobal, cancelGlobal, castGlobal, createRun } from './battle';
import { chooseCard, resolveRescue } from './cards';
import { freshProfile, rollRewards, upgradeHero } from './rewards';

export const R1_SAVE_KEY = 'chaoli-heroes-r1';
export const LEGACY_SAVE_KEY = 'hero-defense-v0.5-atomic';
export interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void }
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function integer(n: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): boolean { return Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max; }
function numbers(value: object, keys: string[]): boolean { return keys.every(k => typeof (value as Record<string, unknown>)[k] === 'number' && Number.isFinite((value as Record<string, unknown>)[k])); }
function finiteTree(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return !value || typeof value !== 'object' || Object.values(value).every(finiteTree);
}
/** Validate before adopting a snapshot; malformed/future data is never erased. */
export function validateSave(value: unknown): asserts value is Save {
  const s = value as Save;
  check(s && finiteTree(s) && s.schemaVersion === 1 && integer(s.revision), '存档版本或数据无效');
  const p = s.profile;
  check(p && integer(p.clearedStage, 0, 20) && p.levels && p.fragments && Array.isArray(p.settlementLedger) && Array.isArray(p.upgradeLedger), '账户记录不完整');
  for (const h of HEROES) check(integer(p.levels[h.id], 1, 20), '英雄等级无效');
  check(Object.entries(p.fragments).every(([k, n]) => (HEROES.some(h => h.id === k) || ['universal-purple', 'universal-gold'].includes(k)) && integer(n)), '碎片记录无效');
  check(typeof p.music === 'boolean' && typeof p.sound === 'boolean', '设置记录无效');
  check(p.settlementLedger.every(x => typeof x === 'string') && p.upgradeLedger.every(x => typeof x === 'string'), '事务账本无效');
  if (s.run) validateRun(s.run);
  if (s.settlement) check(typeof s.settlement.runId === 'string' && integer(s.settlement.stage, 1, 20) && Array.isArray(s.settlement.rewards) && s.settlement.rewards.every(r => typeof r.key === 'string' && integer(r.count, 1, 10)), '结算记录无效');
  check(s.legacyBackup === null || typeof s.legacyBackup === 'string', '旧档备份无效');
  check(['fresh', 'imported'].includes(s.migration), '迁移记录无效');
}
function validateRun(r: Run): void {
  check(r.version === 1 && typeof r.id === 'string' && integer(r.stage, 1, 20) && integer(r.tick) && integer(r.nextUid), '对局版本无效');
  check(['active', 'victory', 'defeat'].includes(r.status) && [1, 1.5, 2].includes(r.rate), '对局状态无效');
  if (r.tuning !== undefined) check(r.tuning && typeof r.tuning.version === 'string' && Number.isFinite(r.tuning.baseScale) && r.tuning.baseScale > 0 && r.tuning.nextWaveDelay === 5
    && [r.tuning.waveScales, r.tuning.spawnIntervals].every(a => Array.isArray(a) && a.length === 15 && a.every(n => Number.isFinite(n) && n > 0)), '难度快照无效');
  check(['spawn', 'card', 'reward', 'replacement'].every(k => integer(r.rng?.[k as keyof Run['rng']], 1, 0xffffffff)), '随机流无效');
  check(Array.isArray(r.slots) && r.slots.length === 4 && Array.isArray(r.unlocked) && r.unlocked.every(id => HEROES.some(h => h.id === id)), '英雄槽位无效');
  check(r.levels && HEROES.every(h => integer(r.levels[h.id], 1, 20)) && numbers(r, ['seed', 'spawnTimer', 'nextWaveTimer', 'spawnedMinions', 'spawnedBosses', 'kills', 'cardSequence']) && typeof r.paused === 'boolean' && typeof r.aiming === 'boolean' && typeof r.grandpaUsed === 'boolean' && typeof r.freeReviveUsed === 'boolean', '对局快照不完整');
  const ids: number[] = [];
  for (const [index, h] of r.slots.entries()) if (h) {
    heroDef(h.id); ids.push(h.uid);
    check(h.slot === index && integer(h.level, 1, 20) && h.hp >= 0 && h.hp <= h.maxHp && h.maxHp > 0 && h.attack > 0 && h.defense >= 0, '英雄数值无效');
    check(h.skills.length === 3 && h.skills.every((n, i) => integer(n, i === 0 ? 1 : 0, 5)) && h.cooldowns.length === 3 && h.cooldowns.every(n => n >= 0), '技能状态无效');
    check(numbers(h, ['uid', 'x', 'y', 'basicCooldown', 'protectionUntil', 'weakUntil', 'shield', 'buffUntil', 'attackBonus', 'cooldownFactor']) && h.base && numbers(h.base, ['hp', 'attack', 'defense']) && (h.deathTick === null || integer(h.deathTick)), '英雄快照不完整');
  }
  check(new Set(r.slots.filter(Boolean).map(h => h!.id)).size === r.slots.filter(Boolean).length, '同名英雄重复');
  check(r.plans?.length === 15 && r.plans.every(w => w.length === 30 && w.every(e => ['RM01', 'RM02', 'RM04', 'RM05'].includes(e.id) && e.x >= 0 && e.x <= 1 && (e.trait === null || /^T0[1-9]$/.test(e.trait)))), '波次计划无效');
  check(integer(r.wave, 0, 15) && integer(r.released, 0, 30) && integer(r.energy, 0, 99) && integer(r.drawDebt, 0, 3), '投放或能量数据无效');
  check(Array.isArray(r.drawQueue) && r.drawQueue.every(q => ['opening', 'energy', 'boss', 'grandpa'].includes(q)) && Array.isArray(r.candidates) && [0, 3].includes(r.candidates.length), '抽卡队列无效');
  check(r.candidates.every(c => typeof c.id === 'string' && ['hero', 'attribute', 'skill', 'global'].includes(c.kind) && ['blue', 'purple', 'gold'].includes(c.quality)), '卡牌数据无效');
  check([null, 'blue', 'purple', 'gold'].includes(r.globalSkill) && [null, 'grandpa', 'wipe'].includes(r.rescue), '技能或救场状态无效');
  for (const list of [r.enemies, r.summons, r.projectiles, r.explosions]) {
    check(Array.isArray(list), '单位列表无效');
    for (const u of list) { check(integer(u.uid, 1, r.nextUid) && u.x >= 0 && u.x <= 1 && u.y >= 0 && u.y <= 1, '单位坐标无效'); ids.push(u.uid); }
  }
  for (const e of r.enemies) check(ENEMIES.some(a => a.id === e.id) && numbers(e, ['hp', 'maxHp', 'attack', 'defense', 'shield', 'commandUntil', 'slowUntil', 'slowFraction', 'rootUntil', 'stunUntil', 'markUntil', 'markDamage', 'cooldown', 'skillCooldown', 'commandCooldown', 'born']) && e.maxHp > 0 && e.hp >= 0 && e.hp <= e.maxHp && typeof e.residual === 'boolean' && typeof e.shieldTriggered === 'boolean' && (e.trait === null || ENEMIES.find(a => a.id === e.id)!.allowedBirthTraits.includes(e.trait)), '怪物快照无效');
  for (const sum of r.summons) check(['SUM-BAG', 'SUM-WOOD', 'SUM-BURST', 'SUM-DURABLE'].includes(sum.id) && r.slots.some(h => h?.uid === sum.owner) && numbers(sum, ['hp', 'maxHp', 'baseHp', 'attack', 'defense', 'radius', 'slow', 'ends', 'cooldown', 'interval', 'shots', 'weakUntil', 'idleTime', 'fortressUntil', 'attackFactor']) && sum.hp >= 0 && sum.maxHp > 0 && sum.hp <= sum.maxHp, '召唤物快照无效');
  for (const projectile of r.projectiles) check(numbers(projectile, ['target', 'damage', 'speed', 'weakSeconds', 'radius']) && ['hero', 'enemy'].includes(projectile.side) && projectile.damage >= 0 && projectile.speed > 0 && (projectile.retargeted === undefined || typeof projectile.retargeted === 'boolean'), '弹道快照无效');
  for (const explosion of r.explosions) check(numbers(explosion, ['at', 'damage', 'radius']) && explosion.radius > 0 && explosion.damage >= 0, '爆炸快照无效');
  check(new Set(ids).size === ids.length, '单位编号重复');
  check(Array.isArray(r.events) && r.events.length <= 160 && integer(r.eventSequence), '表现事件无效');
}

export class R1Session {
  data: Save = { schemaVersion: 1, revision: 0, profile: freshProfile(), run: null, settlement: null, legacyBackup: null, migration: 'fresh' };
  error = ''; inBattle = false; background = false;
  private durable: string | null = null;
  private pending: Save | null = null;
  private readBlocked = false;
  private clock = new BattleClock();
  private autosave = 0;
  constructor(private storage: StoragePort) {
    try {
      const raw = storage.getItem(R1_SAVE_KEY); this.durable = raw;
      if (raw !== null) { const parsed: unknown = JSON.parse(raw); validateSave(parsed); this.data = parsed; }
      else {
        const legacy = storage.getItem(LEGACY_SAVE_KEY);
        if (legacy !== null) {
          const parsed = JSON.parse(legacy);
          check(parsed.schema === 1 && parsed.profile?.heroes, '旧存档无法识别，已保留原始数据');
          for (const h of HEROES) if (h.legacyIdentity) {
            const level = parsed.profile.heroes[h.legacyIdentity]?.level;
            check(integer(level, 1), '旧英雄等级无法识别'); this.data.profile.levels[h.id] = Math.min(20, level);
          }
          this.data.legacyBackup = legacy; this.data.migration = 'imported';
        }
      }
    } catch (e) { this.error = String((e as Error).message); this.readBlocked = true; }
  }
  private persist(next: Save): void {
    check(!this.readBlocked, '存档读取失败，已停止写入');
    check(this.storage.getItem(R1_SAVE_KEY) === this.durable, '其它窗口已更新存档，请重新载入');
    next.revision = this.data.revision + 1;
    validateSave(next);
    const serialized = JSON.stringify(next);
    this.storage.setItem(R1_SAVE_KEY, serialized);
    this.durable = serialized; this.data = next; this.error = ''; this.autosave = 0; this.pending = null;
  }
  private transaction(action: (draft: Save) => boolean): boolean {
    if (this.error || this.readBlocked) return false;
    const next = copy(this.data);
    try { if (!action(next)) return false; this.persist(next); return true; }
    catch (e) { this.error = (e as Error).message; this.pending = next; this.clock.reset(); return false; }
  }
  retrySave(): boolean {
    if (this.readBlocked || !this.pending) return false;
    try { this.persist(this.pending); return true; } catch (e) { this.error = (e as Error).message; return false; }
  }
  start(stage: number, seed: number, abandon = false): boolean {
    const result = this.transaction(d => {
      if (d.run?.status === 'active' && !abandon) return false;
      stageDef(stage); d.run = createRun(d.profile, stage, seed, `r1-${d.revision + 1}-${seed >>> 0}`); d.settlement = null; return true;
    });
    if (result) { this.inBattle = true; this.clock.reset(); }
    return result;
  }
  resume(): boolean { if (!this.data.run || this.error) return false; this.inBattle = true; this.clock.reset(); return true; }
  camp(): boolean { const ok = this.transaction(() => true); if (ok) { this.inBattle = false; this.clock.reset(); } return ok; }
  private mutateRun(action: (r: Run) => boolean): boolean { return this.transaction(d => !!d.run && action(d.run)); }
  choose(id: string, slot?: number): boolean { return this.mutateRun(r => chooseCard(r, id, slot)); }
  rescue(accept: boolean): boolean { return this.mutateRun(r => resolveRescue(r, accept)); }
  aim(): boolean { return this.mutateRun(aimGlobal); }
  cancelAim(): boolean { return this.mutateRun(r => { if (!r.aiming) return false; cancelGlobal(r); return true; }); }
  cast(x = .5, y = .5, angle = 0): boolean { return this.mutateRun(r => castGlobal(r, x, y, angle)); }
  pause(value: boolean): boolean { return this.mutateRun(r => { r.paused = value; return true; }); }
  speed(value: 1 | 1.5 | 2): boolean { return this.mutateRun(r => { if (![1, 1.5, 2].includes(value)) return false; r.rate = value; return true; }); }
  upgrade(id: string): boolean { return this.transaction(d => upgradeHero(d.profile, id, `${id}:${d.profile.levels[id]}`)); }
  settings(key: 'music' | 'sound', enabled: boolean): boolean { return this.transaction(d => { d.profile[key] = enabled; return true; }); }
  hide(): void { this.background = true; this.clock.reset(); this.transaction(() => true); }
  show(): void { this.background = false; this.clock.reset(); }
  private settle(d: Save): void {
    const run = d.run;
    if (!run || run.status !== 'victory' || d.profile.settlementLedger.includes(run.id)) return;
    d.profile.clearedStage = Math.max(d.profile.clearedStage, run.stage);
    const rewards = rollRewards(run.stage, d.profile.clearedStage, run.rng);
    for (const r of rewards) d.profile.fragments[r.key] = (d.profile.fragments[r.key] || 0) + r.count;
    d.profile.settlementLedger.push(run.id); d.settlement = { runId: run.id, stage: run.stage, rewards };
  }
  tick(seconds: number): void {
    if (!this.inBattle || this.background || this.error || !this.data.run) return;
    const r = this.data.run, before = copy(this.data);
    const stamp = `${r.wave}:${r.cardSequence}:${r.rescue}:${r.status}`;
    this.clock.advance(r, seconds);
    this.autosave += Math.max(0, Math.min(.25, seconds));
    const critical = stamp !== `${r.wave}:${r.cardSequence}:${r.rescue}:${r.status}`;
    if (critical || this.autosave >= 5 || r.status === 'victory' && !this.data.profile.settlementLedger.includes(r.id)) {
      this.settle(this.data);
      const next = this.data; this.data = before;
      try { this.persist(next); }
      catch (e) { this.error = (e as Error).message; this.pending = next; this.clock.reset(); }
    }
  }
}
