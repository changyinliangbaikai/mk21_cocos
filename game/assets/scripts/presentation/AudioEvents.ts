/** Pure, read-only audio intent routing. No combat command, clock or random stream is touched. */
export type AudioBus = 'music' | 'sfx' | 'voice';
export interface AudioIntent { id: string; bus: AudioBus; priority: number; combat: boolean; key?: string; }
export interface AudioPlan {
  family: 'menu' | 'battle' | 'boss' | 'calm' | 'result';
  suspended: boolean; combatPaused: boolean; quiet: number; intensity: number;
  muted: boolean; music: number; sfx: number; voice: number;
}
export interface AudioSnapshot {
  runId: string; screen: string; overlay: string | null; phase: string; wave: number; tick: number; tickHz: number;
  baseHp: number; baseMaxHp: number; energy: number; earned: number; calmWave: number | null;
  grandpaUsed: boolean; secondUsed: boolean; ad: any; settings: any;
  heroes: Record<string, { type: string; star: number }>; enemies: Record<string, any>;
  effects: any[]; damageLog: any[]; readySkills: string[]; owned: string[]; configVersion: string;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const clamp = (n: unknown, fallback: number): number => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
export function captureAudioState(data: any): AudioSnapshot {
  const r = data?.run, b = r?.battle, live = (b?.enemies || []).filter((e: any) => !e.terminal);
  const chickenAura = r?.config?.monsters?.find((e: any) => e.id === 'M005')?.aura;
  const enemies: Record<string, any> = {};
  for (const e of b?.enemies || []) enemies[e.id] = { type: e.type, terminal: e.terminal || null, hp: e.hp, x: e.x, y: e.y,
    hard: !!e.hard, windup: e.bossWindupUntil ?? null,
    commanding: e.type === 'M005' && !e.hard && !e.terminal && chickenAura && live.some((other: any) =>
      other.id !== e.id && Math.hypot(other.x - e.x, other.y - e.y) <= chickenAura.radius) };
  const heroes: Record<string, any> = {};
  for (const h of b?.heroes || []) heroes[h.id] = { type: h.type, star: h.star };
  return { runId: r?.id || '', screen: data?.screen || 'camp', overlay: data?.overlay || null,
    phase: r?.phase || '', wave: b?.wave || 0, tick: b?.tick || 0, tickHz: r?.config?.clock?.tick_hz || 60,
    baseHp: b?.baseHp || 0, baseMaxHp: r?.config?.run?.base_max_hp || 20, energy: b?.energy || 0,
    earned: b?.stats?.energyGained || 0, calmWave: r?.calmWave ?? null,
    grandpaUsed: !!r?.grandpaUsed, secondUsed: !!r?.secondUsed, ad: r?.ad ? clone(r.ad) : null,
    settings: clone(data?.profile?.settings || {}), heroes, enemies, configVersion: r?.config?.design_version || '',
    effects: (b?.stats?.effects || []).map((e: any) => ({ ...e })), damageLog: (b?.stats?.damageLog || []).map((e: any) => ({ ...e })),
    readySkills: (r?.equipped || []).filter((id: string) => id && r.skills[id]?.readyTick <= (b?.tick || 0)),
    owned: Object.keys(data?.profile?.heroes || {}).filter(id => data.profile.heroes[id].owned).sort() };
}
export function audioPlan(s: AudioSnapshot, background = false): AudioPlan {
  const battleScreen = s.screen === 'battle', ended = ['victory', 'defeat'].includes(s.phase);
  const active = battleScreen && !ended;
  let family: AudioPlan['family'] = 'menu';
  if (s.screen === 'result' && ended) family = 'result';
  else if (active && s.calmWave === s.wave) family = 'calm';
  else if (active && s.wave === 20) family = 'boss';
  else if (active && (s.wave > 1 || s.phase !== 'deploy')) family = 'battle';
  const count = Object.values(s.enemies).filter(e => !e.terminal).length;
  const slowSelection = s.configVersion === '0.7' && ['summon', 'move'].includes(s.overlay || '');
  const combatPaused = !battleScreen || s.phase !== 'battle' || (!!s.overlay && !slowSelection);
  const quiet = ['firstFailure', 'secondFailure', 'adPending'].includes(s.phase) && battleScreen ? .25 : combatPaused && active ? .48 : 1;
  return { family, suspended: background || s.phase === 'adPending', combatPaused, quiet,
    intensity: count >= 12 || s.wave >= 16 ? 2 : count >= 6 || s.wave >= 7 ? 1 : 0,
    muted: !!(s.settings.muted ?? s.settings.mute), music: clamp(s.settings.music, .6), sfx: clamp(s.settings.sfx, .7), voice: clamp(s.settings.voice, .8) };
}

const attackIds: Record<string, string> = { H001: 'AUD_SFX_012', H002: 'AUD_SFX_015', H003: 'AUD_SFX_018', H004: 'AUD_SFX_021' };
const impactIds: Record<string, string> = { H001: 'AUD_SFX_013', H002: 'AUD_SFX_016', H003: 'AUD_SFX_019', H004: 'AUD_SFX_022' };
const manualIds: Record<string, string> = { K001: 'AUD_SFX_014', K002: 'AUD_SFX_017', K003: 'AUD_SFX_020', K004: 'AUD_SFX_023', P001: 'AUD_SFX_024', P002: 'AUD_SFX_025', P003: 'AUD_SFX_026' };
const pulseIds: Record<string, string> = { K001: 'AUD_SFX_013', K002: 'AUD_SFX_016', K003: 'AUD_SFX_019', K004: 'AUD_SFX_022', P001: 'AUD_SFX_022', P002: 'AUD_SFX_025', P003: 'AUD_SFX_026' };

export class AudioEventRouter {
  private previous?: AudioSnapshot;
  private baselineNext = true;
  private blocked = false;
  private effects = new Set<string>();
  private damage = new Set<string>();
  private once = new Set<string>();
  private praiseCount = 0;
  plan?: AudioPlan;
  background(): void { this.blocked = true; this.baselineNext = true; }
  foreground(): void { this.blocked = false; this.baselineNext = true; }
  reset(): void { this.previous = undefined; this.baselineNext = true; this.effects.clear(); this.damage.clear(); this.once.clear(); }
  private remember(s: AudioSnapshot): void {
    this.previous = s; this.effects = new Set(s.effects.map(e => JSON.stringify(e)));
    this.damage = new Set(s.damageLog.map(e => JSON.stringify(e)));
    if (s.grandpaUsed) this.once.add(`${s.runId}:grandpa`);
    if (s.secondUsed) this.once.add(`${s.runId}:revive`);
    if (['secondFailure', 'adPending', 'freeDeploy', 'defeat'].includes(s.phase)) this.once.add(`${s.runId}:second-entry`);
    if (['victory', 'defeat'].includes(s.phase)) this.once.add(`${s.runId}:result`);
    if (s.calmWave === s.wave && s.phase !== 'deploy') this.once.add(`${s.runId}:calm:${s.wave}`);
  }
  private cue(out: AudioIntent[], id: string, priority = 2, combat = false, key?: string): void {
    if (key && this.once.has(key)) return;
    if (key) this.once.add(key);
    out.push({ id, bus: id.startsWith('AUD_MUS') ? 'music' : id.startsWith('AUD_VO') ? 'voice' : 'sfx', priority, combat, key });
  }
  private transitions(before: AudioSnapshot, after: AudioSnapshot, out: AudioIntent[]): boolean {
    const sameRun = !!after.runId && before.runId === after.runId;
    if (!sameRun) return false;
    const grandpa = !before.grandpaUsed && after.grandpaUsed;
    const revive = !before.secondUsed && after.secondUsed && after.ad?.status === 'applied';
    if (grandpa && !this.once.has(`${after.runId}:grandpa`)) {
      this.cue(out, 'AUD_MUS_010', 0, false, `${after.runId}:grandpa`);
      this.cue(out, 'AUD_SFX_034', 0); this.cue(out, 'AUD_SFX_035', 0); this.cue(out, 'AUD_VO_001', 1);
    }
    if (revive && !this.once.has(`${after.runId}:revive`)) {
      this.cue(out, 'AUD_MUS_011', 1, false, `${after.runId}:revive`); this.cue(out, 'AUD_SFX_036', 1);
      if (['ad', 'fallback'].includes(after.ad.result)) this.cue(out, 'AUD_SFX_035', 0);
    }
    if (after.phase === 'secondFailure' && before.phase !== 'secondFailure') this.cue(out, 'AUD_VO_003', 0, false, `${after.runId}:second-entry`);
    if (after.phase === 'cards' && before.phase !== 'cards') {
      if (!grandpa && !revive) this.cue(out, 'AUD_SFX_033', 1);
      this.cue(out, 'AUD_SFX_007', 2);
    }
    if (before.calmWave !== null && after.calmWave === null) {
      this.cue(out, 'AUD_SFX_038', 1); this.cue(out, 'AUD_VO_006', 2);
    }
    if (['victory', 'defeat'].includes(after.phase) && before.phase !== after.phase) {
      this.cue(out, after.phase === 'victory' ? 'AUD_MUS_008' : 'AUD_MUS_009', 1, false, `${after.runId}:result`);
    }
    return grandpa || revive;
  }
  observe(data: any): AudioIntent[] { return this.observeSnapshot(captureAudioState(data)); }
  private observeSnapshot(after: AudioSnapshot): AudioIntent[] {
    this.plan = audioPlan(after, this.blocked);
    const before = this.previous;
    if (this.baselineNext || !before || before.runId !== after.runId || after.tick < before.tick) {
      this.remember(after); this.baselineNext = false; return [];
    }
    if (this.blocked || this.plan.suspended) { this.remember(after); return []; }
    const out: AudioIntent[] = [], rescue = this.transitions(before, after, out);
    const sameWave = before.wave === after.wave;
    const freshEvent = (e: any) => e.tick >= after.tick - Math.ceil(after.tickHz * .25);
    if (sameWave && after.screen === 'battle' && !rescue && after.tick >= before.tick) {
      for (const e of after.effects) {
        const key = JSON.stringify(e); if (this.effects.has(key) || !freshEvent(e)) continue;
        if (e.kind === 'attack') {
          const type = after.heroes[e.heroId]?.type || before.heroes[e.heroId]?.type;
          if (attackIds[type]) this.cue(out, attackIds[type], 2, true);
        } else if (e.kind === 'explosion') this.cue(out, 'AUD_SFX_013', 2, true);
        else if (e.kind === 'sound') this.cue(out, 'AUD_SFX_019', 2, true);
        else if (e.kind === 'chain') this.cue(out, 'AUD_SFX_029', 2, true);
        else if (e.kind === 'skillCast' && manualIds[e.skillId]) this.cue(out, manualIds[e.skillId], 1, true);
        else if (e.kind === 'skillPulse' && pulseIds[e.skillId]) this.cue(out, pulseIds[e.skillId], 1, true);
      }
      for (const event of after.damageLog) {
        if (this.damage.has(JSON.stringify(event)) || !freshEvent(event) || event.damage <= 0) continue;
        const heroType = String(event.source || '').split('-')[0];
        // Corn/sound/skill pulse impacts already have explicit effects; locked slippers/punches use actual hits.
        if (heroType === 'H004' || heroType === 'H002') this.cue(out, impactIds[heroType], 2, true);
        else if (String(event.source).startsWith('C009')) this.cue(out, 'AUD_SFX_027', 2, true);
        if (after.enemies[event.enemyId]?.type === 'M002') this.cue(out, 'AUD_SFX_040', 2, true);
      }
      for (const [id, enemy] of Object.entries(after.enemies)) {
        const old = before.enemies[id];
        if (enemy.terminal === 'killed' && old?.terminal !== 'killed') this.cue(out, enemy.type === 'M004' ? 'AUD_SFX_042' : 'AUD_SFX_028', 2, true);
        if (!enemy.terminal && !old) {
          if (['B001', 'B002'].includes(enemy.type)) this.cue(out, 'AUD_SFX_044', 1, true);
          if (enemy.type === 'M003') this.cue(out, 'AUD_SFX_041', 2, true);
          if (enemy.type === 'M001') this.cue(out, 'AUD_SFX_039', 3, true);
        }
        if (enemy.commanding && !old?.commanding) this.cue(out, 'AUD_SFX_043', 1, true);
        if (enemy.type === 'B001' && enemy.windup !== null && enemy.windup !== old?.windup) this.cue(out, 'AUD_SFX_045', 0, true);
        if (enemy.type === 'B001' && old?.windup !== null && old?.windup !== undefined && enemy.windup === null &&
          !enemy.hard && !enemy.terminal && after.tick >= old.windup) this.cue(out, 'AUD_SFX_046', 0, true);
      }
      if (after.baseHp < before.baseHp) this.cue(out, 'AUD_SFX_030', 0);
      if (before.baseHp > after.baseMaxHp * .25 && after.baseHp <= after.baseMaxHp * .25) this.cue(out, 'AUD_SFX_031', 0);
      if (after.earned > before.earned && after.calmWave !== after.wave) this.cue(out, 'AUD_SFX_032', 2, true);
      if (after.readySkills.some(id => !before.readySkills.includes(id))) this.cue(out, 'AUD_SFX_009', 1);
    }
    if (after.owned.some(id => !before.owned.includes(id))) this.cue(out, 'AUD_SFX_047', 1);
    this.remember(after);
    // Multiple same-frame hits are one intent; real-time limiter additionally aggregates across frames.
    return out.filter((intent, index) => out.findIndex(v => v.id === intent.id) === index);
  }
  command(name: string, payload: any, success: boolean, before: AudioSnapshot, after: AudioSnapshot): AudioIntent[] {
    if (this.baselineNext || !this.previous) { this.remember(before); this.baselineNext = false; }
    this.plan = audioPlan(after, this.blocked);
    if (this.blocked || (this.plan.suspended && name !== 'adResult' && name !== 'freeRevive')) { this.remember(after); return []; }
    const out: AudioIntent[] = [];
    if (!success) {
      // Duplicate/late ad callbacks are technical inputs, not user-facing action sounds.
      if (name !== 'adResult') this.cue(out, 'AUD_SFX_003', 2);
      this.remember(after); return out;
    }
    if (name === 'cast') {
      const cast = after.effects.slice().reverse().find(e => e.kind === 'skillCast' && e.tick === after.tick);
      if (cast && manualIds[cast.skillId]) this.cue(out, manualIds[cast.skillId], 1, true);
    } else if (name === 'summon') this.cue(out, 'AUD_SFX_002', 2);
    else if (name === 'move') {
      const merged = Object.keys(after.heroes).length < Object.keys(before.heroes).length;
      const newHero = Object.keys(after.heroes).find(id => !before.heroes[id]);
      this.cue(out, merged ? after.heroes[newHero || '']?.star === 3 ? 'AUD_SFX_006' : 'AUD_SFX_005' : 'AUD_SFX_004', merged ? 1 : 2);
    } else if (name === 'chooseCard') this.cue(out, 'AUD_SFX_008', 2);
    else if (name === 'equipSkill') this.cue(out, 'AUD_SFX_037', 2);
    else if (name === 'setSpeed') this.cue(out, 'AUD_SFX_011', 2);
    else if (name === 'startWave') {
      if (before.phase !== 'freeDeploy') this.cue(out, 'AUD_SFX_010', 1);
      if (after.calmWave === after.wave) this.cue(out, 'AUD_VO_002', 2, false, `${after.runId}:calm:${after.wave}`);
    } else if (name === 'praise' && after.owned.some(id => !before.owned.includes(id))) {
      this.cue(out, this.praiseCount++ % 2 ? 'AUD_VO_005' : 'AUD_VO_004', 1);
    } else if (!['grandpa', 'freeRevive', 'adResult', 'adRequest', 'pauseBackground', 'resumeBackground', 'tutorialDismiss'].includes(name)) this.cue(out, 'AUD_SFX_001', 2);
    this.transitions(before, after, out);
    if (after.owned.some(id => !before.owned.includes(id))) this.cue(out, 'AUD_SFX_047', 1);
    this.remember(after);
    return out.filter((intent, index) => out.findIndex(v => v.id === intent.id) === index);
  }
}

/** Audio-only tuning from the sound specification. These never alter game logic. */
export const AUDIO_LIMITS = { totalSfx: 12, groupCaps: [2, 3, 5, 2], musicLayers: 4, voice: 1 };
export function defaultAudioInterval(id: string): number {
  if (id === 'AUD_SFX_032') return .15;
  if (id === 'AUD_SFX_028') return .1;
  if (id === 'AUD_SFX_029') return .16;
  if (id === 'AUD_SFX_039') return .8;
  if (id === 'AUD_SFX_031') return 2;
  if (id.startsWith('AUD_VO')) return .5;
  return .07;
}
export interface AudioVoiceSlot { id: string; priority: number; started: number; active: boolean; }
const urgent: Record<string, number> = { AUD_SFX_045: 100, AUD_SFX_031: 90, AUD_SFX_030: 80, AUD_SFX_046: 75, AUD_SFX_035: 70, AUD_SFX_034: 60 };
export function chooseAudioSlot(slots: AudioVoiceSlot[], priority: number, id = ''): number {
  const active = slots.map((s, index) => ({ ...s, index })).filter(s => s.active);
  const group = active.filter(s => s.priority === priority);
  if (group.length >= AUDIO_LIMITS.groupCaps[priority]) {
    if (priority !== 0) return -1;
    const weakest = group.sort((a, b) => (urgent[a.id] || 0) - (urgent[b.id] || 0) || a.started - b.started)[0];
    return (urgent[id] || 0) >= (urgent[weakest.id] || 0) ? weakest.index : -1;
  }
  const empty = slots.findIndex(s => !s.active); if (empty >= 0) return empty;
  const weaker = active.filter(s => s.priority > priority).sort((a, b) => b.priority - a.priority || a.started - b.started);
  return weaker.length ? weaker[0].index : -1;
}
