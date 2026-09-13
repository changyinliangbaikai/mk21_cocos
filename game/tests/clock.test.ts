import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GameSession} from '../assets/scripts/domain/session';
const c=JSON.parse(readFileSync('docs/design/configs/prototype-v0.5.json','utf8'));
function create(speed=1){let save:string|null=null;const g=new GameSession(c,{getItem:()=>save,setItem:(_k,v)=>{save=v;}});g.dispatch('newRun',{seed:20260912});
for(const slot of ['L1-B','L2-B','L3-B'])assert.equal(g.dispatch('summon',{heroId:'H001',slot}),true);g.dispatch('setSpeed',speed);g.dispatch('startWave');return g;}
test('T01/T02: actual session accumulator produces equal wave results at 60fps/30fps and 1x/2x',()=>{
 const a=create(1),b=create(2);let i=0;while(a.data.run.phase==='battle'&&i++<2000)a.advance(1/60);
 i=0;while(b.data.run.phase==='battle'&&i++<2000)b.advance(1/30);
 assert.equal(a.data.run.phase,'cards');assert.deepEqual(a.data.run.battle,b.data.run.battle);assert.deepEqual(a.data.run.candidates,b.data.run.candidates);
 assert.ok(Math.abs(a.data.run.timings.wall/2-b.data.run.timings.wall)<.04);
});
test('T02/T28: frame backlog is retained, pause does not accumulate combat time, setting close returns source',()=>{
 const g=create();g.advance(5);assert.equal(g.data.run.battle.tick,240);g.advance(0);assert.equal(g.data.run.battle.tick,300);
 g.dispatch('openSkills');g.dispatch('settings');g.advance(20);assert.equal(g.data.run.battle.tick,300);
 g.dispatch('closeOverlay');assert.equal(g.data.overlay,'skills');g.advance(20);assert.equal(g.data.run.battle.tick,300);
 g.dispatch('closeOverlay');g.advance(1/60);assert.equal(g.data.run.battle.tick,301);
 g.dispatch('pauseBackground');g.advance(30);assert.equal(g.data.run.battle.tick,301);g.dispatch('resumeBackground');g.advance(1/60);assert.equal(g.data.run.battle.tick,302);
});
