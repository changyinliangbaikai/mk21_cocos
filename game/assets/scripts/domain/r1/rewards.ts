import { HEROES, Quality, RULES, heroDef, stageDef } from './config';
import { Profile, Reward, Run } from './model';
import { QUALITIES, freshIncentive, progressPieces, applyRunAchievements, RewardReceipt } from './incentives';
import { RandomState, pick, random, shuffle, weighted } from './random';

export function freshProfile(): Profile {
  return { clearedStage: 0, levels: Object.fromEntries(HEROES.map(h => [h.id, 1])), fragments: {}, music: true, sound: true, settlementLedger: [], upgradeLedger: [], incentive: freshIncentive() };
}
export const unlockedHeroes = (p: Profile): string[] => HEROES.filter(h => h.unlockAfterStage <= p.clearedStage).map(h => h.id);
export function rollRewards(stage: number, clearedStage: number, rng: RandomState): Reward[] {
  return combineRewards(rollRewardSlots(stage, clearedStage, rng), stageDef(stage).difficulty === 'superhard' ? 2 : 1);
}
function combineRewards(slots: string[], multiplier: number): Reward[] {
  const amounts: Record<string, number> = {};
  for (const key of slots) amounts[key] = (amounts[key] || 0) + multiplier;
  return Object.entries(amounts).map(([key, count]) => ({ key, count }));
}
export function rollRewardSlots(stage: number, clearedStage: number, rng: RandomState): string[] {
  const normal = stageDef(stage).difficulty === 'normal';
  const pool = (q: Quality) => HEROES.filter(h => h.quality === q && (!normal || h.unlockAfterStage <= clearedStage)).map(h => h.id);
  const specific = (q: Quality) => pick(pool(q), rng, 'reward');
  const slots = Array.from({ length: 5 }, () => normal ? specific('blue') : random(rng, 'reward') < .3 ? 'universal-purple' : specific('purple'));
  const replacementSlots = shuffle([0, 1, 2, 3, 4], rng, 'reward');
  if (normal) {
    if (random(rng, 'reward') < .2 && pool('purple').length) slots[replacementSlots[0]] = specific('purple');
    if (random(rng, 'reward') < .02 && pool('gold').length) slots[replacementSlots[1]] = specific('gold');
  } else {
    const e = weighted(RULES.rewards.hard.goldEvents.map(e => ({ value: e, weight: e.probability })), rng, 'reward');
    for (let i = 0; i < e.quantity; i++) slots[replacementSlots[i]] = e.type === 'universal_gold' ? 'universal-gold' : specific('gold');
  }
  return slots;
}
/** Only new runs have the immutable incentive snapshot. Old runs retain their original reward path. */
export function settleProgression(p: Profile, r: Run): {rewards:Reward[];receipt?:RewardReceipt} {
  const s=r.incentive,i=p.incentive,won=r.status==='victory';
  if(!s||!i){if(won)p.clearedStage=Math.max(p.clearedStage,r.stage);return {rewards:won?rollRewards(r.stage,p.clearedStage,r.rng):[]};}
  let focus=s.focusByQuality[s.primary];
  const oldClear=p.clearedStage;
  if(won&&!s.expedition)p.clearedStage=Math.max(p.clearedStage,r.stage);
  const hard=stageDef(r.stage).difficulty!=='normal',multiplier=r.stage%10===0?2:1;
  const pool=(q:Quality)=>HEROES.filter(h=>h.quality===q&&(hard||h.unlockAfterStage<=p.clearedStage));
  const token=(q:Quality)=>q==='purple'&&hard&&random(r.rng,'reward')<.3?'universal-purple':pick(pool(q).map(h=>h.id),r.rng,'reward');
  let slots=won?rollRewardSlots(r.stage,p.clearedStage,r.rng):Array.from({length:s.checkpoint===10?2:s.checkpoint===5?1:0},()=>token(hard?'purple':'blue'));
  let milestone=false;
  if(won&&s.firstClear&&!s.expedition){
    let qualities:Quality[]|undefined;
    if(r.stage===5||r.stage===15)qualities=Array(5).fill('purple');
    if(r.stage===8)qualities=Array(5).fill('gold');
    if(r.stage===10)qualities=s.route==='gold'?['gold','gold','gold','purple','purple']:Array(5).fill('purple');
    if(r.stage===20)qualities=Array(5).fill(s.route);
    if(qualities){slots=qualities.map(token);milestone=true;}
  }
  let directed=0;
  for(const q of QUALITIES){
    const unfinished=pool(q).filter(h=>p.levels[h.id]<20),requested=milestone&&r.stage===8&&q==='gold'?'RH09':s.focusByQuality[q];
    const target=unfinished.find(h=>h.id===requested)?.id||unfinished[0]?.id;if(!target)continue;
    let left=won&&(s.firstClear||q==='blue'&&s.beginner)?5:2;
    slots=slots.map(key=>{
      if(key.startsWith('universal')||heroDef(key).quality!==q)return key;
      if(left>0){left--;directed+=multiplier;return target;}
      return p.levels[key]>=20?pick(unfinished.map(h=>h.id),r.rng,'reward'):key;
    });
  }
  const rewards=combineRewards(slots,multiplier);
  // These records are adopted atomically with inventory and the settlement ledger by the session.
  if(won){
    if(s.expedition){const x=s.expedition,key=`${x.tier}:${x.contract}`;if(!i.expedition.firstWins.includes(x.tier))i.expedition.firstWins.push(x.tier);if(!i.expedition.wins.includes(key))i.expedition.wins.push(key);i.expedition.unlockedTier=Math.max(i.expedition.unlockedTier,Math.min(8,x.tier+1));i.expedition.bestTicks[key]=Math.min(i.expedition.bestTicks[key]??Infinity,r.tick);}
    else if(!i.storyClaimed.includes(r.stage))i.storyClaimed.push(r.stage);
  }
  const gained=(id:string)=>rewards.filter(x=>x.key===id||x.key==='universal-'+heroDef(id).quality).reduce((n,x)=>n+x.count,0);
  if(!gained(focus)){
    const alternatives=HEROES.filter(h=>h.unlockAfterStage<=p.clearedStage&&p.levels[h.id]<20&&gained(h.id)>0);
    const priority=(id:string)=>(progressPieces(p,id)+gained(id)>=10?100:0)+gained(id);
    alternatives.sort((a,b)=>priority(b.id)-priority(a.id)||a.id.localeCompare(b.id));
    if(alternatives.length)focus=alternatives[0].id;
  }
  const before=progressPieces(p,focus);
  const newGoals=applyRunAchievements(p,r),newHeroes=won?HEROES.filter(h=>h.unlockAfterStage>oldClear&&h.unlockAfterStage<=p.clearedStage).map(h=>h.id):[];
  const after=before+rewards.filter(x=>x.key===focus||x.key==='universal-'+heroDef(focus).quality).reduce((n,x)=>n+x.count,0);
  return {rewards,receipt:{ruleVersion:s.ruleVersion,outcome:won?'victory':'defeat',reason:won?milestone?'首通里程碑':s.firstClear?'首胜定向':'通关补给':slots.length?'阵亡保留':'本局没有碎片',cap:5*multiplier,checkpoint:s.checkpoint,focus,before,after,directed,newHeroes,newGoals,firstClear:s.firstClear,route:s.route,...(s.expedition?{expedition:s.expedition}:{})}};
}
export function upgradeCost(p: Profile, id: string): { specific: number; universal: number; available: boolean } {
  const h = heroDef(id), specific = Math.min(10, p.fragments[id] || 0), universal = 10 - specific;
  return { specific, universal, available: p.levels[id] < 20 && unlockedHeroes(p).includes(id) && (universal === 0 || h.quality !== 'blue' && (p.fragments[`universal-${h.quality}`] || 0) >= universal) };
}
export function upgradeHero(p: Profile, id: string, transactionId: string): boolean {
  if (!transactionId || p.upgradeLedger.includes(transactionId)) return false;
  const cost = upgradeCost(p, id);
  if (!cost.available) return false;
  p.fragments[id] = (p.fragments[id] || 0) - cost.specific;
  if (cost.universal) p.fragments[`universal-${heroDef(id).quality}`] -= cost.universal;
  p.levels[id]++; p.upgradeLedger.push(transactionId);
  if(p.incentive){p.incentive.goals['first-upgrade']=1;if(heroDef(id).quality==='blue')p.incentive.beginnerDone=true;}
  return true;
}
