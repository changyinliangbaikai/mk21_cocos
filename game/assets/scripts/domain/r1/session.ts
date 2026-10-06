import { ENEMIES, HEROES, Quality, RULES, heroDef, stageDef } from './config';
import { Run, Save, copy } from './model';
import { BattleClock, aimGlobal, cancelGlobal, castGlobal, createRun } from './battle';
import { chooseCard, resolveRescue } from './cards';
import { freshProfile, settleProgression, upgradeHero } from './rewards';

import { Expedition, GOALS, Specialization, freshIncentive, validateIncentives } from './incentives';

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
  check(s.rosterSize === undefined || s.rosterSize === 10, '英雄名单版本无效');
  const p = s.profile;
  check(p && integer(p.clearedStage, 0, 20) && p.levels && p.fragments && Array.isArray(p.settlementLedger) && Array.isArray(p.upgradeLedger), '账户记录不完整');
  for (const h of HEROES) check(integer(p.levels[h.id], 1, 20), '英雄等级无效');
  check(Object.entries(p.fragments).every(([k, n]) => (HEROES.some(h => h.id === k) || ['universal-purple', 'universal-gold'].includes(k)) && integer(n)), '碎片记录无效');
  check(typeof p.music === 'boolean' && typeof p.sound === 'boolean', '设置记录无效');
  check(p.settlementLedger.every(x => typeof x === 'string') && p.upgradeLedger.every(x => typeof x === 'string'), '事务账本无效');
  if (s.run) validateRun(s.run);
  validateIncentives(p,s.run);
  check(s.incentiveBackup===undefined||typeof s.incentiveBackup==='string','成长迁移备份无效');
  if (s.settlement) check(typeof s.settlement.runId === 'string' && integer(s.settlement.stage, 1, 20) && Array.isArray(s.settlement.rewards) && s.settlement.rewards.every(r => typeof r.key === 'string' && integer(r.count, 1, 10)), '结算记录无效');
  if(s.settlement?.receipt){const t=s.settlement.receipt;
    check(t.ruleVersion==='R1.2.0'&&['victory','defeat'].includes(t.outcome)&&typeof t.reason==='string'&&[5,10].includes(t.cap)&&[0,5,10].includes(t.checkpoint)
      && HEROES.some(h=>h.id===t.focus)&&[t.before,t.after,t.directed].every(n=>integer(n))&&typeof t.firstClear==='boolean'&&['gold','purple'].includes(t.route)
      &&Array.isArray(t.newHeroes)&&t.newHeroes.every(id=>HEROES.some(h=>h.id===id))&&Array.isArray(t.newGoals)&&t.newGoals.every(id=>GOALS.some(g=>g.id===id))
      &&s.settlement.rewards.reduce((n,x)=>n+x.count,0)<=t.cap,'成长结算无效');
    if(t.expedition)check(integer(t.expedition.tier,1,8)&&['shield','speed','crossfire'].includes(t.expedition.contract),'远征结算无效');
  }
  check(s.legacyBackup === null || typeof s.legacyBackup === 'string', '旧档备份无效');
  check(['fresh', 'imported'].includes(s.migration), '迁移记录无效');
}
function validateRun(r: Run): void {
  check(r.version === 1 && typeof r.id === 'string' && integer(r.stage, 1, 20) && integer(r.tick) && integer(r.nextUid), '对局版本无效');
  check(['active', 'victory', 'defeat'].includes(r.status) && [1, 1.5, 2].includes(r.rate), '对局状态无效');
  if (r.tuning !== undefined) check(r.tuning && typeof r.tuning.version === 'string' && Number.isFinite(r.tuning.baseScale) && r.tuning.baseScale > 0 && r.tuning.nextWaveDelay === 5
    && [r.tuning.waveScales, r.tuning.spawnIntervals].every(a => Array.isArray(a) && a.length === 15 && a.every(n => Number.isFinite(n) && n > 0)), '难度快照无效');
  const energy = r.tuning?.minionEnergy;
  const explicitQuota = r.tuning?.minionsPerWave;
  // C-038/C-039 inferred their quota from a 100-energy wave; current saves store it separately.
  const quota = explicitQuota === undefined ? energy === undefined ? 30 : Math.round(RULES.cards.energyPerDraw / energy) : explicitQuota;
  if (explicitQuota === undefined) check(energy === undefined || Number.isFinite(energy) && energy > 0 && integer(quota, 1, 100)
    && Math.abs(energy * quota - RULES.cards.energyPerDraw) < 1e-8, '能量快照无效');
  else check(integer(quota, 1, 1000) && energy !== undefined && Number.isFinite(energy) && energy > 0 && energy <= 100
    && Math.abs(energy * quota - Math.round(energy * quota)) < 1e-8, '波次或能量快照无效');
  check(r.energyRemainder === undefined || integer(r.energyRemainder, 0, quota - 1)
    && (energy !== undefined && !Number.isInteger(energy) || r.energyRemainder === 0), '能量余量无效');
  if (r.tuning?.crowd !== undefined) {
    const c = r.tuning.crowd;
    check(c && (c.formation === undefined || c.formation === 'wide-lanes-v1'), '出生阵型无效');
    check(c && integer(c.throughWave, 1, 15) && integer(c.batchSize, 1, quota) && quota % c.batchSize === 0
      && numbers(c, ['interval', 'period', 'clearDelay']) && c.interval >= 1 / 60 && c.period > (c.batchSize - 1) * c.interval && c.clearDelay > 0, '怪群快照无效');
  }
  if (r.tuning?.feel !== undefined) {
    const f = r.tuning.feel;
    check(f && f.startingSkill2 === 1 && numbers(f, ['deployCastDelay', 'cardCastDelay', 'normalCooldownFactor', 'thirdCooldownFactor', 'radiusScale', 'meleeSkillRange'])
      && f.deployCastDelay > 0 && f.cardCastDelay > 0 && f.normalCooldownFactor > 0 && f.thirdCooldownFactor > 0 && f.radiusScale >= 1 && f.radiusScale <= 2 && f.meleeSkillRange >= .5 && f.meleeSkillRange <= 1, '英雄节奏快照无效');
  }
  if (r.tuning?.areaAttacks !== undefined) {
    const a=r.tuning.areaAttacks;
    check(a && a.version===1 && a.radii && HEROES.every(h=>Array.isArray(a.radii[h.id])&&a.radii[h.id].length===5&&a.radii[h.id].every((n,i,values)=>Number.isFinite(n)&&n>0&&n<=.5&&(!i||n>values[i-1]))),'群攻快照无效');
  }
  check(['spawn', 'card', 'reward', 'replacement'].every(k => integer(r.rng?.[k as keyof Run['rng']], 1, 0xffffffff)), '随机流无效');
  check(Array.isArray(r.slots) && r.slots.length === 4 && Array.isArray(r.unlocked) && r.unlocked.every(id => HEROES.some(h => h.id === id)), '英雄槽位无效');
  check(r.levels && HEROES.every(h => integer(r.levels[h.id], 1, 20)) && numbers(r, ['seed', 'spawnTimer', 'nextWaveTimer', 'spawnedMinions', 'spawnedBosses', 'kills', 'cardSequence']) && typeof r.paused === 'boolean' && typeof r.aiming === 'boolean' && typeof r.grandpaUsed === 'boolean' && typeof r.freeReviveUsed === 'boolean', '对局快照不完整');
  const ids: number[] = [];
  for (const [index, h] of r.slots.entries()) if (h) {
    heroDef(h.id); ids.push(h.uid);
    check(h.slot === index && integer(h.level, 1, 20) && h.hp >= 0 && h.hp <= h.maxHp && h.maxHp > 0 && h.attack > 0 && h.defense >= 0, '英雄数值无效');
    check(h.skills.length === 3 && h.skills.every((n, i) => integer(n, i === 0 ? 1 : 0, 5)) && h.cooldowns.length === 3 && h.cooldowns.every(n => n >= 0), '技能状态无效');
    check(numbers(h, ['uid', 'x', 'y', 'basicCooldown', 'protectionUntil', 'weakUntil', 'shield', 'buffUntil', 'attackBonus', 'cooldownFactor']) && h.base && numbers(h.base, ['hp', 'attack', 'defense']) && (h.deathTick === null || integer(h.deathTick)), '英雄快照不完整');
    if(h.buffs!==undefined)check(h.buffs&&Object.entries(h.buffs).every(([id,b])=>['RH03-S3','RH10-S3','RH10-perk-A'].includes(id)&&b&&numbers(b,['until','attack','cooldown','basic'])&&b.until>=0&&b.attack>=0&&b.attack<=1&&b.cooldown>0&&b.cooldown<=1&&b.basic>=0&&b.basic<=1),'技能增益来源无效');
    if (h.skillWindup != null) check(numbers(h.skillWindup, ['remaining', 'slot']) && h.skillWindup.remaining >= 0 && [2, 3].includes(h.skillWindup.slot)
      && h.skillWindup.center && numbers(h.skillWindup.center, ['x', 'y']) && h.skillWindup.center.x >= 0 && h.skillWindup.center.x <= 1 && h.skillWindup.center.y >= 0 && h.skillWindup.center.y <= 1, '技能前摇无效');
  }
  check(new Set(r.slots.filter(Boolean).map(h => h!.id)).size === r.slots.filter(Boolean).length, '同名英雄重复');
  check(r.plans?.length === 15 && r.plans.every(w => w.length === quota && w.every(e => ['RM01', 'RM02', 'RM04', 'RM05'].includes(e.id) && e.x >= 0 && e.x <= 1 && (e.trait === null || /^T0[1-9]$/.test(e.trait)))), '波次计划无效');
  check(integer(r.wave, 0, 15) && integer(r.released, 0, quota) && integer(r.energy, 0, 99) && integer(r.drawDebt, 0, 3), '投放或能量数据无效');
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
  for(const p of r.projectiles)if(p.group!==undefined)check(r.tuning?.areaAttacks&&p.group&&Number.isFinite(p.group.minY)&&p.group.minY>=0&&p.group.minY<=1&&p.side==='hero'&&p.radius>0&&p.radius<=.6&&!p.chain,'群攻弹道无效');
  for(const s of r.summons)if(s.splashRadius!==undefined)check(r.tuning?.areaAttacks&&Number.isFinite(s.splashRadius)&&s.splashRadius>0&&s.splashRadius<=.6,'召唤群攻无效');
  for (const p of r.projectiles) if (p.chain !== undefined) check(p.chain && integer(p.chain.remaining, 1, 8) && integer(p.chain.kills, 0, 8)
    && Array.isArray(p.chain.visited) && p.chain.visited.length <= 8 && p.chain.visited.every(n => integer(n, 1, r.nextUid)) && new Set(p.chain.visited).size === p.chain.visited.length
    && Number.isFinite(p.chain.bossBonus) && p.chain.bossBonus >= 0 && p.side === 'hero' && p.effect === 'RH04-S2', '弹射快照无效');
  for (const p of r.projectiles) if (p.launch !== undefined) check(p.launch && numbers(p.launch, ['x', 'y']) && p.launch.x >= 0 && p.launch.x <= 1 && p.launch.y === 1 && p.side === 'hero', '出手位置无效');
  for(const p of r.projectiles)if(p.chain?.last!==undefined)check(p.chain.last&&numbers(p.chain.last,['x','y'])&&p.chain.last.x>=0&&p.chain.last.x<=1&&p.chain.last.y>=0&&p.chain.last.y<=1,'弹射轨迹无效');
  for (const explosion of r.explosions) check(numbers(explosion, ['at', 'damage', 'radius']) && explosion.radius > 0 && explosion.damage >= 0, '爆炸快照无效');
  if(r.skillBursts!==undefined){
    check(Array.isArray(r.skillBursts)&&r.skillBursts.length<=64,'连续技能队列无效');
    for(const b of r.skillBursts)check(numbers(b,['owner','at','damage','radius','level','index','x','y'])&&integer(b.owner,1,r.nextUid)&&r.slots.some(h=>h?.uid===b.owner&&b.source.startsWith(h.id+'-'))
      && /^RH(?:02-S2|07-S3|08-S3|09-S[23]|10-S[23])$/.test(b.source)&&integer(b.level,1,5)&&integer(b.index,0,4)&&b.at>=0&&b.damage>=0&&b.radius>0&&b.radius<=2&&b.x>=0&&b.x<=1&&b.y>=0&&b.y<=1
      &&(b.kind==='pulse'&&b.target===undefined||b.kind==='rocket'&&b.source==='RH09-S2'&&integer(b.target,1,r.nextUid)),'连续技能快照无效');
  }
  for(const unit of [...r.projectiles,...r.summons,...(r.skillBursts||[])])if(unit.cast!==undefined){const c=unit.cast;check(r.incentive&&integer(c.id,1,r.incentive.castSequence)&&integer(c.owner,1,r.nextUid)&&r.slots.some(h=>h?.uid===c.owner&&h.id===c.hero)&&[2,3].includes(c.slot)&&typeof c.aoe==='boolean','施法来源无效');}
  for(const e of r.enemies){if(e.pulledBy!==undefined)check(e.pulledBy&&integer(e.pulledBy.owner,1,r.nextUid)&&Number.isFinite(e.pulledBy.until)&&e.pulledBy.until>=0,'拉拢来源无效');if(e.pushUntil!==undefined)check(Number.isFinite(e.pushUntil)&&e.pushUntil>=0,'击退间隔无效');}
  check(new Set(ids).size === ids.length, '单位编号重复');
  check(Array.isArray(r.events) && r.events.length <= 160 && integer(r.eventSequence), '表现事件无效');
}

