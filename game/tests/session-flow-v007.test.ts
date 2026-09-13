import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GameSession,SAVE_KEY,type StoragePort} from '../assets/scripts/domain/session';
const current=JSON.parse(readFileSync('docs/design/configs/prototype-v0.5.json','utf8'));
const previous=JSON.parse(readFileSync('docs/design/configs/history/prototype-v0.6.json','utf8'));
const original=JSON.parse(readFileSync('docs/design/configs/history/prototype-v0.5.json','utf8'));
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
class MemoryStorage implements StoragePort {raw:string|null=null;fail=false;getItem(key:string){assert.equal(key,SAVE_KEY);return this.raw;}setItem(key:string,value:string){assert.equal(key,SAVE_KEY);if(this.fail)throw Error('interrupted write');this.raw=value;}}
const command=(g:GameSession,name:string,payload?:any)=>assert.equal(g.dispatch(name,payload),true,`${name}: ${g.data.notice}`);
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
function make(config=current){const storage=new MemoryStorage(),g=new GameSession(config,storage);command(g,'newRun',{seed:20260914});return{g,storage};}
/** Technical completion/failure fixtures exercise real session transitions and accounting;
 * they deliberately skip combat difficulty and are not ordinary-playthrough evidence. */
function cards(g:GameSession){g.battle!.clearWave(false);g.data.run.phase='battle';g.data.overlay=null;g.advance(1/60);assert.equal(g.data.run.phase,'cards');}
function choose(g:GameSession){cards(g);const id=g.data.run.candidates[0];command(g,'chooseCard',id);return id;}
function motion(speed=1){const {g,storage}=make();const b=g.battle!;b.state.queue=[];b.state.ledger=[];const e=b.spawn('M001',2,current.world.spawn_y);command(g,'setSpeed',speed);command(g,'startWave');return{g,storage,enemyId:e.id};}
function failure(g:GameSession,grandpaUsed=false){g.data.run.grandpaUsed=grandpaUsed;g.data.run.battle.baseHp=0;g.data.run.battle.result='failed';g.advance(.1);}

