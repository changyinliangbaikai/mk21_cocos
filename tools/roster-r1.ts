import {mkdirSync,writeFileSync} from 'node:fs';
import {createRun,stepBattle} from '../game/assets/scripts/domain/r1/battle';
import {deployHero,chooseCard,resolveRescue} from '../game/assets/scripts/domain/r1/cards';
import {freshProfile} from '../game/assets/scripts/domain/r1/rewards';
import {copy} from '../game/assets/scripts/domain/r1/model';
import {validateSave} from '../game/assets/scripts/domain/r1/session';
const squads=[['RH07','RH01','RH02','RH03'],['RH08','RH01','RH02','RH04'],['RH09','RH01','RH03','RH04'],['RH10','RH01','RH02','RH04'],['RH07','RH08','RH09','RH10']];
const rows=[];
for(const squad of squads)for(const stage of [6,10,20])for(const policy of ['skills','attributes'])for(let seed=1;seed<=8;seed++){
 const p=freshProfile();p.clearedStage=20;let r=createRun(p,stage,seed*733,`roster-${stage}-${policy}-${seed}`);r.drawQueue=[];r.candidates=[];squad.forEach((id,i)=>deployHero(r,id,i));
 const first:Record<string,number>={},casts:Record<string,number>={},hits:Record<string,number>={},bursts:Record<string,number>={};let seq=0,peak=0,restored=false;
 for(let n=0;r.status==='active'&&n<60000;n++){
  if(r.rescue)resolveRescue(r,r.rescue==='grandpa'||!r.freeReviveUsed);
  else if(r.candidates.length){const rank=(c:typeof r.candidates[number])=>c.kind==='attribute'?(policy==='attributes'?90:50):c.kind==='skill'?(policy==='skills'?c.skillSlot===1?80:90:60):0;chooseCard(r,[...r.candidates].sort((a,b)=>rank(b)-rank(a))[0].id);}
  stepBattle(r);peak=Math.max(peak,r.enemies.length);
  for(const e of r.events.filter(e=>e.seq>seq)){
   const id=e.source.slice(0,4);if(e.type==='hero-skill'){first[id]??=e.tick/60;casts[e.source]=(casts[e.source]||0)+1;}
   if(e.type==='enemy-hit'&&e.source.match(/-S[23]$/))hits[e.source]=(hits[e.source]||0)+1;
   if(e.type==='skill-result'&&(e.amount||0)>=3)bursts[id]=(bursts[id]||0)+1;
  }seq=r.eventSequence;
  if(!restored&&r.wave>=7){const save={schemaVersion:1 as const,rosterSize:10,revision:0,profile:p,run:copy(r),settlement:null,legacyBackup:null,migration:'fresh' as const};validateSave(save);r=save.run;restored=true;}
 }
 if(r.status==='active')throw Error('Hung run '+r.id);
 rows.push({stage,policy,seed,squad,status:r.status,wave:r.wave,seconds:r.tick/60,spawned:r.spawnedMinions,bosses:r.spawnedBosses,kills:r.kills,first,casts,hits,bursts,peak,restored});
}
const report={version:'R1.1.0',limitations:['preselected squads on unlocked test accounts; level 1 permanent stats','legal card choices; no perfect global aiming; no invulnerability','synthetic evidence, not player win rate or phone performance'],summary:{runs:rows.length,wins:rows.filter(r=>r.status==='victory').length,peak:Math.max(...rows.map(r=>r.peak)),perHero:['RH07','RH08','RH09','RH10'].map(id=>({id,runs:rows.filter(r=>r.squad.includes(id)).length,withSkill:rows.filter(r=>r.squad.includes(id)&&r.first[id]!=null).length,skill2Hits:rows.reduce((n,r)=>n+(r.hits[id+'-S2']||0),0),skill3Hits:rows.reduce((n,r)=>n+(r.hits[id+'-S3']||0),0)}))},rows};
mkdirSync('artifacts/r1/c033',{recursive:true});writeFileSync('artifacts/r1/c033/roster-matrix.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.summary,null,2));
