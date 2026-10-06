import { HEROES, Quality, enemyDef, heroDef, stageDef } from './config';
import { Enemy, Hero, Profile, Reward, Run, copy, deployed, event, now, waveMinionQuota } from './model';

export type Specialization = 'A' | 'B';
export type Contract = 'shield' | 'speed' | 'crossfire';
export type Expedition = { tier: number; contract: Contract };
export const INCENTIVE_VERSION = 'R1.2.0';
export const QUALITIES: Quality[] = ['blue', 'purple', 'gold'];
export const CONTRACTS: {id:Contract;name:string;hint:string;composition:Record<string,number>;traits:Record<string,number>}[] = [
  {id:'shield',name:'破盾阵',hint:'护盾怪群 · 多段破盾与范围爆破',composition:{RM01:48,RM02:48,RM04:16,RM05:8},traits:{T04:20,T03:8,T01:8}},
  {id:'speed',name:'疾行阵',hint:'疾行突进 · 控场与近战守线',composition:{RM01:48,RM02:48,RM04:16,RM05:8},traits:{T01:20,T02:8,T03:8}},
  {id:'crossfire',name:'交叉火力',hint:'半数远程 · 射程、护盾与治疗',composition:{RM01:40,RM02:20,RM04:36,RM05:24},traits:{T02:12,T03:12,T04:12}},
];
export const EXPEDITION_HP = [1,1.1,1.2,1.32,1.45,1.6,1.76,1.94];
export const EXPEDITION_ATTACK = [1,1.05,1.1,1.15,1.2,1.25,1.3,1.35];
export const GOALS = [
  {id:'first-burst',name:'初露锋芒',hint:'一次技能最终击倒3只小怪',target:1},
  {id:'first-reserve',name:'稳住防线',hint:'完整清除前5波及Boss',target:1},
  {id:'first-upgrade',name:'初次培养',hint:'完成一次永久升级',target:1},
  {id:'first-trial',name:'初次试阵',hint:'上阵一名关卡解锁的新英雄',target:1},
  {id:'captain-ultimate',name:'绝招初成',hint:'队长3技能实际命中或有效支援',target:1},
  {id:'perk-win',name:'专精初成',hint:'携带专精通关一次',target:1},
  {id:'pull-combo',name:'控爆接力',hint:'拉拢后2秒内由另一英雄范围技击倒，累计10只',target:10},
  {id:'frost-beam',name:'冰封穿透',hint:'磁束命中4名受控敌人，单局2次',target:2},
  {id:'cooldown-relay',name:'接力合奏',hint:'返还后1.5秒内两名队友施法，单局3次',target:3},
  {id:'summon-guard',name:'守线反击',hint:'召唤物承伤达上阵基础生命60%并通关',target:1},
] as const;
export interface IncentiveProfile {
  version: 1; focusByQuality: Record<Quality,string>; primary: Quality; captain: string;
  beginnerDone: boolean; storyClaimed: number[]; routes: Record<string,'gold'|'purple'>;
  specializations: Record<string,Specialization>; goal: string; goals: Record<string,number>;
  expedition: { unlockedTier: number; firstWins: number[]; wins: string[]; bestTicks: Record<string,number> };
  heroRecords: Record<string,{wins:number;bestBurst:number}>;
}
export interface CastRef { id:number; owner:number; hero:string; slot:number; aoe:boolean }
export interface IncentiveRun {
  version:1; ruleVersion:string; focusByQuality:Record<Quality,string>; primary:Quality; captain:string;
  beginner:boolean; specializations:Record<string,Specialization>; route:'gold'|'purple'; firstClear:boolean;
  expedition?:Expedition; minionDeaths:number[]; bossDeaths:number[]; bossQuota:number[]; checkpoint:0|5|10;
  castSequence:number; casts:Record<string,{ref:CastRef;at:number;kills:number}>;
  stats:{goals:Record<string,number>;summonDamage:number;heroBaseHp:number;bestBurst:Record<string,number>};
  relays:{owner:number;until:number;casters:number[]}[];
}
export interface RewardReceipt {
  ruleVersion:string; outcome:'victory'|'defeat'; reason:string; cap:number; checkpoint:number;
  focus:string; before:number; after:number; directed:number; newHeroes:string[]; newGoals:string[];
  firstClear:boolean; route:'gold'|'purple'; expedition?:Expedition;
}
export function freshIncentive(p?:Profile):IncentiveProfile {
  return {version:1,focusByQuality:{blue:'RH02',purple:'RH04',gold:'RH09'},primary:'blue',captain:'RH02',
    beginnerDone:!!p&&HEROES.some(h=>h.quality==='blue'&&p.levels[h.id]>1),
    storyClaimed:Array.from({length:p?.clearedStage||0},(_,i)=>i+1),routes:{'10':'gold','20':'gold'},specializations:{},goal:'first-burst',goals:{},
    expedition:{unlockedTier:1,firstWins:[],wins:[],bestTicks:{}},heroRecords:{}};
}
export const progressPieces=(p:Profile,id:string):number=>(p.fragments[id]||0)+(heroDef(id).quality==='blue'?0:p.fragments['universal-'+heroDef(id).quality]||0);
export function createIncentiveRun(p:Profile,stage:number,expedition?:Expedition):IncentiveRun|undefined {
  const i=p.incentive;if(!i)return undefined;
  if(expedition&&(p.clearedStage<20||!Number.isInteger(expedition.tier)||expedition.tier<1||expedition.tier>i.expedition.unlockedTier||expedition.tier>8||!CONTRACTS.some(c=>c.id===expedition.contract)))throw new Error('远征尚未开放');
  const specials=Object.fromEntries(Object.entries(i.specializations).filter(([id])=>p.levels[id]>=3&&heroDef(id).unlockAfterStage<=p.clearedStage));
  return {version:1,ruleVersion:INCENTIVE_VERSION,focusByQuality:copy(i.focusByQuality),primary:i.primary,captain:i.captain,beginner:!i.beginnerDone,specializations:specials,route:i.routes[String(stage)]||'gold',
    firstClear:expedition?!i.expedition.firstWins.includes(expedition.tier):!i.storyClaimed.includes(stage),...(expedition?{expedition:copy(expedition)}:{}),
    minionDeaths:Array(15).fill(0),bossDeaths:Array(15).fill(0),bossQuota:Array.from({length:15},(_,n)=>n===14?1:(stageDef(stage).miniBosses[String(n+1)]||[]).length),checkpoint:0,
    castSequence:0,casts:{},stats:{goals:{},summonDamage:0,heroBaseHp:0,bestBurst:{}},relays:[]};
}
export const specialization=(r:Run,h:Hero):Specialization|undefined=>r.incentive?.specializations[h.id];
export const goalProgress=(r:Run,id:string,n=1):void=>{if(r.incentive)r.incentive.stats.goals[id]=Math.max(r.incentive.stats.goals[id]||0,n);};
export function startCast(r:Run,h:Hero,slot:number):CastRef|undefined {
  const i=r.incentive;if(!i)return undefined;
  const ref:CastRef={id:++i.castSequence,owner:h.uid,hero:h.id,slot,aoe:slot>=2};
  i.casts[String(ref.id)]={ref,at:now(r),kills:0};
  const keys=Object.keys(i.casts);for(const key of keys.slice(0,Math.max(0,keys.length-120)))delete i.casts[key];
  i.relays=i.relays.filter(x=>x.until>=now(r));
  for(const relay of i.relays)if(relay.owner!==h.uid&&!relay.casters.includes(h.uid)){relay.casters.push(h.uid);if(relay.casters.length===2)goalProgress(r,'cooldown-relay',(i.stats.goals['cooldown-relay']||0)+1);}
  return ref;
}
export function recordUsefulCast(r:Run,cast:CastRef|undefined,amount:number):void {
  if(cast&&amount>0&&cast.slot===3&&cast.hero===r.incentive?.captain)goalProgress(r,'captain-ultimate');
}
export function recordFinalKill(r:Run,e:Enemy,cast?:CastRef):void {
  const i=r.incentive;if(!i)return;
  const minion=enemyDef(e.id).tier==='minion',index=e.wave-1;
  if(index>=0&&index<15)(minion?i.minionDeaths:i.bossDeaths)[index]++;
  for(const checkpoint of [5,10] as const)if(i.checkpoint<checkpoint&&i.minionDeaths.slice(0,checkpoint).every((n,j)=>n===waveMinionQuota(r,j+1))&&i.bossDeaths.slice(0,checkpoint).every((n,j)=>n===i.bossQuota[j])){
    i.checkpoint=checkpoint;goalProgress(r,'first-reserve');event(r,'checkpoint',String(checkpoint),{x:.5,y:.03},undefined,checkpoint===5?1:2);
  }
  if(!cast||!minion)return;
  const record=i.casts[String(cast.id)];if(record){record.kills++;i.stats.bestBurst[cast.hero]=Math.max(i.stats.bestBurst[cast.hero]||0,record.kills);if(record.kills>=3)goalProgress(r,'first-burst');}
  if(cast.aoe&&e.pulledBy&&e.pulledBy.until>=now(r)&&e.pulledBy.owner!==cast.owner)goalProgress(r,'pull-combo',(i.stats.goals['pull-combo']||0)+1);
}
export function applyRunAchievements(p:Profile,r:Run):string[]{
  const i=p.incentive,s=r.incentive;if(!i||!s)return[];
  if(r.status==='victory'){
    if(deployed(r).some(h=>s.specializations[h.id]))goalProgress(r,'perk-win');
    if(s.stats.heroBaseHp>0&&s.stats.summonDamage>=s.stats.heroBaseHp*.6)goalProgress(r,'summon-guard');
    for(const h of deployed(r)){const rec=i.heroRecords[h.id]||(i.heroRecords[h.id]={wins:0,bestBurst:0});rec.wins++;rec.bestBurst=Math.max(rec.bestBurst,s.stats.bestBurst[h.id]||0);}
  }
  const unlocked:string[]=[];
  for(const g of GOALS){const old=i.goals[g.id]||0,n=s.stats.goals[g.id]||0;i.goals[g.id]=Math.min(g.target,g.id==='pull-combo'?old+n:Math.max(old,n));if(old<g.target&&i.goals[g.id]>=g.target)unlocked.push(g.id);}
  return unlocked;
}
export function milestoneName(level:number):string {return level>=20?'超力宗师':level>=15?'精通英雄':level>=10?'超力先锋':level>=6?'战术新星':level>=3?'专精觉醒':'成长英雄';}
export function rewardPreview(p:Profile,stage:number,expedition?:Expedition):string {
  const i=p.incentive;if(!i)return `通关${stage%10===0?10:5}张碎片`;
  if(expedition)return `${i.expedition.firstWins.includes(expedition.tier)?'通关补给':'本阶首胜定向'} · 10张碎片`;
  if(i.storyClaimed.includes(stage))return `通关${stage%10===0?10:5}片 · 同品质专属最多${stage%10===0?4:2}片定向`;
  if(stage===5||stage===15)return '首通5紫 · 专属部分全部定向';
  if(stage===8)return '首通解锁烟火龙仔＋该英雄5片';
  if(stage===10)return i.routes['10']==='purple'?'首通10紫 · 培养紫色组合':'首通6金＋4紫 · 培养金色核心';
  if(stage===20)return i.routes['20']==='purple'?'首通10紫 · 培养紫色组合':'首通10金 · 培养金色核心';
  return '首通5片 · 专属部分全部定向';
}
export const SPECIALIZATIONS:Record<string,{name:string;slot:number;description:string}[]>={
 RH01:[{name:'聚拳',slot:2,description:'拉拢距离＋35%\n技能伤害−10%'},{name:'重锤决胜',slot:3,description:'命中不多于2人：伤害＋25%\n命中3人以上：伤害−10%'}],
 RH02:[{name:'锅底回响',slot:2,description:'首段60%＋延迟回响40%\n总预算不变，标记仅首段'},{name:'慢速重炮',slot:3,description:'少一发更重炮弹，总预算不变\n半径＋10%，发射间隔＋25%'}],
 RH03:[{name:'余音护盾',slot:2,description:'治疗−10%，溢出转护盾\n护盾最多为目标生命5%'},{name:'急救独奏',slot:2,description:'只救最低血量一人，治疗＋50%\n冷却−15%，放弃群体治疗'}],
 RH04:[{name:'密集弹跳',slot:2,description:'多跳1人，每段伤害降低\n总预算不变，弹射距离−10%'},{name:'重鞋首击',slot:2,description:'首击＋40%，后续−15%\n总目标数减少1'}],
 RH05:[{name:'牵引木桩',slot:2,description:'落地轻拉怪物\n木桩生命−15%'},{name:'绊脚木桩',slot:2,description:'被敌击毁时周围定身0.5秒\n木桩生命−20%，到期不触发'}],
 RH06:[{name:'护卫沙包',slot:2,description:'召唤时全队获得5%生命护盾\n沙包普攻伤害−20%'},{name:'冲阵沙包',slot:2,description:'沙包轻推近战小怪，不推Boss\n同目标间隔1.2秒，生命−15%'}],
 RH07:[{name:'广域磁束',slot:2,description:'光束宽度＋30%\n伤害−18%'},{name:'聚焦磁束',slot:2,description:'光束宽度−25%\n伤害＋25%'}],
 RH08:[{name:'扩散冰雾',slot:2,description:'喷雾半角＋8°\n减速强度−10个百分点'},{name:'凝霜冰雾',slot:2,description:'半角−8°，已减速目标冻结＋0.3秒\n冷却＋10%'}],
 RH09:[{name:'礼炮齐射',slot:2,description:'全部礼炮同时出手\n冷却＋10%'},{name:'散花礼炮',slot:2,description:'爆破半径＋15%\n单发伤害−15%'}],
 RH10:[{name:'鼓舞星灯',slot:2,description:'护盾−20%，受盾队友普攻＋8%\n持续3秒，同源刷新'},{name:'合奏领奏',slot:3,description:'放弃本技能攻击加成\n队友冷却返还＋0.8秒，上限3秒'}],
};

