import { readFileSync,writeFileSync,existsSync,renameSync } from 'node:fs';
import { GameSession } from '../game/assets/scripts/domain/session';
const [mode,path]=process.argv.slice(2);
const c=JSON.parse(readFileSync('docs/design/configs/prototype-v0.5.json','utf8'));
const storage={getItem:()=>existsSync(path)?readFileSync(path,'utf8'):null,setItem:(_k:string,v:string)=>{writeFileSync(path+'.tmp',v);renameSync(path+'.tmp',path);}};
const g=new GameSession(c,storage),cmd=(k:string,p?:any)=>{if(!g.dispatch(k,p))throw new Error(g.data.notice);};
if(mode==='prepare'){
 cmd('newRun',{seed:20260912});cmd('summon',{heroId:'H001',slot:'L1-B'});cmd('startWave');
 g.advance(0.5);cmd('settings');
 // Technical failure fixture: demonstrate an interrupted pending ad transaction, without claiming normal play.
 g.data.run.phase='secondFailure';g.data.run.grandpaUsed=true;g.data.run.battle.baseHp=0;
 cmd('closeOverlay');cmd('adRequest');cmd('adResult',{id:g.data.run.ad.id,result:'unknown'});
 console.log(JSON.stringify({id:g.data.run.id,ad:g.data.run.ad,phase:g.data.run.phase}));
}else if(mode==='recover'){
 cmd('continueRun');const before=g.data.run.battle.energy;const id=g.data.run.ad.id;
 cmd('freeRevive');const late=g.dispatch('adResult',{id,result:'completed'});
 console.log(JSON.stringify({id:g.data.run.id,phase:g.data.run.phase,secondUsed:g.data.run.secondUsed,gain:g.data.run.battle.energy-before,late,ad:g.data.run.ad,xp:g.data.profile.trainingXp}));
}else if(mode==='inspect'){
 console.log(JSON.stringify({id:g.data.run.id,phase:g.data.run.phase,secondUsed:g.data.run.secondUsed,ad:g.data.run.ad,xp:g.data.profile.trainingXp}));
}
