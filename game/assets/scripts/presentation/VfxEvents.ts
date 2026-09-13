import { battleReserveScreen, battleScreenToWorld } from './BattleProjection';
/** Presentation-only projection of committed state. No commands, damage, rewards or RNG writes. */
export interface VfxPoint { x: number; y: number }
export interface VfxIntent {
  key: string; recipe: string; clock: 'battle' | 'ui'; tick: number; point: VfxPoint; priority: number;
  from?: VfxPoint; to?: VfxPoint; endTick?: number; radius?: number; duration?: number; emitters?: string[];
  textures?: string[]; positions?: VfxPoint[]; lane?: number; persistent?: boolean; tint?: string; delay?: number;
  replacements?: Record<string, string>;
  stage?: 'launch' | 'impact' | 'cast' | 'death' | 'income';
  family?: string; amount?: number; flash?: boolean; bodyTexture?: string; bodySize?: number;
}
export interface VfxSnapshot {
  runId: string; wave: number; tick: number; tickHz: number; screen: string; phase: string; overlay: string | null;
  config: any; heroes: any[]; enemies: any[]; effects: any[]; damage: any[]; events: any[]; skills: string[];
  grandpa: boolean; second: boolean; ad: any; protectionUntil: number; earned: number; calm: boolean; cleared: number;
  baseHp: number; baseMaxHp: number;
  flash: boolean;
}
export interface VfxFrame { snapshot: VfxSnapshot; bursts: VfxIntent[]; persistent: VfxIntent[]; clearBattle: boolean }
const point = (value: any): VfxPoint => ({ x: Number(value?.x) || 0, y: Number(value?.y) || 0 });
export function captureVfxState(data: any): VfxSnapshot {
  const r = data?.run, b = r?.battle, config = r?.config;
  return { runId: r?.id || '', wave: b?.wave || 0, tick: b?.tick || 0, tickHz: config?.clock?.tick_hz || 60,
    screen: data?.screen || 'camp', phase: r?.phase || '', overlay: data?.overlay || null, config,
    heroes: (b?.heroes || []).map((h: any) => ({ ...h })),
    enemies: (b?.enemies || []).map((e: any) => ({ id: e.id, type: e.type, x: e.x, y: e.y, hp: e.hp,
      terminal: e.terminal, hardEnd: e.hard?.endTick || 0, hardStart: e.hard?.startTick || 0,
      markEnd: e.mark?.endTick || 0, immuneUntil: e.immuneUntil, bossWindupUntil: e.bossWindupUntil,
      slowEnd: Math.max(0, ...e.slows.map((v: any) => v.endTick)),
      vulnerableEnd: Math.max(0, ...e.vulnerabilities.map((v: any) => v.endTick)),
      hastes: e.hastes.map((v: any) => ({ ...v })) })),
    effects: (b?.stats?.effects || []).map((e: any) => ({ ...e })), damage: (b?.stats?.damageLog || []).map((e: any) => ({ ...e })),
    events: (b?.events || []).map((e: any) => ({ ...e, from: e.from && point(e.from), to: e.to && point(e.to),
      origin: e.origin && point(e.origin), target: e.target && { ...e.target } })), skills: Object.keys(r?.skills || {}),
    grandpa: !!r?.grandpaUsed, second: !!r?.secondUsed, ad: r?.ad && { ...r.ad }, protectionUntil: b?.protectionUntil || 0,
    earned: b?.stats?.energyGained || 0, calm: !!b?.calm, cleared: b?.stats?.cleared || 0,
    baseHp: b?.baseHp || 0, baseMaxHp: config?.run?.base_max_hp || 20, flash: data?.profile?.settings?.shake !== false };
}
export function visualAssetId(id: string): string { return id === 'B002' ? 'B001' : id; }
export function advanceFeedbackTick(visualTick: number, authoritativeTick: number, realDt: number, hz: number, scale: number): number {
  if (!Number.isFinite(realDt) || realDt < 0 || scale <= 0) return visualTick;
  return Math.min(authoritativeTick + .999, Math.max(authoritativeTick, visualTick) + realDt * hz * scale);
}
export function hitFeedback(age: number, strength = 1, flash = true): { active: boolean; scaleX: number; scaleY: number; offsetX: number; offsetY: number; flash: number } {
  const amount = Math.max(.5, Math.min(1.5, strength));
  if (!Number.isFinite(age) || age < 0 || age >= .26) return { active: false, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, flash: 0 };
  const squash = age < .065 ? 1 - age / .065 : -Math.sin((age - .065) / .195 * Math.PI) * .36;
  return { active: true, scaleX: 1 + squash * .18 * amount, scaleY: 1 - squash * .16 * amount,
    offsetX: Math.sin(age * 75) * Math.max(0, 1 - age / .14) * 3 * amount,
    offsetY: Math.max(0, Math.sin(age / .26 * Math.PI)) * 3 * amount,
    flash: flash ? Math.max(0, 1 - age / .095) * .9 : 0 };
}

