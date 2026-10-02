import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRun,stepBattle,BattleClock,effectiveRate} from '../assets/scripts/domain/r1/battle';
import {deployHero,chooseCard,showDraft} from '../assets/scripts/domain/r1/cards';
import {castHeroSkill,updateSkillBursts,updateProjectiles,updateHeroes,damageAlly} from '../assets/scripts/domain/r1/combat';
import {HEROES,SKILLS,heroDef,skillDef,autoSkillRadius} from '../assets/scripts/domain/r1/config';
import {freshProfile,rollRewards,unlockedHeroes,upgradeHero} from '../assets/scripts/domain/r1/rewards';
import {R1Session,R1_SAVE_KEY,validateSave} from '../assets/scripts/domain/r1/session';
import {spawnEnemy} from '../assets/scripts/domain/r1/waves';
import {copy,Run} from '../assets/scripts/domain/r1/model';
import {beamEnd,inBeam,inCone} from '../assets/scripts/domain/r1/hero-shapes';
import {streams} from '../assets/scripts/domain/r1/random';
import {attackFamily,friendlyProjectileVisual} from '../assets/scripts/presentation/R1CombatVisuals';
const ids=['RH07','RH08','RH09','RH10'];
function field(id='RH07',level=1){const p=freshProfile();p.clearedStage=20;const r=createRun(p,1,330,'roster-test');r.drawQueue=[];r.candidates=[];r.wave=15;r.released=30;const h=deployHero(r,id,0);h.skills=[level,level,level];h.basicCooldown=99;return{r,h,p};}
function enemy(r:Run,x=.3,y=.6,hp=1000,id='RM01'){const e=spawnEnemy(r,{id,trait:null,x},1);e.y=y;e.hp=e.maxHp=hp;return e;}
function finish(r:Run,n=180){for(let i=0;i<n;i++){r.tick++;updateSkillBursts(r);updateProjectiles(r,1/60);}}
class Memory{map=new Map<string,string>();getItem(k:string){return this.map.get(k)??null;}setItem(k:string,v:string){this.map.set(k,v);}}