test('v007 first wave is explicitly prepared once and never auto-starts',()=>{
 const {g}=make();assert.equal(g.data.run.configVersion,'0.7');assert.equal(g.autoWaveRemaining(),null);assert.equal(g.combatTimeScale(),0);g.advance(100);assert.equal(g.data.run.battle.tick,0);assert.equal(g.data.run.phase,'deploy');command(g,'startWave');assert.equal(g.combatTimeScale(),1);assert.equal(g.dispatch('startWave'),false);assert.equal(g.data.run.commands.filter((c:any)=>c.type==='startWave').length,1);
});
test('v007 choosing a card creates one durable next-wave queue and one automatic start',()=>{
 const {g,storage}=make();const chosen=choose(g);assert.equal(g.dispatch('chooseCard',chosen),false);const r=g.data.run,queue=clone(r.battle.queue),ledger=clone(r.battle.ledger),tick=r.battle.tick,energy=r.battle.energy;
 assert.equal(r.battle.wave,2);assert.equal(g.autoWaveRemaining(),1.2);assert.equal(JSON.parse(storage.raw!).run.autoWave.remainingRealSeconds,1.2);
 g.advance(1.19);assert.equal(r.phase,'deploy');near(g.autoWaveRemaining()!,.01);assert.equal(r.battle.tick,tick);g.advance(.01);assert.equal(g.data.run.phase,'battle');assert.equal(g.autoWaveRemaining(),null);assert.equal(g.data.run.battle.tick,tick);assert.equal(g.data.run.battle.energy,energy);assert.deepEqual(g.data.run.battle.queue,queue);assert.deepEqual(g.data.run.battle.ledger,ledger);
 g.advance(0);assert.equal(g.data.run.commands.filter((c:any)=>c.type==='startWave'&&c.wave===2).length,1);assert.equal(JSON.parse(storage.raw!).run.autoWave,null);assert.equal(g.dispatch('startWave'),false);
});
test('v007 countdown uses real seconds at both speeds and carries frame remainder into battle',()=>{
 for(const speed of [1,2]){const {g}=make();choose(g);command(g,'setSpeed',speed);const tick=g.data.run.battle.tick;g.advance(.6);near(g.autoWaveRemaining()!,.6);g.advance(.7);assert.equal(g.autoWaveRemaining(),null);assert.equal(g.data.run.battle.tick-tick,6*speed);near(g.data.run.timings.deploy,1.2);near(g.data.run.timings.battle,.1+1/60);}
});
test('v007 countdown pauses in nested settings/library, placement, background and camp',()=>{
 const {g}=make();choose(g);g.advance(.3);near(g.autoWaveRemaining()!,.9);
 command(g,'openSkills');command(g,'settings');g.advance(20);near(g.autoWaveRemaining()!,.9);command(g,'closeOverlay');assert.equal(g.data.overlay,'skills');g.advance(20);near(g.autoWaveRemaining()!,.9);command(g,'closeOverlay');
 for(const [begin,cancel] of [['beginSummon','cancelSummon'],['beginMove','cancelMove']]){command(g,begin);g.advance(20);near(g.autoWaveRemaining()!,.9);command(g,cancel);}
 command(g,'pauseBackground');g.advance(30);near(g.autoWaveRemaining()!,.9);assert.equal(g.combatTimeScale(),0);command(g,'resumeBackground');command(g,'camp');g.advance(30);near(g.autoWaveRemaining()!,.9);command(g,'continueRun');g.advance(.9);assert.equal(g.data.run.phase,'battle');
});
test('v007 mid-countdown reload starts at camp and continues once without duplicating budget or XP',()=>{
 const {g,storage}=make();choose(g);g.advance(.4);const before=clone(g.data.run.battle),xp=g.data.profile.trainingXp,raw=storage.raw;const loaded=new GameSession(current,storage);assert.equal(loaded.data.screen,'camp');assert.equal(storage.raw,raw);loaded.advance(100);near(loaded.autoWaveRemaining()!,.8);assert.deepEqual(loaded.data.run.battle,before);command(loaded,'continueRun');loaded.advance(.8);assert.equal(loaded.data.run.phase,'battle');assert.equal(loaded.data.profile.trainingXp,xp);assert.deepEqual(loaded.data.run.battle.ledger,before.ledger);const again=new GameSession(current,storage);again.advance(100);command(again,'continueRun');again.advance(.5);assert.equal(again.autoWaveRemaining(),null);assert.equal(again.data.run.commands.filter((c:any)=>c.type==='startWave'&&c.wave===2).length,1);
});
test('v007 automatic-start storage failure rolls back and cannot advance until explicit reload',()=>{
 const {g,storage}=make();choose(g);const raw=storage.raw;storage.fail=true;g.advance(1.2);assert.equal(g.data.run.phase,'deploy');assert.equal(g.combatTimeScale(),0);assert.match(g.data.notice,/保存失败/);assert.equal(storage.raw,raw);const before=clone(g.data.run.battle);g.advance(100);assert.deepEqual(g.data.run.battle,before);storage.fail=false;const recovered=new GameSession(current,storage);command(recovered,'continueRun');recovered.advance(1.2);assert.equal(recovered.data.run.phase,'battle');assert.equal(recovered.data.run.commands.filter((c:any)=>c.type==='startWave'&&c.wave===2).length,1);
});
test('v007 placement time scale multiplies 1x/2x and advances real enemies/cooldowns without rewriting speed',()=>{
 for(const speed of [1,2]){const {g,enemyId}=motion(speed),r=g.data.run,e=r.battle.enemies.find((e:any)=>e.id===enemyId),y=e.y;r.skills.P001={readyTick:600,casts:0,availableTicks:0};r.equipped=['P001',null];
 command(g,'beginSummon');near(g.combatTimeScale(),speed*.2);g.advance(1);assert.equal(r.battle.tick,12*speed);near(e.y-y,current.monsters.find((m:any)=>m.id==='M001').speed_units_per_second*speed*.2);near(g.skillRemaining('P001'),10-.2*speed);assert.equal(r.speed,speed);assert.equal(g.data.profile.settings.speed,speed);command(g,'cancelSummon');assert.equal(g.combatTimeScale(),speed);g.advance(.5);assert.equal(r.battle.tick,42*speed);}
});
test('v007 successful placement and move resume selected speed; invalid placement preserves slow mode and energy',()=>{
 const {g}=motion(2);command(g,'beginSummon');const energy=g.data.run.battle.energy;assert.equal(g.dispatch('summon',{heroId:'H001',slot:'bad'}),false);near(g.combatTimeScale(),.4);assert.equal(g.data.run.battle.energy,energy);command(g,'summon',{heroId:'H001',slot:'R1'});assert.equal(g.combatTimeScale(),2);assert.equal(g.data.run.battle.energy,energy-40);const h=g.data.run.battle.heroes[0];h.nextAttackTick=900;command(g,'beginMove',{id:h.id});g.advance(1);assert.equal(g.data.run.battle.tick,24);command(g,'move',{id:h.id,slot:'R2'});assert.equal(g.combatTimeScale(),2);assert.equal(h.nextAttackTick,900);command(g,'beginMove',{id:h.id});command(g,'cancelMove');assert.equal(g.combatTimeScale(),2);
});
test('v007 normal inspection clock stays full speed, nested settings and aim pause placement safely',()=>{
 const {g}=motion();g.advance(.5);assert.equal(g.data.run.battle.tick,30);command(g,'beginMove');command(g,'settings');g.advance(20);assert.equal(g.data.run.battle.tick,30);assert.equal(g.combatTimeScale(),0);command(g,'closeOverlay');assert.equal(g.data.overlay,'move');near(g.combatTimeScale(),.2);g.advance(.5);assert.equal(g.data.run.battle.tick,36);command(g,'cancelMove');g.data.run.skills.P001={readyTick:0,casts:0,availableTicks:0};g.data.run.equipped=['P001',null];command(g,'aim','P001');g.advance(20);assert.equal(g.data.run.battle.tick,36);assert.equal(g.combatTimeScale(),0);command(g,'cancelAim');assert.equal(g.combatTimeScale(),1);
});
test('v007 slow-mode fractional ticks are invariant under frame subdivision',()=>{
 const a=motion(2).g,b=motion(2).g;command(a,'beginSummon');command(b,'beginSummon');for(let i=0;i<60;i++)a.advance(1/60);for(let i=0;i<10;i++)b.advance(.1);assert.equal(a.data.run.battle.tick,24);assert.deepEqual(a.data.run.battle,b.data.run.battle);
});
test('v007 failure while choosing a placement clears pending interaction and rejects stale input',()=>{
 for(const overlay of ['beginSummon','beginMove']){const {g}=motion();command(g,overlay);failure(g);assert.equal(g.data.run.phase,'firstFailure');assert.equal(g.data.overlay,null);assert.equal(g.data.overlaySource,null);assert.equal(g.data.run.savedOverlay,null);assert.equal(g.combatTimeScale(),0);assert.equal(g.can('grandpa'),true);const energy=g.data.run.battle.energy;assert.equal(g.dispatch('summon',{heroId:'H001',slot:'R1'}),false);assert.equal(g.data.run.battle.energy,energy);}
});
test('v007 wave completion during slow placement clears it and grants one durable XP/card choice',()=>{
 const {g,storage}=motion();command(g,'beginMove');g.battle!.clearWave(false);g.advance(.1);assert.equal(g.data.run.phase,'cards');assert.equal(g.data.overlay,null);assert.equal(g.data.run.aimSkill,null);assert.equal(g.data.profile.trainingXp,1);const choices=clone(g.data.run.candidates);g.advance(30);assert.deepEqual(g.data.run.candidates,choices);assert.equal(g.data.profile.trainingXp,1);const recovered=new GameSession(current,storage);command(recovered,'continueRun');command(recovered,'chooseCard',choices[0]);assert.equal(recovered.autoWaveRemaining(),1.2);
});
test('v007 reload drops ephemeral placement even when settings was opened above it, without changing the battle ledger',()=>{
 for(const settings of [false,true]){const {g,storage}=motion(2);command(g,'beginMove');g.advance(.5);if(settings)command(g,'settings');else command(g,'setting',{key:'music',value:.4});const battle=clone(g.data.run.battle),loaded=new GameSession(current,storage);assert.deepEqual(loaded.data.run.battle,battle);loaded.advance(50);command(loaded,'continueRun');if(settings){assert.equal(loaded.data.overlay,'settings');command(loaded,'closeOverlay');}assert.equal(loaded.data.overlay,null);assert.equal(loaded.combatTimeScale(),2);assert.deepEqual(loaded.data.run.battle.ledger,battle.ledger);}
});
test('v007 free revival never auto-starts and protection starts only after explicit ready',()=>{
 const {g}=motion();command(g,'beginMove');failure(g,true);assert.equal(g.data.run.phase,'secondFailure');command(g,'freeRevive');assert.equal(g.data.run.phase,'freeDeploy');assert.equal(g.autoWaveRemaining(),null);const tick=g.data.run.battle.tick;g.advance(60);assert.equal(g.data.run.battle.tick,tick);command(g,'beginSummon');g.advance(60);assert.equal(g.data.run.battle.tick,tick);command(g,'cancelSummon');command(g,'startWave');assert.equal(g.data.run.battle.protectionUntil,tick+current.rescue.free_revive_protection_seconds*current.clock.tick_hz);assert.equal(g.combatTimeScale(),1);
});
test('v007 rescue still borrows exact next budget and the automatically started calm wave earns zero',()=>{
 const {g}=make();command(g,'startWave');failure(g);const before=g.data.run.battle.energy;command(g,'grandpa');assert.equal(g.data.run.battle.energy-before,current.waves[0].energy_budget+current.waves[1].energy_budget);command(g,'chooseCard',g.data.run.candidates[0]);assert.equal(g.autoWaveRemaining(),1.2);const calmEnergy=g.data.run.battle.energy;g.advance(1.2);assert.equal(g.data.run.phase,'battle');assert.equal(g.data.run.battle.calm,true);g.battle!.clearWave(true);g.advance(1/60);assert.equal(g.data.run.phase,'cards');assert.equal(g.data.run.battle.energy,calmEnergy);assert.equal(g.data.run.calmWave,null);
});
test('v007 client preserves true 0.5/0.6 run rules until explicit replacement',()=>{
 for(const config of [original,previous]){const {g,storage}=make(config);command(g,'startWave');command(g,'beginSummon');command(g,'camp');const oldRun=clone(g.data.run),raw=storage.raw,updated=new GameSession(current,storage);assert.equal(storage.raw,raw);assert.deepEqual(updated.data.run,oldRun);assert.match(updated.data.notice,/旧局第1波保留原规则；新玩法规则开新局生效/);command(updated,'continueRun');assert.equal(updated.combatTimeScale(),0);command(updated,'cancelSummon');cards(updated);command(updated,'chooseCard',updated.data.run.candidates[0]);assert.equal(updated.autoWaveRemaining(),null);const tick=updated.data.run.battle.tick;updated.advance(20);assert.equal(updated.data.run.phase,'deploy');assert.equal(updated.data.run.battle.tick,tick);command(updated,'camp');const profile=clone(updated.data.profile);command(updated,'newRun');assert.equal(updated.data.overlay,'replace');command(updated,'newRun',{confirm:true,seed:123});assert.equal(updated.data.run.configVersion,'0.7');assert.equal(updated.autoWaveRemaining(),null);assert.deepEqual(updated.data.profile,profile);}
});
test('v007 corrupted countdown state is rejected atomically without rewriting profile or run',()=>{
 const {g,storage}=make();choose(g);const before=clone(g.data.run),profile=clone(g.data.profile),raw=storage.raw;for(const alter of [(r:any)=>r.autoWave.wave=1,(r:any)=>r.autoWave.remainingRealSeconds=-1,(r:any)=>r.autoWave.remainingRealSeconds=2,(r:any)=>r.phase='battle']){const broken=clone(before);alter(broken);assert.equal(g.restoreRun(broken),false);assert.deepEqual(g.data.run,before);assert.deepEqual(g.data.profile,profile);assert.equal(storage.raw,raw);}
});
