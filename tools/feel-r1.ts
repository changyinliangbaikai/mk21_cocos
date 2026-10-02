import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Card, Run } from '../game/assets/scripts/domain/r1/model';

const option = (key: string, fallback: string) => process.argv.find(a => a.startsWith('--' + key + '='))?.slice(key.length + 3) || fallback;
const variant = option('variant', 'current'), seeds = Number(option('seeds', '16'));
const stages = option('stages', '1,2').split(',').map(Number), label = option('label', variant);
const meleeRange = Number(option('melee-range', '0'));
if (!Number.isFinite(meleeRange) || meleeRange !== 0 && (meleeRange < .5 || meleeRange > 1)) throw new Error('melee-range must be between 0.5 and 1');
if (!['current', 'baseline'].includes(variant) || !/^[a-z0-9-]+$/.test(label) || !Number.isInteger(seeds) || seeds < 1 || seeds > 100 || stages.some(s => !Number.isInteger(s) || s < 1 || s > 20)) throw new Error('Invalid feel matrix arguments');
const base = resolve(variant === 'baseline' ? 'artifacts/r1/feel-c032/baseline/domain/r1' : 'game/assets/scripts/domain/r1');
const {createRun,stepBattle} = require(base + '/battle.ts') as typeof import('../game/assets/scripts/domain/r1/battle');
const {chooseCard,resolveRescue} = require(base + '/cards.ts') as typeof import('../game/assets/scripts/domain/r1/cards');
const {freshProfile} = require(base + '/rewards.ts') as typeof import('../game/assets/scripts/domain/r1/rewards');
const {RULES} = require(base + '/config.ts') as typeof import('../game/assets/scripts/domain/r1/config');
const policies = ['balanced','first','attributes','ranged-three'];
const offensive = (s:string) => /^RH(?:0[12456789]|10)-S[23]$/.test(s);
const rank = (c: Card, p: string) => c.kind === 'hero' ? p === 'ranged-three' ? -1 : 100 : p === 'first' ? 0
  : p === 'balanced' ? c.kind === 'skill' ? c.skillSlot === 1 ? 90 : 80 : c.kind === 'attribute' ? 70 : 60
  : c.kind === 'attribute' ? 90 : c.kind === 'skill' ? 70 : 50;