/** Code-side art direction over the shipped textures; no new gameplay events.
 * Each returned layer consumes a slot in the existing global 96-quad budget. */
export function feedbackLayers(intent: VfxIntent, original: any[]): any[] {
  const id = intent.recipe, ultimate = /^K00[1-4]$/.test(id);
  const family = intent.family || (id.startsWith('BASIC_') ? id.slice(6) : ultimate ? `H${id.slice(1)}` : '');
  const tone = ({ H001: '#FFC347', H002: '#FF6656', H003: '#47E0CB', H004: '#BE82FF' } as Record<string, string>)[family] || '#FFD260';
  const graphics = (graphic: string, size: number, duration: number, extra: any = {}) => ({ graphic, texture: `draw:${graphic}`, logicalSize: [size, size],
    lifetimeSeconds: duration, tint: tone, opacity: [1, 0], ...extra });
  const tex = (texture: string, size: number, duration: number, extra: any = {}) => ({ texture, logicalSize: [size, size], lifetimeSeconds: duration, ...extra });
  if (intent.stage === 'cast' && ultimate) return [
    graphics('castSeal', 126, .34, { scale: [.65, 1.3], rotationSpeed: family === 'H004' ? 210 : 55, atDestination: true }),
    tex(({ H001: 'VFX_CORN', H002: 'VFX_FIST', H003: 'VFX_SOUND_WAVE', H004: 'VFX_SHOE' } as any)[family], 88, .3,
      { scale: [.55, 1.08], opacity: [.95, 0], atDestination: true, rotationSpeed: family === 'H004' ? 330 : -30 }),
    graphics('speed', 150, .24, { count: 1, atDestination: true, flashOnly: true }),
  ];
  if (id === 'ENERGY') return [
    tex('UI_ENERGY', 24, .62, { emitter: 'rewardSourceToEnergyHud', count: 3, staggerSeconds: .055, path: 'energyArc', scale: [1.15, .7] }),
    ...(intent.amount ? [graphics('income', 120, .58, { amount: intent.amount, opacity: [1, 0], rise: 34 })] : []),
  ];
  if (id === 'MONSTER_DEATH' || id === 'PUDDING_SPLIT') return [
    ...(intent.bodyTexture ? [tex(visualAssetId(intent.bodyTexture), intent.bodySize || 72, .27,
      { scale: [1, .6], opacity: [.85, 0], rotationSpeed: 65, bodyOffset: (intent.bodySize || 72) * .36 })] : []),
    graphics('death', id === 'PUDDING_SPLIT' ? 82 : 65, .38, { scale: [.45, 1.2], tint: '#FFEBB0' }),
    tex('VFX_SMOKE', 66, .42, { scale: [.35, 1.1], opacity: [.5, 0], rise: 14 }),
    tex('VFX_STAR', 18, .35, { count: 3, spreadRadius: 32, scale: [1, .3], opacity: [.95, 0], rotationSpeed: 180 }),
  ];
  if (id === 'HIT' && family === 'H001') return [graphics('cornKernels', 68, .18, { scale: [.6, 1], opacityHold: .3 })];
  if (id === 'HIT') return [graphics('impact', 47, .18, { scale: [.8, 1.2], flashOnly: true }),
    graphics(family === 'H002' ? 'punch' : family === 'H003' ? 'notes' : family === 'H004' ? 'slap' : 'shards', 62, .27)];
  if (id === 'BASIC_H001' && intent.persistent) return [
    tex('VFX_CORN', 46, .4, { emitter: 'projectile', path: 'muzzleToAuthoritativeImpact', rotation: 'travelDirection', rotationSpeed: 280 }),
    graphics('trail', 20, .4, { emitter: 'projectileTail', opacity: [.9, .3] }),
  ];
  if (id === 'BASIC_H004' && (intent.persistent || intent.emitters?.includes('projectileTail'))) return [
    tex('VFX_SHOE', 46, .4, { emitter: 'projectile', path: 'providedChaseArc', rotation: 'travelDirection', rotationSpeed: 520 }),
    tex('VFX_SHOE_TRAIL', 64, .4, { emitter: 'projectileTail', path: 'providedChaseArc', rotation: 'travelDirection', opacity: [.75, .25] }),
  ];
  if (intent.stage === 'launch' && family === 'H001') return [graphics('cornKernels', 52, .2, { atOrigin: true })];
  if (family === 'H002' && (id.startsWith('BASIC_') || id === 'K002')) {
    if (intent.emitters?.includes('eachAuthoritativeHit')) return [graphics('punch', 96, .29, { scale: [.65, 1.2] }), tex('VFX_IMPACT', 74, .17, { flashOnly: true, opacity: [.85, 0] })];
    return [
      graphics('speed', ultimate ? 150 : 73, ultimate ? .42 : .24, { emitter: ultimate ? 'laneSweep' : 'projectile', path: 'line' }),
      tex('VFX_SPRING', 40, ultimate ? .4 : .2, { emitter: ultimate ? 'laneTether' : 'tether', width: ultimate ? 24 : 12, opacity: [.8, 0] }),
      tex('VFX_FIST', ultimate ? 112 : 56, ultimate ? .44 : .2, { emitter: ultimate ? 'laneSweep' : 'projectile', path: 'line', rotation: 'travelDirection' }),
      ...(!ultimate ? [graphics('punch', 72, .24, { atDestination: true })] : []),
    ];
  }
  if ((family === 'H001' && !intent.persistent) || id === 'K001' && !intent.persistent) {
    return [
      // A brief solid read wins against the yellow road; few heavy kernels
      // replace overlapping thin rings. Timings remain within the v007 envelope.
      graphics('cornShock', ultimate ? 244 : 156, ultimate ? .42 : .26, { scale: [.48, 1.05], opacityHold: .12 }),
      graphics('cornKernels', ultimate ? 226 : 146, ultimate ? .5 : .32, { scale: [.5, 1.08], opacityHold: .3 }),
      graphics('popcornCore', ultimate ? 158 : 106, ultimate ? .3 : .22, { scale: [.82, 1.08], opacityHold: .48 }),
      tex('VFX_POPCORN', ultimate ? 130 : 85, ultimate ? .3 : .22, { scale: [.86, 1.03], opacity: [1, 0], opacityHold: .5, rotationSpeed: ultimate ? -32 : 38 }),
      ...(ultimate ? [tex('VFX_POPCORN', 42, .5, { count: 3, spreadRadius: 105, scale: [.6, 1], opacity: [1, 0], opacityHold: .3, rotationSpeed: 135 })] : []),
    ];
  }
  if (family === 'H003' && !intent.persistent) return [
    graphics('ring', 120, ultimate ? .46 : .3, { sizeBinding: 'attackAreaDiameter', count: 3, staggerSeconds: .055, scale: [.2, 1], lineWidth: ultimate ? 5 : 3 }),
    graphics('notes', ultimate ? 170 : 82, ultimate ? .48 : .32, { count: 1, scale: [.65, 1.1] }),
    tex('VFX_SOUND_WAVE', ultimate ? 110 : 62, .3, { count: 2, spreadRadius: 20, rotationDegrees: 90, opacity: [.85, 0] }),
  ];
  if (family === 'H004' && !intent.persistent) return [
    tex('VFX_SHOE', ultimate ? 84 : 44, ultimate ? .28 : .2, { path: 'providedChaseArc', rotationSpeed: 640, opacity: [1, .2] }),
    graphics('slap', ultimate ? 112 : 63, ultimate ? .32 : .23, { atDestination: true, scale: [.65, 1.1] }),
    tex('VFX_SHOE_TRAIL', ultimate ? 140 : 67, .24, { atDestination: true, rotationSpeed: 150, opacity: [.85, 0] }),
    graphics('impact', ultimate ? 76 : 39, .13, { flashOnly: true, atDestination: true }),
  ];
  return original;
}
function heroPoint(s: VfxSnapshot, hero: any): VfxPoint {
  const pad = s.config?.world?.pads.find((p: any) => p.id === hero?.slot);
  if (pad) return point(pad);
  const reserve = s.config?.world?.reserve_ids.indexOf(hero?.slot) ?? -1;
  return battleScreenToWorld(battleReserveScreen(Math.max(0, reserve)));
}
function enemyPoint(s: VfxSnapshot, id: number): VfxPoint | undefined {
  const e = s.enemies.find(e => e.id === id); return e && point(e);
}
const effectKey = (e: any): string => JSON.stringify(e);
export function chooseVfxSlot(slots: { active: boolean; priority: number; serial: number }[], priority: number): number {
  const free = slots.findIndex(slot => !slot.active); if (free >= 0) return free;
  let candidate = -1;
  slots.forEach((slot, i) => {
    if (slot.priority > priority && (candidate < 0 || slot.priority > slots[candidate].priority ||
      (slot.priority === slots[candidate].priority && slot.serial < slots[candidate].serial))) candidate = i;
  });
  return candidate;
}

