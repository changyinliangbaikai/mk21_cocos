import { mkdirSync, writeFileSync } from 'node:fs';
import { createRun, stepBattle } from '../game/assets/scripts/domain/r1/battle';
import { chooseCard, resolveRescue } from '../game/assets/scripts/domain/r1/cards';
import { freshProfile } from '../game/assets/scripts/domain/r1/rewards';
import { Card, copy } from '../game/assets/scripts/domain/r1/model';
import { HEROES, RULES, STAGES, legacyStageTuning } from '../game/assets/scripts/domain/r1/config';

// Same seeds/formations/decisions across candidates. No player's storage is used.
const option = (key: string, fallback: string) => process.argv.find(a => a.startsWith('--' + key + '='))?.split('=')[1] || fallback;
const count = Number(option('seeds', '24'));
const stages = option('stages', '1,2,3,4,5,6,10').split(',').map(Number);
const scenario = option('scenario', 'current'), curve = option('curve', 'current');
const heroLevel = Number(option('hero-level', '1'));
const spawnBase = Number(option('spawn-base', '0')); // Optional in-memory pacing experiment.
const policies = option('policies', 'balanced,first,attributes,ranged-three').split(',');
if (!Number.isInteger(count) || count < 1 || count > 1000 || !/^[a-z0-9-]+$/.test(scenario)
  || !['legacy', 'current'].includes(curve) || !Number.isInteger(heroLevel) || heroLevel < 1 || heroLevel > 20 || !Number.isFinite(spawnBase) || spawnBase < 0 || spawnBase > 2
  || stages.some(id => !STAGES.some(s => s.id === id))
  || policies.some(p => !['balanced', 'first', 'attributes', 'ranged-three'].includes(p))) throw new Error('Invalid balance arguments');