test('C033 exact roster, power budgets, unlock milestones and complete 30 skill definitions',()=>{
 assert.deepEqual(['blue','purple','gold'].map(q=>HEROES.filter(h=>h.quality===q).length),[3,4,3]);assert.equal(SKILLS.length,30);
 for(const[id,gate]of[['RH07',3],['RH08',5],['RH09',8],['RH10',10]] as const){const p=freshProfile();p.clearedStage=gate-1;assert.ok(!unlockedHeroes(p).includes(id));p.clearedStage=gate;assert.ok(unlockedHeroes(p).includes(id));assert.equal(heroDef(id).fragmentsPerLevel,10);}
});
for(const id of ids)for(const level of [1,3,5]){
 test(`C033 ${id} S1 Lv${level} has ${level} distinct basic targets`,()=>{const {r,h}=field(id,level);h.skills=[level,0,0];h.basicCooldown=0;for(let i=0;i<7;i++)enemy(r,.2+i*.08);updateHeroes(r,.01);updateHeroes(r,1);assert.equal(r.projectiles.length,level);assert.equal(new Set(r.projectiles.map(p=>p.target)).size,level);});
 for(const slot of [2,3])test(`C033 ${id} S${slot} Lv${level} damages real targets with its own source`,()=>{
  const {r,h}=field(id,level);for(let i=0;i<8;i++)enemy(r,.19+i%4*.03,.55+Math.floor(i/4)*.05);assert.equal(castHeroSkill(r,h,slot),true);finish(r);assert.ok(r.enemies.some(e=>e.hp<e.maxHp));assert.ok(r.events.some(e=>e.type==='enemy-hit'&&e.source===`${id}-S${slot}`));assert.equal(r.skillBursts?.length,0);assert.ok(h.cooldowns[slot-1]>0);
 });
}
test('C033 beam and fan use their actual shapes, not circles or rectangles',()=>{
 const origin={x:.5,y:1},end=beamEnd(origin,{x:.5,y:.6});assert.deepEqual(end,{x:.5,y:0});assert.ok(inBeam({x:.52,y:.1},origin,end,.04));assert.ok(!inBeam({x:.6,y:.6},origin,end,.04));
 assert.ok(inCone({x:.6,y:.5},origin,end,1,30));assert.ok(!inCone({x:.98,y:.9},origin,end,1,30));assert.ok(!inCone({x:.5,y:0},origin,end,1,30));
 const {r,h}=field();enemy(r,h.x,.5);const outside=enemy(r,.9,.7);castHeroSkill(r,h,2);assert.equal(outside.hp,outside.maxHp);assert.ok(r.events.some(e=>e.type==='beam-hit'&&e.from?.x===h.x));
});
test('C033 beam priority includes a boss even when a larger minion group is elsewhere',()=>{const{r,h}=field();const b=enemy(r,.16,.3,1000,'RL01');for(let i=0;i<9;i++)enemy(r,.65+i*.01,.5);castHeroSkill(r,h,2);assert.ok(b.hp<b.maxHp);});
test('C033 higher penguin skill unlocks real root, with boss resistance',()=>{const{r,h}=field('RH08',3);const e=enemy(r,.2,.6),b=enemy(r,.2,.62,1000,'RL01');castHeroSkill(r,h,2);assert.ok(e.slowUntil>0&&e.rootUntil>0);assert.ok(b.rootUntil<e.rootUntil);});
test('C033 dragon rockets launch in sequence and damage only upon arrival, retargeting when needed',()=>{
 const{r,h}=field('RH09',3),a=enemy(r,.3,.4),b=enemy(r,.5,.4);castHeroSkill(r,h,2);assert.equal(r.projectiles.length,0);assert.equal(r.skillBursts?.length,4);updateSkillBursts(r);assert.equal(r.projectiles.length,1);assert.equal(a.hp,a.maxHp);a.hp=0;finish(r);assert.ok(b.hp<b.maxHp);assert.equal(r.skillBursts?.length,0);assert.equal(r.projectiles.length,0);
});
test('C033 star shield refreshes without stacking, cleanses, and cannot refund its own cooldown',()=>{
 const{r,h}=field('RH10',3),other=deployHero(r,'RH03',1);enemy(r);other.weakUntil=20;other.cooldowns=[0,10,10];castHeroSkill(r,h,2);const shield=other.shield;castHeroSkill(r,h,2);assert.equal(other.shield,shield);assert.equal(other.weakUntil,0);assert.ok(shield>0);castHeroSkill(r,h,3);assert.equal(other.cooldowns[1],8.4);assert.equal(other.attackBonus,.18);assert.ok(h.cooldowns[2]>10);const attack=other.attackBonus;castHeroSkill(r,h,3);assert.equal(other.attackBonus,attack);
});
test('C033 scheduled hits cancel after caster death; damage already flying remains valid',()=>{
 const{r,h}=field('RH09');enemy(r);castHeroSkill(r,h,2);updateSkillBursts(r);assert.equal(r.projectiles.length,1);damageAlly(r,h,10000,'test');finish(r);assert.equal(r.skillBursts?.length,0);assert.equal(r.events.filter(e=>e.type==='area-impact').length,1);
});
test('C033 pauses freeze scheduled hits; 1x and 2x clocks produce the same battle result',()=>{
 const{r,h}=field('RH07',3);enemy(r);castHeroSkill(r,h,3);r.paused=true;const frozen=copy(r);new BattleClock().advance(r,.2);assert.deepEqual(r,frozen);r.paused=false;
 const a=copy(r),b=copy(r);a.rate=1;b.rate=2;const ca=new BattleClock(),cb=new BattleClock();for(let i=0;i<30;i++){ca.advance(a,1/30);cb.advance(b,1/60);}b.rate=1;assert.deepEqual(a,b);
});
test('C033 in-flight and pending multi-hit saves replay exactly',()=>{
 for(const id of ids){const{r,h,p}=field(id,3);enemy(r);castHeroSkill(r,h,3);finish(r,8);const storage=new Memory(),s=new R1Session(storage);s.data.profile=p;s.data.run=copy(r);s.camp();const reload=new R1Session(storage);assert.equal(reload.error,'');const restored=reload.data.run!;finish(r);finish(restored);assert.deepEqual(restored,r);}
});
test('C033 malformed queues and missing current levels preserve original stored bytes',()=>{
 for(const mutate of[(s:any)=>{s.run.skillBursts[0].damage=-1;},(s:any)=>{delete s.profile.levels.RH07;},(s:any)=>{s.run.skillBursts[0].source='RH01-S3';}]){const {r,h,p}=field('RH07');enemy(r);castHeroSkill(r,h,3);const m=new Memory(),s=new R1Session(m);s.data.profile=p;s.data.run=r;mutate(s.data);const raw=JSON.stringify(s.data);m.setItem(R1_SAVE_KEY,raw);const reload=new R1Session(m);assert.ok(reload.error);assert.equal(reload.start(1,3),false);assert.equal(m.getItem(R1_SAVE_KEY),raw);}
});
test('C033 six-hero save expands levels without changing old run candidates, RNG or unlock pool',()=>{
 const m=new Memory(),s=new R1Session(m);s.data.profile.clearedStage=2;s.start(2,42);const old:any=copy(s.data);delete old.rosterSize;for(const id of ids){delete old.profile.levels[id];delete old.run.levels[id];}const raw=JSON.stringify(old);m.setItem(R1_SAVE_KEY,raw);const loaded=new R1Session(m);assert.equal(loaded.error,'');assert.equal(m.getItem(R1_SAVE_KEY),raw);for(const id of ids)assert.equal(loaded.data.profile.levels[id],1);assert.deepEqual(loaded.data.run?.candidates,old.run.candidates);assert.deepEqual(loaded.data.run?.rng,old.run.rng);assert.deepEqual(loaded.data.run?.unlocked,old.run.unlocked);assert.equal(loaded.camp(),true);validateSave(JSON.parse(m.getItem(R1_SAVE_KEY)!));
});
test('C033 new hero fragments can drop, use the correct universal quality, and cannot drop while locked in normal stages',()=>{
 const seen=new Set<string>();for(let seed=1;seed<=400;seed++){for(const r of rollRewards(5,20,streams(seed)))seen.add(r.key);assert.ok(rollRewards(1,0,streams(seed)).every(r=>!ids.includes(r.key)));}for(const id of ids)assert.ok(seen.has(id));
 for(const id of ids){const p=freshProfile();p.clearedStage=20;p.fragments[id]=4;p.fragments['universal-'+heroDef(id).quality]=6;assert.equal(upgradeHero(p,id,'u'),true);assert.equal(p.levels[id],2);assert.equal(p.fragments[id],0);}
});
test('C033 production assets and card metadata cover ten heroes and every skill level without fallbacks',()=>{
 const manifest=JSON.parse(readFileSync('game/assets/resources/r1/manifest.json','utf8')),cards=JSON.parse(readFileSync('game/assets/scripts/domain/r1/ui-cards.json','utf8'));
 assert.equal(new Set(manifest.atlases.map((a:any)=>a.id)).size,manifest.atlases.length);
 for(const h of HEROES){assert.ok(manifest.atlases.find((a:any)=>a.id===h.id));assert.ok(manifest.atlases.find((a:any)=>a.id==='PORTRAIT-'+h.id));assert.ok(cards.find((c:any)=>c.id==='HERO-'+h.id));for(const slot of[1,2,3])for(const level of slot===1?[2,3,5]:[1,3,5]){assert.equal(attackFamily(`${h.id}-S${slot}`),h.id);assert.ok(cards.find((c:any)=>c.id===`${h.id}-S${slot}-L${level}`));}}
 for(const id of ids){assert.equal(manifest.atlases.find((a:any)=>a.id===id).frames.length,12);assert.equal(manifest.atlases.find((a:any)=>a.id==='IC-'+id).frames.length,3);assert.equal(manifest.atlases.find((a:any)=>a.id==='FX-'+id).frames.length,9);assert.equal(friendlyProjectileVisual(id+'-S1')?.pack,'FX-'+id);}
});
test('C033 penguin never consumes a cast or plays a windup with no target inside its real fan reach',()=>{
 const{r,h}=field('RH08');enemy(r,1,0);h.cooldowns[1]=0;h.cooldowns[2]=999;
 assert.equal(castHeroSkill(r,h,2),false);assert.equal(h.cooldowns[1],0);updateHeroes(r,.01);assert.equal(h.skillWindup,undefined);
});
