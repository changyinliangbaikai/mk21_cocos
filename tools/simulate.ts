/** Automated legal-command playthrough, NOT a human playtest or device timing benchmark. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { GameSession } from '../game/assets/scripts/domain/session';
const config=JSON.parse(readFileSync('docs/design/configs/prototype-v0.5.json','utf8'));
function simulate(seed:number,speed:number,strategy:number){
  let stored:string|null=null;const game=new GameSession(config,{getItem:()=>stored,setItem:(_k,v)=>{stored=v;}});
  const cmd=(k:string,v?:any)=>{if(!game.dispatch(k,v))throw new Error(k+': '+game.data.notice);};
  cmd('hero','H004');cmd('praise','H004');cmd('ackUnlock','H004');cmd('back');cmd('open','roster');cmd('rosterToggle','H004');cmd('saveRoster');cmd('newRun',{seed});cmd('setSpeed',speed);
  const r=()=>game.data.run,s=()=>r().battle;
  const plan=strategy===0?['H004','H004','H004']:strategy===1?['H001','H004','H001']:['H004','H001','H004'];
  const pads=['L1-B','L2-B','L3-B'];
  for(let i=0;i<3;i++)cmd('summon',{heroId:plan[i],slot:pads[i]});
  let lastBuyTick=-1, iterations=0,firstThree:any=null;
  const started=performance.now();
  while(!['victory','defeat'].includes(r().phase)&&iterations++<120000){
    if(r().phase==='firstFailure'||r().phase==='secondFailure')break;
    if(r().phase==='cards'){
      const preference=['C007','C008','C012','C010','C011','C002','C001','C013','C014','C005','C009','C015','C006','C003','C004'];
      cmd('chooseCard',[...r().candidates].sort((a,b)=>preference.indexOf(a)-preference.indexOf(b))[0]);continue;
    }
    // Reinvest only earned energy; preserve the three initial road anchors while building pairs in reserve.
    if(s().energy>=40 && lastBuyTick!==s().tick){
      lastBuyTick=s().tick;
      const anchors=pads.map(slot=>s().heroes.find((h:any)=>h.slot===slot));
      let i=anchors.findIndex((h:any)=>h.star===1);
      if(i<0)i=anchors.findIndex((h:any)=>h.star===2);
      if(i>=0){
        const hero=anchors[i], anchorSlot=hero.slot, reserve=s().heroes.filter((h:any)=>h.slot.startsWith('R'));
        if(hero.star===1){const slot=config.world.reserve_ids.find((slot:string)=>!s().heroes.some((h:any)=>h.slot===slot));if(slot){cmd('summon',{heroId:hero.type,slot});cmd('move',{id:s().heroes.find((h:any)=>h.slot===slot).id,slot:hero.slot});}}
        else {
          const slot=config.world.reserve_ids.find((slot:string)=>!s().heroes.some((h:any)=>h.slot===slot));
          if(slot){cmd('summon',{heroId:hero.type,slot});const pairs=s().heroes.filter((h:any)=>h.slot.startsWith('R') && h.type===hero.type && h.star===1);
            if(pairs.length===2){const dest=pairs[1].slot;cmd('move',{id:pairs[0].id,slot:dest});const upgraded=s().heroes.find((h:any)=>h.slot===dest);cmd('move',{id:upgraded.id,slot:anchorSlot});if(!firstThree)firstThree={tick:s().tick,wave:s().wave,energy:s().energy};}
          }
        }
      } else {
        const spare=config.world.pads.find((p:any)=>!s().heroes.some((h:any)=>h.slot===p.id));
        if(spare)cmd('summon',{heroId:spare.lane===2?'H001':'H004',slot:spare.id});
        else {
          const pair=s().heroes.find((h:any)=>h.star<3 && s().heroes.some((o:any)=>o.id!==h.id&&o.type===h.type&&o.star===h.star));
          if(pair){const other=s().heroes.find((o:any)=>o.id!==pair.id&&o.type===pair.type&&o.star===pair.star);cmd('move',{id:pair.id,slot:other.slot});}
        }
      }
    }
    if(r().phase==='deploy'){
      for(const id of Object.keys(r().skills))if(!r().equipped.includes(id)){const slot=r().equipped.indexOf(null);if(slot>=0)cmd('equipSkill',{id,slot});}
      cmd('startWave');
    }
    const live=s().enemies.filter((e:any)=>!e.terminal);
    for(const id of r().equipped){if(!id||game.skillRemaining(id)>0||!live.length)continue;
      const def=config.skills.find((v:any)=>v.id===id);cmd('aim',id);
      const enemy=live.find((e:any)=>e.type==='B001')||[...live].sort((a:any,b:any)=>b.y-a.y)[0];
      cmd('cast',def.target==='enemy'?{enemyId:enemy.id}:def.target==='lane'?{lane:enemy.lane}:def.target==='global_confirm'?{confirm:true}:{x:enemy.x,y:enemy.y});
    }
    game.advance(1/60/speed);
  }
  return {seed,speed,strategy,result:r().phase,completed:r().completedWaves.length,ticks:s().tick,battleSeconds:s().tick/60,simulatedWallSeconds:r().timings.wall,computationMs:Math.round(performance.now()-started),baseHp:s().baseHp,energy:s().energy,spawned:s().stats.spawned,killed:s().stats.killed,leaked:s().stats.leaked,damage:s().stats.damage,peakEnemies:s().stats.peakEnemies,peakEvents:s().stats.peakEvents,trainingXp:game.data.profile.trainingXp,cardHistory:r().cardHistory,snapshots:r().snapshots,firstThree,commands:r().commands,waveReports:r().waveReports};
}
const summaries=[];
for(const strategy of [0,1,2]){const v=simulate(20260912,1,strategy);summaries.push(v);console.log(JSON.stringify({...v,commands:v.commands.length,waveReports:undefined,snapshots:undefined,cardHistory:undefined}));}
const best=summaries.find(v=>v.result==='victory')||summaries.sort((a,b)=>b.completed-a.completed)[0];
const paired=simulate(20260912,2,best.strategy);summaries.push(paired);
mkdirSync('artifacts/validation',{recursive:true});writeFileSync('artifacts/validation/lv1-automated-runs.json',JSON.stringify({kind:'automated_legal_commands_not_human_playtest',configVersion:config.design_version,summaries},null,2));
console.log('Paired 2x:',JSON.stringify({...paired,commands:paired.commands.length,waveReports:undefined,snapshots:undefined,cardHistory:undefined}));
