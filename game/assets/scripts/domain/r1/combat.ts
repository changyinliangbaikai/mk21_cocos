import { Role, RULES, SkillDefinition, autoSkillCooldown, autoSkillRadius, basicAreaRadius, enemyDef, heroDef, skillDef } from './config';
import { Enemy, Hero, Point, Projectile, Run, Summon, aliveHeroes, deployed, distance, event, now, waveMinionQuota } from './model';
import { gainMinionEnergy } from './cards';
import { beamEnd, inBeam, inCone } from './hero-shapes';
import { CastRef, goalProgress, recordFinalKill, recordUsefulCast, specialization, startCast } from './incentives';

type Ally = Hero | Summon;
const isHero = (ally: Ally): ally is Hero => 'skills' in ally;
const activeSummons = (r: Run) => r.summons.filter(s => s.hp > 0 && s.id !== 'SUM-BURST');
const allies = (r: Run): Ally[] => [...aliveHeroes(r), ...activeSummons(r)];
const num = (e: Record<string, number | string | boolean>, key: string, fallback = 0) => typeof e[key] === 'number' ? e[key] as number : fallback;
const boss = (e: Enemy) => enemyDef(e.id).tier !== 'minion';
function buffStats(r:Run,h:Hero):{attack:number;cooldown:number;basic:number}{
  if(!r.incentive)return {attack:h.buffUntil>now(r)?h.attackBonus:0,cooldown:h.buffUntil>now(r)?h.cooldownFactor:1,basic:0};
  const live=Object.values(h.buffs||{}).filter(b=>b.until>now(r));
  return {attack:Math.max(0,...live.map(b=>b.attack)),cooldown:Math.min(1,...live.map(b=>b.cooldown)),basic:Math.max(0,...live.map(b=>b.basic))};
}
function addBuff(r:Run,h:Hero,source:string,duration:number,attack=0,cooldown=1,basic=0):void{
  if(r.incentive){const b=h.buffs||(h.buffs={});b[source]={until:now(r)+duration,attack,cooldown,basic};}
  else {const active=h.buffUntil>now(r);h.attackBonus=Math.max(active?h.attackBonus:0,attack);h.cooldownFactor=Math.min(active?h.cooldownFactor:1,cooldown);}
  h.buffUntil=Math.max(h.buffUntil,now(r)+duration);
  if(r.incentive){const stats=buffStats(r,h);h.attackBonus=stats.attack;h.cooldownFactor=stats.cooldown;}
}
export const heroAttack=(r:Run,h:Hero):number=>h.attack*(1+buffStats(r,h).attack)*(h.weakUntil>now(r)?.8:1);
export function heroSkillRadius(r:Run,h:Hero,slot:number,level=h.skills[slot-1]):number{
  const base=autoSkillRadius(r.tuning,h.id,slot,level),perk=specialization(r,h);
  return base*(slot===2?(h.id==='RH07'?(perk==='A'?1.3:perk==='B'?.75:1):h.id==='RH09'&&perk==='B'?1.15:h.id==='RH04'&&perk==='A'?.9:1):1);
}
export function heroSkillCooldown(r:Run,h:Hero,slot:number,level=h.skills[slot-1]):number{
  const base=autoSkillCooldown(r.tuning,h.id,slot,level),perk=specialization(r,h);
  return base*(slot===2?(h.id==='RH03'&&perk==='B'?.85:h.id==='RH08'&&perk==='B'||h.id==='RH09'&&perk==='A'?1.1:1):1);
}
export function damageAlly(r: Run, a: Ally, raw: number, source: string, weakSeconds = 0): number {
  if (a.hp <= 0 || a.id === 'SUM-BURST' || isHero(a) && a.protectionUntil > now(r)) return 0;
  const damage = Math.max(1, Math.ceil(raw - a.defense)), absorbed = isHero(a) ? Math.min(a.shield, damage) : 0;
  if (isHero(a)) a.shield -= absorbed;
  const loss = Math.min(a.hp, damage - absorbed); a.hp -= loss;
  if (isHero(a) && weakSeconds > 0) {
    a.weakUntil = Math.max(a.weakUntil, now(r) + weakSeconds);
    for (const s of r.summons.filter(s => s.owner === a.uid)) s.weakUntil = a.weakUntil;
  }
  if(!isHero(a)&&r.incentive)r.incentive.stats.summonDamage+=loss+absorbed;
  event(r, 'ally-hit', source, a, a.uid, loss);
  if (a.hp <= 0) {
    if (isHero(a)) { a.deathTick = r.tick; a.windup = null; a.skillWindup = null; }
    if(!isHero(a)&&a.id==='SUM-WOOD'){const owner=r.slots.find(h=>h?.uid===a.owner);if(owner&&owner.hp>0&&specialization(r,owner)==='B'){for(const e of nearby(r,a,a.radius))controlEnemy(r,e,'root',.5);event(r,'perk-root','RH05-S2',a,a.uid,.5,a.radius);}}
    event(r, 'ally-death', a.id, a, a.uid);
  }
  return loss;
}
function hitDamage(r: Run, e: Enemy, raw: number, role: Role | 'global'): number {
  const factor = e.trait === 'T02' && role === 'ranged' ? e.commandUntil > now(r) ? .7 : .8 : 1;
  return Math.max(1, Math.ceil((raw - e.defense) * factor));
}
export function damageEnemy(r: Run, e: Enemy, raw: number, role: Role | 'global', source: string, triggerMark = true, cast?:CastRef): number {
  if (e.hp <= 0) return 0;
  const buffed = e.commandUntil > now(r);
  if (e.trait === 'T04' && !e.shieldTriggered) {
    e.shieldTriggered = true; e.shield = e.maxHp * (buffed ? .3 : .2);
    event(r, 'trait-shield', 'T04', e, e.uid);
  }
  const damage = hitDamage(r, e, raw, role), absorb = Math.min(e.shield, damage);
  e.shield -= absorb; const loss = Math.min(e.hp, damage - absorb); e.hp -= loss;
  recordUsefulCast(r,cast,loss+absorb);
  event(r, 'enemy-hit', source, e, e.uid, loss);
  const mark = triggerMark && e.markUntil > now(r) ? e.markDamage : 0;
  if (mark) { e.markUntil = 0; e.markDamage = 0; }
  if (e.hp <= 0) {
    e.windup = null;
    if (e.trait === 'T06' && !e.residual) {
      e.residual = true; e.hp = e.maxHp * (buffed ? .3 : .2);
      event(r, 'trait-residual', 'T06', e, e.uid); return loss;
    }
    r.kills++; recordFinalKill(r,e,cast);
    const energy = enemyDef(e.id).tier === 'minion' ? gainMinionEnergy(r) : 0;
    if (enemyDef(e.id).tier !== 'minion') r.drawQueue.push('boss');
    if (e.trait === 'T08') {
      r.explosions.push({ uid: ++r.nextUid, x: e.x, y: e.y, at: now(r) + .6, damage: e.attack * (buffed ? 1.8 : 1.5), radius: buffed ? .17 : .13 });
      event(r, 'explosion-warning', 'T08', e, e.uid, undefined, buffed ? .17 : .13);
    }
    event(r, 'enemy-death', e.id, e, e.uid, energy);
  } else if (mark) damageEnemy(r, e, mark, e.markRole, 'corn-mark', false);
  return loss;
}
export function controlEnemy(r: Run, e: Enemy, kind: 'slow' | 'root' | 'stun', seconds: number, fraction = 0): void {
  const factor = enemyDef(e.id).bossControlDurationFactor * (e.trait === 'T03' ? e.commandUntil > now(r) ? .65 : .8 : 1);
  const until = now(r) + seconds * factor;
  if (kind === 'slow') {
    const previous = e.slowUntil > now(r) ? e.slowFraction : 0;
    e.slowUntil = Math.max(e.slowUntil, until); e.slowFraction = Math.max(previous, fraction);
  }
  if (kind === 'root') { e.rootUntil = Math.max(e.rootUntil, until); if (e.windup?.kind === 'basic' && enemyDef(e.id).attackType === 'melee') e.windup = null; }
  if (kind === 'stun') { e.stunUntil = Math.max(e.stunUntil, until); e.windup = null; }
}
function heroRange(r: Run, h: Hero, skill = false): number {
  return skill && r.tuning?.feel && heroDef(h.id).role === 'melee' ? r.tuning.feel.meleeSkillRange : heroDef(h.id).verticalRangeFraction;
}
function legalHeroTargets(r: Run, h: Hero, ignoreRange = false, skill = false): Enemy[] {
  const residualCleanup = r.wave === 15 && r.released === waveMinionQuota(r) && !r.enemies.some(e => e.hp > 0 && !e.residual);
  return r.enemies.filter(e => e.hp > 0 && (ignoreRange || 1 - e.y <= heroRange(r,h,skill) + 1e-8 || residualCleanup && e.residual));
}
export function heroTargets(r: Run, h: Hero, ignoreRange = false, skill = false): Enemy[] { return legalHeroTargets(r, h, ignoreRange, skill).sort(targetOrder(r, h)); }
function urgentEnemy(r: Run, e: Enemy): boolean {
  return enemyDef(e.id).attackType === 'melee' && aliveHeroes(r).some(h => distance(h, e) * 656 <= RULES.battle.targeting.emergencyMeleeDistancePixels);
}
/** Compare actual circular footprints. Mandatory threats stay inside the selected footprint.
 * Pair-derived candidates are bounded; scoring still includes every legal enemy. */
