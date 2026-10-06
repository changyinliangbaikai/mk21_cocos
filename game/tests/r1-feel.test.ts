import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, stepBattle, aimGlobal, castGlobal } from '../assets/scripts/domain/r1/battle';
import { chooseCard, deployHero } from '../assets/scripts/domain/r1/cards';
import { castHeroSkill, heroTargets, updateProjectiles } from '../assets/scripts/domain/r1/combat';
import { autoSkillCooldown, autoSkillRadius } from '../assets/scripts/domain/r1/config';
import { copy } from '../assets/scripts/domain/r1/model';
import { freshProfile } from '../assets/scripts/domain/r1/rewards';
import { R1Session, R1_SAVE_KEY } from '../assets/scripts/domain/r1/session';
import { spawnEnemy } from '../assets/scripts/domain/r1/waves';
import { feedbackRate } from '../assets/scripts/presentation/R1CombatVisuals';

function field(id='RH02') {
  const p=freshProfile(); p.clearedStage=20;
  const r=createRun(p,1,3200,'feel-test');r.drawQueue=[];r.candidates=[];r.wave=15;r.released=r.plans[Math.max(0,r.wave-1)].length;
  const h=deployHero(r,id,0);h.basicCooldown=999;return {r,h};
}
function target(r:ReturnType<typeof field>['r'],x=.5,y=.6,hp=1000){const e=spawnEnemy(r,{id:'RM01',trait:null,x},1);e.y=y;e.hp=e.maxHp=hp;e.rootUntil=999;return e;}
test('C032 heroes enter with their identity skill, without consuming a card or changing the global slot',()=>{
  const {r,h}=field(); assert.deepEqual(h.skills,[1,1,0]);assert.equal(r.globalSkill,null);assert.equal(r.energy,0);assert.equal(r.tuning!.crowd!.throughWave,15);
  target(r);for(let i=0;i<210;i++)stepBattle(r);
  const cast=r.events.find(e=>e.type==='hero-skill');assert.ok(cast);assert.ok(cast.tick/60<=3);assert.equal(cast.source,'RH02-S2');
});
test('C032 a skill card visibly starts its upgraded skill within two seconds of a legal target',()=>{
  for(const slot of [2,3]){
    const {r,h}=field();target(r);h.cooldowns[slot-1]=20;
    const c={id:'upgrade',kind:'skill' as const,quality:'purple' as const,heroId:h.id,skillSlot:slot,level:slot===2?2:1};
    r.drawQueue=['energy'];r.candidates=[c];assert.equal(chooseCard(r,c.id),true);
    for(let i=0;i<120;i++)stepBattle(r);
    assert.ok(r.events.some(e=>e.type==='hero-skill'&&e.source===`${h.id}-S${slot}`&&e.tick<=120));
    assert.ok(r.events.some(e=>e.type==='skill-upgraded'&&e.amount===c.level));
  }
});
test('C032 older snapshots retain locked skills and the old cooldown/radius',()=>{
  const {r}=field();r.slots=[null,null,null,null];delete r.tuning!.feel;
  const h=deployHero(r,'RH01',0);assert.deepEqual(h.skills,[1,0,0]);
  assert.equal(autoSkillCooldown(r.tuning,h.id,2,1),10);assert.equal(autoSkillRadius(r.tuning,h.id,2,1),.13);
  r.drawQueue=['energy'];r.candidates=[{id:'old',kind:'skill',quality:'purple',heroId:h.id,skillSlot:2,level:1}];
  chooseCard(r,'old');assert.equal(h.cooldowns[1],10);
});
test('C032 shoe bounces deal damage at arrival, hit distinct enemies once, and preserve state across restore',()=>{
  const {r,h}=field('RH04');h.skills[1]=3;
  for(let i=0;i<6;i++)target(r,.3+i*.06,.55,20);
  assert.equal(castHeroSkill(r,h,2),true);assert.equal(r.kills,0);assert.equal(r.projectiles.length,1);
  for(let i=0;i<180&&!r.events.some(e=>e.type==='chain-hit');i++){r.tick++;updateProjectiles(r,1/60);}
  const saved=copy(r);assert.ok(r.projectiles.length>0);
  for(let i=0;i<200;i++){r.tick++;saved.tick++;updateProjectiles(r,1/60);updateProjectiles(saved,1/60);}
  assert.deepEqual(r,saved);assert.equal(r.kills,5);assert.equal(r.projectiles.length,0);
  const hits=r.events.filter(e=>e.type==='chain-hit');assert.equal(hits.length,5);assert.equal(new Set(hits.map(e=>e.target)).size,5);
  assert.equal(r.events.find(e=>e.type==='skill-result')?.amount,5);
});
test('C032 a lone boss cannot absorb all bounce charges as repeated damage',()=>{
  const {r,h}=field('RH04');h.skills[1]=5;const e=target(r);e.id='RL01';castHeroSkill(r,h,2);
  for(let i=0;i<120;i++)updateProjectiles(r,1/60);
  assert.equal(r.events.filter(e=>e.type==='chain-hit').length,1);
  assert.equal(1000-e.hp,Math.ceil(h.attack*2.4*1.2));assert.equal(r.projectiles.length,0);
});
test('C032 an orphaned first shoe can acquire a new target and never resurrect a dead target',()=>{
  const {r,h}=field('RH04'),a=target(r,.5,.5,20);castHeroSkill(r,h,2);a.hp=0;
  const b=target(r,.8,.4,20);for(let i=0;i<120;i++)updateProjectiles(r,1/60);
  assert.equal(b.hp,0);assert.equal(a.hp,0);assert.equal(r.kills,1);
});
test('C032 invalid pacing/chain snapshots do not overwrite original storage',()=>{
  const {r,h}=field('RH04');target(r);castHeroSkill(r,h,2);
  const map=new Map<string,string>(), storage={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);}},s=new R1Session(storage);s.data.run=r;
  for(const mutation of [(d:any)=>{d.run.tuning.feel.radiusScale=100;},(d:any)=>{d.run.projectiles[0].chain.remaining=-1;},(d:any)=>{d.run.projectiles[0].launch.y=5;}]){
    const d=copy(s.data);mutation(d);const raw=JSON.stringify(d);map.set(R1_SAVE_KEY,raw);assert.ok(new R1Session(storage).error);assert.equal(map.get(R1_SAVE_KEY),raw);
  }
});
test('C032 changed hero pacing does not change the player active skill damage or coverage',()=>{
  const {r}=field(),old=copy(r);delete old.tuning!.feel;
  for(const run of [r,old]){target(run,.45,.5);run.globalSkill='blue';assert.equal(aimGlobal(run),true);assert.equal(castGlobal(run,.5,.5),true);}
  assert.deepEqual(r.enemies,old.enemies);assert.equal(r.globalSkill,old.globalSkill);
});
test('C032 readable impact tails survive 2x speed; pause and card slow motion remain respected',()=>{
  assert.ok(.9/feedbackRate(2,2,true)>=.45);assert.equal(feedbackRate(2,2,false),2);
  assert.equal(feedbackRate(0,2,true),0);assert.equal(feedbackRate(.2,2,true),.12);assert.equal(feedbackRate(1,1,true),1);
});
test('C032 melee identity skills can engage the approaching wave while ordinary punches keep half-screen range',()=>{
  const {r,h}=field('RH01'),e=target(r,.4,.15);
  assert.ok(!heroTargets(r,h).includes(e));assert.ok(heroTargets(r,h,false,true).includes(e));
  const hp=e.hp;assert.equal(castHeroSkill(r,h,2),true);assert.ok(e.hp<hp);
  assert.ok(autoSkillRadius(r.tuning,h.id,2,3)>autoSkillRadius(r.tuning,h.id,2,1));
  assert.ok(autoSkillCooldown(r.tuning,h.id,2,3)<autoSkillCooldown(r.tuning,h.id,2,1));
});
