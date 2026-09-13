/** Deterministic battle domain. All distances/seconds/balance values come from v0.5 JSON. */
export interface HeroInstance {
  id: number; type: string; star: number; slot: string;
  nextAttackTick: number; releasedCount: number;
  windupEventId?: number; streakTargetId?: number; streakCount?: number;
}
export interface StatusEffect { source: string; value: number; endTick: number; }
export interface CornMark {
  sourceKind: 'auto' | 'K001'; sourceId: number; explosive: boolean;
  levelMultiplier: number; cards: Record<string, number>;
  damage: number; radius: number; endTick: number;
}
export interface Enemy {
  id: number; type: string; lane: number; x: number; y: number; hp: number; maxHp: number;
  ledgerId: string; budgetShare: number; spawnedTick: number;
  terminal?: 'killed' | 'leaked' | 'cleared';
  slows: StatusEffect[]; vulnerabilities: StatusEffect[]; hastes: StatusEffect[];
  hard?: { startTick: number; endTick: number }; immuneUntil: number;
  knockbacks: { tick: number; distance: number }[]; lastKnockbackTick: number;
  mark?: CornMark; bossNextWindup?: number; bossWindupUntil?: number;
}
export interface SpawnEntry { wave: number; index: number; type: string; lane: number; tick: number; ledgerId: string; }
export interface RewardEntry { id: string; wave: number; budget: number; claimed: number; voided: number; resolved: boolean; }
export interface BattleState {
  seed: number; tick: number; wave: number; waveTick: number; waveStartTick: number;
  nextId: number; heroes: HeroInstance[]; snapshots: Record<string, any>; cards: Record<string, number>;
  enemies: Enemy[]; events: any[]; queue: SpawnEntry[]; spawnIndex: number; ledger: RewardEntry[];
  baseHp: number; energy: number; calm: boolean; protectionUntil: number;
  result: 'running' | 'failed' | 'complete';
  stats: { spawned: number; killed: number; leaked: number; cleared: number; damage: number;
    energyGained: number; peakEnemies: number; peakEvents: number;
    leaks: any[]; damageLog: any[]; effects: any[]; };
}
export interface StepResult { energyGained: number; leaks: number; complete: boolean; failed: boolean; }

export function xorshift32(seed: number): number {
  let x = seed >>> 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0;
}
export function generateWave(config: any, seed: number, wave: number): SpawnEntry[] {
  const def = config.waves.find((v: any) => v.wave === wave);
  if (!def) throw new Error('Unknown wave ' + wave);
  const g = config.spawn_generator;
  const waveSeed = ((seed ^ Math.imul(wave, g.wave_seed_multiply)) >>> 0) || g.zero_seed_fallback;
  let rng = waveSeed;
  const normal: string[] = [];
  Object.keys(def.counts).sort().forEach(type => {
    if (config.monsters.find((m: any) => m.id === type).control_class !== 'boss') {
      for (let i = 0; i < def.counts[type]; i++) normal.push(type);
    }
  });
  for (let i = normal.length - 1; i > 0; i--) {
    rng = xorshift32(rng); const j = rng % (i + 1);
    const temp = normal[i]; normal[i] = normal[j]; normal[j] = temp;
  }
  const window = Math.floor(def.target_combat_seconds * g.normal_spawn_window_fraction * config.clock.tick_hz + 0.5);
  const rows: any[] = normal.map((type, i) => ({ type, lane: (i + waveSeed % config.world.lane_centers_x.length) % config.world.lane_centers_x.length + 1,
    tick: normal.length === 1 ? 0 : Math.floor(i * window / (normal.length - 1) + 0.5), order: i, boss: 0 }));
  Object.keys(def.counts).sort().forEach(type => {
    if (config.monsters.find((m: any) => m.id === type).control_class === 'boss') {
      for (let i = 0; i < def.counts[type]; i++) rows.push({ type, lane: g.boss_lane,
        tick: Math.floor(window * g.boss_spawn_window_fraction + 0.5), order: i, boss: 1 });
    }
  });
  rows.sort((a, b) => a.tick - b.tick || a.boss - b.boss || a.order - b.order);
  return rows.map((row, index) => ({ wave, index: index + 1, type: row.type, lane: row.lane,
    tick: row.tick, ledgerId: wave + ':' + (index + 1) }));
}