export function heroSkillCenter(r: Run, h: Hero, radius: number): Point | null {
  const legal = heroTargets(r, h, false, true), primary = legal[0]; if (!primary) return null;
  if (radius <= 0) return { x: primary.x, y: primary.y };
  const incoming = reservedDamage(r, h.uid);
  for (const other of aliveHeroes(r)) if (other.uid !== h.uid && other.skillWindup) {
    const cast = other.skillWindup, skill = skillDef(other.id, cast.slot), i = other.skills[cast.slot - 1] - 1;
    if (Number(other.id.slice(2)) >= 7) continue; // Shape/multi-stage reservations are not circular instant hits.
    for (const e of legalHeroTargets(r, other, false, true).filter(e => distance(e, cast.center) <= autoSkillRadius(r.tuning, other.id, cast.slot, i + 1) + 1e-8)) {
      const raw = heroAttack(r, other) * skill.damageAttackMultiplier[i] * (boss(e) ? 1 + num(skill.levelEffect[i], 'bossBonus') : 1);
      incoming.set(e.uid, (incoming.get(e.uid) || 0) + hitDamage(r, e, raw, heroDef(other.id).role));
    }
  }
  const useful = legal.filter(e => needsAttack(r, e, incoming)); if (!useful.length) return null;
  const mandatory = urgentEnemy(r, primary) || boss(primary) ? primary : null;
  const seeds = (mandatory ? [mandatory, ...useful.filter(e => e.uid !== mandatory.uid && distance(e, primary) <= radius * 2 + 1e-8)] : useful).slice(0, 24);
  const candidates: Point[] = legal.map(e => ({ x: e.x, y: e.y }));
  for (let i = 0; i < seeds.length; i++) for (let j = i + 1; j < seeds.length; j++) {
    const a = seeds[i], b = seeds[j], dx = b.x - a.x, dy = (b.y - a.y) * 800 / 656, length = Math.hypot(dx, dy);
    if (length < 1e-8 || length > radius * 2) continue;
    const height = Math.sqrt(Math.max(0, radius * radius - length * length / 4));
    for (const sign of [-1, 1]) candidates.push({ x: (a.x + b.x) / 2 + sign * -dy / length * height,
      y: (a.y + b.y) / 2 + sign * dx / length * height * 656 / 800 });
  }
  let best: Point = primary, count = -1, tie = Infinity;
  const minY = Math.min(primary.y, 1 - heroRange(r,h,true));
  for (const candidate of candidates) {
    const p = { x: Math.max(0, Math.min(1, candidate.x)), y: Math.max(minY, Math.min(1, candidate.y)) };
    if (mandatory && distance(p, mandatory) > radius + 1e-8) continue;
    const covered = useful.reduce((n, e) => n + (distance(p, e) <= radius + 1e-8 ? 1 : 0), 0), offset = distance(p, primary);
    if (covered > count || covered === count && offset < tie - 1e-8) { best = p; count = covered; tie = offset; }
  }
  return count > 0 ? { x: best.x, y: best.y } : null;
}
export function heroSkillWindupSeconds(id: string, slot: number): number {
  return id === 'RH01' ? slot === 2 ? .24 : .32 : id === 'RH02' ? slot === 2 ? .36 : .3 : Number(id.slice(2)) >= 7 ? .22 : 0;
}
/** Protect the hero line, then focus bosses, then choose by the attacker's own distance. */
function targetOrder(r: Run, origin: Point): (a: Enemy, b: Enemy) => number {
  const heroes = aliveHeroes(r), priorities = new Map<number, number>();
  for (const e of r.enemies) {
    const urgent = enemyDef(e.id).attackType === 'melee' && heroes.some(h => distance(h, e) * 656 <= RULES.battle.targeting.emergencyMeleeDistancePixels);
    priorities.set(e.uid, urgent ? 0 : boss(e) ? 1 : 2);
  }
  return (a, b) => priorities.get(a.uid)! - priorities.get(b.uid)! || distance(origin, a) - distance(origin, b) || a.uid - b.uid;
}
function basicDamage(r: Run, h: Hero): number { return heroAttack(r, h) * (1+buffStats(r,h).basic) * skillDef(h.id, 1).damageAttackMultiplier[h.skills[0] - 1]; }
/** Derived from the saved windups/projectiles; no separate reservation state can become stale. */
function reservedDamage(r: Run, exceptHero?: number, projectiles: Projectile[] = r.projectiles): Map<number, number> {
  const damage = new Map<number, number>(), enemies = new Map(r.enemies.filter(e => e.hp > 0).map(e => [e.uid, e]));
  const add = (uid: number, raw: number, role: Role) => { const e = enemies.get(uid); if (e) damage.set(uid, (damage.get(uid) || 0) + hitDamage(r, e, raw, role)); };
  for (const p of projectiles) if (p.side === 'hero') {
    const target = enemies.get(p.target);
    if (p.group && target) for (const e of enemies.values()) { if (e.y >= p.group.minY && distance(e, target) <= p.radius) add(e.uid, p.damage, p.role); }
    else add(p.target, p.damage * (p.chain && target && boss(target) ? 1 + p.chain.bossBonus : 1), p.role);
  }
  for (const h of aliveHeroes(r)) if (h.uid !== exceptHero && h.windup) {
    const legal = new Set(legalHeroTargets(r, h).map(e => e.uid));
    const radius = basicAreaRadius(r.tuning, h.id, h.skills[0]), target = enemies.get(h.windup.targets[0]);
    if (radius && target && legal.has(target.uid)) for (const e of enemies.values()) { if (legal.has(e.uid) && distance(e, target) <= radius) add(e.uid, basicDamage(r,h), heroDef(h.id).role); }
    else for (const uid of h.windup.targets) if (legal.has(uid)) add(uid, basicDamage(r, h), heroDef(h.id).role);
  }
  return damage;
}
function needsAttack(r: Run, e: Enemy, incoming: Map<number, number>): boolean {
  const untriggeredShield = e.trait === 'T04' && !e.shieldTriggered ? e.maxHp * (e.commandUntil > now(r) ? .3 : .2) : 0;
  return (incoming.get(e.uid) || 0) + 1e-8 < e.hp + e.shield + untriggeredShield;
}
function basicTargets(r: Run, h: Hero): Enemy[] {
  const incoming = reservedDamage(r, h.uid);
  return heroTargets(r, h).filter(e => needsAttack(r, e, incoming)).slice(0, r.tuning?.areaAttacks ? 1 : h.skills[0]);
}
export function enemyTarget(r: Run, e: Enemy): Ally | undefined {
  const legal = activeSummons(r), taunts = legal.filter(s => s.taunt && distance(s, e) <= s.radius)
    .sort((a, b) => distance(e, a) - distance(e, b) || a.uid - b.uid);
  if (taunts.length) return taunts[0];
  const heroes = aliveHeroes(r);
  if (enemyDef(e.id).attackType === 'ranged') return heroes.sort((a, b) => Math.abs(a.x - e.x) - Math.abs(b.x - e.x) || a.slot - b.slot)[0];
  const pool: Ally[] = e.trait === 'T09' ? heroes : [...heroes, ...legal];
  return pool.sort((a, b) => distance(e, a) - distance(e, b) || a.uid - b.uid)[0];
}
function projectile(r: Run, origin: Point, target: number, side: 'hero' | 'enemy', damage: number, role: Role, effect: string, weakSeconds = 0, radius = 0): void {
  r.projectiles.push({ uid: ++r.nextUid, x: origin.x, y: origin.y, target, side, damage, role, effect, weakSeconds, radius, speed: side === 'hero' ? 650 : 380 });
  if ('slot' in origin) r.projectiles[r.projectiles.length - 1].launch = { x: origin.x, y: origin.y };
  event(r, 'projectile', effect, origin, target);
}
function moveToward(p: Point, target: Point, pixels: number): void {
  const dx = (target.x - p.x) * 656, dy = (target.y - p.y) * 800, len = Math.hypot(dx, dy);
  if (!len) return; const ratio = Math.min(1, pixels / len); p.x += dx * ratio / 656; p.y += dy * ratio / 800;
}
export function updateProjectiles(r: Run, dt: number): void {
  const kept: Projectile[] = [], pending = r.projectiles;
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    let target: Enemy | Ally | undefined = p.side === 'hero' ? r.enemies.find(e => e.uid === p.target && e.hp > 0) : allies(r).find(a => a.uid === p.target);
    if (!target && p.chain) {
      target = r.enemies.filter(e => e.hp > 0 && !p.chain!.visited.includes(e.uid) && (!p.chain!.visited.length || distance(p, e) <= p.radius)).sort(targetOrder(r, p))[0];
      if (target) p.target = target.uid;
      else { event(r, 'skill-result', p.effect, p, undefined, p.chain.kills); continue; }
    }
    if (!target && p.side === 'hero' && !p.retargeted) {
      // Do not count already-landed shots or this shot itself as future damage.
      const incoming = reservedDamage(r, undefined, kept.concat(pending.slice(i + 1)));
      target = r.enemies.filter(e => e.hp > 0 && needsAttack(r, e, incoming)).sort(targetOrder(r, p))[0];
      if (target) { p.target = target.uid; p.retargeted = true; event(r, 'projectile-retarget', p.effect, p, target.uid); }
    }
    if (!target) continue;
    if (distance(p, target) * 656 <= p.speed * dt) {
      if (p.side === 'hero') {
        if (p.chain) {
          const before = r.kills, e = target as Enemy, from = { x: p.x, y: p.y };
          damageEnemy(r, e, p.damage * (p.chain.visited.length?(p.chainLaterFactor||1):1) * (boss(e) ? 1 + p.chain.bossBonus : 1), p.role, p.effect,true,p.cast);
          p.chain.kills += r.kills - before; p.chain.visited.push(e.uid); p.chain.remaining--;
          delete p.launch;
          p.x = e.x; p.y = e.y;
          const next = p.chain.remaining > 0 ? nearby(r, p, p.radius).filter(e => !p.chain!.visited.includes(e.uid)).sort((a,b)=>distance(p,a)-distance(p,b)||a.uid-b.uid)[0] : undefined;
          event(r, 'chain-hit', p.effect, p, e.uid, p.chain.visited.length);
          if(p.chain.last)event(r,'chain-link',p.effect,p,e.uid,undefined,undefined,p.chain.last);
          p.chain.last={x:p.x,y:p.y};
          if (next) { p.target = next.uid; p.retargeted = false; kept.push(p); }
          else event(r, 'skill-result', p.effect, from, undefined, p.chain.kills);
          continue;
        }
        const before = r.kills;
        if (p.radius > 0) nearby(r, target, p.radius).filter(e => !p.group || e.y >= p.group.minY).forEach(e => damageEnemy(r, e, p.damage, p.role, p.effect,true,p.cast));
        else damageEnemy(r, target as Enemy, p.damage, p.role, p.effect,true,p.cast);
        if (p.radius > 0) { event(r, p.group ? 'group-impact' : 'area-impact', p.effect, target, undefined, undefined, p.radius, p.launch); event(r, 'skill-result', p.effect.startsWith('RH') ? p.effect : 'RH02-S3', target, undefined, r.kills - before); }
      }
      else damageAlly(r, target as Ally, p.damage, p.effect, p.weakSeconds);
    } else { moveToward(p, target, p.speed * dt); kept.push(p); }
  }
  r.projectiles = kept;
}
function nearby(r: Run, point: Point, radius: number): Enemy[] { return r.enemies.filter(e => e.hp > 0 && distance(e, point) <= radius); }
function displace(r: Run, e: Enemy, center: Point, amount: number, knockback = false, owner?:number): void {
  const oldX=e.x,oldY=e.y;
  const physical = amount * 800 * enemyDef(e.id).bossDisplacementFactor;
  if (knockback) e.y = Math.max(0, e.y - physical / 800); else moveToward(e, center, physical);
  if (e.windup?.kind === 'basic' && enemyDef(e.id).attackType === 'melee') e.windup = null;
  if(!knockback&&owner!==undefined&&(Math.abs(e.x-oldX)+Math.abs(e.y-oldY)>1e-8))e.pulledBy={owner,until:now(r)+2};
}
function makeSummon(r: Run, h: Hero, target: Point, s: SkillDefinition, index: number, cast?:CastRef): Summon {
  const fx = s.levelEffect[index], hp = h.maxHp * num(fx, 'hpOwnerFraction', 1);
  const summon: Summon = { uid: ++r.nextUid, id: String(fx.summon), owner: h.uid, role: heroDef(h.id).role,
    x: target.x, y: Math.min(1, target.y + (fx.summon === 'SUM-BURST' ? .04 : 0)), hp, maxHp: hp, baseHp: hp, attack: h.attack * (1+buffStats(r,h).attack),
    defense: h.defense, radius: autoSkillRadius(r.tuning, h.id, s.slot, index + 1), taunt: !!fx.taunt, slow: num(fx, 'slowFraction'),
    ends: now(r) + num(fx, 'durationSeconds', 60), cooldown: num(fx, 'shotIntervalSeconds', 1),
    interval: num(fx, 'shotIntervalSeconds', num(fx, 'attackIntervalSeconds', 1)), shots: num(fx, 'extraShots', -1),
    weakUntil: h.weakUntil, idleTime: 0, fortressUntil: 0,
    attackFactor: num(fx, 'shotMultiplier', num(fx, 'extraShotMultiplier', num(fx, 'attackOwnerMultiplier', 0))) };
  summon.cast=cast;
  if (r.tuning?.areaAttacks && summon.attackFactor && summon.id !== 'SUM-BURST') summon.splashRadius = Math.max(.09, summon.radius * .65);
  const perk=specialization(r,h);
  if(h.id==='RH05'&&perk){const factor=perk==='A'?.85:.8;summon.hp*=factor;summon.maxHp*=factor;summon.baseHp*=factor;}
  if(h.id==='RH06'&&perk==='B'){summon.hp*=.85;summon.maxHp*=.85;summon.baseHp*=.85;}
  if(h.id==='RH02'&&perk==='B'){const original=summon.shots;summon.shots=Math.max(1,original-1);summon.attackFactor*=original/summon.shots;summon.radius*=1.1;summon.interval*=1.25;summon.cooldown=summon.interval;}
  for (const old of r.summons.filter(a => a.owner === h.uid)) event(r, 'summon-end', old.id, old, old.uid);
  r.summons = r.summons.filter(a => a.owner !== h.uid); r.summons.push(summon);
  event(r, 'summon', summon.id, summon, summon.uid); return summon;
}
export function castHeroSkill(r: Run, h: Hero, slot: number, lockedCenter?: Point): boolean {
  const level=h.skills[slot-1];if(!level||h.hp<=0)return false;
  if(Number(h.id.slice(2))>=7&&slot>=2)return castExpansionSkill(r,h,slot,lockedCenter);
  const s=skillDef(h.id,slot),i=level-1,fx=s.levelEffect[i],radius=heroSkillRadius(r,h,slot),role=heroDef(h.id).role,perk=specialization(r,h),killsBefore=r.kills;
  let center:Point,victims:Enemy[]=[],cast:CastRef|undefined;
  if(h.id==='RH03'){
    const team=aliveHeroes(r);
    if(slot===2){
      const targets=team.filter(a=>a.hp<a.maxHp||!!fx.cleanseWeakness&&a.weakUntil>now(r)).sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp||a.slot-b.slot);
      if(!targets.length)return false;center=targets[0];cast=startCast(r,h,slot);
      const selected=perk==='B'?[targets[0]]:team.filter(a=>distance(center,a)<=radius).slice(0,num(fx,'targetCap',4));
      for(const a of selected){
        const budget=a.maxHp*num(fx,'healMaxHpFraction')*(perk==='A'?.9:perk==='B'?1.5:1),heal=Math.min(a.maxHp-a.hp,budget);a.hp+=heal;
        if(perk==='A'){const shield=Math.min(a.maxHp*.05,budget-heal);a.shield=Math.max(a.shield,shield);if(shield>0)event(r,'hero-shield',s.id,a,a.uid,shield);}
        if(fx.cleanseWeakness){a.weakUntil=0;for(const sum of r.summons.filter(sum=>sum.owner===a.uid))sum.weakUntil=0;}
        recordUsefulCast(r,cast,heal);event(r,'heal',s.id,a,a.uid,heal);
      }
    }else{
      center=h;cast=startCast(r,h,slot);
      for(const a of team){addBuff(r,a,s.id,num(fx,'durationSeconds'),num(fx,'attackBonus'),num(fx,'skillCooldownFactor',1));recordUsefulCast(r,cast,1);event(r,'hero-buff',s.id,a,a.uid,num(fx,'durationSeconds'));}
    }
  }else{
    const target=heroTargets(r,h,false,true)[0];if(!target&&!lockedCenter)return false;
    const aim=lockedCenter||heroSkillCenter(r,h,radius);if(!aim)return false;center=aim;
    if(h.id==='RH04'&&slot===2){
      if(!target)return false;center={x:target.x,y:target.y};cast=startCast(r,h,slot);
      const original=num(fx,'totalHits'),hits=perk==='A'?Math.min(8,original+1):perk==='B'?Math.max(2,original-1):original,factor=perk==='A'?original/hits:perk==='B'?1.4:1;
      if(r.tuning?.feel){
        projectile(r,h,target.uid,'hero',heroAttack(r,h)*s.damageAttackMultiplier[i]*factor,role,s.id,0,radius);
        const p=r.projectiles[r.projectiles.length-1];p.chain={remaining:hits,visited:[],kills:0,bossBonus:num(fx,'bossBonus')};p.cast=cast;if(perk==='B')p.chainLaterFactor=.85/1.4;
        p.speed=850;h.cooldowns[slot-1]=heroSkillCooldown(r,h,slot);event(r,'hero-skill',s.id,h,h.uid,0,radius);return true;
      }
      victims=[target];while(victims.length<hits){const last=victims[victims.length-1],next=nearby(r,last,radius).filter(e=>!victims.includes(e)).sort((a,b)=>distance(last,a)-distance(last,b)||a.uid-b.uid)[0];if(!next)break;victims.push(next);}
    }else{victims=legalHeroTargets(r,h,false,true).filter(e=>distance(e,center)<=radius+1e-8);cast=startCast(r,h,slot);}
    const raw=heroAttack(r,h)*s.damageAttackMultiplier[i];
    for(const [n,e] of victims.entries()){
      let factor=1;
      if(h.id==='RH01')factor=slot===2&&perk==='A'?.9:slot===3&&perk==='B'?(victims.length<=2?1.25:.9):1;
      if(h.id==='RH02'&&slot===2&&perk==='A')factor=.6;
      if(h.id==='RH04'&&slot===2){const count=num(fx,'totalHits');factor=perk==='A'?count/Math.min(8,count+1):perk==='B'?(n===0?1.4:.85):1;}
      damageEnemy(r,e,raw*factor*(boss(e)?1+num(fx,'bossBonus'):1),role,s.id,true,cast);if(e.hp<=0)continue;
      if(num(fx,'pullDistanceDepth'))displace(r,e,center,num(fx,'pullDistanceDepth')*(h.id==='RH01'&&slot===2&&perk==='A'?1.35:1),false,h.uid);
      if(h.id==='RH05'&&slot===2&&perk==='A')displace(r,e,center,.04,false,h.uid);
      if(num(fx,'knockbackDepth'))displace(r,e,center,num(fx,'knockbackDepth'),true);
      if(num(fx,'rootSeconds'))controlEnemy(r,e,'root',num(fx,'rootSeconds'));
      if(num(fx,'slowSeconds'))controlEnemy(r,e,'slow',num(fx,'slowSeconds'),num(fx,'slowFraction'));
      if(num(fx,'markOneExtraHitMultiplier')){e.markUntil=now(r)+num(fx,'markSeconds');e.markDamage=heroAttack(r,h)*num(fx,'markOneExtraHitMultiplier');e.markRole=role;}
    }
    if(h.id==='RH02'&&slot===2&&perk==='A')(r.skillBursts||(r.skillBursts=[])).push({owner:h.uid,source:s.id,at:now(r)+.28,damage:raw*.4,radius,level,index:1,kind:'pulse',x:center.x,y:center.y,cast,echo:true});
    if(fx.summon){
      if(h.id==='RH06'&&slot===3){
        let sum=r.summons.find(a=>a.owner===h.uid&&a.hp>0&&a.id==='SUM-BAG');if(!sum)sum=makeSummon(r,h,center,skillDef(h.id,2),Math.max(0,h.skills[1]-1),cast);
        const desired=sum.baseHp*num(fx,'summonHpMultiplier',1);sum.hp+=Math.max(0,desired-sum.maxHp);sum.maxHp=desired;sum.attackFactor=.6*num(fx,'summonAttackMultiplier',1);
        sum.fortressUntil=now(r)+num(fx,'durationSeconds');sum.ends=Math.max(sum.ends,sum.fortressUntil);
        for(const a of aliveHeroes(r).filter(a=>distance(a,sum!)<=radius))a.shield=Math.max(a.shield,a.maxHp*num(fx,'shieldNearbyHeroMaxHpFraction'));
      }else{
        makeSummon(r,h,center,s,i,cast);if(num(fx,'shieldOwnerMaxHpFraction'))h.shield=Math.max(h.shield,h.maxHp*num(fx,'shieldOwnerMaxHpFraction'));
        if(h.id==='RH06'&&slot===2&&perk==='A')for(const a of aliveHeroes(r)){a.shield=Math.max(a.shield,a.maxHp*.05);event(r,'hero-shield',s.id,a,a.uid,a.maxHp*.05);}
      }
    }
  }
  h.cooldowns[slot-1]=heroSkillCooldown(r,h,slot);event(r,'hero-skill',s.id,center!,h.uid,victims.length,radius);
  if(h.id!=='RH03')event(r,'skill-result',s.id,center!,h.uid,r.kills-killsBefore,radius);return true;
}
export function updateHeroes(r: Run, dt: number): void {
  for (const h of aliveHeroes(r)) {
    h.basicCooldown = Math.max(0, h.basicCooldown - dt);
    for (let i = 1; i < 3; i++) h.cooldowns[i] = Math.max(0, h.cooldowns[i] - dt / buffStats(r,h).cooldown);
    if (h.windup) {
      h.windup.remaining -= dt;
      if (h.windup.remaining <= 1e-8) {
        const role = heroDef(h.id).role, targets = basicTargets(r, h);
        for (const target of targets) {
          const damage = basicDamage(r, h), radius = basicAreaRadius(r.tuning,h.id,h.skills[0]), source = `${h.id}-S1`;
          if (role === 'melee') {
            if (radius) {
              const center = { x: target.x, y: target.y }, victims = legalHeroTargets(r,h).filter(e => distance(e,center) <= radius), before = r.kills;
              victims.forEach(e => damageEnemy(r,e,damage,role,source));
              event(r,'group-impact',source,center,h.uid,victims.length,radius,h);
              event(r,'skill-result',source,center,h.uid,r.kills-before,radius);
            } else damageEnemy(r, target, damage, role, source);
          } else {
            projectile(r, h, target.uid, 'hero', damage, role, source,0,radius);
            if(radius)r.projectiles[r.projectiles.length-1].group={minY:Math.max(0,1-heroRange(r,h))};
          }
        }
        if (targets.length) event(r, 'hero-attack', `${h.id}-S1`, h);
        else h.basicCooldown = 0;
        h.windup = null;
      }
    }
    if (h.basicCooldown <= 1e-8 && !h.windup) {
      const targets = basicTargets(r, h);
      if (targets.length) {
        h.basicCooldown = heroDef(h.id).attackIntervalSeconds;
        h.windup = { remaining: Math.min(.25, h.basicCooldown * .2), targets: targets.map(e => e.uid) };
      }
    }
    if (h.skillWindup) {
      h.skillWindup.remaining = Math.max(0, h.skillWindup.remaining - dt);
      if (h.skillWindup.remaining <= 1e-8) {
        const cast = h.skillWindup; h.skillWindup = null; castHeroSkill(r, h, cast.slot, cast.center);
      }
    } else for (const slot of [2, 3]) if (h.skills[slot - 1] && h.cooldowns[slot - 1] <= 1e-8) {
      if(h.id==='RH08'&&slot===2){const fx=skillDef(h.id,2).levelEffect[h.skills[1]-1];if(!heroTargets(r,h,false,true).some(e=>distance(h,e)<=num(fx,'depth')*800/656))continue;}
      const duration = heroSkillWindupSeconds(h.id, slot);
      if (duration) {
        const radius = heroSkillRadius(r,h,slot), center = heroSkillCenter(r, h, radius);
        if (!center) continue;
        h.skillWindup = { remaining: duration, slot, center };
        event(r, 'hero-skill-windup', `${h.id}-S${slot}`, center, h.uid, duration, radius); break;
      }
      castHeroSkill(r, h, slot);
    }
  }
}
export function updateSummons(r: Run, dt: number): void {
  for (const s of r.summons) {
    if (s.hp <= 0) continue;
    if (s.ends <= now(r)) { event(r, 'summon-end', s.id, s, s.uid); continue; }
    if (s.fortressUntil && s.fortressUntil <= now(r)) {
      s.fortressUntil = 0; s.maxHp = s.baseHp; s.hp = Math.min(s.hp, s.maxHp); s.attackFactor = .6;
    }
    if (s.slow) for (const e of nearby(r, s, s.radius)) controlEnemy(r, e, 'slow', .3, s.slow);
    if (!s.attackFactor) continue;
    s.cooldown = Math.max(0, s.cooldown - dt); if (s.cooldown > 1e-8) continue;
    const legal = r.enemies.filter(e => e.hp > 0 && (s.id !== 'SUM-BAG' || distance(e, s) <= .15)), incoming = reservedDamage(r);
    const targets = legal.filter(e => needsAttack(r, e, incoming)).sort(targetOrder(r, s));
    if (!targets.length) {
      s.idleTime = legal.length ? 0 : s.idleTime + dt;
      if (s.id === 'SUM-BURST' && s.idleTime >= 2) { s.hp = 0; event(r, 'summon-end', s.id, s, s.uid); }
      continue;
    }
    const owner=r.slots.find(h=>h?.uid===s.owner),perk=owner?specialization(r,owner):undefined;
    s.idleTime = 0; const target = targets[0], damage = s.attack * s.attackFactor * (s.weakUntil > now(r) ? .8 : 1)*(s.id==='SUM-BAG'&&perk==='A'?.8:1);
    if (s.id === 'SUM-BAG') {
      const victims=s.splashRadius?nearby(r,target,s.splashRadius):[target];
      for(const victim of victims){damageEnemy(r,victim,damage,s.role,s.id,true,s.cast?{...s.cast,aoe:!!s.splashRadius}:undefined);if(victim.hp>0&&perk==='B'&&!boss(victim)&&enemyDef(victim.id).attackType==='melee'&&(victim.pushUntil||0)<=now(r)){displace(r,victim,s,.02,true);victim.pushUntil=now(r)+1.2;event(r,'perk-push','RH06-S2',victim,victim.uid);}}
      if(s.splashRadius)event(r,'group-impact',s.id,target,s.uid,victims.length,s.splashRadius);
    }
    else {projectile(r,s,target.uid,'hero',damage,s.role,s.id,0,s.id==='SUM-BURST'?s.radius:s.splashRadius||0);const p=r.projectiles[r.projectiles.length-1];p.cast=s.cast?{...s.cast,aoe:!!p.radius}:undefined;if(s.splashRadius)p.group={minY:0};}
    event(r, 'summon-attack', s.id, s, s.uid); s.cooldown = s.interval;
    if (s.shots > 0 && --s.shots === 0) { s.hp = 0; event(r, 'summon-spent', s.id, s, s.uid); }
  }
  r.summons = r.summons.filter(s => s.hp > 0 && s.ends > now(r));
}
function inAttackRange(e: Enemy, a: Ally): boolean {
  return enemyDef(e.id).attackType === 'ranged' ? e.y >= .5 - 1e-8 : distance(e, a) * 656 <= 40 + 1e-8;
}
function resolveEnemyCast(r: Run, e: Enemy): void {
  const cast = e.windup!; e.windup = null;
  if (cast.kind === 'command') {
    for (const m of r.enemies.filter(m => m.hp > 0 && enemyDef(m.id).tier === 'minion')) m.commandUntil = Math.max(m.commandUntil, now(r) + 5);
    event(r, 'boss-command', e.id, e); return;
  }
  if (cast.kind === 'skill') {
    const def = RULES.bossAbilities[e.id as 'RS01' | 'RS02' | 'RL01' | 'RL02'];
    if ('projectiles' in def) {
      for (const uid of cast.targets) if (allies(r).some(a => a.uid === uid)) projectile(r, e, uid, 'enemy', e.attack * def.damagePerProjectileMultiplier, 'ranged', `${e.id}-skill`);
    } else {
      if (e.id === 'RS01') { e.x = cast.center.x; e.y = Math.max(0, cast.center.y - .05); }
      for (const a of allies(r).filter(a => distance(a, cast.center) <= def.radiusBattleWidthFraction)) damageAlly(r, a, e.attack * def.damageMultiplier, `${e.id}-skill`);
    }
    event(r, 'boss-skill', e.id, cast.center); return;
  }
  const a = allies(r).find(a => a.uid === cast.targets[0]); if (!a || !inAttackRange(e, a)) return;
  if (enemyDef(e.id).attackType === 'ranged') projectile(r, e, a.uid, 'enemy', e.attack, 'ranged', e.id, e.trait === 'T07' ? e.commandUntil > now(r) ? 6 : 4 : 0);
  else damageAlly(r, a, e.attack, e.id);
  event(r, 'enemy-attack', e.id, e, a.uid);
}
export function updateEnemies(r: Run, dt: number): void {
  for (const e of r.enemies) {
    if (e.hp <= 0 || e.residual) continue;
    e.cooldown = Math.max(0, e.cooldown - dt); e.skillCooldown = Math.max(0, e.skillCooldown - dt); e.commandCooldown = Math.max(0, e.commandCooldown - dt);
    if (e.stunUntil > now(r)) { e.windup = null; continue; }
    if (e.windup) { e.windup.remaining -= dt; if (e.windup.remaining <= 1e-8) resolveEnemyCast(r, e); continue; }
    const target = enemyTarget(r, e); if (!target) continue;
    const d = enemyDef(e.id);
    if (d.tier === 'boss' && e.commandCooldown <= 1e-8) {
      e.commandCooldown = 12; e.windup = { kind: 'command', remaining: 1, targets: [], center: { x: e.x, y: e.y } };
      event(r, 'command-warning', e.id, e); continue;
    }
    if (d.tier !== 'minion' && e.skillCooldown <= 1e-8) {
      const def = RULES.bossAbilities[e.id as 'RS01' | 'RS02' | 'RL01' | 'RL02'];
      e.skillCooldown = def.cooldownSeconds;
      e.windup = { kind: 'skill', remaining: def.telegraphSeconds, targets: e.id === 'RS02' ? aliveHeroes(r).sort((a, b) => distance(e, a) - distance(e, b) || a.slot - b.slot).slice(0, 3).map(a => a.uid) : [target.uid], center: { x: target.x, y: target.y } };
      event(r, 'boss-warning', e.id, target, undefined, undefined, 'radiusBattleWidthFraction' in def ? def.radiusBattleWidthFraction : .1); continue;
    }
    if (inAttackRange(e, target)) {
      if (e.cooldown <= 1e-8) {
        e.cooldown = d.attackIntervalSeconds; e.windup = { kind: 'basic', remaining: Math.min(.25, d.attackIntervalSeconds * .2), targets: [target.uid], center: { x: target.x, y: target.y } };
      }
    } else if (e.rootUntil <= now(r)) {
      const buffed = e.commandUntil > now(r);
      let speed = d.baseMoveDesignPixelsPerSecond;
      if (e.trait === 'T01') speed *= buffed ? 1.35 : 1.2;
      if (e.trait === 'T05' && e.hp / e.maxHp < .2) speed *= buffed ? 1.65 : 1.5;
      if (buffed && (!e.trait || e.trait === 'T09')) speed *= 1.15;
      if (e.slowUntil > now(r)) speed *= 1 - e.slowFraction;
      if (d.attackType === 'ranged') e.y = Math.min(.5, e.y + speed * dt / 800);
      else {
        const remaining = Math.max(0, distance(e, target) * 656 - 40);
        moveToward(e, target, Math.min(remaining, speed * dt));
      }
    }
  }
}
export function updateExplosions(r: Run): void {
  for (const ex of r.explosions.filter(ex => ex.at <= now(r))) {
    for (const a of allies(r).filter(a => distance(a, ex) <= ex.radius)) damageAlly(r, a, ex.damage, 'T08');
    event(r, 'explosion', 'T08', ex, undefined, undefined, ex.radius);
  }
  r.explosions = r.explosions.filter(ex => ex.at > now(r));
}

