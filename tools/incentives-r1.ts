import {mkdirSync,writeFileSync} from 'node:fs';
import {createRun,stepBattle} from '../game/assets/scripts/domain/r1/battle';
import {deployHero,chooseCard,resolveRescue} from '../game/assets/scripts/domain/r1/cards';
import {freshProfile,settleProgression} from '../game/assets/scripts/domain/r1/rewards';
import {copy,Run} from '../game/assets/scripts/domain/r1/model';
import {validateSave} from '../game/assets/scripts/domain/r1/session';
import {CONTRACTS,Expedition,Specialization} from '../game/assets/scripts/domain/r1/incentives';
import {heroDef} from '../game/assets/scripts/domain/r1/config';
const squads=[['RH01','RH02','RH03','RH04'],['RH05','RH06','RH07','RH08'],['RH09','RH10','RH01','RH03'],['RH07','RH08','RH09','RH10']];
const rows:any[]=[];
for(const squad of squads)for(const tier of [1,4,8])for(const contract of CONTRACTS)for(const perk of ['A','B'] as const)for(let seed=1;seed<=3;seed++){
 const p=freshProfile();p.clearedStage=20;p.incentive!.expedition.unlockedTier=8;p.incentive!.beginnerDone=true;
 for(const id of squad){p.levels[id]=3;p.incentive!.specializations[id]=perk;}
 const r=createRun(p,20,seed*733+341,`incentive-${squad[0]}-${tier}-${contract.id}-${perk}-${seed}`,{tier,contract:contract.id});r.drawQueue=[];r.candidates=[];squad.forEach((id,i)=>deployHero(r,id,i));
 let peak=0,firstFive=0,firstTen=0,restored=false,casts=0,seq=0;
 for(let loop=0;r.status==='active'&&loop<80000;loop++){
  if(r.rescue)resolveRescue(r,r.rescue==='grandpa'||!r.freeReviveUsed);
  else if(r.candidates.length){const rank=(c:typeof r.candidates[number])=>c.kind==='skill'?c.skillSlot===1?80:90:c.kind==='attribute'?70:0;chooseCard(r,[...r.candidates].sort((a,b)=>rank(b)-rank(a))[0].id);}
  stepBattle(r);peak=Math.max(peak,r.enemies.length);
  if(!firstFive&&r.incentive!.checkpoint>=5)firstFive=r.tick/60;
  if(!firstTen&&r.incentive!.checkpoint>=10)firstTen=r.tick/60;
  casts+=r.events.filter(e=>e.seq>seq&&e.type==='hero-skill').length;seq=r.eventSequence;
  if(!restored&&r.wave>=7){const save={schemaVersion:1 as const,rosterSize:10,revision:0,profile:p,run:copy(r),settlement:null,legacyBackup:null,migration:'fresh' as const};validateSave(save);Object.assign(r,save.run);restored=true;}
 }
 if(r.status==='active')throw Error('Unsettled '+r.id);
 const result=settleProgression(p,r),total=result.rewards.reduce((a,b)=>a+b.count,0);
 if(total>(r.status==='victory'?10:4))throw Error('Reward cap');
 rows.push({squad,tier,contract:contract.id,perk,seed,status:r.status,wave:r.wave,seconds:r.tick/60,firstFive,firstTen,casts,peak,total,checkpoint:r.incentive!.checkpoint,goals:r.incentive!.stats.goals,restored});
}
const summary={runs:rows.length,wins:rows.filter(r=>r.status==='victory').length,losses:rows.filter(r=>r.status==='defeat').length,maxPeak:Math.max(...rows.map(r=>r.peak)),groups:squads.map(squad=>({squad,...Object.fromEntries([1,4,8].map(t=>[t,rows.filter(r=>r.tier===t&&r.squad===squad&&r.status==='victory').length+'/'+rows.filter(r=>r.tier===t&&r.squad===squad).length]))})),zeroCheckpoint:rows.filter(r=>r.checkpoint===0).length};
mkdirSync('artifacts/r1/c034',{recursive:true});writeFileSync('artifacts/r1/c034/expedition-matrix.json',JSON.stringify({version:'R1.2.0',summary,limits:['synthetic legal skill-first choices on preselected unlocked level3 squads','not real player retention or phone performance','A/B comparison depends on skill RNG and geometry; includes full-game outcomes rather than only damage'],rows},null,2)+'\n');console.log(JSON.stringify(summary,null,2));
