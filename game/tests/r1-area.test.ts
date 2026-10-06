import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun} from '../assets/scripts/domain/r1/battle';
import {deployHero,chooseCard,showDraft} from '../assets/scripts/domain/r1/cards';
import {updateHeroes,updateProjectiles,castHeroSkill,updateSummons} from '../assets/scripts/domain/r1/combat';
import {HEROES,SKILLS,RULES,basicAreaRadius,heroDef,skillDef} from '../assets/scripts/domain/r1/config';
import {copy,Run} from '../assets/scripts/domain/r1/model';
import {freshProfile} from '../assets/scripts/domain/r1/rewards';
import {R1Session,R1_SAVE_KEY,validateSave} from '../assets/scripts/domain/r1/session';
import {spawnEnemy} from '../assets/scripts/domain/r1/waves';
import baseline from './fixtures/r1-pre-area-damage.json';
import cards from '../assets/scripts/domain/r1/ui-cards.json';

function field(id='RH02',level=1){const p=freshProfile();p.clearedStage=20;const r=createRun(p,1,4101,'area');r.drawQueue=[];r.candidates=[];r.wave=15;r.released=120;const h=deployHero(r,id,0);h.x=.5;h.skills=[level,0,0];return{r,h,p};}
function enemy(r:Run,x=.5,y=.75,id='RM01',hp=10000){const e=spawnEnemy(r,{id,x,trait:null},1);e.y=y;e.hp=e.maxHp=hp;e.defense=0;return e;}
function strike(r:Run){updateHeroes(r,.01);updateHeroes(r,.26);for(let n=0;n<180;n++){r.tick++;updateProjectiles(r,1/60);}}

