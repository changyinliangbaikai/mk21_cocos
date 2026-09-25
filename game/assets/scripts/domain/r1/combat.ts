import { Role, RULES, SkillDefinition, enemyDef, heroDef, skillDef } from './config';
import { Enemy, Hero, Point, Projectile, Run, Summon, aliveHeroes, deployed, distance, event, now } from './model';
import { gainEnergy } from './cards';

type Ally = Hero | Summon;
const isHero = (ally: Ally): ally is Hero => 'skills' in ally;
const activeSummons = (r: Run) => r.summons.filter(s => s.hp > 0 && s.id !== 'SUM-BURST');
const allies = (r: Run): Ally[] => [...aliveHeroes(r), ...activeSummons(r)];
const num = (e: Record<string, number | string | boolean>, key: string, fallback = 0) => typeof e[key] === 'number' ? e[key] as number : fallback;
const boss = (e: Enemy) => enemyDef(e.id).tier !== 'minion';
export const heroAttack = (r: Run, h: Hero): number => h.attack * (h.buffUntil > now(r) ? 1 + h.attackBonus : 1) * (h.weakUntil > now(r) ? .8 : 1);
export function damageAlly(r: Run, a: Ally, raw: number, source: string, weakSeconds = 0): number {
  if (a.hp <= 0 || a.id === 'SUM-BURST' || isHero(a) && a.protectionUntil > now(r)) return 0;
  const damage = Math.max(1, Math.ceil(raw - a.defense)), absorbed = isHero(a) ? Math.min(a.shield, damage) : 0;
  if (isHero(a)) a.shield -= absorbed;
  const loss = Math.min(a.hp, damage - absorbed); a.hp -= loss;
  if (isHero(a) && weakSeconds > 0) {
    a.weakUntil = Math.max(a.weakUntil, now(r) + weakSeconds);
    for (const s of r.summons.filter(s => s.owner === a.uid)) s.weakUntil = a.weakUntil;
  }
  event(r, 'ally-hit', source, a, a.uid, loss);
  if (a.hp <= 0) {
    if (isHero(a)) { a.deathTick = r.tick; a.windup = null; }
    event(r, 'ally-death', a.id, a, a.uid);
  }
  return loss;
}
function hitDamage(r: Run, e: Enemy, raw: number, role: Role | 'global'): number {
  const factor = e.trait === 'T02' && role === 'ranged' ? e.commandUntil > now(r) ? .7 : .8 : 1;
  return Math.max(1, Math.ceil((raw - e.defense) * factor));
}
export function damageEnemy(r: Run, e: Enemy, raw: number, role: Role | 'global', source: string, triggerMark = true): number {
  if (e.hp <= 0) return 0;
  const buffed = e.commandUntil > now(r);
  if (e.trait === 'T04' && !e.shieldTriggered) {
    e.shieldTriggered = true; e.shield = e.maxHp * (buffed ? .3 : .2);
    event(r, 'trait-shield', 'T04', e, e.uid);
  }
  const damage = hitDamage(r, e, raw, role), absorb = Math.min(e.shield, damage);
  e.shield -= absorb; const loss = Math.min(e.hp, damage - absorb); e.hp -= loss;
  event(r, 'enemy-hit', source, e, e.uid, loss);
  const mark = triggerMark && e.markUntil > now(r) ? e.markDamage : 0;
  if (mark) { e.markUntil = 0; e.markDamage = 0; }
  if (e.hp <= 0) {
    e.windup = null;
    if (e.trait === 'T06' && !e.residual) {
      e.residual = true; e.hp = e.maxHp * (buffed ? .3 : .2);
      event(r, 'trait-residual', 'T06', e, e.uid); return loss;
    }
    r.kills++;
    if (enemyDef(e.id).tier === 'minion') gainEnergy(r, enemyDef(e.id).energyOnFinalDeath); else r.drawQueue.push('boss');
    if (e.trait === 'T08') {
      r.explosions.push({ uid: ++r.nextUid, x: e.x, y: e.y, at: now(r) + .6, damage: e.attack * (buffed ? 1.8 : 1.5), radius: buffed ? .17 : .13 });
      event(r, 'explosion-warning', 'T08', e, e.uid, undefined, buffed ? .17 : .13);
    }
    event(r, 'enemy-death', e.id, e, e.uid);
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
function legalHeroTargets(r: Run, h: Hero, ignoreRange = false): Enemy[] {
  const residualCleanup = r.wave === 15 && r.released === 30 && !r.enemies.some(e => e.hp > 0 && !e.residual);
  return r.enemies.filter(e => e.hp > 0 && (ignoreRange || 1 - e.y <= heroDef(h.id).verticalRangeFraction + 1e-8 || residualCleanup && e.residual));
}
export function heroTargets(r: Run, h: Hero, ignoreRange = false): Enemy[] { return legalHeroTargets(r, h, ignoreRange).sort(targetOrder(r, h)); }
/** Protect the hero line, then focus bosses, then choose by the attacker's own distance. */
function targetOrder(r: Run, origin: Point): (a: Enemy, b: Enemy) => number {
  const heroes = aliveHeroes(r), priorities = new Map<number, number>();
  for (const e of r.enemies) {
    const urgent = enemyDef(e.id).attackType === 'melee' && heroes.some(h => distance(h, e) * 656 <= RULES.battle.targeting.emergencyMeleeDistancePixels);
    priorities.set(e.uid, urgent ? 0 : boss(e) ? 1 : 2);
  }
  return (a, b) => priorities.get(a.uid)! - priorities.get(b.uid)! || distance(origin, a) - distance(origin, b) || a.uid - b.uid;
}
function basicDamage(r: Run, h: Hero): number { return heroAttack(r, h) * skillDef(h.id, 1).damageAttackMultiplier[h.skills[0] - 1]; }
/** Derived from the saved windups/projectiles; no separate reservation state can become stale. */
function reservedDamage(r: Run, exceptHero?: number, projectiles: Projectile[] = r.projectiles): Map<number, number> {
  const damage = new Map<number, number>(), enemies = new Map(r.enemies.filter(e => e.hp > 0).map(e => [e.uid, e]));
  const add = (uid: number, raw: number, role: Role) => { const e = enemies.get(uid); if (e) damage.set(uid, (damage.get(uid) || 0) + hitDamage(r, e, raw, role)); };
  for (const p of projectiles) if (p.side === 'hero') add(p.target, p.damage, p.role);
  for (const h of aliveHeroes(r)) if (h.uid !== exceptHero && h.windup) {
    const legal = new Set(legalHeroTargets(r, h).map(e => e.uid));
    for (const uid of h.windup.targets) if (legal.has(uid)) add(uid, basicDamage(r, h), heroDef(h.id).role);
  }
  return damage;
}
function needsAttack(r: Run, e: Enemy, incoming: Map<number, number>): boolean {
  const untriggeredShield = e.trait === 'T04' && !e.shieldTriggered ? e.maxHp * (e.commandUntil > now(r) ? .3 : .2) : 0;
  return (incoming.get(e.uid) || 0) + 1e-8 < e.hp + e.shield + untriggeredShield;
}
function basicTargets(r: Run, h: Hero): Enemy[] {
  const incoming = reservedDamage(r, h.uid);
  return heroTargets(r, h).filter(e => needsAttack(r, e, incoming)).slice(0, h.skills[0]);
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
    if (!target && p.side === 'hero' && !p.retargeted) {
      // Do not count already-landed shots or this shot itself as future damage.
      const incoming = reservedDamage(r, undefined, kept.concat(pending.slice(i + 1)));
      target = r.enemies.filter(e => e.hp > 0 && needsAttack(r, e, incoming)).sort(targetOrder(r, p))[0];
      if (target) { p.target = target.uid; p.retargeted = true; event(r, 'projectile-retarget', p.effect, p, target.uid); }
    }
    if (!target) continue;
    if (distance(p, target) * 656 <= p.speed * dt) {
      if (p.side === 'hero') {
        if (p.radius > 0) nearby(r, target, p.radius).forEach(e => damageEnemy(r, e, p.damage, p.role, p.effect));
        else damageEnemy(r, target as Enemy, p.damage, p.role, p.effect);
      }
      else damageAlly(r, target as Ally, p.damage, p.effect, p.weakSeconds);
    } else { moveToward(p, target, p.speed * dt); kept.push(p); }
  }
  r.projectiles = kept;
}
function nearby(r: Run, point: Point, radius: number): Enemy[] { return r.enemies.filter(e => e.hp > 0 && distance(e, point) <= radius); }
function displace(r: Run, e: Enemy, center: Point, amount: number, knockback = false): void {
  const physical = amount * 800 * enemyDef(e.id).bossDisplacementFactor;
  if (knockback) e.y = Math.max(0, e.y - physical / 800); else moveToward(e, center, physical);
  if (e.windup?.kind === 'basic' && enemyDef(e.id).attackType === 'melee') e.windup = null;
}
function makeSummon(r: Run, h: Hero, target: Point, s: SkillDefinition, index: number): Summon {
  const fx = s.levelEffect[index], hp = h.maxHp * num(fx, 'hpOwnerFraction', 1);
  const summon: Summon = { uid: ++r.nextUid, id: String(fx.summon), owner: h.uid, role: heroDef(h.id).role,
    x: target.x, y: Math.min(1, target.y + (fx.summon === 'SUM-BURST' ? .04 : 0)), hp, maxHp: hp, baseHp: hp, attack: h.attack * (h.buffUntil > now(r) ? 1 + h.attackBonus : 1),
    defense: h.defense, radius: s.radiusBattleWidthFraction[index], taunt: !!fx.taunt, slow: num(fx, 'slowFraction'),
    ends: now(r) + num(fx, 'durationSeconds', 60), cooldown: num(fx, 'shotIntervalSeconds', 1),
    interval: num(fx, 'shotIntervalSeconds', num(fx, 'attackIntervalSeconds', 1)), shots: num(fx, 'extraShots', -1),
    weakUntil: h.weakUntil, idleTime: 0, fortressUntil: 0,
    attackFactor: num(fx, 'shotMultiplier', num(fx, 'extraShotMultiplier', num(fx, 'attackOwnerMultiplier', 0))) };
  for (const old of r.summons.filter(a => a.owner === h.uid)) event(r, 'summon-end', old.id, old, old.uid);
  r.summons = r.summons.filter(a => a.owner !== h.uid); r.summons.push(summon);
  event(r, 'summon', summon.id, summon, summon.uid); return summon;
}
export function castHeroSkill(r: Run, h: Hero, slot: number): boolean {
  const level = h.skills[slot - 1]; if (!level || h.hp <= 0) return false;
  const s = skillDef(h.id, slot), i = level - 1, fx = s.levelEffect[i], radius = s.radiusBattleWidthFraction[i], role = heroDef(h.id).role;
  let center: Point, victims: Enemy[] = [];
  if (h.id === 'RH03') {
    const team = aliveHeroes(r);
    if (slot === 2) {
      const targets = team.filter(a => a.hp < a.maxHp || !!fx.cleanseWeakness && a.weakUntil > now(r))
        .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.slot - b.slot);
      if (!targets.length) return false;
      center = targets[0];
      for (const a of team.filter(a => distance(center, a) <= radius).slice(0, num(fx, 'targetCap', 4))) {
        const heal = Math.min(a.maxHp - a.hp, a.maxHp * num(fx, 'healMaxHpFraction')); a.hp += heal;
        if (fx.cleanseWeakness) { a.weakUntil = 0; for (const sum of r.summons.filter(sum => sum.owner === a.uid)) sum.weakUntil = 0; }
        event(r, 'heal', s.id, a, a.uid, heal);
      }
    } else {
      center = h;
      for (const a of team) {
        const active = a.buffUntil > now(r); a.attackBonus = Math.max(active ? a.attackBonus : 0, num(fx, 'attackBonus'));
        a.cooldownFactor = Math.min(active ? a.cooldownFactor : 1, num(fx, 'skillCooldownFactor', 1));
        a.buffUntil = Math.max(a.buffUntil, now(r) + num(fx, 'durationSeconds'));
      }
    }
  } else {
    const target = heroTargets(r, h)[0]; if (!target) return false;
    center = { x: target.x, y: target.y };
    if (h.id === 'RH04' && slot === 2) {
      victims = [target];
      while (victims.length < num(fx, 'totalHits')) {
        const last = victims[victims.length - 1];
        const next = nearby(r, last, radius).filter(e => !victims.includes(e)).sort((a, b) => distance(last, a) - distance(last, b) || a.uid - b.uid)[0];
        if (!next) break; victims.push(next);
      }
    } else victims = nearby(r, center, radius);
    for (const e of victims) {
      damageEnemy(r, e, heroAttack(r, h) * s.damageAttackMultiplier[i] * (boss(e) ? 1 + num(fx, 'bossBonus') : 1), role, s.id);
      if (e.hp <= 0) continue;
      if (num(fx, 'pullDistanceDepth')) displace(r, e, center, num(fx, 'pullDistanceDepth'));
      if (num(fx, 'knockbackDepth')) displace(r, e, center, num(fx, 'knockbackDepth'), true);
      if (num(fx, 'rootSeconds')) controlEnemy(r, e, 'root', num(fx, 'rootSeconds'));
      if (num(fx, 'slowSeconds')) controlEnemy(r, e, 'slow', num(fx, 'slowSeconds'), num(fx, 'slowFraction'));
      if (num(fx, 'markOneExtraHitMultiplier')) { e.markUntil = now(r) + num(fx, 'markSeconds'); e.markDamage = heroAttack(r, h) * num(fx, 'markOneExtraHitMultiplier'); e.markRole = role; }
    }
    if (fx.summon) {
      if (h.id === 'RH06' && slot === 3) {
        let sum = r.summons.find(a => a.owner === h.uid && a.hp > 0 && a.id === 'SUM-BAG');
        if (!sum) sum = makeSummon(r, h, center, skillDef(h.id, 2), Math.max(0, h.skills[1] - 1));
        const desired = sum.baseHp * num(fx, 'summonHpMultiplier', 1);
        // Same-source fortress refreshes; repeated casts cannot compound health or attack.
        sum.hp += Math.max(0, desired - sum.maxHp); sum.maxHp = desired;
        sum.attackFactor = .6 * num(fx, 'summonAttackMultiplier', 1);
        sum.fortressUntil = now(r) + num(fx, 'durationSeconds'); sum.ends = Math.max(sum.ends, sum.fortressUntil);
        for (const a of aliveHeroes(r).filter(a => distance(a, sum!) <= radius)) a.shield = Math.max(a.shield, a.maxHp * num(fx, 'shieldNearbyHeroMaxHpFraction'));
      } else {
        makeSummon(r, h, center, s, i);
        if (num(fx, 'shieldOwnerMaxHpFraction')) h.shield = Math.max(h.shield, h.maxHp * num(fx, 'shieldOwnerMaxHpFraction'));
      }
    }
  }
  h.cooldowns[slot - 1] = s.cooldownSeconds[i];
  event(r, 'hero-skill', s.id, center!, h.uid, undefined, radius); return true;
}
export function updateHeroes(r: Run, dt: number): void {
  for (const h of aliveHeroes(r)) {
    h.basicCooldown = Math.max(0, h.basicCooldown - dt);
    for (let i = 1; i < 3; i++) h.cooldowns[i] = Math.max(0, h.cooldowns[i] - dt / (h.buffUntil > now(r) ? h.cooldownFactor : 1));
    if (h.windup) {
      h.windup.remaining -= dt;
      if (h.windup.remaining <= 1e-8) {
        const role = heroDef(h.id).role, targets = basicTargets(r, h);
        for (const target of targets) {
          const damage = basicDamage(r, h);
          if (role === 'melee') damageEnemy(r, target, damage, role, `${h.id}-S1`);
          else projectile(r, h, target.uid, 'hero', damage, role, `${h.id}-S1`);
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
    for (const slot of [2, 3]) if (h.skills[slot - 1] && h.cooldowns[slot - 1] <= 1e-8) castHeroSkill(r, h, slot);
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
    s.idleTime = 0; const target = targets[0], damage = s.attack * s.attackFactor * (s.weakUntil > now(r) ? .8 : 1);
    if (s.id === 'SUM-BAG') damageEnemy(r, target, damage, s.role, s.id);
    else projectile(r, s, target.uid, 'hero', damage, s.role, s.id, 0, s.id === 'SUM-BURST' ? s.radius : 0);
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
