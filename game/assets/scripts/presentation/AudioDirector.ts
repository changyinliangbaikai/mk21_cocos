import { AudioClip, AudioSource, Node } from 'cc';
import { AudioPlaybackLifetime, admitsAudioIntent, boundedAudioReady, closesCombatAudio, combatAudioPauseAction, readyAudioGroup, sampleAudioClocks } from './AudioPlayback';
import { AUDIO_LIMITS, AudioEventRouter, audioPlan, captureAudioState, chooseAudioSlot, defaultAudioInterval,
  type AudioBus, type AudioIntent, type AudioPlan, type AudioSnapshot } from './AudioEvents';

export interface AudioCatalogPort {
  audio(id: string): AudioClip | null;
  audioInfo(id: string): { bus?: string; gain?: number; loop?: boolean; bpm?: number; syncGroup?: string;
    duration?: number; sampleRate?: number; loopStart?: number; loopEnd?: number; minInterval?: number; priority?: number } | undefined;
  audioVariants?(id: string): AudioClip[];
}
interface Track {
  id: string; node: Node; source: AudioSource; running: boolean; ready: boolean; gain: number;
  started: number; actualStarts: number; lastStartAt: number; error?: string; cancelReadiness?: () => void;
  sampledTime: number; sampledAt: number;
}
interface VoiceSlot extends Track {
  active: boolean; priority: number; combat: boolean; paused: boolean; lifetime: AudioPlaybackLifetime; bus: AudioBus;
}
const MUSIC_LOOPS = ['AUD_MUS_001', 'AUD_MUS_002', 'AUD_MUS_003', 'AUD_MUS_004', 'AUD_MUS_005', 'AUD_MUS_006', 'AUD_MUS_007'];
const STEMS = ['AUD_MUS_002', 'AUD_MUS_003', 'AUD_MUS_004', 'AUD_MUS_005'];
const bounded = (value: number, fallback = 1): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;

/** Real Cocos sources only; music always uses its own real-time clocks and default playback rate.
 * Audio is an observer. It never calls GameSession.dispatch/advance or changes the saved game.
 */
export class AudioDirector {
  private catalog?: AudioCatalogPort;
  private root?: Node;
  private router = new AudioEventRouter();
  private latest?: AudioSnapshot;
  private plan: AudioPlan = { family: 'menu', suspended: false, combatPaused: true, quiet: 1, intensity: 0,
    muted: false, music: .6, sfx: .7, voice: .8 };
  private tracks = new Map<string, Track>();
  private sfx: VoiceSlot[] = [];
  private voice?: VoiceSlot;
  private stinger?: VoiceSlot;
  private unlocked = false;
  private hidden = false;
  private dead = false;
  private realTime = 0;
  private currentFamily = '';
  private familyIds: string[] = [];
  private density = 0;
  private densityChangedAt = -Infinity;
  private pendingDensity = 0;
  private pendingDensityAt = 0;
  private lastBar = -1;
  private duck = 1;
  private duckUntil = 0;
  private lastPlay = new Map<string, number>();
  private variants = new Map<string, number>();
  private missing = new Set<string>();
  private suppressed = { locked: 0, missing: 0, muted: 0, suspended: 0, paused: 0, canceledBeforeStart: 0, rateLimit: 0, polyphony: 0, stale: 0 };
  private requested = 0;
  private resumeRequests = 0;
  private actualStarts = 0;
  private driftSeconds = 0;
  private syncCorrections = 0;
  private syncCorrectionEvents: { at: number; id: string; observedDrift: number; leaderTime: number; trackTime: number }[] = [];
  private lastSyncAt = 0;
  private syncMetadataValid = false;
  private syncIssues: string[] = [];
  private playbackErrors: string[] = [];
  private sceneIdentity = '';
  private scenePhase = '';

