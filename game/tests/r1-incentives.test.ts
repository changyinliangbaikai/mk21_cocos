import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, stepBattle } from '../assets/scripts/domain/r1/battle';
import { chooseCard, deployHero } from '../assets/scripts/domain/r1/cards';
import { castHeroSkill, damageAlly, damageEnemy, heroAttack, heroSkillRadius, heroSkillCooldown, updateProjectiles, updateSkillBursts, updateSummons } from '../assets/scripts/domain/r1/combat';
import { HEROES, autoSkillCooldown, enemyDef, heroDef, skillDef } from '../assets/scripts/domain/r1/config';
import { freshProfile, rollRewards, settleProgression, upgradeHero } from '../assets/scripts/domain/r1/rewards';
import { R1Session, R1_SAVE_KEY, validateSave } from '../assets/scripts/domain/r1/session';
import { copy, Run } from '../assets/scripts/domain/r1/model';
import { spawnEnemy } from '../assets/scripts/domain/r1/waves';
import { CONTRACTS, GOALS, Specialization, applyRunAchievements, recordFinalKill, startCast } from '../assets/scripts/domain/r1/incentives';
import { streams } from '../assets/scripts/domain/r1/random';
class Memory {map=new Map<string,string>();fail=false;getItem(k:string){return this.map.get(k)??null;}setItem(k:string,v:string){if(this.fail)throw new Error('disk failure');this.map.set(k,v);}}
function field(id='RH02',perk?:Specialization,level=3){const p=freshProfile();p.clearedStage=20;p.levels[id]=3;if(perk)p.incentive!.specializations[id]=perk;const r=createRun(p,1,341,'i-test');r.drawQueue=[];r.candidates=[];r.wave=1;r.released=r.plans[Math.max(0,r.wave-1)].length;const h=deployHero(r,id,0);h.skills=[1,level,level];return {p,r,h};}
function enemy(r:Run,x=.4,y=.6,hp=10000,id='RM01',wave=1){const e=spawnEnemy(r,{id,trait:null,x},wave);e.y=y;e.hp=e.maxHp=hp;return e;}
function finish(r:Run,ticks=240){for(let n=0;n<ticks;n++){r.tick++;updateSkillBursts(r);updateProjectiles(r,1/60);}}
function certify(r:Run,to=10){for(let w=1;w<=to;w++){for(let n=0;n<r.plans[w-1].length;n++){const e=enemy(r,.5,.5,1,'RM01',w);damageEnemy(r,e,9999,'ranged','test');}for(let n=0;n<r.incentive!.bossQuota[w-1];n++){const e=enemy(r,.5,.5,1,'RS01',w);damageEnemy(r,e,9999,'ranged','test');}}}
function settle(s:R1Session,status:'victory'|'defeat'){s.data.run!.status=status;s.inBattle=true;s.tick(0);}