export class VfxEventRouter {
  private previous?: VfxSnapshot;
  private effects = new Set<string>();
  private damage = new Set<string>();
  private baselineNext = true;
  private hidden = false;
  private baseline(s: VfxSnapshot): void {
    this.previous = s; this.effects = new Set(s.effects.map(effectKey)); this.damage = new Set(s.damage.map(effectKey));
    this.baselineNext = false;
  }
  background(): void { this.hidden = true; this.baselineNext = true; }
  foreground(): void { this.hidden = false; this.baselineNext = true; }
  observe(data: any): VfxFrame { return this.read(captureVfxState(data)); }
  command(_name: string, _payload: any, success: boolean, before: VfxSnapshot, after: VfxSnapshot): VfxFrame {
    if (!success) return { snapshot: after, bursts: [], persistent: this.persistent(after), clearBattle: false };
    if (!this.previous || before.runId !== this.previous.runId) this.baseline(before);
    return this.read(after, before);
  }
  private read(s: VfxSnapshot, commandBefore?: VfxSnapshot): VfxFrame {
    const old = commandBefore || this.previous;
    const identityChanged = !old || old.runId !== s.runId || old.wave !== s.wave || old.tick > s.tick;
    const clearBattle = identityChanged || s.screen !== 'battle' || ['cards', 'firstFailure', 'secondFailure', 'adPending', 'victory', 'defeat'].includes(s.phase);
    if (this.hidden || this.baselineNext || identityChanged) {
      this.baseline(s); return { snapshot: s, bursts: [], persistent: this.hidden ? [] : this.persistent(s), clearBattle: true };
    }
    const bursts: VfxIntent[] = [], base = { x: s.config?.world?.field_size[0] / 2 || 360, y: s.config?.world?.base_y || 648 };
    const naturalFinish = old!.phase === 'battle' && ['cards', 'victory'].includes(s.phase);
    const oldEnemies = new Map(old!.enemies.map(e => [e.id, e]));
    const add = (recipe: string, key: string, at: VfxPoint, extra: Partial<VfxIntent> = {}): void => {
      bursts.push({ key: `${s.runId}:${s.wave}:${key}`, recipe, clock: naturalFinish ? 'ui' : 'battle', tick: s.tick, point: at, priority: 2, flash: s.flash, ...extra });
    };
    const grandpa = !old!.grandpa && s.grandpa;
    const revive = !old!.second && s.second;
    if (grandpa) add('GRANDPA', 'grandpa', base, { clock: 'ui', priority: 0, delay: .12 });
    if (revive) add('REVIVE', 'revive', base, { clock: 'ui', priority: 0, textures: ['VFX_RING'] });
    if (grandpa || (revive && s.ad?.status === 'applied' && ['ad', 'fallback'].includes(s.ad.result))) {
      add('CLEAR', 'clear', base, { clock: 'ui', priority: 0, delay: grandpa ? .12 : 0,
        positions: old!.enemies.filter(e => !e.terminal).map(point) });
    }
    if (grandpa || revive) add('ENERGY', 'rescue-energy', base, { clock: 'ui', priority: 1 });
    if (old!.phase !== s.phase && ['victory', 'defeat'].includes(s.phase)) {
      add(s.phase === 'victory' ? 'MERGE' : 'MONSTER_DEATH', 'settlement', { x: 360, y: 230 }, { clock: 'ui', priority: 1 });
    }
    for (const hero of s.heroes) {
      if (hero.star > 1 && !old!.heroes.some(h => h.id === hero.id) && old!.heroes.filter(h => h.type === hero.type && h.star === hero.star - 1).length >= 2)
        add('MERGE', `merge:${hero.id}`, heroPoint(s, hero), { clock: 'ui', priority: 1 });
    }
    for (const id of s.skills) if (!old!.skills.includes(id)) add('SKILL_UNLOCK', `unlock:${id}`, { x: 662, y: 771 }, { clock: 'ui', priority: 1 });
    // Failure/clear transitions never turn cleared entities into normal kills or replay old pulses.
    if (!grandpa && !revive && (s.screen === 'battle' && s.phase === 'battle' || naturalFinish)) {
      for (const e of s.effects) {
        const key = effectKey(e); if (this.effects.has(key) || s.tick - e.tick > s.tickHz * .3) continue;
        const at = Number.isFinite(e.x) ? point(e) : enemyPoint(s, e.enemyId) || base;
        const extra: Partial<VfxIntent> = { tick: e.tick, radius: e.radius };
        if (e.kind === 'attack') {
          const hero = s.heroes.find(h => h.id === e.heroId);
          if (hero && ['H001', 'H002'].includes(hero.type)) add(`BASIC_${hero.type}`, key, at, { ...extra, family: hero.type, stage: 'launch', from: heroPoint(s, hero), to: at });
        } else if (e.kind === 'sound') add('BASIC_H003', key, at, { ...extra, family: 'H003', stage: 'impact' });
        else if (e.kind === 'explosion' || e.kind === 'chain') add('BASIC_H001', key, at, { ...extra, family: 'H001', stage: 'impact', priority: e.kind === 'chain' ? 1 : 2 });
        else if (e.kind === 'retarget') add('BASIC_H004', key, at, { ...extra, emitters: ['projectileTail'], from: at, to: enemyPoint(s, e.enemyId) || at });
        else if (e.kind === 'knockback') add('P002', key, { x: at.x, y: e.toY }, { ...extra, textures: ['VFX_ARROW'], from: { x: at.x, y: e.fromY }, to: { x: at.x, y: e.toY }, duration: .15 });
        else if (e.kind === 'skillCast' && /^K00[1-4]$/.test(e.skillId)) {
          const def = s.config.skills.find((v: any) => v.id === e.skillId);
          const target = e.lane ? { x: s.config.world.lane_centers_x[e.lane - 1], y: base.y - 65 } : at;
          add(e.skillId, `cast:${key}`, target, { ...extra, radius: def?.radius, stage: 'cast', priority: 0, lane: e.lane });
        } else if (e.kind === 'skillCast' && e.skillId === 'P001') {
          const pending = s.events.find(v => v.kind === 'skill' && v.skillId === 'P001' && v.target.x === e.x && v.target.y === e.y);
          add('P001', key, at, { ...extra, emitters: ['fallToSelectedArea'], endTick: pending?.tick, priority: 1 });
        } else if (e.kind === 'skillPulse' && !['K004', 'P003'].includes(e.skillId)) {
          const def = s.config.skills.find((v: any) => v.id === e.skillId);
          const p = e.lane ? { x: s.config.world.lane_centers_x[e.lane - 1], y: base.y } : at;
          add(e.skillId, key, p, { ...extra, radius: e.radius ?? def?.radius, lane: e.lane, priority: 1, stage: 'impact',
            emitters: e.skillId === 'P001' ? ['onAuthoritativeImpact'] : e.skillId === 'K003' ? ['eachAuthoritativePulse'] : undefined });
        }
      }
      const hitGroups = new Set<string>();
      for (const e of s.damage) {
        if (this.damage.has(effectKey(e)) || s.tick - e.tick > s.tickHz * .25 || e.damage <= 0) continue;
        const at = enemyPoint(s, e.enemyId); if (!at) continue;
        const group = `${e.tick}:${e.enemyId}:${e.source}`; if (hitGroups.has(group)) continue; hitGroups.add(group);
        const isShoe = String(e.source).startsWith('H004');
        if (e.source === 'K004') add('K004', group, at, { tick: e.tick, priority: 1, stage: 'impact', from: { x: at.x + 85, y: at.y - 40 }, to: at });
        else add(isShoe ? 'BASIC_H004' : e.source === 'K002' ? 'K002' : 'HIT', group, at,
          { tick: e.tick, priority: 3, stage: 'impact', family: String(e.source).replace(/^K/, 'H').split('-')[0], emitters: isShoe ? ['onAuthoritativeImpact'] : e.source === 'K002' ? ['eachAuthoritativeHit'] : undefined,
            replacements: s.enemies.find(v => v.id === e.enemyId)?.type === 'M002' ? { VFX_SPARK: 'VFX_SHARD' } : undefined });
      }
      for (const enemy of s.enemies) {
        const prior = oldEnemies.get(enemy.id);
        if (enemy.terminal === 'killed' && (!prior || !prior.terminal)) add(enemy.type === 'M004' ? 'PUDDING_SPLIT' : 'MONSTER_DEATH', `death:${enemy.id}`, point(enemy), { priority: 2, stage: 'death', bodyTexture: enemy.type,
          bodySize: enemy.type === 'B001' ? 162 : enemy.type === 'B002' ? 120 : enemy.type === 'M004-S' ? 49 : Math.max(72, (s.config.monsters.find((m: any) => m.id === enemy.type)?.body_radius || 24) * 3.1) });
        if (s.config.monsters.find((m: any) => m.id === enemy.type)?.pulse && enemy.hastes.some((h: any) => h.source === `boss:${enemy.id}` && !prior?.hastes.some((p: any) => p.source === h.source && p.endTick === h.endTick)))
          add('GOOSE_TELL', `boss-impact:${enemy.id}:${s.tick}`, point(enemy), { radius: s.config.monsters.find((m: any) => m.id === enemy.type).pulse.radius, duration: .4, priority: 0, textures: ['VFX_RING'] });
      }
      if (s.earned > old!.earned && !s.calm) {
        const dead = s.enemies.find(e => e.terminal === 'killed' && oldEnemies.has(e.id) && !oldEnemies.get(e.id)!.terminal);
        add('ENERGY', `income:${s.tick}:${s.earned}`, dead ? point(dead) : base, { clock: naturalFinish ? 'ui' : 'battle', priority: 2, stage: 'income', amount: s.earned - old!.earned });
      }
    }
    this.baseline(s);
    return { snapshot: s, bursts, persistent: this.persistent(s), clearBattle };
  }
  private persistent(s: VfxSnapshot): VfxIntent[] {
    if (s.screen !== 'battle' || !s.config || ['victory', 'defeat', 'cards', 'firstFailure', 'secondFailure', 'adPending'].includes(s.phase)) return [];
    const out: VfxIntent[] = [], base = { x: s.config.world.field_size[0] / 2, y: s.config.world.base_y };
    const live = s.enemies.filter(e => !e.terminal);
    const auraSources = live.map(e => ({ enemy: e, aura: s.config.monsters.find((m: any) => m.id === e.type)?.aura }))
      .filter(v => v.aura && v.enemy.hardEnd <= s.tick);
    const add = (recipe: string, key: string, at: VfxPoint, extra: Partial<VfxIntent> = {}): void => {
      out.push({ key: `${s.runId}:${s.wave}:persistent:${key}`, recipe, clock: 'battle', tick: s.tick, point: at, priority: 2, persistent: true, flash: s.flash, ...extra });
    };
    if (s.protectionUntil > s.tick || s.phase === 'freeDeploy' && s.second) add('REVIVE', 'base-protection', base,
      { textures: ['VFX_SHIELD'], endTick: s.phase === 'freeDeploy' ? undefined : s.protectionUntil, priority: 0 });
    if (s.baseHp > 0 && s.baseHp <= s.baseMaxHp * .25) add('DANGER', 'base-danger', base, { radius: 65, priority: 0 });
    for (const e of s.events) {
      if (e.kind === 'corn' || e.kind === 'slipper') add(e.kind === 'corn' ? 'BASIC_H001' : 'BASIC_H004', `projectile:${e.id}`, point(e.to || e),
        { tick: e.releasedTick, endTick: e.tick, from: point(e.from || e.origin), to: point(e.to || e), emitters: ['projectile', 'projectileTail'] });
    }
    const fields = new Map<number, any>();
    for (const e of s.events) if (e.kind === 'skill' && e.skillId === 'K003') {
      const existing = fields.get(e.castId); if (!existing || e.tick > existing.tick) fields.set(e.castId, e);
    }
    for (const e of Array.from(fields.values())) add('K003', `field:${e.castId}`, point(e.target),
      { endTick: e.tick, radius: s.config.skills.find((v: any) => v.id === 'K003').radius, emitters: ['persistentArea'], priority: 1 });
    for (const e of s.effects.filter(v => v.kind === 'skillPulse' && v.skillId === 'P003')) {
      const end = Math.max(0, ...s.enemies.filter(v => !v.terminal && v.hardStart >= e.tick && Math.hypot(v.x - e.x, v.y - e.y) <= e.radius).map(v => v.hardEnd));
      if (end > s.tick) add('P003', `mute-field:${e.tick}:${e.x}:${e.y}`, point(e), { endTick: end, radius: e.radius, emitters: ['persistentArea'], priority: 1 });
    }
    for (const e of live) {
      let markers = 0;
      if (e.hardEnd > s.tick) { add('STATE', `hard:${e.id}`, point(e), { endTick: e.hardEnd, textures: ['VFX_MUTE'], priority: 0 }); markers++; }
      if (e.markEnd > s.tick) { add('K001', `mark:${e.id}`, { x: e.x + 22, y: e.y - 30 }, { endTick: e.markEnd, textures: ['VFX_MARK'] }); markers++; }
      if (markers < 2 && Math.max(e.slowEnd, e.vulnerableEnd) > s.tick) {
        add('STATE', `slow:${e.id}`, point(e), { endTick: Math.max(e.slowEnd, e.vulnerableEnd), textures: ['VFX_AURA'], tint: e.vulnerableEnd > s.tick ? '#F6B5DD' : '#A7DDEB' }); markers++;
      }
      if (e.bossWindupUntil > s.tick && !e.hardEnd) add('GOOSE_TELL', `tell:${e.id}`, point(e), { endTick: e.bossWindupUntil,
        radius: s.config.monsters.find((m: any) => m.id === e.type).pulse.radius, priority: 0 });
      const aura = s.config.monsters.find((m: any) => m.id === e.type)?.aura;
      if (aura && e.hardEnd <= s.tick && live.some(v => v.id !== e.id && Math.hypot(v.x - e.x, v.y - e.y) <= aura.radius))
        add('CHICK_BUFF', `aura:${e.id}`, point(e), { radius: aura.radius, emitters: ['buffSource'], priority: 2 });
      if (markers < 2 && (e.hastes.some((h: any) => h.endTick > s.tick) || auraSources.some(source => {
        const other = source.enemy;
        return other.id !== e.id && Math.hypot(other.x - e.x, other.y - e.y) <= source.aura.radius;
      }))) add('CHICK_BUFF', `haste:${e.id}`, point(e), { emitters: ['buffedTargets'] });
    }
    return out;
  }
}
