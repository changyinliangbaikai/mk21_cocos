import {writeFileSync,mkdirSync} from 'node:fs';
import {createRun,stepBattle} from '../game/assets/scripts/domain/r1/battle';
import {deployHero,chooseCard,resolveRescue} from '../game/assets/scripts/domain/r1/cards';
import {freshProfile,settleProgression} from '../game/assets/scripts/domain/r1/rewards';
const rows:any[]=[];
for(const stage of [2,5,10,20])for(const weak of [false,true])for(let seed=1;seed<=6;seed++){
 const p=freshProfile();p.clearedStage=20;p.incentive!.storyClaimed=Array.from({length:20},(_,i)=>i+1);p.incentive!.beginnerDone=true;
 const squad=weak?['RH03','RH05','RH08']:['RH01','RH02','RH03','RH04'];
 let firstFive=0,firstTen=0;
 const r=createRun(p,stage,seed*137+1234,'efficiency');r.drawQueue=[];r.candidates=[];squad.forEach((id,i)=>deployHero(r,id,i));
 for(let n=0;r.status==='active'&&n<80000;n++){
  if(r.rescue)resolveRescue(r,weak?false:r.rescue==='grandpa'||!r.freeReviveUsed);
  else if(r.candidates.length){const rank=(c:typeof r.candidates[number])=>weak?c.kind==='skill'&&c.heroId==='RH03'?100:c.kind==='attribute'&&c.heroId==='RH03'?90:c.kind==='hero'?0:10:c.kind==='skill'?c.skillSlot===1?90:80:c.kind==='attribute'?70:0;chooseCard(r,[...r.candidates].sort((a,b)=>rank(b)-rank(a))[0].id);}
  stepBattle(r);if(!firstFive&&r.incentive!.checkpoint>=5)firstFive=r.tick/60;if(!firstTen&&r.incentive!.checkpoint>=10)firstTen=r.tick/60;
 }
 if(r.status==='active')throw Error('unsettled');const packet=settleProgression(p,r),total=packet.rewards.reduce((n,x)=>n+x.count,0);
 rows.push({stage,weak,seed,status:r.status,seconds:r.tick/60,firstFive,firstTen,checkpoint:r.incentive!.checkpoint,total,piecesPerMinute:total/(r.tick/3600),revives:r.freeReviveUsed});
}
const groups=[2,5,10,20].map(stage=>{const group=rows.filter(x=>x.stage===stage),wins=group.filter(x=>!x.weak&&x.status==='victory'),losses=group.filter(x=>x.weak&&x.status==='defeat');const victory= wins.reduce((n,x)=>n+x.piecesPerMinute,0)/wins.length,loss=Math.max(0,...losses.map(x=>x.piecesPerMinute));return{stage,wins:wins.length,weakDefeats:losses.length,victoryRate:victory,maxDefeatRate:loss,ratio:losses.length?loss/victory:null,naturalPaidDefeats:losses.filter(x=>x.total>0).length,conservativeInstantDefeatTotalRatio:Math.max(...group.filter(x=>x.status==='victory').map(x=>Math.max((stage%10===0?2:1)/x.firstFive,(stage%10===0?4:2)/x.firstTen)/(x.total/x.seconds))),interpretation:losses.some(x=>x.total>0)?'observed paid defeat samples':'no paid defeat in this sample; not proof of farming safety'};});
mkdirSync('artifacts/r1/c034',{recursive:true});writeFileSync('artifacts/r1/c034/efficiency.json',JSON.stringify({groups,rows,limits:['fixed 1x simulation with zero selection delays; excludes menus and human decision time','weak legal team and support-first card policy, all rescues refused; no artificial kill or damage override','sampled audit does not prove every possible exploit absent']},null,2)+'\n');console.log(JSON.stringify(groups,null,2));