export class Battle {
  state: BattleState;
  config: any;
  private pending: any[] = [];
  constructor(config: any, options: any = {}) {
    this.config = config;
    if (options.state) { this.state = options.state; return; }
    this.state = {
      seed: (options.seed >>> 0) || config.spawn_generator.zero_seed_fallback,
      tick: options.tick || 0, wave: options.wave || 1, waveTick: 0, waveStartTick: options.tick || 0,
      nextId: Math.max(0, ...(options.heroes || []).map((h: any) => h.id)) + 1,
      heroes: options.heroes || [], snapshots: options.snapshots || {}, cards: options.cards || {},
      enemies: [], events: [], queue: [], spawnIndex: 0, ledger: [],
      baseHp: options.baseHp === undefined ? config.run.base_max_hp : options.baseHp,
      energy: options.energy === undefined ? config.run.starting_energy : options.energy,
      calm: !!options.calm, protectionUntil: options.protectionUntil || 0, result: 'running',
      stats: { spawned: 0, killed: 0, leaked: 0, cleared: 0, damage: 0, energyGained: 0,
        peakEnemies: 0, peakEvents: 0, leaks: [], damageLog: [], effects: [] },
    };
    this.beginWave(this.state.wave, this.state.calm);
  }
  seconds(value: number): number { return Math.ceil(value * this.config.clock.tick_hz); }
  allocateId(): number { return this.state.nextId++; }
  private heroDef(type: string): any { return this.config.heroes.find((h: any) => h.id === type); }
  private monsterDef(type: string): any { return this.config.monsters.find((m: any) => m.id === type); }
  private card(id: string): any { return this.config.cards.find((c: any) => c.id === id).effects; }
  private count(id: string, cards = this.state.cards): number { return cards[id] || 0; }
  private level(type: string): number {
    const snapshot = this.state.snapshots[type];
    return this.config.progression.damage_multipliers_by_level[(snapshot ? snapshot.level : 1) - 1];
  }
  private live(): Enemy[] { return this.state.enemies.filter(e => !e.terminal); }
  private enemy(id: number): Enemy | undefined { return this.state.enemies.find(e => e.id === id && !e.terminal); }
  private pad(hero: HeroInstance): any { return this.config.world.pads.find((p: any) => p.id === hero.slot); }
  private distance(a: any, b: any): number { return Math.hypot(a.x - b.x, a.y - b.y); }
  private classIndex(enemy: Enemy): number { return this.config.control.classes.indexOf(this.monsterDef(enemy.type).control_class); }
  private elite(enemy: Enemy): boolean { return this.monsterDef(enemy.type).control_class !== 'normal'; }
  private effect(kind: string, data: any): void {
    this.state.stats.effects.push({ tick: this.state.tick, kind, ...data });
    if (this.state.stats.effects.length > 100) this.state.stats.effects.shift();
  }
  private event(kind: string, tick: number, data: any): number {
    const id = this.allocateId(); this.state.events.push({ id, kind, tick, ...data }); return id;
  }
  beginWave(wave: number, calm = false): void {
    const s = this.state; s.wave = wave; s.waveStartTick = s.tick; s.waveTick = 0;
    s.calm = calm; s.enemies = []; s.events = []; s.spawnIndex = 0; s.result = 'running';
    s.queue = generateWave(this.config, s.seed, wave);
    s.queue.forEach(row => {
      if (!s.ledger.some(entry => entry.id === row.ledgerId)) s.ledger.push({ id: row.ledgerId, wave,
        budget: this.monsterDef(row.type).reward_energy, claimed: 0, voided: 0, resolved: false });
    });
    s.heroes.forEach(h => { delete h.windupEventId; });
    this.pending = [];
  }
  prepareWave(wave: number, calm = false): void { this.beginWave(wave, calm); }
  remainingBudget(): number {
    return this.state.ledger.filter(e => e.wave === this.state.wave).reduce((sum, e) => sum + Math.max(0, e.budget - e.claimed - e.voided), 0);
  }
  clearWave(grantRemaining: boolean): number {
    const remaining = this.remainingBudget();
    this.state.ledger.filter(e => e.wave === this.state.wave && !e.resolved).forEach(e => {
      const rest = Math.max(0, e.budget - e.claimed - e.voided);
      if (grantRemaining && !this.state.calm) e.claimed += rest; else e.voided += rest;
      e.resolved = true;
    });
    if (grantRemaining && !this.state.calm) { this.state.energy += remaining; this.state.stats.energyGained += remaining; }
    this.live().forEach(e => { e.terminal = 'cleared'; this.state.stats.cleared++; });
    this.state.spawnIndex = this.state.queue.length; this.finish();
    return remaining;
  }
  private finish(): void {
    this.state.result = 'complete'; this.state.events = []; this.pending = [];
    this.state.heroes.forEach(h => { delete h.windupEventId; });
  }
  moveHero(id: number, slot: string): boolean {
    const hero = this.state.heroes.find(h => h.id === id);
    if (!hero || ![...this.config.world.pads.map((p: any) => p.id), ...this.config.world.reserve_ids].includes(slot)) return false;
    if (hero.windupEventId !== undefined) this.state.events = this.state.events.filter(e => e.id !== hero.windupEventId);
    delete hero.windupEventId; hero.slot = slot; return true;
  }
  range(hero: HeroInstance, cards = this.state.cards): number {
    return this.heroDef(hero.type).range_units * (1 + this.count('C011', cards) * this.card('C011').all_hero_search_range_add_per_pick
      + (hero.type === 'H002' ? this.count('C003', cards) * this.card('C003').H002_search_and_ray_range_add_per_pick : 0));
  }
  private sortedTargets(list: Enemy[], heroType: string): Enemy[] {
    return list.sort((a, b) => (heroType === 'H004' ? Number(this.elite(b)) - Number(this.elite(a)) : 0) || b.y - a.y || a.id - b.id);
  }
  targetFor(hero: HeroInstance): Enemy | undefined {
    const pad = this.pad(hero); if (!pad) return undefined;
    return this.sortedTargets(this.live().filter(e => this.distance(pad, e) <= this.range(hero)), hero.type)[0];
  }
  /** Exposed for deterministic scenario tests and inspector; normal spawns use the same path. */
  spawn(type: string, lane: number, y = this.config.world.spawn_y, ledgerId?: string, share?: number): Enemy {
    const def = this.monsterDef(type), wave = this.config.waves.find((w: any) => w.wave === this.state.wave);
    const id = this.allocateId(), key = ledgerId || ('debug:' + id);
    if (!this.state.ledger.some(e => e.id === key)) this.state.ledger.push({ id: key, wave: this.state.wave,
      budget: share === undefined ? def.reward_energy : share, claimed: 0, voided: 0, resolved: false });
    // Mini Boss stages have explicit HP in their immutable run config. Ordinary
    // monsters and older snapshots retain the existing base/multiplier formula.
    const hp = def.hp_by_wave?.[wave.wave] ?? def.hp_base * (def.uses_wave_hp_multiplier ? wave.hp_multiplier : 1);
    const enemy: Enemy = { id, type, lane, x: this.config.world.lane_centers_x[lane - 1], y, hp, maxHp: hp,
      ledgerId: key, budgetShare: share === undefined ? def.reward_energy : share, spawnedTick: this.state.tick,
      slows: [], vulnerabilities: [], hastes: [], immuneUntil: 0, knockbacks: [], lastKnockbackTick: -Number.MAX_SAFE_INTEGER };
    if (def.pulse) enemy.bossNextWindup = this.state.tick + this.seconds(def.pulse.first_windup_seconds);
    this.state.enemies.push(enemy); this.state.stats.spawned++; return enemy;
  }
  private account(enemy: Enemy, killed: boolean): void {
    const entry = this.state.ledger.find(e => e.id === enemy.ledgerId)!;
    const amount = Math.min(enemy.budgetShare, Math.max(0, entry.budget - entry.claimed - entry.voided));
    if (killed && !this.state.calm) { entry.claimed += amount; this.state.energy += amount; this.state.stats.energyGained += amount; }
    else entry.voided += amount;
    entry.resolved = entry.claimed + entry.voided >= entry.budget;
  }
  private expire(): void {
    const tick = this.state.tick;
    this.live().forEach(e => {
      e.slows = e.slows.filter(s => s.endTick > tick); e.vulnerabilities = e.vulnerabilities.filter(s => s.endTick > tick);
      e.hastes = e.hastes.filter(s => s.endTick > tick);
      e.knockbacks = e.knockbacks.filter(k => k.tick > tick - this.seconds(this.config.control.knockback_window_seconds));
      if (e.mark && e.mark.endTick <= tick) delete e.mark;
      if (e.hard && e.hard.endTick <= tick) {
        e.immuneUntil = tick + this.seconds(this.config.control.hard_control_immunity_after_seconds[this.classIndex(e)]);
        delete e.hard;
      }
    });
  }
  private addStatus(list: StatusEffect[], source: string, value: number, duration: number): void {
    const endTick = this.state.tick + this.seconds(duration), existing = list.find(s => s.source === source);
    if (existing) { existing.endTick = Math.max(existing.endTick, endTick); existing.value = Math.max(existing.value, value); }
    else list.push({ source, value, endTick });
  }
  slow(enemy: Enemy, source: string, strength: number, duration: number): void {
    if (enemy.terminal) return;
    this.addStatus(enemy.slows, source, strength * this.config.control.slow_and_hard_duration_multipliers[this.classIndex(enemy)], duration);
  }
  hardControl(enemy: Enemy, duration: number): boolean {
    if (enemy.terminal || enemy.immuneUntil > this.state.tick) return false;
    const i = this.classIndex(enemy), tick = this.state.tick;
    const end = tick + this.seconds(duration * this.config.control.slow_and_hard_duration_multipliers[i]);
    const start = enemy.hard ? enemy.hard.startTick : tick;
    const cap = start + this.seconds(this.config.control.hard_control_continuous_cap_seconds[i]);
    enemy.hard = { startTick: start, endTick: Math.min(cap, Math.max(enemy.hard ? enemy.hard.endTick : tick, end)) };
    delete enemy.bossWindupUntil; return true;
  }
  knockback(enemy: Enemy, rawDistance: number, source = 'knockback', cards = this.state.cards): number {
    if (enemy.terminal || rawDistance <= 0) return 0;
    const c = this.config.control, i = this.classIndex(enemy), tick = this.state.tick;
    if (tick - enemy.lastKnockbackTick < this.seconds(c.knockback_min_interval_seconds[i])) return 0;
    enemy.knockbacks = enemy.knockbacks.filter(k => k.tick > tick - this.seconds(c.knockback_window_seconds));
    const budget = c.knockback_window_distance_caps[i] - enemy.knockbacks.reduce((sum, k) => sum + k.distance, 0);
    const distance = Math.max(0, Math.min(rawDistance * c.knockback_multipliers[i], c.knockback_per_event_caps[i], budget, enemy.y - this.config.world.spawn_y));
    if (distance === 0) return 0;
    const oldY = enemy.y; enemy.y -= distance; enemy.lastKnockbackTick = tick; enemy.knockbacks.push({ tick, distance });
    if (this.count('C009', cards)) {
      const collision = this.card('C009');
      this.live().filter(other => other.id !== enemy.id && other.lane === enemy.lane &&
        other.y >= enemy.y - collision.collision_radius && other.y <= oldY + collision.collision_radius)
        .sort((a, b) => Math.abs(oldY - a.y) - Math.abs(oldY - b.y) || a.id - b.id)
        .slice(0, collision.max_collision_victims_per_knockback).forEach(other => this.pending.push({ kind: 'hit',
          enemyId: other.id, damage: collision.collision_damage_by_pick[this.count('C009', cards) - 1], damageType: collision.damage_type, source: 'C009:' + source }));
    }
    this.effect('knockback', { enemyId: enemy.id, fromY: oldY, toY: enemy.y }); return distance;
  }
  private cornMark(sourceKind: 'auto' | 'K001', sourceId: number, level: number, cards: Record<string, number>, explosive: boolean): CornMark {
    const attack = this.heroDef('H001').attack;
    return { sourceKind, sourceId, explosive, levelMultiplier: level, cards: { ...cards },
      damage: attack.mark_explosion_damage_lv1_star3 * level * (1 + this.count('C002', cards) * this.card('C002').H001_mark_damage_add_per_pick +
        (sourceKind === 'auto' ? this.count('C012', cards) * this.card('C012').all_hero_auto_damage_add_per_pick : 0)),
      radius: attack.mark_explosion_radius * (1 + this.count('C001', cards) * this.card('C001').H001_auto_and_mark_radius_add_per_pick),
      endTick: this.state.tick + this.seconds(attack.mark_duration_seconds) };
  }
  mark(enemy: Enemy, incoming: CornMark): void {
    if (enemy.terminal) return;
    const old = enemy.mark;
    if (!old) { enemy.mark = { ...incoming, cards: { ...incoming.cards } }; return; }
    const stronger = Number(incoming.explosive) > Number(old.explosive) || (incoming.explosive === old.explosive &&
      (incoming.damage > old.damage || (incoming.damage === old.damage && incoming.sourceId < old.sourceId)));
    enemy.mark = { ...(stronger ? incoming : old), endTick: Math.max(old.endTick, incoming.endTick) };
  }
  private autoDamage(type: string, star: number, level: number, cards: Record<string, number>, enemy?: Enemy): number {
    let addition = this.count('C012', cards) * this.card('C012').all_hero_auto_damage_add_per_pick;
    if (type === 'H001') addition += this.count('C002', cards) * this.card('C002').H001_direct_auto_damage_add_per_pick;
    if (type === 'H003') addition += this.count('C005', cards) * this.card('C005').H003_auto_damage_add_per_pick;
    if (type === 'H004' && enemy && this.elite(enemy)) addition += this.eliteBonus(cards);
    const def = this.heroDef(type); return def.damage_lv1_star1 * def.star_multipliers[star - 1] * level * (1 + addition);
  }
  private eliteBonus(cards: Record<string, number>): number {
    return this.count('C007', cards) * this.card('C007').H004_auto_and_K004_elite_damage_add +
      this.count('C008', cards) * this.card('C008').H004_auto_and_K004_elite_damage_add_per_pick;
  }
  private startAttacks(): void {
    this.state.heroes.slice().sort((a, b) => a.id - b.id).forEach(hero => {
      if (hero.streakTargetId && !this.enemy(hero.streakTargetId)) { hero.streakCount = 0; delete hero.streakTargetId; }
      if (hero.nextAttackTick > this.state.tick || hero.windupEventId !== undefined) return;
      const target = this.targetFor(hero); if (!target) return;
      const def = this.heroDef(hero.type), cards = this.state.cards;
      const interval = def.interval_seconds * (1 + (hero.type === 'H001' ? this.count('C001') * this.card('C001').H001_interval_add_per_pick : 0)) *
        Math.pow(this.card('C010').all_hero_auto_interval_multiplier_per_pick, this.count('C010'));
      hero.nextAttackTick = this.state.tick + this.seconds(interval);
      const windup = Math.min(def.windup_seconds, interval * this.card('C010').windup_max_fraction_of_interval);
      hero.windupEventId = this.event('release', this.state.tick + this.seconds(windup), { heroId: hero.id, enemyId: target.id });
    });
  }
  private release(event: any): void {
    const hero = this.state.heroes.find(h => h.id === event.heroId);
    if (!hero || hero.windupEventId !== event.id) return;
    delete hero.windupEventId;
    const target = this.enemy(event.enemyId), origin = this.pad(hero);
    if (!target || !origin) return;
    hero.releasedCount++;
    const def = this.heroDef(hero.type), a = def.attack, cards = { ...this.state.cards }, level = this.level(hero.type);
    const damage = this.autoDamage(hero.type, hero.star, level, cards);
    const base = { heroId: hero.id, heroType: hero.type, star: hero.star, level, cards,
      origin: { x: origin.x, y: origin.y }, damage, damageType: def.damage_type, source: hero.type };
    this.effect('attack', { heroId: hero.id, enemyId: target.id, x: target.x, y: target.y });
    if (hero.type === 'H001') {
      const flight = Math.max(a.min_flight_ticks, this.seconds(this.distance(origin, target) / a.speed_units_per_second));
      this.event('corn', this.state.tick + flight, { ...base, x: target.x, y: target.y, releasedTick: this.state.tick });
    } else if (hero.type === 'H002') {
      const range = this.range(hero, cards), length = this.distance(origin, target);
      const dx = (target.x - origin.x) / length, dy = (target.y - origin.y) / length;
      const heavy = hero.star >= a.heavy_from_star && hero.releasedCount % a.heavy_every_released_attacks === 0;
      const victims = this.live().filter(e => e.lane === target.lane).map(e => {
        const along = (e.x - origin.x) * dx + (e.y - origin.y) * dy;
        const nearest = Math.max(0, Math.min(range, along));
        return { enemy: e, along, distance: Math.hypot(e.x - origin.x - nearest * dx, e.y - origin.y - nearest * dy) };
      }).filter(v => v.distance <= a.half_width).sort((x, y) => x.along - y.along || x.enemy.id - y.enemy.id)
        .slice(0, heavy ? a.heavy_max_targets : a.max_targets_by_star[hero.star - 1]);
      const knockback = (heavy ? a.heavy_knockback : a.knockback_by_star[hero.star - 1]) *
        (1 + this.count('C004', cards) * this.card('C004').H002_auto_and_K002_knockback_add_per_pick);
      victims.forEach(v => this.pending.push({ kind: 'hit', ...base, enemyId: v.enemy.id, knockback }));
    } else if (hero.type === 'H003') {
      const radius = a.radius * (1 + this.count('C005', cards) * this.card('C005').H003_auto_radius_add_per_pick);
      this.live().filter(e => this.distance(target, e) <= radius).forEach(e => this.pending.push({ kind: 'hit', ...base, enemyId: e.id,
        slow: { strength: a.slow_strength, duration: a.slow_duration_seconds * (1 + this.count('C006', cards) * this.card('C006').H003_auto_and_K003_slow_duration_add_per_pick) },
        vulnerability: hero.star >= a.vulnerability_from_star ? { strength: a.vulnerability_strength, duration: a.vulnerability_duration_seconds } : undefined,
        hard: hero.star >= a.hard_control_from_star && hero.releasedCount % a.hard_control_every_released_attacks === 0 ? a.hard_control_duration_seconds : undefined }));
      this.effect('sound', { x: target.x, y: target.y, radius });
    } else if (hero.type === 'H004') {
      if (this.elite(target)) {
        hero.streakCount = hero.streakTargetId === target.id ? (hero.streakCount || 0) + 1 : 1; hero.streakTargetId = target.id;
      } else { hero.streakCount = 0; delete hero.streakTargetId; }
      const pursuit = hero.star >= a.pursuit_from_star && (hero.streakCount || 0) >= a.pursuit_every_same_elite_target_releases;
      if (pursuit) hero.streakCount = 0;
      this.event('slipper', this.state.tick + Math.max(a.min_flight_ticks, this.seconds(this.distance(origin, target) / a.speed_units_per_second)),
        { ...base, enemyId: target.id, pursuit, retargets: 0, releasedTick: this.state.tick,
          from: { x: origin.x, y: origin.y }, to: { x: target.x, y: target.y }, range: this.range(hero, cards) });
    }
  }
  private retargetProjectiles(): void {
    this.state.events.filter(e => e.kind === 'slipper' && !this.enemy(e.enemyId)).forEach(event => {
      this.retargetProjectile(event);
    });
  }
  private retargetProjectile(event: any): boolean {
    if (!this.count('C007', event.cards) || event.retargets >= this.heroDef('H004').attack.max_retargets_per_projectile_with_card) return false;
    const t = Math.min(1, Math.max(0, (this.state.tick - event.releasedTick) / Math.max(1, event.tick - event.releasedTick)));
    const position = { x: event.from.x + (event.to.x - event.from.x) * t, y: event.from.y + (event.to.y - event.from.y) * t };
    const target = this.sortedTargets(this.live().filter(e => this.distance(event.origin, e) <= event.range), 'H004')[0];
    if (!target) return false;
    event.enemyId = target.id; event.retargets++; event.from = position; event.to = { x: target.x, y: target.y };
    event.releasedTick = this.state.tick;
    event.tick = this.state.tick + Math.max(this.heroDef('H004').attack.min_flight_ticks,
      this.seconds(this.distance(position, target) / this.heroDef('H004').attack.speed_units_per_second));
    this.effect('retarget', { enemyId: target.id, x: position.x, y: position.y }); return true;
  }
  invokeSkill(id: string, target: any = {}): boolean {
    const skill = this.config.skills.find((s: any) => s.id === id); if (!skill || this.state.result !== 'running') return false;
    if (skill.target === 'area' && (!Number.isFinite(target.x) || !Number.isFinite(target.y) || target.x < 0 || target.y < 0 ||
      target.x > this.config.world.field_size[0] || target.y > this.config.world.field_size[1])) return false;
    if (skill.target === 'lane' && !this.config.world.lane_centers_x[target.lane - 1]) return false;
    if (skill.target === 'enemy' && !this.enemy(target.enemyId)) return false;
    const castId = this.allocateId(), enemy = this.enemy(target.enemyId);
    const data = { skillId: id, castId, cards: { ...this.state.cards }, level: skill.hero ? this.level(skill.hero) : 1,
      target: { ...target }, lastPosition: enemy ? { x: enemy.x, y: enemy.y } : undefined };
    skill.pulse_offsets_seconds.forEach((offset: number, pulse: number) => this.event('skill', this.state.tick + this.seconds(offset), { ...data, pulse }));
    this.effect('skillCast', { skillId: id, ...target }); return true;
  }
  private skillPulse(event: any): void {
    const skill = this.config.skills.find((s: any) => s.id === event.skillId), cards = event.cards;
    let radius = skill.radius;
    if (skill.id === 'P003') radius = this.card('C015').radius_by_pick[Math.max(0, this.count('C015', cards) - 1)];
    let victims: Enemy[];
    if (skill.target === 'area') victims = this.live().filter(e => this.distance(e, event.target) <= radius);
    else if (skill.target === 'lane') victims = this.live().filter(e => e.lane === event.target.lane);
    else if (skill.target === 'global_confirm') victims = this.live();
    else {
      let enemy = this.enemy(event.target.enemyId);
      const old = this.state.enemies.find(e => e.id === event.target.enemyId);
      if (old) event.lastPosition = { x: old.x, y: old.y };
      if (!enemy && event.lastPosition) enemy = this.live().sort((a, b) => this.distance(a, event.lastPosition) - this.distance(b, event.lastPosition) || a.id - b.id)[0];
      victims = enemy ? [enemy] : [];
      if (!enemy) {
        this.state.events = this.state.events.filter(e => e.kind !== 'skill' || e.castId !== event.castId);
      }
      this.state.events.filter(e => e.kind === 'skill' && e.castId === event.castId).forEach(e => {
        e.target = { enemyId: enemy ? enemy.id : event.target.enemyId };
        e.lastPosition = enemy ? { x: enemy.x, y: enemy.y } : event.lastPosition;
      });
    }
    victims.forEach(enemy => {
      let damage = skill.damage_per_pulse * event.level;
      if (skill.id === 'K004' && this.elite(enemy)) damage *= 1 + this.eliteBonus(cards);
      if (skill.id === 'P001') damage *= 1 + this.card('C013').damage_add_by_pick[Math.max(0, this.count('C013', cards) - 1)];
      let knockback = skill.knockback;
      if (skill.id === 'K002') knockback *= 1 + this.count('C004', cards) * this.card('C004').H002_auto_and_K002_knockback_add_per_pick;
      this.pending.push({ kind: 'hit', enemyId: enemy.id, damage, damageType: skill.damage_type, source: skill.id, cards, knockback,
        trackedSkill: skill.id === 'K004' ? event : undefined,
        mark: skill.id === 'K001' ? this.cornMark('K001', event.castId, event.level, cards, true) : undefined,
        slow: skill.slow_strength ? { strength: skill.slow_strength, duration: skill.slow_duration_seconds *
          (1 + this.count('C006', cards) * this.card('C006').H003_auto_and_K003_slow_duration_add_per_pick) } : undefined,
        hard: skill.hard_control_seconds });
    });
    this.effect('skillPulse', { skillId: skill.id, ...event.target, radius });
  }
  private processEvent(event: any): void {
    if (event.kind === 'release') this.release(event);
    if (event.kind === 'skill') this.skillPulse(event);
    if (event.kind === 'corn') {
      const a = this.heroDef('H001').attack, radius = a.explosion_radius_by_star[event.star - 1] *
        (1 + this.count('C001', event.cards) * this.card('C001').H001_auto_and_mark_radius_add_per_pick);
      this.live().filter(e => this.distance(e, event) <= radius).forEach(enemy => this.pending.push({ kind: 'hit', ...event, enemyId: enemy.id,
        mark: event.star >= a.mark_from_star ? this.cornMark('auto', event.heroId, event.level, event.cards, event.star >= a.explosive_mark_from_star) : undefined }));
      this.effect('explosion', { x: event.x, y: event.y, radius });
    }
    if (event.kind === 'slipper' || event.kind === 'followup') {
      this.pending.push({ kind: 'slipperImpact', projectile: event });
    }
  }
  private resolveSlipper(event: any): any {
    const enemy = this.enemy(event.enemyId);
    if (!enemy) {
      // A hit earlier in this very FIFO damage queue can kill the target too.
      if (event.kind === 'slipper' && this.retargetProjectile(event)) this.state.events.push(event);
      return undefined;
    }
    const a = this.heroDef('H004').attack;
    const damage = this.autoDamage('H004', event.star, event.level, event.cards, enemy) * (event.fraction === undefined ? 1 : event.fraction);
    if (event.kind === 'slipper') {
      const { id, kind, tick, ...snapshot } = event;
      if (event.star >= a.return_from_star) this.event('followup', this.state.tick + this.seconds(a.return_delay_seconds),
        { ...snapshot, fraction: a.return_damage_fraction, followup: 'return' });
      if (event.pursuit) this.event('followup', this.state.tick + this.seconds(a.pursuit_delay_seconds),
        { ...snapshot, fraction: a.pursuit_damage_fraction, followup: 'pursuit' });
    }
    return { kind: 'hit', enemyId: enemy.id, damage, damageType: this.heroDef('H004').damage_type,
      source: event.kind === 'followup' ? 'H004-' + event.followup : 'H004', cards: event.cards };
  }
  /** Queued hit uses the same death/control path as gameplay. Call flushDamage in scenario tests. */
  damage(enemyId: number, damage: number, damageType = 'energy', options: any = {}): void {
    this.pending.push({ kind: 'hit', enemyId, damage, damageType, source: 'test', ...options });
  }
  flushDamage(): void {
    while (this.pending.length) {
      let event = this.pending.shift();
      if (event.kind === 'death') { this.death(event); continue; }
      if (event.kind === 'slipperImpact') { event = this.resolveSlipper(event.projectile); if (!event) continue; }
      let enemy = this.enemy(event.enemyId);
      if (!enemy && event.trackedSkill) {
        const tracked = event.trackedSkill, old = this.state.enemies.find(e => e.id === event.enemyId);
        const position = old || tracked.lastPosition;
        enemy = position ? this.live().sort((a, b) => this.distance(a, position) - this.distance(b, position) || a.id - b.id)[0] : undefined;
        if (enemy) {
          event.enemyId = enemy.id;
          event.damage = this.config.skills.find((s: any) => s.id === 'K004').damage_per_pulse * tracked.level *
            (1 + (this.elite(enemy) ? this.eliteBonus(tracked.cards) : 0));
          this.state.events.filter(e => e.kind === 'skill' && e.castId === tracked.castId).forEach(e => {
            e.target = { enemyId: enemy!.id }; e.lastPosition = { x: enemy!.x, y: enemy!.y };
          });
        } else this.state.events = this.state.events.filter(e => e.kind !== 'skill' || e.castId !== tracked.castId);
      }
      if (!enemy) continue;
      if (event.slow) this.slow(enemy, event.source, event.slow.strength, event.slow.duration);
      if (event.vulnerability) this.addStatus(enemy.vulnerabilities, event.source, event.vulnerability.strength, event.vulnerability.duration);
      if (event.hard) this.hardControl(enemy, event.hard);
      if (event.mark) this.mark(enemy, event.mark);
      const vulnerability = Math.min(this.config.control.vulnerability_cap, Math.max(0, ...enemy.vulnerabilities.map(v => v.value)));
      const armor = event.damageType === 'physical' ? 1 - this.monsterDef(enemy.type).physical_reduction : 1;
      const precision = Math.pow(10, this.config.clock.damage_decimal_places);
      const damage = Math.floor(Math.max(0, event.damage) * (1 + vulnerability) * armor * precision + 0.5 + Number.EPSILON) / precision;
      enemy.hp -= damage; this.state.stats.damage += damage;
      this.state.stats.damageLog.push({ tick: this.state.tick, enemyId: enemy.id, source: event.source, damage, chainId: event.chainId, depth: event.depth });
      if (this.state.stats.damageLog.length > 250) this.state.stats.damageLog.shift();
      if (enemy.hp <= 0) {
        enemy.terminal = 'killed'; this.state.stats.killed++;
        this.pending.push({ kind: 'death', enemy, chainId: event.chainId, depth: event.depth });
      } else if (event.knockback) this.knockback(enemy, event.knockback, event.source, event.cards || this.state.cards);
    }
  }
  private death(event: any): void {
    const enemy: Enemy = event.enemy, def = this.monsterDef(enemy.type), mark = enemy.mark;
    if (def.split) {
      def.split.child_upstream_offsets.slice(0, def.split.count).forEach((offset: number) => {
        const y = Math.max(this.config.world.spawn_y, Math.min(this.config.world.base_y - Number.EPSILON, enemy.y - offset));
        this.spawn(def.split.child_id, enemy.lane, y, enemy.ledgerId, def.split.reward_budget_shared / def.split.count);
      });
    } else this.account(enemy, true);
    const maxDepth = this.heroDef('H001').attack.mark_max_chain_depth;
    if (mark && mark.explosive && (event.depth === undefined || event.depth < maxDepth)) {
      const depth = event.depth === undefined ? 1 : event.depth + 1;
      const chainId = event.chainId === undefined ? this.allocateId() : event.chainId;
      this.live().filter(target => this.distance(enemy, target) <= mark.radius).forEach(target => this.pending.push({ kind: 'hit', enemyId: target.id,
        damage: mark.damage, damageType: 'energy', source: mark.sourceKind + '-mark', chainId, depth,
        mark: depth < maxDepth ? { ...mark, cards: { ...mark.cards }, endTick: this.state.tick + this.seconds(this.heroDef('H001').attack.mark_duration_seconds) } : undefined }));
      this.effect('chain', { x: enemy.x, y: enemy.y, radius: mark.radius, depth, chainId });
    }
  }
  private moveMonsters(): void {
    const live = this.live(), tick = this.state.tick;
    live.forEach(enemy => {
      const pulse = this.monsterDef(enemy.type).pulse; if (!pulse) return;
      if (enemy.bossNextWindup !== undefined && tick >= enemy.bossNextWindup) {
        enemy.bossNextWindup += this.seconds(pulse.period_seconds);
        if (!enemy.hard) enemy.bossWindupUntil = tick + this.seconds(pulse.windup_seconds);
      }
      if (enemy.bossWindupUntil !== undefined && tick >= enemy.bossWindupUntil) {
        delete enemy.bossWindupUntil;
        if (!enemy.hard) live.filter(other => (pulse.includes_self || other.id !== enemy.id) && this.distance(enemy, other) <= pulse.radius)
          .forEach(other => this.addStatus(other.hastes, 'boss:' + enemy.id, pulse.haste, pulse.duration_seconds));
      }
    });
    const speeds = live.map(enemy => {
      if (enemy.hard) return 0;
      const def = this.monsterDef(enemy.type), i = this.classIndex(enemy);
      let haste = Math.max(0, ...enemy.hastes.map(s => s.value));
      live.forEach(other => {
        const aura = this.monsterDef(other.type).aura;
        if (aura && (!aura.disabled_during_hard_control || !other.hard) && (aura.includes_self || other.id !== enemy.id) && this.distance(enemy, other) <= aura.radius) haste = Math.max(haste, aura.haste);
      });
      const slow = Math.max(0, ...enemy.slows.map(s => s.value));
      return def.speed_units_per_second * Math.max(this.config.control.min_speed_fraction_of_base[i], (1 + haste) * (1 - slow));
    });
    live.forEach((enemy, index) => {
      enemy.y += speeds[index] / this.config.clock.tick_hz;
      if (enemy.y >= this.config.world.base_y) {
        enemy.terminal = 'leaked'; this.account(enemy, false); this.state.stats.leaked++;
        if (this.state.protectionUntil <= tick) this.state.baseHp = Math.max(0, this.state.baseHp - this.monsterDef(enemy.type).leak_damage);
        this.state.stats.leaks.push({ tick, wave: this.state.wave, type: enemy.type, lane: enemy.lane, enemyId: enemy.id });
      }
    });
  }
  step(): StepResult {
    const s = this.state, beforeEnergy = s.energy, beforeLeaks = s.stats.leaked;
    if (s.result !== 'running') return { energyGained: 0, leaks: 0, complete: s.result === 'complete', failed: s.result === 'failed' };
    s.waveTick = s.tick - s.waveStartTick; this.expire();
    while (s.spawnIndex < s.queue.length && s.queue[s.spawnIndex].tick <= s.waveTick) {
      const row = s.queue[s.spawnIndex++]; this.spawn(row.type, row.lane, this.config.world.spawn_y, row.ledgerId);
    }
    this.retargetProjectiles(); this.startAttacks();
    while (true) {
      s.events.sort((a, b) => a.tick - b.tick || a.id - b.id);
      if (!s.events.length || s.events[0].tick > s.tick) break;
      this.processEvent(s.events.shift());
    }
    this.flushDamage(); this.moveMonsters();
    s.stats.peakEnemies = Math.max(s.stats.peakEnemies, this.live().length);
    s.stats.peakEvents = Math.max(s.stats.peakEvents, s.events.length);
    if (s.baseHp <= 0) s.result = 'failed';
    else if (s.spawnIndex >= s.queue.length && !this.live().length) this.finish();
    s.tick++; s.waveTick = s.tick - s.waveStartTick;
    return { energyGained: s.energy - beforeEnergy, leaks: s.stats.leaked - beforeLeaks,
      complete: (s as BattleState).result === 'complete', failed: s.result === 'failed' };
  }
}