function expansionControl(r: Run, e: Enemy, center: Point, fx: Record<string, number | string | boolean>, index: number, owner?:number): void {
  if(e.hp<=0)return;
  if(num(fx,'pullDistanceDepth'))displace(r,e,center,num(fx,'pullDistanceDepth'),false,owner);
  const root=num(fx,'rootSeconds')+(index===0?num(fx,'firstRootSeconds'):0);
  if(root)controlEnemy(r,e,'root',root);
  if(num(fx,'slowSeconds'))controlEnemy(r,e,'slow',num(fx,'slowSeconds'),num(fx,'slowFraction'));
}
/** New kits lock their real shape/strike positions and snapshot damage before scheduling. */
function castExpansionSkill(r: Run, h: Hero, slot: number, lockedCenter?: Point): boolean {
  const level=h.skills[slot-1],s=skillDef(h.id,slot),fx=s.levelEffect[level-1],role=heroDef(h.id).role,perk=specialization(r,h);
  const legal=heroTargets(r,h,false,true).filter(e=>h.id!=='RH08'||slot!==2||distance(h,e)<=num(fx,'depth')*800/656),primary=legal[0];if(!primary)return false;
  const radius=heroSkillRadius(r,h,slot),center=lockedCenter||heroSkillCenter(r,h,radius)||primary;
  const raw=heroAttack(r,h)*s.damageAttackMultiplier[level-1]*(slot===2?(h.id==='RH07'?(perk==='A'?.82:perk==='B'?1.25:1):h.id==='RH09'&&perk==='B'?.85:1):1);
  const cast=startCast(r,h,slot);
  if(slot===2&&(h.id==='RH07'||h.id==='RH08')){
    const halfAngle=perk==='A'?num(fx,'halfAngle')+8:perk==='B'?Math.max(15,num(fx,'halfAngle')-8):num(fx,'halfAngle');
    const mandatory=urgentEnemy(r,primary)||boss(primary)?primary:null;
    const covers=(aim:Point,e:Enemy)=>h.id==='RH07'?inBeam(e,h,beamEnd(h,aim),radius):inCone(e,h,aim,num(fx,'depth')*800/656,halfAngle);
    const candidates=legal.filter(aim=>!mandatory||covers(aim,mandatory));
    const aim=candidates.sort((a,b)=>legal.filter(e=>covers(b,e)).length-legal.filter(e=>covers(a,e)).length||distance(primary,a)-distance(primary,b)||a.uid-b.uid)[0]||primary;
    const victims=legal.filter(e=>covers(aim,e)),before=r.kills;
    if(h.id==='RH07'&&victims.filter(e=>e.slowUntil>now(r)||e.rootUntil>now(r)||e.stunUntil>now(r)).length>=4&&r.incentive)goalProgress(r,'frost-beam',(r.incentive.stats.goals['frost-beam']||0)+1);
    for(const e of victims){
      const slowed=e.slowUntil>now(r);damageEnemy(r,e,raw,role,s.id,true,cast);
      if(h.id==='RH08'){
        const altered:Record<string,number|string|boolean>={...fx,slowFraction:perk==='A'?Math.max(.2,num(fx,'slowFraction')-.1):num(fx,'slowFraction')};
        if(perk==='B'&&slowed)altered.rootSeconds=num(fx,'rootSeconds')+.3;
        expansionControl(r,e,aim,altered,0,h.uid);
      }else expansionControl(r,e,aim,fx,0,h.uid);
    }
    event(r,h.id==='RH07'?'beam-hit':'frost-cone',s.id,h.id==='RH07'?beamEnd(h,aim):aim,h.uid,halfAngle,h.id==='RH07'?radius:num(fx,'depth')*800/656,h);
    event(r,'skill-result',s.id,aim,h.uid,r.kills-before,radius);
  }else{
    const queue=r.skillBursts||(r.skillBursts=[]),count=num(fx,'pulses',1);
    for(let index=0;index<count;index++){
      const a=index*2*Math.PI/count,spread=fx.scatter?radius*.65:0;
      const p={x:Math.max(0,Math.min(1,center.x+Math.cos(a)*spread)),y:Math.max(0,Math.min(1,center.y+Math.sin(a)*spread*656/800))};
      const delay=h.id==='RH09'&&slot===2&&perk==='A'?0:index*num(fx,'pulseInterval');
      queue.push({owner:h.uid,source:s.id,at:now(r)+delay,damage:raw,radius,level,index,kind:fx.rocket?'rocket':'pulse',...p,cast,...(fx.rocket?{target:legal[index%legal.length].uid}:{})});
      if(fx.scatter)event(r,'skill-warning',s.id,p,h.uid,delay+.15,radius);
    }
    if(h.id==='RH10'){
      let refunded=false;
      for(const ally of aliveHeroes(r)){
        if(slot===2){
          const old=ally.shield;ally.shield=Math.max(ally.shield,ally.maxHp*num(fx,'teamShieldFraction')*(perk==='A'?.8:1));
          if(perk==='A'&&ally.shield>old)addBuff(r,ally,'RH10-perk-A',3,0,1,.08);
          if(fx.cleanseWeakness){ally.weakUntil=0;for(const sum of r.summons.filter(s=>s.owner===ally.uid))sum.weakUntil=0;}
          recordUsefulCast(r,cast,ally.shield-old);event(r,'hero-shield',s.id,ally,ally.uid,ally.shield);
        }else{
          if(perk!=='B'){addBuff(r,ally,s.id,num(fx,'durationSeconds'),num(fx,'attackBonus'));recordUsefulCast(r,cast,1);}
          if(ally.uid!==h.uid){for(const n of [1,2]){const old=ally.cooldowns[n];ally.cooldowns[n]=Math.max(0,old-Math.min(3,num(fx,'teamCooldownRefund')+(perk==='B'?.8:0)));if(old>ally.cooldowns[n])refunded=true;recordUsefulCast(r,cast,old-ally.cooldowns[n]);}}
          event(r,'hero-buff',s.id,ally,ally.uid,num(fx,'durationSeconds'));
        }
      }
      if(refunded&&r.incentive){r.incentive.relays=r.incentive.relays.filter(x=>x.until>=now(r)).slice(-7);r.incentive.relays.push({owner:h.uid,until:now(r)+1.5,casters:[]});}
    }
  }
  h.cooldowns[slot-1]=heroSkillCooldown(r,h,slot);event(r,'hero-skill',s.id,center,h.uid,0,radius);return true;
}
export function updateSkillBursts(r: Run): void {
  if(!r.skillBursts?.length)return;
  const waiting:NonNullable<Run['skillBursts']>=[];
  for(const burst of r.skillBursts){
    const h=aliveHeroes(r).find(h=>h.uid===burst.owner);if(!h)continue;
    if(burst.at>now(r)+1e-8){waiting.push(burst);continue;}
    const role=heroDef(h.id).role;
    if(burst.kind==='rocket'){
      const target=r.enemies.find(e=>e.uid===burst.target&&e.hp>0)||heroTargets(r,h,false,true)[0];
      if(target){projectile(r,h,target.uid,'hero',burst.damage,role,burst.source,0,burst.radius);r.projectiles[r.projectiles.length-1].speed=760;r.projectiles[r.projectiles.length-1].cast=burst.cast;}
    }else{
      const before=r.kills,fx=skillDef(h.id,Number(burst.source.slice(-1))).levelEffect[burst.level-1];
      const victims=legalHeroTargets(r,h,false,true).filter(e=>distance(e,burst)<=burst.radius);
      for(const e of victims){damageEnemy(r,e,burst.damage*(burst.echo&&boss(e)?1+num(fx,'bossBonus'):1),role,burst.source,!burst.echo,burst.cast);if(!burst.echo)expansionControl(r,e,burst,fx,burst.index,h.uid);}
      event(r,'skill-pulse',burst.source,burst,h.uid,burst.index,burst.radius);
      event(r,'skill-result',burst.source,burst,h.uid,r.kills-before,burst.radius);
    }
  }
  r.skillBursts=waiting;
}
