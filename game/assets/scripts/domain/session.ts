import { Battle, generateWave } from './battle';
import { validateConfig, drawCards, eligibleCards } from './config';

export interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export const SAVE_KEY = 'hero-defense-v0.5-atomic';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const requireRule = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const finished = (r: any) => !r || ['victory','defeat'].includes(r.phase);

/** One durable envelope makes profile grants/consumption and run transitions atomic.
 * Local synchronous storage is the only authority. Animation callbacks never grant rewards.
 */
export class GameSession {
  config: any;
  data: any;
  storage: StoragePort;
  private cached?: Battle;
  private accumulator = 0;
  private saveTicks = 0;
  private revision = 0;
  private durable = "";
  private background = false;
  private storageFault = false;
  private countdownSaveSeconds = 0;
  constructor(config: any, storage: StoragePort) {
    validateConfig(config); this.config = clone(config); this.storage = storage;
    const heroes: any = {};
    for (const h of config.heroes) heroes[h.id] = { owned: h.initially_owned, level: 1, ownedForms: [h.default_form_id], equippedForm: h.default_form_id };
    this.data = { schema: 1, revision: 0, profile: { heroes, trainingXp: 0, completedWaves: 0, victories: 0,
      roster: config.heroes.filter((h: any) => h.initially_owned).map((h: any) => h.id),
      settings: { music: 0.6, sfx: 0.7, voice: 0.8, muted: false, vibration: true, shake: true, speed: 1 },
      tutorials: {}, xpGrants: {}, victoryGrants: {}, upgradeTransactions: {} },
      screen: 'camp', selectedHero: 'H001', rosterDraft: [], overlay: null, notice: '', tutorial: null };
    try {
      const raw = storage.getItem(SAVE_KEY);
      if (raw) {
        const saved = JSON.parse(raw); this.validateSave(saved); this.data = saved; this.revision = saved.revision;
        // P6 adds a master mute without changing existing per-bus preferences or run snapshots.
        this.data.profile.settings.muted ??= false;
        // Startup always has an explicit continue entry; the run phase, candidates and aim remain intact.
        if (saved.screen === 'battle' && saved.run) saved.run.savedOverlay = ['summon','move'].includes(saved.overlay) ? null : saved.overlay;
        if(saved.run?.configVersion==='0.7'){
          if(['summon','move'].includes(saved.run.savedOverlay))saved.run.savedOverlay=null;
          if(['summon','move'].includes(saved.overlaySource))saved.overlaySource=null;
        }
        this.data.screen = 'camp'; this.data.overlay = null;
        this.data.notice = this.legacyRunNotice() || (this.data.run && !finished(this.data.run) ? `已恢复第${this.data.run.battle.wave}波存档，点击继续防守。` : '本机进度已恢复。');
      }
      this.durable = JSON.stringify(this.data);
    } catch (e) { this.storageFault = true; this.data.notice = `存档读取失败，已停止写入：${(e as Error).message}`; }
  }
  get battle(): Battle | undefined {
    const r = this.data.run;
    if (!r) return undefined;
    if (!this.cached || this.cached.state !== r.battle) this.cached = new Battle(r.config, { state: r.battle });
    return this.cached;
  }
  get activeConfig(): any { return this.data.run?.config || this.config; }
  private get flow(): any { const r=this.data.run; return r?.configVersion==='0.7' ? r.config.flow : null; }
  /** Effective combat clock. Consumers must not multiply a tick-based animation by this again. */
  combatTimeScale(): number {
    const d=this.data,r=d.run;
    if(this.background||this.storageFault||d.screen!=='battle'||r?.phase!=='battle')return 0;
    if(!d.overlay)return r.speed;
    return this.flow && ['summon','move'].includes(d.overlay) ? r.speed*this.flow.placement_combat_scale : 0;
  }
  /** Remaining foreground real seconds; overlays/background/camp suspend decrementing. */
  autoWaveRemaining(): number | null {
    const r=this.data.run,timer=r?.autoWave;
    return this.flow?.auto_start_after_card && r.phase==='deploy' && timer?.wave===r.battle.wave
      ? Math.max(0,timer.remainingRealSeconds) : null;
  }
  private legacyRunNotice(): string {
    const r = this.data.run;
    if(r && !finished(r) && this.config.design_version==='0.7' && ['0.5','0.6'].includes(r.configVersion))
      return `旧局第${r.battle.wave}波保留原规则；新玩法规则开新局生效`;
    return r && !finished(r) && r.configVersion === '0.5' && this.config.design_version === '0.6'
      ? `旧局第${r.battle.wave}波保留原收益；新能量规则开新局生效` : '';
  }
  private validateRun(run: any): void {
    requireRule(run && run.configVersion === run.config?.design_version && run.battle, '局快照不完整或版本不匹配');
    validateConfig(run.config);
    if(run.autoWave!=null){
      const timer=run.autoWave;
      requireRule(run.configVersion==='0.7' && run.config.flow.auto_start_after_card && run.phase==='deploy' &&
        timer.wave===run.battle.wave && timer.wave>1 && timer.wave<=run.config.run.waves &&
        Number.isFinite(timer.remainingRealSeconds) && timer.remainingRealSeconds>=0 &&
        timer.remainingRealSeconds<=run.config.flow.auto_wave_countdown_real_seconds, '自动开波计时无效');
    }
  }
  private validateSave(s: any) {
    requireRule(s.schema === 1 && Number.isInteger(s.revision), '存档版本不支持');
    const p = s.profile;
    requireRule(p && Number.isInteger(p.trainingXp) && p.trainingXp >= 0 && p.xpGrants && p.upgradeTransactions, '账户账本不完整');
    for (const h of this.config.heroes) {
      const v = p.heroes[h.id];
      requireRule(v && Number.isInteger(v.level) && v.level >= 1 && v.level <= this.config.progression.level_cap, '英雄等级越界');
      requireRule(v.ownedForms.includes(v.equippedForm) && v.ownedForms.every((id: string) => this.config.forms.some((f: any) => f.id === id && f.hero_id === h.id)), '形态归属无效');
    }
    this.validateRoster(p.roster, p);
    if (s.run) this.validateRun(s.run);
  }
  private validateRoster(ids: string[], p = this.data.profile) {
    requireRule(Array.isArray(ids) && ids.length >= 1 && ids.length <= this.config.run.max_roster_types, '编队需要1～4位英雄');
    requireRule(new Set(ids).size === ids.length && ids.every(id => p.heroes[id]?.owned), '编队包含重复或未拥有英雄');
  }
  private persist() {
    requireRule(!this.storageFault, '存档故障，请修复存储后重新载入');
    const raw = this.storage.getItem(SAVE_KEY);
    if (raw) requireRule(JSON.parse(raw).revision === this.revision, '另一个窗口已更新存档，请刷新后继续');
    this.data.revision = this.revision + 1;
    const serialized = JSON.stringify(this.data);
    this.storage.setItem(SAVE_KEY, serialized);
    this.durable = serialized;
    this.revision = this.data.revision;
  }
  /** Restoring a run never restores an older account. Used by the persistence verifier. */
  restoreRun(run: any): boolean {
    return this.transaction(() => {
      this.validateRun(run);
      this.data.run = clone(run); this.cached = undefined; this.data.screen = 'camp'; this.data.overlay = null;
      this.data.notice = this.legacyRunNotice() || `已恢复第${run.battle.wave}波存档，点击继续防守。`;
    });
  }
  private transaction(action: () => void): boolean {
    const before = clone(this.data);
    try { action(); this.persist(); return true; }
    catch (e) { this.data = before; this.cached = undefined; this.data.notice = (e as Error).message; return false; }
  }
  can(command: string): boolean {
    const d = this.data, r = d.run, ov = d.overlay;
    if (this.background || this.storageFault) return command === 'resumeBackground';
    if (['pauseBackground','setting','tutorialDismiss'].includes(command)) return true;
    if (['summon','move','beginSummon','beginMove'].includes(command)) return d.screen === 'battle' && r && ['deploy','freeDeploy','battle'].includes(r.phase) && (!ov || ['summon','move'].includes(ov));
    if (command === 'startWave') return d.screen === 'battle' && r && ['deploy','freeDeploy'].includes(r.phase) && !ov;
    if (command === 'chooseCard') return d.screen === 'battle' && r?.phase === 'cards' && !ov;
    if (command === 'grandpa') return d.screen === 'battle' && r?.phase === 'firstFailure' && !ov;
    if (['freeRevive','adRequest'].includes(command)) return d.screen === 'battle' && r && ['secondFailure','adPending'].includes(r.phase) && !ov && !r.secondUsed;
    if (command === 'adResult') return r?.phase === 'adPending' && !r.secondUsed;
    if (command === 'aim') return d.screen === 'battle' && r?.phase === 'battle' && !ov;
    if (command === 'cast') return d.screen === 'battle' && r?.phase === 'battle' && ov === 'aim';
    if (command === 'equipSkill') return d.screen === 'battle' && r && ['deploy','freeDeploy','battle'].includes(r.phase) && (!ov || ov === 'skills');
    if (command === 'setSpeed') return d.screen === 'battle' && r && ['deploy','freeDeploy','battle'].includes(r.phase) && (!ov || ov === 'settings');
    if (command === 'openSkills') return d.screen === 'battle' && r && ['deploy','freeDeploy','battle'].includes(r.phase) && !ov;
    if (['upgrade','equipForm'].includes(command)) return d.screen === 'hero' && !ov;
    if (['rosterToggle','rosterMove','saveRoster'].includes(command)) return d.screen === 'roster' && !ov;
    return true;
  }
  dispatch(command: string, payload?: any): boolean {
    if (command === 'pauseBackground') { this.background = true; this.accumulator = 0; return this.transaction(() => {}); }
    if (command === 'resumeBackground') { this.background = false; this.accumulator = 0; return true; }
    return this.transaction(() => {
      requireRule(this.can(command), '当前阶段不能执行此操作');
      const d = this.data, p = d.profile, r = d.run, c = r?.config || this.config;
      d.notice = '';
      switch (command) {
        case 'open':
          requireRule(!d.overlay && d.screen !== 'battle', '请先保存返回营地');
          requireRule(['camp','collection','roster'].includes(payload), '未知页面');
          if (d.screen === 'roster' && d.rosterDraft.join() !== p.roster.join()) { d.pendingNavigation={screen:payload}; d.overlay='discardRoster'; break; }
          d.screen = payload; if (payload === 'roster') { d.rosterDraft = [...p.roster]; d.rosterSource = 'camp'; } break;
        case 'hero':
          requireRule(!d.overlay && d.screen !== 'battle' && p.heroes[payload], '英雄不可查看');
          if (d.screen === 'roster' && d.rosterDraft.join() !== p.roster.join()) { d.pendingNavigation={screen:'hero',hero:payload}; d.overlay='discardRoster'; break; }
          d.selectedHero = payload; d.screen = 'hero'; break;
        case 'back':
          if (d.overlay) { this.closeOverlay(); break; }
          if (d.screen === 'roster' && d.rosterDraft.join() !== p.roster.join()) { d.pendingNavigation={screen:'camp'}; d.overlay = 'discardRoster'; }
          else d.screen = d.screen === 'hero' ? 'collection' : 'camp'; break;
        case 'rosterToggle': {
          requireRule(p.heroes[payload]?.owned, '未拥有的英雄不能编入');
          const i = d.rosterDraft.indexOf(payload); if (i >= 0) d.rosterDraft.splice(i, 1);
          else { requireRule(d.rosterDraft.length < c.run.max_roster_types, '编队最多4位'); d.rosterDraft.push(payload); } break;
        }
        case 'rosterMove': {
          const i = d.rosterDraft.indexOf(payload.id), j = i + payload.direction;
          requireRule(i >= 0 && j >= 0 && j < d.rosterDraft.length, '已到编队边界');
          [d.rosterDraft[i], d.rosterDraft[j]] = [d.rosterDraft[j], d.rosterDraft[i]]; break;
        }
        case 'saveRoster': this.validateRoster(d.rosterDraft); p.roster = [...d.rosterDraft]; d.screen = 'camp'; d.notice = '编队已保存，于下一新局生效。'; break;
        case 'discardRoster': requireRule(d.overlay === 'discardRoster', '没有未保存编队'); d.rosterDraft = [...p.roster]; d.overlay = null; d.screen = d.pendingNavigation?.screen || 'camp'; if(d.pendingNavigation?.hero)d.selectedHero=d.pendingNavigation.hero; d.pendingNavigation=null; break;
        case 'newRun':
          requireRule(['camp','result'].includes(d.screen), '请回营地开始新局');
          if (!finished(r) && !payload?.confirm) { d.overlay = 'replace'; break; }
          requireRule(!d.overlay || d.overlay === 'replace', '请完成当前操作'); this.createRun(payload?.seed); break;
        case 'cancelReplace': requireRule(d.overlay === 'replace', '没有替换确认'); d.overlay = null; break;
        case 'continueRun':
          requireRule(r && !finished(r), '没有进行中的防守'); d.screen = 'battle';
          d.overlay = r.savedOverlay || null; r.savedOverlay = null; this.accumulator = 0; break;
        case 'camp':
          requireRule(r || d.screen !== 'battle', '没有局记录');
          if (r && !finished(r)) r.savedOverlay = d.overlay === 'settings' ? d.overlaySource : d.overlay;
          if(this.flow && ['summon','move'].includes(r?.savedOverlay))r.savedOverlay=null;
          d.screen = 'camp'; d.overlay = null; this.accumulator = 0; break;
        case 'upgrade': this.upgrade(payload); break;
        case 'equipForm': {
          const h = p.heroes[payload.heroId], f = this.config.forms.find((f: any) => f.id === payload.formId);
          requireRule(h?.owned && f?.hero_id === payload.heroId && h.ownedForms.includes(f.id), '此形态尚未拥有');
          h.equippedForm = f.id; d.notice = '已穿戴，下一新局生效。'; break;
        }
        case 'openPraise': requireRule(d.screen === 'hero' && !p.heroes[payload]?.owned && !d.overlay, '英雄已拥有或页面不符'); d.overlay = 'praise'; d.unlockHero = payload; break;
        case 'praise':
          requireRule(d.screen === 'hero' && ['praise',null].includes(d.overlay), '请在英雄详情选择夸赞');
          requireRule(this.config.heroes.some((h: any) => h.id === payload && h.praise_unlock_allowed), '无法解锁');
          this.unlockHero(payload); d.overlay = 'unlock'; d.unlockHero = payload; break;
        case 'ackUnlock':
          if (r) r.pendingUnlocks = r.pendingUnlocks.filter((id: string) => id !== payload);
          d.overlay = null; break;
        case 'showUnlock': requireRule(r?.pendingUnlocks.includes(payload), '没有解锁消息'); d.unlockHero = payload; d.overlay = 'unlock'; break;
        case 'beginSummon': d.overlay = 'summon'; break;
        case 'beginMove': d.overlay = 'move'; break;
        case 'cancelSummon': case 'cancelMove': requireRule(['summon','move'].includes(d.overlay), '没有选位操作'); d.overlay = null; break;
        case 'summon': this.summon(payload); d.overlay = null; break;
        case 'move': this.move(payload); d.overlay = null; break;
        case 'startWave': this.startWave(); break;
        case 'setSpeed': requireRule([1,2].includes(payload), '只支持1×/2×'); r.speed = payload; p.settings.speed = payload; this.recordCommand('setSpeed',payload); break;
        case 'chooseCard': this.chooseCard(payload); break;
        case 'openSkills': d.overlay = 'skills'; break;
        case 'equipSkill': this.equipSkill(payload); break;
        case 'aim':
          requireRule(r.equipped.includes(payload) && r.skills[payload] && this.skillRemaining(payload) <= 0, '技能未装备或仍在冷却');
          r.aimSkill = payload; d.overlay = 'aim'; break;
        case 'cast': this.cast(payload); break;
        case 'cancelAim': requireRule(d.overlay === 'aim', '没有瞄准操作'); d.overlay = null; r.aimSkill = null; break;
        case 'grandpa': this.grandpa(); break;
        case 'endRun':
          requireRule(r && !finished(r), '本局已结束'); r.phase = 'defeat'; r.battle.result = 'failed'; d.screen = 'result'; this.clearBattleInteraction(); this.accumulator = 0; break;
        case 'freeRevive': this.revive('free'); break;
        case 'adRequest':
          requireRule(r.phase === 'secondFailure', '已有待决广告，请先处理');
          r.ad = { id: `${r.id}:rescue:${++r.adSequence}`, status: 'pending' }; r.phase = 'adPending'; break;
        case 'adResult': this.adResult(payload); break;
        case 'settings': requireRule(d.overlay !== 'settings', '设置已打开'); d.overlaySource = d.overlay; d.overlay = 'settings'; break;
        case 'closeOverlay': this.closeOverlay(); break;
        case 'setting':
          requireRule(Object.prototype.hasOwnProperty.call(p.settings,payload.key), '未知设置');
          if (['music','sfx','voice'].includes(payload.key)) requireRule(Number.isFinite(payload.value) && payload.value >= 0 && payload.value <= 1, '音量须为0～1');
          else if (payload.key === 'speed') requireRule([1,2].includes(payload.value), '倍速错误');
          else requireRule(typeof payload.value === 'boolean', '开关值错误');
          p.settings[payload.key] = payload.value; break;
        case 'tutorialDismiss': if (payload) p.tutorials[payload] = true; d.tutorial = null; break;
        default: throw new Error(`未知命令：${command}`);
      }
      if (d.screen === 'camp' && !d.notice) d.notice = this.legacyRunNotice();
      if(this.combatTimeScale()===0)this.accumulator=0;
    });
  }
  private closeOverlay() {
    const d = this.data;
    requireRule(!!d.overlay, '没有可关闭浮层');
    if (d.overlay === 'settings') { d.overlay = d.overlaySource || null; d.overlaySource = null; }
    else { d.overlay = null; if (d.run) d.run.aimSkill = null; }
  }
  private startWave(): void {
    const r=this.data.run,c=r.config;
    if(r.phase==='freeDeploy'){
      r.battle.protectionUntil=r.battle.tick+Math.ceil(c.rescue.free_revive_protection_seconds*c.clock.tick_hz);
      r.battle.result='running';
    }
    if(Object.prototype.hasOwnProperty.call(r,'autoWave'))r.autoWave=null;
    r.phase='battle';this.accumulator=0;this.countdownSaveSeconds=0;this.recordCommand('startWave',{});
    if(r.calmWave===r.battle.wave)this.tutorial('calm','冷静波：本波怪物能量为0，完成后仍获得训练经验。');
  }
  private clearBattleInteraction(): void {
    const d=this.data,r=d.run;d.overlay=null;d.overlaySource=null;
    if(r){r.aimSkill=null;r.savedOverlay=null;if(Object.prototype.hasOwnProperty.call(r,'autoWave'))r.autoWave=null;}
    this.countdownSaveSeconds=0;
  }
  private createRun(seed?: number) {
    const d = this.data, p = d.profile, c = this.config; this.validateRoster(p.roster);
    seed = (seed ?? ((Date.now() ^ Math.floor(Math.random()*0xffffffff)) >>> 0)) >>> 0;
    if (!seed) seed = c.spawn_generator.zero_seed_fallback;
    const snapshots: any = {}; for (const id of p.roster) snapshots[id] = { level:p.heroes[id].level, form:p.heroes[id].equippedForm };
    const id = `${Date.now().toString(36)}-${this.revision}-${seed}`;
    const b = new Battle(c, { seed, wave:1, heroes:[], snapshots:clone(snapshots), cards:{}, baseHp:c.run.base_max_hp, energy:c.run.starting_energy, calm:false });
    d.run = { id, configVersion:c.design_version, config:clone(c), seed, snapshots, phase:'deploy', battle:b.state,
      cards:{}, candidates:[], rng:((seed as number) ^ c.card_draw.rng_seed_xor)>>>0 || c.spawn_generator.zero_seed_fallback,
      skills:{}, equipped:[null,null], grandpaUsed:false, secondUsed:false, calmWave:null, ad:null, adSequence:0,
      completedWaves:[], cardHistory:[], pendingUnlocks:[], speed:p.settings.speed, nextHeroId:1,
      ...(c.design_version==='0.7'?{autoWave:null}:{}),
      timings:{wall:0,battle:0,deploy:0,cards:0,aim:0,settings:0,ad:0,other:0}, waveReports:[], commands:[], skillWaveStats:{} };
    d.run.battle.cards = d.run.cards; this.cached = b; d.screen='battle'; d.overlay=null; this.accumulator=0;
    this.tutorial('deploy','选一名英雄，再点场上空位。每路都需要防守，点开始才会出怪。');
  }
  private unlockHero(id: string) {
    const p=this.data.profile, h=p.heroes[id]; if (h.owned) return;
    const def=this.config.heroes.find((v:any)=>v.id===id); requireRule(def,'未知英雄');
    h.owned=true; h.level=1; h.ownedForms=[def.default_form_id]; h.equippedForm=def.default_form_id;
    this.data.notice=`${def.name}已永久解锁！下一新局可编入。`;
  }
  private upgrade(payload: any) {
    const p=this.data.profile,c=this.config,h=p.heroes[payload.heroId];
    const id=payload.transactionId || `${payload.heroId}:${payload.expectedLevel}`;
    requireRule(!p.upgradeTransactions[id], '本次升级已完成');
    requireRule(h?.owned,'未拥有的英雄不能升级');
    requireRule(h.level===payload.expectedLevel,'等级已变化，请查看最新成本');
    requireRule(h.level<c.progression.level_cap,'已满级');
    const cost=c.progression.level_costs[h.level-1]; requireRule(p.trainingXp>=cost,`训练经验不足，还差${cost-p.trainingXp}`);
    p.trainingXp-=cost; h.level++;
    const newly:string[]=[];
    for (const f of c.forms.filter((f:any)=>f.hero_id===payload.heroId && f.unlock_level<=h.level)) if (!h.ownedForms.includes(f.id)) {h.ownedForms.push(f.id);newly.push(f.name);}
    p.upgradeTransactions[id]={heroId:payload.heroId,level:h.level,cost};
    this.data.notice=`升级至Lv${h.level}，消耗${cost}，余额${p.trainingXp}。${newly.length?`解锁${newly.join('、')}，可单独选择穿戴。`:''}`;
  }
  private recordCommand(type: string, payload: any) {
    const r=this.data.run; r.commands.push({tick:r.battle.tick,wave:r.battle.wave,type,payload:clone(payload)});
  }
  private summon(v:any) {
    const r=this.data.run,c=r.config,s=r.battle;
    requireRule(r.snapshots[v.heroId], '此英雄未带入本局');
    requireRule([...c.world.pads.map((p:any)=>p.id),...c.world.reserve_ids].includes(v.slot), '非法部署位');
    requireRule(!s.heroes.some((h:any)=>h.slot===v.slot),'位置已有英雄');
    requireRule(s.heroes.length<12,'阵容已满，可交换调整或继续防守');
    const cost=c.heroes.find((h:any)=>h.id===v.heroId).summon_energy; requireRule(s.energy>=cost,`能量不足，还差${cost-s.energy}`);
    s.energy-=cost; s.heroes.push({id:this.battle!.allocateId(),type:v.heroId,star:1,slot:v.slot,nextAttackTick:s.tick,releasedCount:0});
    this.recordCommand('summon',v);
    if (c.world.reserve_ids.includes(v.slot)) this.tutorial('reserve','待部署英雄暂不战斗，可换位或合成；已解锁手动技能仍能使用。');
    else if (s.heroes.some((h:any,i:number)=>s.heroes.some((o:any,j:number)=>i!==j && h.type===o.type && h.star===o.star && h.star<3))) this.tutorial('merge','拖动同名同星英雄到一起，2合1升星；也可点选后点目标。');
  }
  private move(v:any) {
    const r=this.data.run,s=r.battle,c=r.config,b=this.battle!;
    requireRule([...c.world.pads.map((p:any)=>p.id),...c.world.reserve_ids].includes(v.slot),'非法部署位');
    const h=s.heroes.find((h:any)=>h.id===v.id); requireRule(h,'英雄已变化');
    requireRule(h.slot!==v.slot,'英雄已在此位置');
    const target=s.heroes.find((o:any)=>o.slot===v.slot),old=h.slot;
    if (target && h.type===target.type && h.star===target.star && h.star<c.run.max_star) {
      const tick=Math.max(h.nextAttackTick,target.nextAttackTick),star=h.star+1;
      b.moveHero(h.id,v.slot); b.moveHero(target.id,old);
      s.heroes=s.heroes.filter((o:any)=>o.id!==h.id && o.id!==target.id);
      s.heroes.push({id:b.allocateId(),type:h.type,star,slot:v.slot,nextAttackTick:tick,releasedCount:0,streakCount:0});
      if (star===3) { this.unlockSkill(c.heroes.find((o:any)=>o.id===h.type).player_skill_id); this.tutorial('three','本局首次三星：手动技能已收入技能库。空槽可装备，点击技能再确认目标施放。'); }
      this.data.notice=`合成${star}星成功！`;
    } else { b.moveHero(h.id,v.slot); if(target)b.moveHero(target.id,old); }
    if(c.world.reserve_ids.includes(v.slot))this.tutorial('reserve','这里的英雄暂不战斗，可以换位或合成。');
    this.recordCommand('move',v);
  }
  private unlockSkill(id:string) {
    const r=this.data.run; if(r.skills[id])return;
    r.skills[id]={readyTick:r.battle.tick,casts:0,availableTicks:0};
    this.data.notice=`新技能${id}已收入技能库${r.equipped.includes(null)?'，可装备空槽':'，波间可替换'}。`;
  }
  private equipSkill(v:any) {
    const r=this.data.run; requireRule(r.skills[v.id] && Number.isInteger(v.slot) && v.slot>=0 && v.slot<2,'技能或槽位无效');
    requireRule(!r.equipped.includes(v.id),'此技能已装备');
    requireRule(r.phase!=='battle' || (!r.equipped[v.slot] && !this.data.overlay),'战斗中技能库只读；非空替换仅限波间');
    r.equipped[v.slot]=v.id; this.recordCommand('equipSkill',v);
  }
  skillRemaining(id:string):number { const r=this.data.run; return r?.skills[id]? Math.max(0,(r.skills[id].readyTick-r.battle.tick)/r.config.clock.tick_hz):0; }
  private cast(target:any) {
    const r=this.data.run,c=r.config,id=r.aimSkill,def=c.skills.find((s:any)=>s.id===id);
    requireRule(def && r.equipped.includes(id) && this.skillRemaining(id)<=0,'技能尚未可用');
    if(def.target==='global_confirm')requireRule(target?.confirm===true,'请二次确认全场施放');
    requireRule(this.battle!.invokeSkill(id,target || {}),'无效目标，请重新选择');
    let cd=def.cooldown_seconds;
    if(id==='P002')cd=c.cards.find((v:any)=>v.id==='C014').effects.cooldown_seconds_by_pick[Math.max(0,(r.cards.C014||1)-1)];
    r.skills[id].readyTick=r.battle.tick+Math.ceil(cd*c.clock.tick_hz); r.skills[id].casts++;
    const stats=this.waveSkill(id);stats.casts++; this.recordCommand('cast',{id,target});
    this.data.overlay=null;r.aimSkill=null;
  }
  private waveSkill(id:string):any {const r=this.data.run,key=`${r.battle.wave}:${id}`;return r.skillWaveStats[key] ||= {id,wave:r.battle.wave,availableTicks:0,casts:0};}
  private chooseCard(id:string) {
    const r=this.data.run;requireRule(r.candidates.includes(id),'此卡不在已保存候选中');
    requireRule(eligibleCards(r.config,Object.keys(r.snapshots),r.cards,r.skills).some(v=>v.id===id),'此卡已无合法效果');
    this.recordCommand('chooseCard',id);
    r.cards[id]=(r.cards[id]||0)+1;r.cardHistory.push(id);r.battle.cards=r.cards;
    const c=r.config.cards.find((c:any)=>c.id===id);if(c.effects.unlock_skill)this.unlockSkill(c.effects.unlock_skill);
    r.candidates=[];const next=r.battle.wave+1;this.battle!.beginWave(next,r.calmWave===next);r.phase='deploy';
    if(this.flow?.auto_start_after_card)r.autoWave={wave:next,remainingRealSeconds:this.flow.auto_wave_countdown_real_seconds};
    this.countdownSaveSeconds=0;
  }
  private completeWave(reason:string) {
    const d=this.data,r=d.run,p=d.profile,w=r.battle.wave;
    requireRule(r.battle.result==='complete' && r.battle.baseHp>0,'不能在失败状态完成波次');
    this.clearBattleInteraction();
    const key=`${r.id}:${w}`;
    if(!p.xpGrants[key]){p.xpGrants[key]=true;p.trainingXp+=r.config.progression.training_xp_per_completed_wave;p.completedWaves++;}
    if(!r.completedWaves.includes(w)) {
      r.completedWaves.push(w);r.waveReports.push({wave:w,tick:r.battle.tick,reason,energy:r.battle.energy,baseHp:r.battle.baseHp});
    }
    for(const h of this.config.heroes)if(!p.heroes[h.id].owned && p.completedWaves>=h.unlock_completed_waves){this.unlockHero(h.id);if(!r.pendingUnlocks.includes(h.id))r.pendingUnlocks.push(h.id);}
    if(r.calmWave===w)r.calmWave=null;
    r.battle.calm=false;
    if(w===r.config.run.waves){
      p.victoryGrants ||= {}; if(!p.victoryGrants[r.id]){p.victories++;p.victoryGrants[r.id]=true;}r.victoryCounted=true;r.phase='victory';d.screen='result';d.overlay=null;
    } else {
      if(!r.candidates.length){const draw=drawCards(r.config,Object.keys(r.snapshots),r.cards,r.skills,r.rng);r.rng=draw.rng;r.candidates=draw.ids;}
      r.phase='cards';d.overlay=null;
    }
  }
  private grandpa() {
    const r=this.data.run,c=r.config,w=r.battle.wave;requireRule(!r.grandpaUsed,'老爷爷本局已使用');
    r.grandpaUsed=true;r.battle.baseHp=Math.ceil(c.run.base_max_hp*c.rescue.restore_hp_fraction);
    const u=this.battle!.clearWave(true),advance=w<c.run.waves?c.waves[w].energy_budget:0;
    r.battle.energy+=advance;r.calmWave=w<c.run.waves?w+1:null;r.lastRescue={type:'grandpa',wave:w,remaining:u,advance};
    this.completeWave('grandpa');this.data.notice=`老爷爷清本波，剩余${u}＋预支${advance}能量。${advance?'下一整波怪物能量为0。':''}`;
  }
  private revive(kind:'free'|'ad'|'fallback') {
    const r=this.data.run,c=r.config;requireRule(r.grandpaUsed && !r.secondUsed,'救场机会不可用');
    r.secondUsed=true;r.battle.baseHp=Math.ceil(c.run.base_max_hp*c.rescue.restore_hp_fraction);r.battle.energy+=c.rescue.second_revive_energy;
    if(!r.ad)r.ad={id:`${r.id}:rescue:${++r.adSequence}`,status:'applied'};
    r.ad.status='applied';r.ad.result=kind;r.lastRescue={type:kind,wave:r.battle.wave,energy:c.rescue.second_revive_energy};
    if(kind==='free'){this.clearBattleInteraction();r.battle.result='running';r.phase='freeDeploy';this.data.notice='免费复活已到账。怪物保留，先调整阵容，再继续防守（3战斗秒保护）。';}
    else {this.battle!.clearWave(false);this.completeWave(kind);this.data.notice=kind==='fallback'?'模拟广告技术失败，按设计兜底恢复并清波；不是观看成功。':'模拟广告完成，恢复并清波；没有额外击杀能量。';}
  }
  private adResult(v:any) {
    const r=this.data.run;requireRule(r.ad?.id===v.id && r.ad.status!=='applied','重复或迟到的广告回调已忽略');
    requireRule(['completed','cancelled','failed','unknown'].includes(v.result),'未知广告状态');
    if(v.result==='unknown'){r.ad.status='unknown';this.data.notice='广告结果未知，保持暂停；可明确改用免费复活。';}
    else if(v.result==='cancelled'){r.ad.status='cancelled';r.phase='secondFailure';this.data.notice='已主动取消；未消耗复活机会，可选择免费复活。';}
    else this.revive(v.result==='completed'?'ad':'fallback');
  }
  forecast():any {
    const r=this.data.run;if(!r || finished(r))return null;
    const wave=r.phase==='cards'?r.battle.wave+1:r.battle.wave;if(wave>20)return null;
    const def=r.config.waves[wave-1],q=generateWave(r.config,r.seed,wave);
    return {wave,counts:clone(def.counts),budget:r.calmWave===wave?0:def.energy_budget,lanes:Array.from(new Set(q.map((v:any)=>v.lane))),calm:r.calmWave===wave};
  }
  private tutorial(key:string,text:string){if(!this.data.profile.tutorials[key]){this.data.profile.tutorials[key]=true;this.data.tutorial={key,text};}}
  private stopOnStorageFault(error:unknown): void {
    this.data=this.durable?JSON.parse(this.durable):this.data;this.cached=undefined;this.storageFault=true;
    this.data.notice=`保存失败，战斗已暂停：${error instanceof Error?error.message:String(error)}。请恢复存储后刷新。`;
    this.accumulator=0;
  }
  private saveRealtime(): boolean {
    try{this.persist();return true;}catch(error){this.stopOnStorageFault(error);return false;}
  }
  /** Real time is accumulated without dropping low-frame-rate combat ticks. */
  advance(realSeconds:number):void {
    if(!Number.isFinite(realSeconds)||realSeconds<0||this.background||this.storageFault)return;
    const d=this.data,r=d.run;if(!r||finished(r)||d.screen!=='battle')return;
    r.timings.wall+=realSeconds;
    const remaining=this.autoWaveRemaining();
    if(remaining!==null && !d.overlay){
      const consumed=Math.min(realSeconds,remaining);
      r.autoWave.remainingRealSeconds=Math.max(0,remaining-consumed);
      r.timings.deploy+=consumed;this.countdownSaveSeconds+=consumed;
      if(r.autoWave.remainingRealSeconds>1e-8){
        // A hard reload can add at most 250 ms of preparation, never remove it.
        // Pause/navigation commands persist the exact current remainder immediately.
        if(this.countdownSaveSeconds>=.25){this.countdownSaveSeconds=0;this.saveRealtime();}
        return;
      }
      if(!this.dispatch('startWave')){this.stopOnStorageFault(this.data.notice);return;}
      realSeconds=Math.max(0,realSeconds-consumed);
    }
    const bucket=d.overlay==='aim'?'aim':d.overlay==='settings'?'settings':r.phase==='adPending'?'ad':d.overlay?'other':r.phase==='battle'?'battle':r.phase==='cards'?'cards':'deploy';
    r.timings[bucket]+=realSeconds;
    const scale=this.combatTimeScale();
    if(scale===0){this.accumulator=0;return;}
    this.accumulator+=realSeconds*scale*r.config.clock.tick_hz;
    let steps=0;
    while(this.accumulator>=1-1e-8 && steps<240 && this.combatTimeScale()>0){
      this.accumulator=Math.max(0,this.accumulator-1);steps++;
      const b=this.battle!;b.step();
      for(const id of r.equipped)if(id && r.skills[id].readyTick<r.battle.tick){r.skills[id].availableTicks++;this.waveSkill(id).availableTicks++;}
      if(r.battle.stats.energyGained>0)this.tutorial('energy','打倒怪物获得局内能量，继续定向召唤。训练经验在每波完成后另行到账。');
      let save=false;
      if(r.battle.result==='failed') {r.phase=!r.grandpaUsed?'firstFailure':!r.secondUsed?'secondFailure':'defeat';this.clearBattleInteraction();if(r.phase==='defeat')d.screen='result';save=true;}
      else if(r.battle.result==='complete'){this.completeWave('normal');save=true;}
      if(++this.saveTicks>=60){this.saveTicks=0;save=true;}
      if(save && !this.saveRealtime())return;
    }
    if(r.phase!=='battle')this.accumulator=0;
  }
  recap():string[] {
    const r=this.data.run;if(!r)return[];
    const result:string[]=[],counts=[0,0,0];for(const l of r.battle.stats.leaks||[])counts[l.lane-1]++;
    const max=Math.max(...counts);if(max>0)result.push(`${['左','中','右'][counts.indexOf(max)]}路本局漏过${max}只怪物。`);
    const unused=Object.values(r.skillWaveStats).find((s:any)=>s.wave===r.battle.wave && s.availableTicks>0 && s.casts===0) as any;
    if(unused)result.push(`本波技能${unused.id}曾可用但未施放。`);
    return result.slice(0,2);
  }
}
