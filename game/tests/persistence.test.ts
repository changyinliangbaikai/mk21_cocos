import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GameSession,SAVE_KEY } from '../assets/scripts/domain/session';
import { validateConfig } from '../assets/scripts/domain/config';
const c=JSON.parse(readFileSync('docs/design/configs/prototype-v0.5.json','utf8'));
const mem=()=>{const map=new Map<string,string>();return {getItem:(k:string)=>map.get(k)||null,setItem:(k:string,v:string)=>{map.set(k,v);}};};
test('P0: runtime config validates references, economy and geometry; unsafe form stats are rejected',()=>{
 validateConfig(c);const bad=structuredClone(c);bad.forms[0].damage=2;assert.throws(()=>validateConfig(bad),/形态/);
 const wrong=structuredClone(c);wrong.waves[0].energy_budget++;assert.throws(()=>validateConfig(wrong),/预算/);
});
test('T11 cross-process: unknown ad survives process exit, explicit free locks result, late callback cannot clear',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cocos-save-')),path=join(dir,'save.json');
 try{const call=(mode:string)=>JSON.parse(execFileSync(process.execPath,['--import','tsx','tools/persistence-child.ts',mode,path],{encoding:'utf8'}));
 const first=call('prepare'),second=call('recover'),third=call('inspect');
 assert.equal(first.phase,'adPending');assert.equal(first.ad.status,'unknown');assert.equal(second.id,first.id);
 assert.equal(second.phase,'freeDeploy');assert.equal(second.gain,80);assert.equal(second.late,false);assert.equal(second.xp,0);
 assert.equal(third.phase,'freeDeploy');assert.equal(third.secondUsed,true);assert.equal(third.ad.result,'free');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('T22: failing durable write rolls back whole upgrade; retry with same expected level consumes once',()=>{
 const store=mem(),g=new GameSession(c,store);g.dispatch('hero','H001');g.data.profile.trainingXp=48;g.data.profile.heroes.H001.level=2;g.dispatch('setting',{key:'music',value:.5});
 const original=store.setItem;store.setItem=()=>{throw new Error('quota exceeded');};
 assert.equal(g.dispatch('upgrade',{heroId:'H001',expectedLevel:2,transactionId:'upgrade-a'}),false);
 assert.equal(g.data.profile.trainingXp,48);assert.equal(g.data.profile.heroes.H001.level,2);assert.match(g.data.notice,/quota/);
 store.setItem=original;assert.equal(g.dispatch('upgrade',{heroId:'H001',expectedLevel:2,transactionId:'upgrade-a'}),true);
 assert.equal(g.data.profile.trainingXp,28);const restored=new GameSession(c,store);assert.equal(restored.data.profile.trainingXp,28);
 assert.equal(restored.data.profile.heroes.H001.level,3);assert.equal(restored.data.profile.heroes.H001.equippedForm,'H001-F01');
});
test('P5: second browser cannot overwrite a newer account or repeat consumption',()=>{
 const store=mem(),first=new GameSession(c,store);first.dispatch('settings');const stale=new GameSession(c,store);
 first.dispatch('setting',{key:'music',value:.2});assert.equal(stale.dispatch('setting',{key:'sfx',value:.9}),false);
 assert.match(stale.data.notice,/另一个窗口/);assert.equal(new GameSession(c,store).data.profile.settings.music,.2);
});
test('P5: corrupt save is reported and preserved instead of silently overwritten',()=>{
 const store=mem();store.setItem(SAVE_KEY,'{bad json');const g=new GameSession(c,store);
 assert.match(g.data.notice,/存档读取失败/);assert.equal(g.dispatch('newRun'),false);assert.equal(store.getItem(SAVE_KEY),'{bad json');
});
test('T28: reload preserves aim/source overlay, while uncommitted summon can safely cancel',()=>{
 const store=mem(),g=new GameSession(c,store);g.dispatch('newRun');g.data.run.skills.P001={readyTick:0,casts:0,availableTicks:0};g.data.run.equipped[0]='P001';g.dispatch('startWave');g.dispatch('aim','P001');
 const restored=new GameSession(c,store);assert.equal(restored.data.screen,'camp');restored.dispatch('continueRun');assert.equal(restored.data.overlay,'aim');
 const tick=restored.data.run.battle.tick;restored.advance(20);assert.equal(restored.data.run.battle.tick,tick);assert.equal(restored.dispatch('cancelAim'),true);
});
test('T28: navigating from a dirty roster to a locked hero asks to discard and keeps saved roster untouched',()=>{
 const g=new GameSession(c,mem());g.dispatch('open','roster');const before=[...g.data.profile.roster];g.dispatch('rosterToggle','H003');
 assert.equal(g.dispatch('hero','H004'),true);assert.equal(g.data.screen,'roster');assert.equal(g.data.overlay,'discardRoster');assert.deepEqual(g.data.profile.roster,before);
 g.dispatch('closeOverlay');assert.equal(g.data.screen,'roster');assert.equal(g.data.rosterDraft.length,2);
 g.dispatch('hero','H004');g.dispatch('discardRoster');assert.equal(g.data.screen,'hero');assert.equal(g.data.selectedHero,'H004');assert.deepEqual(g.data.profile.roster,before);
});