test('D034 captain is one of exactly three unique opening choices, only the first offer is forced',()=>{
 for(let seed=1;seed<=200;seed++){const p=freshProfile();p.clearedStage=20;p.incentive!.captain='RH10';const r=createRun(p,1,seed,'captain');assert.equal(r.candidates.length,3);assert.equal(new Set(r.candidates.map(c=>c.heroId)).size,3);assert.equal(r.candidates.filter(c=>c.heroId==='RH10').length,1);chooseCard(r,r.candidates.find(c=>c.heroId==='RH10')!.id);assert.ok(!r.candidates.some(c=>c.heroId==='RH10'));assert.equal(r.drawQueue.length,2);}
});
test('D034 plans, captain, route and specialization are immutable in an existing run',()=>{
 const s=new R1Session(new Memory());s.data.profile.clearedStage=20;s.data.profile.levels.RH07=3;s.setSpecialization('RH07','A');s.start(10,33);const before=copy(s.data.run!.incentive);s.setCaptain('RH10');s.setFocus('RH01');s.setRoute(10,'purple');s.setSpecialization('RH07','B');assert.deepEqual(s.data.run!.incentive,before);s.start(10,34,true);assert.equal(s.data.run!.incentive!.route,'purple');assert.equal(s.data.run!.incentive!.specializations.RH07,'B');
});
test('D034 chapter packets and 20-stage growth promises hold without exceeding caps',()=>{
 for(const route of ['gold','purple'] as const)for(let seed=1;seed<=100;seed++){const p=freshProfile();p.incentive!.routes={'10':route,'20':route};for(let stage=1;stage<=20;stage++){
 const r=createRun(p,stage,seed*100+stage,'path-'+stage);r.status='victory';const {rewards}=settleProgression(p,r);assert.equal(rewards.reduce((n,x)=>n+x.count,0),stage%10===0?10:5);for(const x of rewards)p.fragments[x.key]=(p.fragments[x.key]||0)+x.count;
 for(const id of Object.values(p.incentive!.focusByQuality))while(upgradeHero(p,id,id+':'+p.levels[id])){}
 if(stage===3)assert.ok(p.levels.RH02>=2);if(stage===6)assert.ok(p.levels.RH02>=3);if(route==='gold'){if(stage===10)assert.ok(p.levels.RH09>=2);if(stage===20)assert.ok(p.levels.RH09>=3);}else{if(stage===15)assert.ok(p.levels.RH04>=3);if(stage===20)assert.ok(p.levels.RH04>=4);}
 }}
});
test('D034 repeat wins preserve exact original rarity quantities across 1000 seeds per difficulty',()=>{
 const sums=(rewards:{key:string;count:number}[])=>['blue','purple','gold'].map(q=>rewards.filter(x=>(x.key.startsWith('universal')?x.key.slice(10):heroDef(x.key).quality)===q).reduce((n,x)=>n+x.count,0));
 for(const stage of [1,5,10])for(let seed=1;seed<=1000;seed++){const p=freshProfile();p.clearedStage=20;p.incentive!.beginnerDone=true;p.incentive!.storyClaimed=Array.from({length:20},(_,i)=>i+1);const r=createRun(p,stage,seed,'repeat');r.status='victory';const expected=rollRewards(stage,20,copy(r.rng));assert.deepEqual(sums(settleProgression(p,r).rewards),sums(expected));}
});
test('D034 first-clear reward cannot be claimed twice, nor re-rolled after a failed save',()=>{
 const m=new Memory(),s=new R1Session(m);s.data.profile.clearedStage=9;s.start(10,25);m.fail=true;settle(s,'victory');assert.ok(s.error);assert.equal(s.data.profile.fragments.RH09,undefined);m.fail=false;assert.equal(s.retrySave(),true);const rewards=copy(s.data.settlement);const p=copy(s.data.profile);s.tick(1);assert.deepEqual(s.data.settlement,rewards);assert.deepEqual(s.data.profile,p);assert.equal(s.data.profile.fragments.RH09,6);s.start(10,26);assert.equal(s.data.run!.incentive!.firstClear,false);
});
test('D034 checkpoint requires every actual prior minion and boss, including residual final death',()=>{
 const {r}=field();r.wave=10;r.incentive!.minionDeaths.fill(r.plans[0].length,0,5);const boss=enemy(r,.5,.5,1,'RS01',5);assert.equal(r.incentive!.checkpoint,0);damageEnemy(r,boss,999,'ranged','x');assert.equal(r.incentive!.checkpoint,5);
 const {r:q}=field();const e=enemy(q,.5,.5,1);e.trait='T06';e.maxHp=100;damageEnemy(q,e,999,'ranged','x');assert.equal(q.incentive!.minionDeaths[0],0);damageEnemy(q,e,999,'ranged','x');assert.equal(q.incentive!.minionDeaths[0],1);
});
test('D034 defeat pays only certified reserve, revival pays nothing, subsequent victory does not add reserve',()=>{
 for(const stage of [1,5,10]){const m=new Memory(),s=new R1Session(m);s.data.profile.clearedStage=20;s.start(stage,350);certify(s.data.run!,10);s.data.run!.rescue='wipe';s.rescue(true);assert.equal(s.data.settlement,null);s.data.run!.rescue='wipe';assert.equal(s.rescue(false),true);assert.equal(s.data.settlement!.rewards.reduce((n,x)=>n+x.count,0),stage===10?4:2);assert.ok(s.data.settlement!.rewards.every(x=>!x.key.endsWith('gold')&&(x.key.startsWith('universal')||heroDef(x.key).quality!=='gold')));const inventory=copy(s.data.profile.fragments);s.tick(0);assert.deepEqual(s.data.profile.fragments,inventory);}
 const s=new R1Session(new Memory());s.start(1,351);certify(s.data.run!);settle(s,'victory');assert.equal(s.data.settlement!.rewards.reduce((n,x)=>n+x.count,0),5);
});
test('D034 abandon has no reward; pause and reload preserve checkpoints',()=>{const m=new Memory(),s=new R1Session(m);s.start(1,4);certify(s.data.run!,5);s.camp();const restored=new R1Session(m);assert.equal(restored.data.run!.incentive!.checkpoint,5);assert.equal(restored.start(1,5,true),true);assert.deepEqual(restored.data.profile.fragments,{});});
test('D034 old save adds a namespace and keeps raw backup, old runs use the original reward system',()=>{
 const m=new Memory(),s=new R1Session(m);s.data.profile.clearedStage=8;s.start(8,62);const old=copy(s.data);delete old.profile.incentive;delete old.run!.incentive;const raw=JSON.stringify(old);m.setItem(R1_SAVE_KEY,raw);const restored=new R1Session(m);assert.equal(restored.error,'');assert.equal(restored.data.incentiveBackup,raw);assert.deepEqual(restored.data.profile.incentive!.storyClaimed,[1,2,3,4,5,6,7,8]);assert.equal(restored.data.run!.incentive,undefined);const expected=rollRewards(8,8,copy(old.run!.rng));settle(restored,'victory');assert.deepEqual(restored.data.settlement!.rewards,expected);assert.equal(restored.data.settlement!.receipt,undefined);
});
test('D034 corrupt growth versions and inventories are never repaired over stored bytes',()=>{
 for(const mutate of [(s:any)=>s.profile.incentive.version=9,(s:any)=>s.profile.incentive.focusByQuality.gold='RH01',(s:any)=>s.run.incentive.checkpoint=10,(s:any)=>s.profile.incentive.specializations.RH10='B']){const m=new Memory(),s=new R1Session(m);s.start(1,1);const value=copy(s.data);mutate(value);const raw=JSON.stringify(value);m.setItem(R1_SAVE_KEY,raw);const read=new R1Session(m);assert.ok(read.error);assert.equal(read.start(1,2),false);assert.equal(m.getItem(R1_SAVE_KEY),raw);}
});
test('D034 full-level goals redirect within the same quality and preserve capped inventory',()=>{
 const {p,r}=field();p.levels.RH02=20;r.status='victory';const a=settleProgression(p,r).rewards;assert.ok(!a.some(x=>x.key==='RH02'));assert.equal(a.reduce((n,x)=>n+x.count,0),5);for(const h of HEROES.filter(h=>h.quality==='blue'))p.levels[h.id]=20;const b=createRun(p,1,341,'max');b.status='victory';assert.equal(settleProgression(p,b).rewards.reduce((n,x)=>n+x.count,0),5);
});
for(const id of HEROES.map(h=>h.id))for(const perk of ['A','B'] as const)for(const level of [1,3,5])test(`D034 ${id} ${perk} skillLv${level} has valid effective combat and restorable state`,()=>{
 const {p,r,h}=field(id,perk,level);h.hp=h.maxHp*.5;for(let n=0;n<8;n++)enemy(r,.19+n*.035,.55);const ally=deployHero(r,'RH03'===id?'RH01':'RH03',1);ally.hp*=.5;
 assert.equal(castHeroSkill(r,h,2),true);assert.equal(castHeroSkill(r,h,3),true);finish(r,60);
 const memory=new Memory(),session=new R1Session(memory);session.data.profile=p;session.data.run=copy(r);assert.equal(session.camp(),true,session.error);const reload=new R1Session(memory);assert.equal(reload.error,'');const rr=reload.data.run!;finish(r);finish(rr);assert.deepEqual(rr,r);
});
test('D034 chef echo has actual delayed 40 percent damage, never duplicates corn marks',()=>{const {r,h}=field('RH02','A',3),e=enemy(r);castHeroSkill(r,h,2);const first=e.maxHp-e.hp,mark=e.markDamage;assert.equal(r.skillBursts!.length,1);assert.equal(r.skillBursts![0].damage,h.attack*skillDef(h.id,2).damageAttackMultiplier[2]*.4);r.tick=18;updateSkillBursts(r);assert.ok(e.maxHp-e.hp>first);assert.equal(e.markDamage,mark);assert.equal(r.skillBursts!.length,0);});
test('D034 heavy corn keeps extra-shot raw budget and adds the published interval and radius tradeoff',()=>{const a=field('RH02',undefined,5),b=field('RH02','B',5);enemy(a.r);enemy(b.r);castHeroSkill(a.r,a.h,3);castHeroSkill(b.r,b.h,3);const x=a.r.summons[0],y=b.r.summons[0];assert.equal(y.shots,x.shots-1);assert.ok(Math.abs(x.shots*x.attackFactor-y.shots*y.attackFactor)<1e-8);assert.equal(y.interval,x.interval*1.25);assert.equal(y.radius,x.radius*1.1);});
test('D034 frog shields only real overheal and solo heal sacrifices other recipients',()=>{const {r,h}=field('RH03','A'),a=deployHero(r,'RH01',1);h.hp-=1;castHeroSkill(r,h,2);assert.ok(h.shield>0&&h.shield<=h.maxHp*.05);h.cooldowns[1]=0;assert.equal(castHeroSkill(r,h,2),false);const b=field('RH03','B');const c=deployHero(b.r,'RH01',1);b.h.hp*=.3;c.hp*=.7;const hp=c.hp;castHeroSkill(b.r,b.h,2);assert.equal(c.hp,hp);assert.equal(b.h.cooldowns[1],autoSkillCooldown(b.r.tuning,b.h.id,2,3)*.85);});
test('D034 aunt 8-target specialization retains unique bounces and normalized damage budget',()=>{const {r,h}=field('RH04','A',5);for(let n=0;n<9;n++)enemy(r,.2+n*.035,.55);castHeroSkill(r,h,2);assert.equal(r.projectiles[0].chain!.remaining,8);finish(r);const hits=r.events.filter(e=>e.type==='chain-hit');assert.equal(hits.length,8);assert.equal(new Set(hits.map(e=>e.target)).size,8);});
test('D034 wood trap triggers only enemy destruction, not expiration or replacement',()=>{const {r,h}=field('RH05','B');const e=enemy(r);castHeroSkill(r,h,2);e.rootUntil=0;const wood=r.summons[0];damageAlly(r,wood,99999,'RM01');assert.ok(e.rootUntil>0);e.rootUntil=0;castHeroSkill(r,h,2);r.summons[0].ends=0;updateSummons(r,.1);assert.equal(e.rootUntil,0);});
test('D034 bag push excludes bosses and repeats no faster than 1.2 battle seconds',()=>{const {r,h}=field('RH06','B');const e=enemy(r,.4,.6);castHeroSkill(r,h,2);const sum=r.summons[0];sum.cooldown=0;const y=e.y;updateSummons(r,.1);assert.ok(e.y<y);const first=e.y;sum.cooldown=0;updateSummons(r,.1);assert.equal(e.y,first);const boss=enemy(r,sum.x,sum.y,9999,'RS01');e.hp=0;sum.cooldown=0;const by=boss.y;updateSummons(r,.1);assert.equal(boss.y,by);});
test('D034 beam changes real width and damage, not only visuals',()=>{const a=field('RH07','A'),b=field('RH07','B');assert.ok(heroSkillRadius(a.r,a.h,2)>heroSkillRadius(b.r,b.h,2));const x=enemy(a.r,a.h.x),y=enemy(b.r,b.h.x);castHeroSkill(a.r,a.h,2);castHeroSkill(b.r,b.h,2);assert.ok(y.maxHp-y.hp>x.maxHp-x.hp);});
test('D034 penguin root is based on state before hit and one resistance application',()=>{const {r,h}=field('RH08','B',3),e=enemy(r,h.x);e.slowUntil=20;const base=Number(skillDef(h.id,2).levelEffect[2].rootSeconds);castHeroSkill(r,h,2);assert.ok(Math.abs(e.rootUntil-base-.3)<1e-8);assert.equal(h.cooldowns[1],heroSkillCooldown(r,h,2));});
test('D034 dragon salvo launches all physical rockets together without instant damage',()=>{const {r,h}=field('RH09','A');const e=enemy(r);castHeroSkill(r,h,2);assert.ok(r.skillBursts!.every(x=>x.at===0));updateSkillBursts(r);assert.equal(r.projectiles.length,4);assert.equal(e.hp,e.maxHp);finish(r);assert.ok(e.hp<e.maxHp);});
test('D034 source buffs expire independently and chorus B keeps frog buff without granting jelly attack',()=>{const {r,h}=field('RH10','B'),frog=deployHero(r,'RH03',1);frog.skills[2]=3;enemy(r);castHeroSkill(r,frog,3);const before=heroAttack(r,frog);castHeroSkill(r,h,3);assert.equal(heroAttack(r,frog),before);assert.ok(!frog.buffs?.['RH10-S3']);r.tick=3000;assert.equal(heroAttack(r,frog),frog.attack);});
test('D034 achievements derive from actual hits, independent casts, pulls and real summon damage',()=>{
 const {r,p,h}=field('RH07');r.incentive!.captain=h.id;for(let cast=0;cast<2;cast++){for(let n=0;n<4;n++){const e=enemy(r,h.x,.3+n*.08);e.slowUntil=30;}castHeroSkill(r,h,2);}assert.equal(r.incentive!.stats.goals['frost-beam'],2);
 const ref=startCast(r,h,3)!;for(let n=0;n<10;n++){const e=enemy(r,.4,.5,1);e.pulledBy={owner:999,until:2};damageEnemy(r,e,999,'ranged','RH07-S3',true,ref);}assert.equal(r.incentive!.stats.goals['pull-combo'],10);assert.equal(r.incentive!.stats.goals['first-burst'],1);r.status='victory';applyRunAchievements(p,r);assert.equal(p.incentive!.goals['pull-combo'],10);
});
test('D034 24 expedition options have exact quotas, proper scaling and independent first-win rewards',()=>{
 const p=freshProfile();p.clearedStage=20;p.incentive!.expedition.unlockedTier=8;
 for(let tier=1;tier<=8;tier++)for(const c of CONTRACTS){const r=createRun(p,20,44,`exp-${tier}-${c.id}`,{tier,contract:c.id});for(const wave of r.plans){assert.equal(wave.length,120);for(const [id,n] of Object.entries(c.composition))assert.equal(wave.filter(e=>e.id===id).length,n);for(const [t,n] of Object.entries(c.traits))assert.equal(wave.filter(e=>e.trait===t).length,n);}assert.equal(r.incentive!.bossQuota.reduce((a,b)=>a+b,0),5);r.status='victory';const result=settleProgression(p,r);assert.equal(result.rewards.reduce((a,b)=>a+b.count,0),10);assert.notEqual(result.receipt!.reason,'首通里程碑');assert.equal(p.clearedStage,20);}
 assert.equal(p.incentive!.expedition.wins.length,24);assert.equal(p.incentive!.expedition.firstWins.length,8);assert.equal(p.incentive!.expedition.unlockedTier,8);
});
test('D034 settlement highlights actual eligible growth when primary earns nothing, without switching the saved plan',()=>{
 const p=freshProfile();p.clearedStage=20;p.fragments.RH04=8;p.incentive!.storyClaimed=Array.from({length:20},(_,i)=>i+1);const before=copy(p.incentive!.focusByQuality);const r=createRun(p,5,1200,'highlight');r.status='victory';const result=settleProgression(p,r);assert.notEqual(result.receipt!.focus,'RH02');assert.ok(result.receipt!.after>result.receipt!.before);assert.equal(p.incentive!.primary,'blue');assert.deepEqual(p.incentive!.focusByQuality,before);
});