const rows: any[] = [];
for (const stage of stages) for (const policy of policies) for (let n=0;n<seeds;n++) {
  const seed = (42+Math.imul(n,2654435761))>>>0, profile=freshProfile(); profile.clearedStage=stage-1;
  const r:Run=createRun(profile,stage,seed,`feel-${stage}-${policy}-${seed}`);
  if(meleeRange && r.tuning?.feel)r.tuning.feel.meleeSkillRange=meleeRange;
  let opening=0, cursor=0, firstSkill:number|null=null, firstDraw:number|null=null, earlyCasts=0, tripleBursts=0, earlyWipe=false, bossActions=0, peak=0, maxSkillKills=0;
  let firstDeath:number|null=null; const casts:any[]=[]; const heroesSeen=new Set<string>();
  for(let loop=0;r.status==='active'&&r.tick<36000&&loop<50000;loop++) {
    if(r.rescue){if(r.wave<5&&r.slots.filter(Boolean).every(h=>h!.hp<=0))earlyWipe=true;resolveRescue(r,r.rescue==='grandpa'||!r.freeReviveUsed);}
    else if(r.candidates.length){
      const wanted=policy==='ranged-three'?['RH04','RH02','RH03']:['RH01','RH02','RH03'];
      const source=r.drawQueue[0], c=source==='opening'?(r.candidates.find(c=>c.kind==='hero'&&c.heroId===wanted[opening])||r.candidates.find(c=>c.kind==='hero')!):[...r.candidates].sort((a,b)=>rank(b,policy)-rank(a,policy))[0];
      if(source==='opening')opening++;
      if(source==='energy'&&firstDraw===null)firstDraw=r.tick/60;
      chooseCard(r,c.id,policy==='ranged-three'&&source==='opening'?opening:undefined);
    }
    stepBattle(r); peak=Math.max(peak,r.enemies.length);
    if(firstDeath===null&&r.slots.some(h=>h&&h.hp<=0))firstDeath=r.tick/60;
    const fresh=r.events.filter(e=>e.seq>cursor); cursor=r.eventSequence;
    const hitSource=new Map<number,string>(), legacyKills=new Map<string,number>();
    for(const e of fresh){
      if(e.type==='hero-skill'&&offensive(e.source)){
        if(firstSkill===null)firstSkill=e.tick/60;
        if(e.tick<=3600){earlyCasts++;heroesSeen.add(e.source.slice(0,4));}
        casts.push({t:e.tick/60,source:e.source,hits:e.amount||0});
      }
      if((e.type==='boss-skill'||e.type==='enemy-attack')&&/^R[SL]/.test(e.source))bossActions++;
      if(e.type==='skill-result'&&offensive(e.source)){
        maxSkillKills=Math.max(maxSkillKills,e.amount||0);
        if(e.tick<=5400&&(e.amount||0)>=3)tripleBursts++;
      }
      if(variant==='baseline'){
        if(e.type==='enemy-hit'&&offensive(e.source)&&e.target!==undefined)hitSource.set(e.target,e.source);
        if(e.type==='enemy-death'&&e.target!==undefined){const s=hitSource.get(e.target);if(s)legacyKills.set(s,(legacyKills.get(s)||0)+1);}
      }
    }
    if(variant==='baseline')for(const n of legacyKills.values()){maxSkillKills=Math.max(maxSkillKills,n);if(r.tick<=5400&&n>=3)tripleBursts++;}
  }
  if(r.status==='active')throw new Error('Unsettled '+r.id);
  rows.push({stage,policy,seed,status:r.status,heroes:r.slots.filter(Boolean).map(h=>h!.id),seconds:r.tick/60,firstSkill,firstDraw,earlyCasts,earlySkillHeroes:[...heroesSeen],tripleBursts,maxSkillKills,earlyWipe,firstDeath,bossActions,peak,spawned:r.spawnedMinions,casts});
}
const initial=rows.filter(r=>r.stage<=2), quantile=(a:number[],q:number)=>a.length?[...a].sort((a,b)=>a-b)[Math.ceil(q*a.length)-1]:null;
const summary={runs:rows.length,initialRuns:initial.length,firstSkillP90:quantile(initial.map(r=>r.firstSkill??999),.9),sixEarlyCastsFraction:initial.filter(r=>r.earlyCasts>=6).length/initial.length,
  threeTripleBurstsFraction:initial.filter(r=>r.tripleBursts>=3).length/initial.length,earlyWipeFraction:initial.filter(r=>r.earlyWipe).length/initial.length,
  meanEarlyCasts:initial.reduce((n,r)=>n+r.earlyCasts,0)/initial.length,meanTripleBursts:initial.reduce((n,r)=>n+r.tripleBursts,0)/initial.length,
  bossActionRuns:rows.filter(r=>r.bossActions>0).length,wins:rows.filter(r=>r.status==='victory').length,peak:Math.max(...rows.map(r=>r.peak))};
const gates={F1:summary.firstSkillP90!==null&&summary.firstSkillP90<=10,F2:summary.sixEarlyCastsFraction>=.9,F3:summary.threeTripleBurstsFraction>=.8,F7:summary.earlyWipeFraction<=.05&&summary.bossActionRuns>0};
const folder='artifacts/r1/feel-c032';mkdirSync(folder,{recursive:true});
writeFileSync(`${folder}/${label}.json`,JSON.stringify({version:RULES.version,variant,tuning:{crowd:RULES.battle.crowd,feel:RULES.battle.feel,meleeRangeOverride:meleeRange||null},summary,gates,limitations:['synthetic decisions, level-one accounts, no perfect active-skill aiming','not a measurement of player happiness, retention, or device performance'],rows},null,2)+'\n');
console.log(JSON.stringify({label,summary,gates},null,2));