/** Versioned namespace is additive to schema 1. Missing is legacy; malformed/future is rejected. */
export function validateIncentives(p:Profile,r?:Run|null):void {
  const check=(ok:unknown)=>{if(!ok)throw new Error('成长系统存档无效，已保留原文');};
  const int=(n:unknown,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&(n as number)>=min&&(n as number)<=max;
  const hero=(id:unknown)=>typeof id==='string'&&HEROES.some(h=>h.id===id);
  const focus=(x:Record<Quality,string>)=>x&&QUALITIES.every(q=>HEROES.some(h=>h.id===x[q]&&h.quality===q));
  const specials=(x:Record<string,Specialization>)=>x&&Object.entries(x).every(([id,s])=>hero(id)&&(s==='A'||s==='B'));
  const goals=(x:Record<string,number>)=>x&&Object.entries(x).every(([id,n])=>GOALS.some(g=>g.id===id)&&int(n));
  const expedition=(x:Expedition)=>x&&int(x.tier,1,8)&&CONTRACTS.some(c=>c.id===x.contract);
  const unique=(x:unknown[],max:number)=>Array.isArray(x)&&x.length<=max&&new Set(x).size===x.length;
  const i=p.incentive;
  if(i!==undefined){
    check(i&&i.version===1&&focus(i.focusByQuality)&&QUALITIES.includes(i.primary)&&hero(i.captain)&&heroDef(i.captain).unlockAfterStage<=p.clearedStage&&typeof i.beginnerDone==='boolean');
    check(unique(i.storyClaimed,20)&&i.storyClaimed.every(n=>int(n,1,p.clearedStage))&&i.routes&&Object.entries(i.routes).every(([s,v])=>['10','20'].includes(s)&&['gold','purple'].includes(v)));
    check(specials(i.specializations)&&Object.keys(i.specializations).every(id=>p.levels[id]>=3&&heroDef(id).unlockAfterStage<=p.clearedStage)&&goals(i.goals)&&GOALS.some(g=>g.id===i.goal));
    const x=i.expedition;check(x&&int(x.unlockedTier,1,8)&&unique(x.firstWins,8)&&x.firstWins.every(n=>int(n,1,8))&&unique(x.wins,24)&&x.wins.every(k=>/^[1-8]:(shield|speed|crossfire)$/.test(k))&&x.bestTicks&&Object.entries(x.bestTicks).every(([k,v])=>x.wins.includes(k)&&int(v)));
    check(i.heroRecords&&Object.entries(i.heroRecords).every(([id,v])=>hero(id)&&v&&int(v.wins)&&int(v.bestBurst)));
  }
  const s=r?.incentive;if(s!==undefined){
    check(i&&s&&s.version===1&&s.ruleVersion===INCENTIVE_VERSION&&focus(s.focusByQuality)&&QUALITIES.includes(s.primary)&&hero(s.captain)&&r!.unlocked.includes(s.captain)&&typeof s.beginner==='boolean'&&typeof s.firstClear==='boolean'&&['gold','purple'].includes(s.route)&&specials(s.specializations));
    check(Object.keys(s.specializations).every(id=>r!.levels[id]>=3&&r!.unlocked.includes(id)));
    check(s.expedition===undefined||expedition(s.expedition)&&r!.stage===20&&p.clearedStage===20);
    check(Array.isArray(s.minionDeaths)&&s.minionDeaths.length===15&&s.minionDeaths.every((n,j)=>int(n,0,waveMinionQuota(r!,j+1)))&&[s.bossDeaths,s.bossQuota].every(a=>Array.isArray(a)&&a.length===15&&a.every(n=>int(n,0,30)))&&[0,5,10].includes(s.checkpoint));
    check(s.bossQuota.every((n,j)=>n===(j===14?1:(stageDef(r!.stage).miniBosses[String(j+1)]||[]).length))&&s.bossDeaths.every((n,j)=>n<=s.bossQuota[j]));
    check(s.checkpoint===0||s.minionDeaths.slice(0,s.checkpoint).every((n,j)=>n===waveMinionQuota(r!,j+1))&&s.bossDeaths.slice(0,s.checkpoint).every((n,j)=>n===s.bossQuota[j]));
    check(int(s.castSequence)&&s.casts&&Object.keys(s.casts).length<=120&&Object.entries(s.casts).every(([key,c])=>c&&String(c.ref.id)===key&&int(c.ref.id,1,s.castSequence)&&int(c.ref.owner,1,r!.nextUid)&&hero(c.ref.hero)&&[2,3].includes(c.ref.slot)&&typeof c.ref.aoe==='boolean'&&int(c.kills)&&Number.isFinite(c.at)&&c.at>=0));
    check(s.stats&&goals(s.stats.goals)&&s.stats.summonDamage>=0&&s.stats.heroBaseHp>=0&&s.stats.bestBurst&&Object.entries(s.stats.bestBurst).every(([id,v])=>hero(id)&&int(v)));
    check(Array.isArray(s.relays)&&s.relays.length<=8&&s.relays.every(v=>v&&int(v.owner,1,r!.nextUid)&&v.until>=0&&unique(v.casters,4)&&v.casters.every(n=>int(n,1,r!.nextUid))));
  }
}