const formation = (policy: string) => policy === 'ranged-three' ? ['RH04', 'RH02', 'RH03'] : ['RH01', 'RH02', 'RH03'];
const rank = (c: Card, policy: string) => {
  if (c.kind === 'hero') return policy === 'ranged-three' ? -1 : 100;
  if (policy === 'first') return 0;
  if (policy === 'attributes' || policy === 'ranged-three') return c.kind === 'attribute' ? 90 : c.kind === 'skill' ? 70 : 50;
  return c.kind === 'skill' ? c.skillSlot === 1 ? 90 : 80 : c.kind === 'attribute' ? 70 : 60;
};
const results: object[] = [];
const summary: object[] = [];
type EncounterMarker = { wave: number; seconds: number; kills: number; backlog: number };
for (const stage of stages) for (const policy of policies) {
  const rows: any[] = [];
  for (let i = 0; i < count; i++) {
    const seed = (42 + Math.imul(i, 2654435761)) >>> 0, p = freshProfile(); p.clearedStage = stage - 1;
    HEROES.forEach(h => { p.levels[h.id] = heroLevel; });
    const r = createRun(p, stage, seed, `balance-${stage}-${policy}-${seed}`);
    if (curve === 'legacy') r.tuning = legacyStageTuning(stage);
    if (spawnBase) r.tuning!.spawnIntervals = Array.from({ length: 15 }, (_, wave) => Number((spawnBase + Math.max(0, 3 - wave) * .05).toFixed(2)));
    const wanted = formation(policy); let opening = 0, draws = 0, peak = 0, firstEnergy: number | null = null;
    let openingHeroes: (string | null)[] = [];
    let eventCursor = 0, firstSkill: number | null = null, earlySkillCasts = 0, earlySkillTargets = 0, largestEarlySkill = 0;
    let firstDeath: EncounterMarker | null = null;
    let firstWipe: EncounterMarker | null = null, earlyCards: Card[] = [];
    for (let loop = 0; r.status === 'active' && r.tick < 60 * 1000 && loop < 150000; loop++) {
      if (r.rescue) {
        if (!firstWipe && r.slots.filter(Boolean).every(h => h!.hp <= 0)) firstWipe = {wave:r.wave,seconds:r.tick/60,kills:r.kills,backlog:r.enemies.length};
        resolveRescue(r, r.rescue === 'grandpa' || !r.freeReviveUsed);
      } else if (r.candidates.length) {
        let card: Card;
        if (r.drawQueue[0] === 'opening') {
          card = r.candidates.find(c => c.heroId === wanted[opening] && c.kind === 'hero') || r.candidates.find(c => c.kind === 'hero')!;
          opening++;
        } else card = [...r.candidates].sort((a,b) => rank(b,policy)-rank(a,policy))[0];
        if (r.drawQueue[0] === 'energy' && firstEnergy === null) firstEnergy = r.tick / 60;
        const slot = policy === 'ranged-three' ? opening : undefined;
        if (chooseCard(r, card.id, card.kind === 'hero' && r.drawQueue[0] === 'opening' ? slot : undefined)) {
          draws++; if (r.wave < 5) earlyCards.push(copy(card));
          if (opening === 3 && !openingHeroes.length) openingHeroes = r.slots.map(h => h?.id || null);
        }
      }
      // Keep the matrix about early build resilience, without automated perfect global aiming.
      stepBattle(r); peak = Math.max(peak, r.enemies.length);
      for (let j = r.events.length - 1; j >= 0 && r.events[j].seq > eventCursor; j--) {
        const e = r.events[j];
        if (e.type === 'hero-skill' && e.amount && /^RH0[12456]-S[23]$/.test(e.source)) {
          if (firstSkill === null) firstSkill = e.tick / 60;
          if (r.wave <= 5) { earlySkillCasts++; earlySkillTargets += e.amount; largestEarlySkill = Math.max(largestEarlySkill, e.amount); }
        }
      }
      eventCursor = r.eventSequence;
      if (!firstDeath && r.slots.some(h => h && h.hp <= 0)) firstDeath = {wave:r.wave,seconds:r.tick/60,kills:r.kills,backlog:r.enemies.length};
    }
    if (r.status === 'active') throw new Error('Unsettled simulation ' + r.id);
    const row = {stage,policy,seed,status:r.status,wave:r.wave,kills:r.kills,seconds:r.tick/60,draws,peak,firstEnergy,firstSkill,earlySkillCasts,earlySkillTargets,largestEarlySkill,firstDeath,firstWipe,openingHeroes,earlyCards,grandpa:r.grandpaUsed,freeRevive:r.freeReviveUsed,tuning:r.tuning};
    rows.push(row); results.push(row);
  }
  const n = rows.length, avg=(f:(r:any)=>number)=>Number((rows.reduce((v,r)=>v+f(r),0)/n).toFixed(2));
  const energyRows = rows.filter(r => r.firstEnergy !== null);
  const skillCasts = rows.reduce((sum,r)=>sum+r.earlySkillCasts,0), skillTargets = rows.reduce((sum,r)=>sum+r.earlySkillTargets,0);
  summary.push({stage,policy,runs:n,wins:rows.filter(r=>r.status==='victory').length,wipesBeforeWave5:rows.filter(r=>r.firstWipe && r.firstWipe.wave<5).length,firstDeathsBeforeWave5:rows.filter(r=>r.firstDeath&&r.firstDeath.wave<5).length,meanEndWave:avg(r=>r.wave),meanPeak:avg(r=>r.peak),earlySkillCasts:skillCasts,meanEarlySkillTargets:skillCasts?Number((skillTargets/skillCasts).toFixed(2)):0,largestEarlySkill:Math.max(...rows.map(r=>r.largestEarlySkill)),energyDrawReached:energyRows.length,meanFirstEnergySeconds:energyRows.length ? Number((energyRows.reduce((sum,r)=>sum+r.firstEnergy,0)/energyRows.length).toFixed(2)) : null});
}
const folder='artifacts/r1/curve-c029';mkdirSync(folder,{recursive:true});
writeFileSync(`${folder}/${scenario}.json`,JSON.stringify({version:RULES.version,scenario,curve,heroLevel,spawnBaseOverride:spawnBase||null,seeds:count,stages:STAGES,limitations:['synthetic policies, not measured player win rates','curve=legacy changes only numeric tuning; targeting and other combat code remain current',`all heroes remain level ${heroLevel}; later-stage levels are synthetic test accounts, not simulated campaign progression`,'opening prefers named heroes but falls back to legal candidates; full roster recorded per run','automatic rescue acceptance; no global aiming'],summary,results},null,2)+'\n');
console.table(summary);