  initialize(catalog: AudioCatalogPort, parent: Node): void {
    if (this.root) this.destroy();
    this.dead = false; this.catalog = catalog; this.root = new Node('MvpAudioDirector'); this.root.setParent(parent);
    this.router = new AudioEventRouter();
    for (const id of MUSIC_LOOPS) {
      const clip = catalog.audio(id); if (!clip) { this.missing.add(id); continue; }
      const track = this.makeTrack(id); track.source.clip = clip; track.source.loop = true;
      track.gain = bounded(catalog.audioInfo(id)?.gain ?? 1);
      this.tracks.set(id, track);
      // Public readiness API, backed by this actual AudioSource's loaded player.
      track.cancelReadiness = boundedAudioReady(track.source.getSampleRate(), 10_000, error => {
        if (this.dead || this.tracks.get(id) !== track) return;
        track.cancelReadiness = undefined;
        if (error) {
          track.error = error; this.playbackErrors.push(`${id}: ${error}`);
          this.pauseTrack(track); track.source.clip = null; // Invalidate the engine's late player load.
        } else track.ready = true;
      });
    }
    for (let i = 0; i < AUDIO_LIMITS.totalSfx; i++) this.sfx.push(this.makeSlot(`sfx-${i}`, 'sfx'));
    this.voice = this.makeSlot('voice', 'voice'); this.stinger = this.makeSlot('stinger', 'music');
    this.checkStemMetadata();
  }
  private makeTrack(name: string): Track {
    const node = new Node(name); node.setParent(this.root!);
    const source = node.addComponent(AudioSource); source.playOnAwake = false; source.volume = 0; source.loop = false;
    const track: Track = { id: name, node, source, running: false, ready: false, gain: 1, started: 0, actualStarts: 0, lastStartAt: -1,
      sampledTime: 0, sampledAt: 0 };
    node.on(AudioSource.EventType.STARTED, () => {
      if (this.dead || !track.running || !source.playing) return;
      track.actualStarts++; track.lastStartAt = this.realTime; this.actualStarts++;
      // An async source may finish loading after the app became silent/hidden.
      if (this.hidden || this.plan.suspended || this.plan.muted) source.volume = 0;
    });
    return track;
  }
  private makeSlot(name: string, bus: AudioBus): VoiceSlot {
    const slot = Object.assign(this.makeTrack(name), { active: false, priority: 3, combat: false, paused: false,
      lifetime: new AudioPlaybackLifetime(), bus });
    slot.node.on(AudioSource.EventType.STARTED, () => {
      if (this.dead || !slot.active || !slot.running || !slot.source.playing) return;
      slot.lifetime.markStarted(); slot.ready = true;
    });
    slot.node.on(AudioSource.EventType.ENDED, () => { slot.active = false; slot.running = false; slot.lifetime.reset(); });
    return slot;
  }
  private checkStemMetadata(): void {
    const info = STEMS.map(id => this.catalog!.audioInfo(id));
    this.syncIssues = [];
    if (STEMS.some(id => !this.tracks.has(id))) this.syncIssues.push('002–005 have missing decoded clips');
    const first = info[0];
    if (!first?.bpm || !first?.sampleRate || !first?.duration) this.syncIssues.push('Stem BPM/sample-rate/duration metadata incomplete');
    else for (let i = 1; i < info.length; i++) {
      const item = info[i];
      if (!item || item.bpm !== first.bpm || item.sampleRate !== first.sampleRate ||
        !item.duration || Math.abs(item.duration - first.duration) > 1 / first.sampleRate || item.syncGroup !== first.syncGroup) {
        this.syncIssues.push(`${STEMS[i]} metadata does not match rhythm stem`);
      }
    }
    this.syncMetadataValid = !this.syncIssues.length;
  }
  /** Call synchronously from a real TOUCH_END/MOUSE_UP handler, never a timer or synthetic command. */
  userGesture(): void {
    if (this.dead || this.hidden) return;
    this.unlocked = true;
    this.syncMusic();
  }
  observe(data: any): void {
    if (this.dead) return;
    this.latest = captureAudioState(data);
    const intents = this.router.observe(data);
    this.plan = this.router.plan || audioPlan(this.latest, this.hidden);
    this.clearFinishedCombat(this.latest);
    this.applyPausePolicy(); this.consume(intents); this.syncMusic();
  }
  command(name: string, payload: any, success: boolean, before: AudioSnapshot, after: AudioSnapshot): void {
    if (this.dead) return;
    this.latest = after;
    const intents = this.router.command(name, payload, success, before, after);
    this.plan = this.router.plan || audioPlan(after, this.hidden);
    this.clearFinishedCombat(after);
    // Leaving an ad pause must restore permission before playing its actual committed result.
    this.applyPausePolicy(); this.consume(intents); this.syncMusic();
  }
  background(): void {
    this.hidden = true; this.router.background(); this.stopTransient();
    for (const track of this.tracks.values()) this.pauseTrack(track);
  }
  foreground(): void {
    this.hidden = false; this.router.foreground();
    if (this.latest) this.plan = audioPlan(this.latest, false);
    // The next observe establishes a new baseline; no backlog or rescue narration is enqueued.
  }
  private applyPausePolicy(): void {
    if (this.hidden || this.plan.suspended) {
      this.stopTransient(); for (const track of this.tracks.values()) this.pauseTrack(track); return;
    }
    for (const slot of this.sfx) if (slot.active && slot.combat) {
      const action = combatAudioPauseAction({ active: slot.active, paused: slot.paused, started: slot.lifetime.started }, this.plan.combatPaused);
      if (action === 'cancel') { this.suppressed.canceledBeforeStart++; this.stopSlot(slot); }
      else if (action === 'pause') { slot.source.pause(); slot.paused = true; slot.running = false; }
      else if (action === 'resume') {
        slot.source.play(); slot.paused = false; slot.running = true; this.requested++; this.resumeRequests++;
      }
    }
    if (this.plan.muted) { this.stopTransient(); for (const track of this.tracks.values()) track.source.volume = 0; }
    if (this.plan.sfx === 0) for (const slot of this.sfx) this.stopSlot(slot);
    if (this.plan.voice === 0 && this.voice) this.stopSlot(this.voice);
  }
  private clearFinishedCombat(snapshot: AudioSnapshot): void {
    const identity = `${snapshot.runId}:${snapshot.wave}`;
    if ((this.sceneIdentity && identity !== this.sceneIdentity) ||
      (snapshot.phase !== this.scenePhase && closesCombatAudio(snapshot.phase))) {
      for (const slot of this.sfx) if (slot.combat) this.stopSlot(slot);
    }
    this.sceneIdentity = identity; this.scenePhase = snapshot.phase;
  }
  private consume(intents: AudioIntent[]): void {
    for (const intent of intents) {
      if (!this.catalog || !this.root) { this.suppressed.missing++; continue; }
      if (!this.unlocked) { this.suppressed.locked++; continue; }
      if (this.hidden || this.plan.suspended) { this.suppressed.suspended++; continue; }
      if (this.plan.muted || this.busVolume(intent.bus) === 0) { this.suppressed.muted++; continue; }
      // A wave-ending observe can include its final hit alongside the cards transition.
      // The committed pause admits UI/settlement cues, never a new combat PLAY to pause immediately.
      if (!admitsAudioIntent(intent.combat, this.plan.combatPaused)) { this.suppressed.paused++; continue; }
      const clips = this.catalog.audioVariants?.(intent.id) || [];
      const base = this.catalog.audio(intent.id);
      if (!base && !clips.length) { this.missing.add(intent.id); this.suppressed.missing++; continue; }
      const info = this.catalog.audioInfo(intent.id);
      const minInterval = Math.max(0, info?.minInterval ?? defaultAudioInterval(intent.id));
      if (this.realTime - (this.lastPlay.get(intent.id) ?? -Infinity) < minInterval) { this.suppressed.rateLimit++; continue; }
      const number = this.variants.get(intent.id) || 0;
      const clip = clips.length ? clips[number % clips.length] : base!;
      let slot: VoiceSlot | undefined;
      if (intent.bus === 'voice') {
        slot = this.voice;
        if (slot?.active && slot.priority <= intent.priority) { this.suppressed.polyphony++; continue; }
      } else if (intent.bus === 'music') {
        slot = this.stinger;
        if (slot?.active && slot.priority < intent.priority && !['AUD_MUS_008', 'AUD_MUS_009'].includes(intent.id)) { this.suppressed.polyphony++; continue; }
      } else {
        const index = chooseAudioSlot(this.sfx, intent.priority, intent.id);
        if (index < 0) { this.suppressed.polyphony++; continue; }
        slot = this.sfx[index];
      }
      if (!slot) continue;
      this.stopSlot(slot); slot.id = intent.id; slot.priority = intent.priority; slot.combat = intent.combat;
      slot.gain = bounded(info?.gain ?? 1); slot.source.clip = clip; slot.source.loop = false;
      slot.source.volume = this.busVolume(intent.bus) * slot.gain;
      slot.lifetime.request(Math.max(.05, clip.getDuration() || info?.duration || 1));
      slot.ready = false; slot.error = undefined;
      slot.active = true; slot.running = true; slot.paused = false; slot.started = this.realTime;
      slot.source.play(); this.requested++; this.lastPlay.set(intent.id, this.realTime); this.variants.set(intent.id, number + 1);
      if (intent.bus === 'voice' || intent.bus === 'music' || intent.priority <= 1) this.duckUntil = Math.max(this.duckUntil, this.realTime + Math.min(slot.lifetime.remaining, 2));
    }
  }
  private busVolume(bus: AudioBus): number { return this.plan.muted ? 0 : this.plan[bus]; }
  private startTrack(track: Track, seek?: number): void {
    if (track.running) return;
    if (seek !== undefined && Number.isFinite(seek)) { track.source.currentTime = seek; track.sampledTime = seek; }
    track.source.play(); track.running = true; track.started = this.realTime; this.requested++;
  }
  private pauseTrack(track: Track): void {
    track.source.volume = 0;
    if (track.running) track.source.pause(); track.running = false;
  }
  private stopSlot(slot: VoiceSlot): void {
    if (slot.active || slot.running) slot.source.stop();
    // Pending Cocos PLAY operations must not resurrect an effect after cancellation or timeout.
    if (slot.active && !slot.lifetime.started) slot.source.clip = null;
    slot.active = false; slot.running = false; slot.paused = false; slot.lifetime.reset(); slot.source.volume = 0;
  }
  private stopTransient(): void {
    for (const slot of this.sfx) this.stopSlot(slot);
    if (this.voice) this.stopSlot(this.voice); if (this.stinger) this.stopSlot(this.stinger);
  }
  private syncMusic(): void {
    if (!this.catalog || !this.unlocked || this.hidden || this.plan.suspended || this.dead) return;
    const family = this.plan.family;
    const ids = family === 'battle' ? STEMS : [family === 'boss' ? 'AUD_MUS_006' : family === 'calm' ? 'AUD_MUS_007' : 'AUD_MUS_001'];
    if (family !== this.currentFamily) {
      this.currentFamily = family; this.familyIds = ids;
      for (const [id, track] of this.tracks) if (!ids.includes(id)) this.pauseTrack(track);
      this.lastBar = -1;
    }
    // All four stems start in the same frame only after their real Cocos players report ready.
    const candidates = ids.map(id => this.tracks.get(id)).filter((v): v is Track => !!v);
    const group = readyAudioGroup(candidates);
    if (!group) return;
    // A failed stem is reported and excluded. If the whole requested family failed, use a
    // genuinely loaded menu track instead of keeping every playable source silent forever.
    if (!group.length) {
      const fallback = this.tracks.get('AUD_MUS_001');
      if (fallback?.ready && !fallback.error) group.push(fallback);
    }
    if (!group.length) return;
    if (group.some(track => !track.running)) sampleAudioClocks(Array.from(this.tracks.values()), this.realTime);
    const lead = group[0], position = lead.sampledTime;
    for (let index = 0; index < group.length; index++) {
      const track = group[index];
      // A music stinger uses one of the four permitted music voices; mute/pause peak stem temporarily.
      if (this.stinger?.active && group.length === AUDIO_LIMITS.musicLayers && index === group.length - 1) { this.pauseTrack(track); continue; }
      this.startTrack(track, index && !track.running ? position : undefined);
    }
  }
  update(realDt: number): void {
    if (this.dead || !Number.isFinite(realDt) || realDt < 0) return;
    // This is the engine's real dt, never multiplied by run.speed.
    if (!this.hidden) this.realTime += realDt;
    // Read each public clock in the same batch, including quiet stems. All other music
    // decisions and diagnostics consume this snapshot without triggering another getter.
    sampleAudioClocks(Array.from(this.tracks.values()), this.realTime);
    this.applyPausePolicy(); this.syncMusic();
    const transient = [...this.sfx, ...(this.voice ? [this.voice] : []), ...(this.stinger ? [this.stinger] : [])];
    for (const slot of transient) {
      if (!slot.active) continue;
      const life = slot.lifetime.advance(realDt, slot.paused);
      if (life === 'timeout') {
        slot.error = 'AudioSource STARTED timed out after 10000 ms';
        this.playbackErrors.push(`${slot.id}: ${slot.error}`); this.stopSlot(slot); continue;
      }
      if (life === 'ended') { this.stopSlot(slot); continue; }
      if (slot.paused) continue;
      slot.source.volume = this.busVolume(slot.bus) * slot.gain;
    }
    const shouldDuck = !!this.voice?.active || !!this.stinger?.active || this.realTime < this.duckUntil;
    const duckTarget = shouldDuck ? .5 : 1;
    this.duck += (duckTarget - this.duck) * Math.min(1, realDt * (shouldDuck ? 14 : 4));
    const lead = this.tracks.get('AUD_MUS_002');
    const bpm = this.catalog?.audioInfo('AUD_MUS_002')?.bpm;
    if (lead?.running && bpm) {
      const barSeconds = 60 / bpm * 4, bar = Math.floor(lead.sampledTime / barSeconds);
      if (this.pendingDensity !== this.plan.intensity) { this.pendingDensity = this.plan.intensity; this.pendingDensityAt = this.realTime; }
      if (bar !== this.lastBar && this.realTime - this.densityChangedAt >= barSeconds * 4 &&
        this.realTime - this.pendingDensityAt >= barSeconds) {
        this.density = this.pendingDensity; this.densityChangedAt = this.realTime;
      }
      this.lastBar = bar;
      if (this.realTime - this.lastSyncAt >= 1 && this.familyIds.length === 4) this.correctStemDrift();
    }
    for (const [id, track] of this.tracks) {
      if (!track.running) { track.source.volume = 0; continue; }
      let gain = 1;
      if (id === 'AUD_MUS_004') gain = this.density >= 1 && !this.plan.combatPaused ? 1 : 0;
      if (id === 'AUD_MUS_005') gain = this.density >= 2 && !this.plan.combatPaused ? 1 : 0;
      if (this.plan.family === 'result') gain *= .3;
      const target = this.hidden || this.plan.suspended ? 0 : this.busVolume('music') * track.gain * this.plan.quiet * this.duck * gain;
      track.source.volume += (target - track.source.volume) * Math.min(1, realDt * 7);
      if (this.plan.muted) track.source.volume = 0;
      const info = this.catalog?.audioInfo(id);
      const duration = track.source.clip?.getDuration() || info?.duration || 0;
      if (info?.loopEnd && info.loopEnd < duration - .01 && track.sampledTime >= info.loopEnd) {
        const start = info.loopStart || 0; track.source.currentTime = start + (track.sampledTime - info.loopEnd);
      }
    }
  }
  private correctStemDrift(): void {
    this.lastSyncAt = this.realTime;
    const group = STEMS.map(id => this.tracks.get(id)).filter((v): v is Track => !!v && v.running && v.source.playing);
    if (group.length < 2) return;
    const position = group[0].sampledTime, duration = group[0].source.clip?.getDuration() || 0;
    this.driftSeconds = 0;
    for (const track of group.slice(1)) {
      const raw = Math.abs(track.sampledTime - position);
      const drift = duration ? Math.min(raw, Math.abs(duration - raw)) : raw;
      this.driftSeconds = Math.max(this.driftSeconds, drift);
      // Public seek correction is deliberately visible in diagnostics; no sample-perfect claim.
      if (drift > .04 && this.realTime - track.lastStartAt > .25) {
        this.syncCorrectionEvents.push({ at: this.realTime, id: track.id, observedDrift: drift, leaderTime: position, trackTime: track.sampledTime });
        if (this.syncCorrectionEvents.length > 20) this.syncCorrectionEvents.shift();
        track.source.currentTime = position; this.syncCorrections++;
      }
    }
  }
  status(): any {
    const inspect = (track: Track) => ({ id: track.id, playing: track.source.playing, requestedPlaying: track.running,
      currentTime: this.tracks.has(track.id) ? track.sampledTime : track.source.currentTime,
      currentTimeSampledAt: this.tracks.has(track.id) ? track.sampledAt : this.realTime,
      volume: track.source.volume, clipLoaded: !!track.source.clip,
      ready: track.ready, actualStartedEvents: track.actualStarts, error: track.error || null });
    return { initialized: !!this.root, unlocked: this.unlocked, background: this.hidden, suspended: this.plan.suspended,
      muted: this.plan.muted, buses: { music: this.plan.music, sfx: this.plan.sfx, voice: this.plan.voice }, family: this.currentFamily,
      music: Array.from(this.tracks.values()).map(inspect), stems: STEMS.map(id => this.tracks.get(id)).filter((t): t is Track => !!t).map(inspect),
      activeSfx: this.sfx.filter(s => s.active).map(s => ({ ...inspect(s), priority: s.priority, paused: s.paused })),
      voice: this.voice?.active ? inspect(this.voice) : null, stinger: this.stinger?.active ? inspect(this.stinger) : null,
      requestedPlayCount: this.requested, resumePlayCount: this.resumeRequests,
      actualStartedEvents: this.actualStarts, suppressed: { ...this.suppressed },
      missing: Array.from(this.missing).sort(), playbackErrors: [...this.playbackErrors], realTime: this.realTime, musicDuck: this.duck,
      synchronization: { metadataMatches: this.syncMetadataValid, issues: [...this.syncIssues], observedDriftSeconds: this.driftSeconds,
        correctionCount: this.syncCorrections, recentCorrections: this.syncCorrectionEvents.map(e => ({ ...e })),
        method: 'Cocos public AudioSource same-frame start and batched public-clock samples plus measured seek correction; not sample-accurate scheduling' } };
  }
  destroy(): void {
    this.dead = true; this.stopTransient();
    for (const track of this.tracks.values()) { track.cancelReadiness?.(); track.source.stop(); track.node.destroy(); }
    this.tracks.clear(); this.sfx = []; this.voice = undefined; this.stinger = undefined;
    this.root?.destroy(); this.root = undefined; this.catalog = undefined; this.latest = undefined;
    this.currentFamily = ''; this.familyIds = []; this.router.reset();
  }
}