test('C041 every batch covers eight full-width lanes and its first eight releases reach both sides',()=>{
 const p=freshProfile();p.clearedStage=20;
 for(const stage of [1,5,6,10,20])for(let seed=1;seed<=8;seed++)for(const w of createRun(p,stage,seed,'spread').plans)for(let at=0;at<120;at+=40){
  const batch=w.slice(at,at+40),bins=Array(8).fill(0);batch.forEach(e=>bins[Math.floor((e.x-.06)/.11)]++);
  assert.deepEqual(bins,Array(8).fill(5));assert.ok(Math.min(...batch.slice(0,8).map(e=>e.x))<.15);assert.ok(Math.max(...batch.slice(0,8).map(e=>e.x))>.85);
 }
});
test('C041 damage tables, hero stats/attack cadence and global skills remain exactly at the prior baseline',()=>{
 assert.deepEqual(HEROES,baseline.heroes);assert.deepEqual(SKILLS.map(s=>({id:s.id,damage:s.damageAttackMultiplier,cooldowns:s.cooldownSeconds})),baseline.skills);
 assert.deepEqual(RULES.globalSkills,baseline.globalSkills);assert.deepEqual(RULES.battle.feel,baseline.feel);
});
for(const hero of HEROES)for(const level of [1,3,5])test(`C041 ${hero.id} level ${level} hits a cluster once per enemy at the original damage`,()=>{
 const {r,h}=field(hero.id,level),radius=basicAreaRadius(r.tuning,hero.id,level);
 const boss=enemy(r,.5,.75,'RL01'),near=[enemy(r,.53,.75),enemy(r,.47,.75),enemy(r,.5,.72)],outside=enemy(r,.5+radius+.02,.75);
 strike(r);const damage=Math.ceil(h.attack*skillDef(hero.id,1).damageAttackMultiplier[level-1]);
 for(const e of [boss,...near])assert.equal(e.maxHp-e.hp,damage,hero.id+'/'+e.id);
 assert.equal(outside.hp,outside.maxHp);assert.equal(r.events.filter(e=>e.type==='group-impact').length,1);
 assert.equal(r.events.filter(e=>e.type==='enemy-hit'&&e.target===boss.uid).length,1);
 assert.ok(radius<.5);
});
test('C041 upgrades expand the physical footprint instead of spawning extra basic shots',()=>{
 for(const hero of HEROES){const low=field(hero.id),high=field(hero.id,5),base=basicAreaRadius(low.r.tuning,hero.id,1),wide=basicAreaRadius(high.r.tuning,hero.id,5);
  assert.ok(wide>base);const offset=(base+wide)/2;
  for(const {r} of [low,high])enemy(r,.5,.75,'RL01');const a=enemy(low.r,.5+offset,.75),b=enemy(high.r,.5+offset,.75);
  strike(low.r);strike(high.r);assert.equal(a.hp,a.maxHp);assert.ok(b.hp<b.maxHp);
  assert.equal(high.r.events.filter(e=>e.type==='projectile').length,hero.role==='melee'?0:1);
 }
});
test('C041 a melee area hit does not damage adjacent enemies outside the legal half-screen range',()=>{
 const {r}=field('RH01',5),boss=enemy(r,.5,.52,'RL01'),out=enemy(r,.5,.49);strike(r);assert.ok(boss.hp<boss.maxHp);assert.equal(out.hp,out.maxHp);
});
test('C041 lethal area reservations redirect another hero toward an uncovered cluster',()=>{
 const {r,h}=field();const a=enemy(r,.5,.75,'RM01',1),b=enemy(r,.53,.75,'RM01',1);updateHeroes(r,.01);assert.ok(h.windup);
 const other=deployHero(r,'RH04',1);other.skills=[1,0,0];const far=enemy(r,.85,.75,'RM01',1);updateHeroes(r,.01);
 assert.deepEqual(other.windup!.targets,[far.uid]);assert.deepEqual(h.windup!.targets,[a.uid]);assert.equal(b.hp,1);
});
test('C041 a launched area shot retains its damage and radius when the hero upgrades or dies, including restore',()=>{
 const {r,h,p}=field('RH02'),e=enemy(r),near=enemy(r,.54,.75);updateHeroes(r,.01);updateHeroes(r,.26);
 assert.equal(r.projectiles.length,1);const shot=copy(r.projectiles[0]);h.skills[0]=5;h.hp=0;h.deathTick=r.tick;
 const storage={getItem:()=>null,setItem:()=>{}};const s=new R1Session(storage);s.data.profile=p;s.data.run=r;validateSave(s.data);const restored=copy(r);
 for(let n=0;n<100;n++){updateProjectiles(r,1/60);updateProjectiles(restored,1/60);}
 assert.deepEqual(r,restored);assert.equal(e.maxHp-e.hp,Math.ceil(shot.damage));assert.equal(near.maxHp-near.hp,Math.ceil(shot.damage));
});
test('C041 old snapshots retain target-count attacks while current cards advertise range growth',()=>{
 const {r,h}=field('RH02',5);delete r.tuning!.areaAttacks;for(let n=0;n<6;n++)enemy(r,.3+n*.06,.75);strike(r);
 assert.equal(r.events.filter(e=>e.type==='projectile').length,5);assert.equal(r.events.filter(e=>e.type==='group-impact').length,0);
 for(const hero of HEROES)for(let level=2;level<=5;level++){const card=cards.find(c=>c.id===`${hero.id}-S1-L${level}`)!;assert.ok(card.lines[0].includes('半径'));assert.ok(!card.details.some(d=>d.includes('个不同目标')));}
});
for(const id of ['RH04','RH06'])test(`C041 ${id} attack summon hits a group with unchanged per-hit multiplier`,()=>{
 const {r,h}=field(id);h.skills=[1,1,1];const a=enemy(r),b=enemy(r,.52,.75);castHeroSkill(r,h,id==='RH04'?3:2);
 const s=r.summons[0];assert.ok(s.splashRadius!>0);a.hp=a.maxHp;b.hp=b.maxHp;s.cooldown=0;updateSummons(r,1/60);for(let n=0;n<80;n++)updateProjectiles(r,1/60);
 const damage=Math.ceil(s.attack*s.attackFactor);assert.equal(a.maxHp-a.hp,damage);assert.equal(b.maxHp-b.hp,damage);
});
test('C041 malformed area snapshots or projectiles never overwrite storage',()=>{
 for(const change of [(r:Run)=>{r.tuning!.areaAttacks!.radii.RH02=[.1];},(r:Run)=>{r.tuning!.areaAttacks!.version=2 as 1;},(r:Run)=>{r.projectiles[0].group!.minY=-1;}]){
  const {r,p}=field();enemy(r);updateHeroes(r,.01);updateHeroes(r,.26);change(r);let raw='';const storage={getItem:()=>raw,setItem:(_k:string,v:string)=>{raw=v;}};
  const s=new R1Session({getItem:()=>null,setItem:()=>{}});s.data.profile=p;s.data.run=r;raw=JSON.stringify(s.data);const original=raw;
  assert.ok(new R1Session(storage).error);assert.equal(raw,original);
 }
});