/** Only the exact six-hero schema is extended; malformed current saves are never repaired. */
function extendLegacyRoster(value: unknown): void {
  const s=value as Save;if(!s||s.schemaVersion!==1||s.rosterSize!==undefined||!s.profile?.levels)return;
  const added=['RH07','RH08','RH09','RH10'],old=['RH01','RH02','RH03','RH04','RH05','RH06'];
  const oldLevels=(levels:Record<string,number>)=>levels&&old.every(id=>integer(levels[id],1,20))&&added.every(id=>!(id in levels));
  if(!oldLevels(s.profile.levels)||s.run&&!oldLevels(s.run.levels))return;
  // A new hero reference with missing levels is corruption, not a legacy account.
  if(added.some(id=>id in (s.profile.fragments||{})||s.run?.unlocked?.includes(id)||s.run?.slots?.some(h=>h?.id===id)))return;
  for(const id of added){s.profile.levels[id]=1;if(s.run)s.run.levels[id]=1;}
  s.rosterSize=10;
}

export class R1Session {
  data: Save = { schemaVersion: 1, rosterSize: 10, revision: 0, profile: freshProfile(), run: null, settlement: null, legacyBackup: null, migration: 'fresh' };
  error = ''; inBattle = false; background = false;
  private durable: string | null = null;
  private pending: Save | null = null;
  private readBlocked = false;
  private clock = new BattleClock();
  private autosave = 0;
  constructor(private storage: StoragePort) {
    try {
      const raw = storage.getItem(R1_SAVE_KEY); this.durable = raw;
      if (raw !== null) { const parsed: unknown = JSON.parse(raw); extendLegacyRoster(parsed); validateSave(parsed); this.data = parsed; if(!this.data.profile.incentive){this.data.incentiveBackup=raw;this.data.profile.incentive=freshIncentive(this.data.profile);} }
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
    // Also applies when a failed end-run transaction succeeds through retrySave.
    if (!next.run) { this.inBattle = false; this.clock.reset(); }
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
  start(stage: number, seed: number, abandon = false, expedition?: Expedition): boolean {
    const result = this.transaction(d => {
      if (d.run?.status === 'active' && !abandon) return false;
      stageDef(stage); d.run = createRun(d.profile, stage, seed, `r1-${d.revision + 1}-${seed >>> 0}`, expedition); d.settlement = null; return true;
    });
    if (result) { this.inBattle = true; this.clock.reset(); }
    return result;
  }
  resume(): boolean { if (!this.data.run || this.error) return false; this.inBattle = true; this.clock.reset(); return true; }
  camp(): boolean { const ok = this.transaction(() => true); if (ok) { this.inBattle = false; this.clock.reset(); } return ok; }
  /** Voluntary abandonment is not defeat settlement and grants no run rewards. */
  endRun(): boolean {
    return this.transaction(d => {
      if (!d.run || d.run.status !== 'active' || !d.run.paused) return false;
      d.run = null; d.settlement = null; return true;
    });
  }
  private mutateRun(action: (r: Run) => boolean): boolean { return this.transaction(d => {if(!d.run||!action(d.run))return false;this.settle(d);return true;}); }
  choose(id: string, slot?: number): boolean { return this.mutateRun(r => chooseCard(r, id, slot)); }
  rescue(accept: boolean): boolean { return this.mutateRun(r => resolveRescue(r, accept)); }
  aim(): boolean { return this.mutateRun(aimGlobal); }
  cancelAim(): boolean { return this.mutateRun(r => { if (!r.aiming) return false; cancelGlobal(r); return true; }); }
  cast(x = .5, y = .5, angle = 0): boolean { return this.mutateRun(r => castGlobal(r, x, y, angle)); }
  pause(value: boolean): boolean { return this.mutateRun(r => { r.paused = value; return true; }); }
  speed(value: 1 | 1.5 | 2): boolean { return this.mutateRun(r => { if (![1, 1.5, 2].includes(value)) return false; r.rate = value; return true; }); }
  upgrade(id: string): boolean { return this.transaction(d => upgradeHero(d.profile, id, `${id}:${d.profile.levels[id]}`)); }
  setFocus(id:string):boolean {return this.transaction(d=>{const h=heroDef(id),i=d.profile.incentive;if(!i)return false;i.focusByQuality[h.quality]=id;i.primary=h.quality;return true;});}
  setCaptain(id:string):boolean {return this.transaction(d=>{const i=d.profile.incentive;if(!i||heroDef(id).unlockAfterStage>d.profile.clearedStage)return false;i.captain=id;return true;});}
  setRoute(stage:number,route:'gold'|'purple'):boolean {return this.transaction(d=>{const i=d.profile.incentive;if(!i||![10,20].includes(stage)||!['gold','purple'].includes(route))return false;i.routes[String(stage)]=route;return true;});}
  setSpecialization(id:string,value:Specialization):boolean {return this.transaction(d=>{const i=d.profile.incentive;if(!i||!['A','B'].includes(value)||d.profile.levels[id]<3||heroDef(id).unlockAfterStage>d.profile.clearedStage)return false;i.specializations[id]=value;return true;});}
  setGoal(id:string):boolean {return this.transaction(d=>{if(!d.profile.incentive||!GOALS.some(g=>g.id===id))return false;d.profile.incentive.goal=id;return true;});}
  settings(key: 'music' | 'sound', enabled: boolean): boolean { return this.transaction(d => { d.profile[key] = enabled; return true; }); }
  hide(): void { this.background = true; this.clock.reset(); this.transaction(() => true); }
  show(): void { this.background = false; this.clock.reset(); }
  private settle(d: Save): void {
    const run = d.run;
    if (!run || run.status === 'active' || d.profile.settlementLedger.includes(run.id)) return;
    const result = settleProgression(d.profile, run);
    for (const r of result.rewards) d.profile.fragments[r.key] = (d.profile.fragments[r.key] || 0) + r.count;
    d.profile.settlementLedger.push(run.id); d.settlement = { runId: run.id, stage: run.stage, ...result };
  }
  tick(seconds: number): void {
    if (!this.inBattle || this.background || this.error || !this.data.run) return;
    const r = this.data.run, before = copy(this.data);
    const stamp = `${r.wave}:${r.cardSequence}:${r.rescue}:${r.status}`;
    this.clock.advance(r, seconds);
    this.autosave += Math.max(0, Math.min(.25, seconds));
    const critical = stamp !== `${r.wave}:${r.cardSequence}:${r.rescue}:${r.status}`;
    if (critical || this.autosave >= 5 || r.status !== 'active' && !this.data.profile.settlementLedger.includes(r.id)) {
      this.settle(this.data);
      const next = this.data; this.data = before;
      try { this.persist(next); }
      catch (e) { this.error = (e as Error).message; this.pending = next; this.clock.reset(); }
    }
  }
}
