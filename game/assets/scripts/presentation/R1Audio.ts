import { AudioClip, AudioSource, JsonAsset, Node } from 'cc';
import { BattleEvent, Profile, Run } from '../domain/r1/model';
import { loadR1 } from './R1Assets';

interface Entry { id: string; resource: string; fallbackResources?: string[]; gain: number }
/** Audio observes logic events. It never advances a battle or a transaction. */
export class R1Audio {
  private entries: Entry[] = [];
  private clips = new Map<string, Promise<AudioClip | null>>();
  private sources: AudioSource[] = [];
  private music: AudioSource;
  private last = new Map<string, number>();
  private elapsed = 0; private unlocked = false; private suspended = false; private generation = 0;
  private track = ''; private dead = false; private settings?: Profile;
  readonly errors: string[] = [];
  constructor(private root: Node, private events: { event: string; audioIds: string[] }[]) {
    const n = new Node('R1Music'); n.setParent(root); this.music = n.addComponent(AudioSource); this.music.playOnAwake = false;
    for (let i = 0; i < 8; i++) { const n = new Node(`R1Sound${i}`); n.setParent(root); const s = n.addComponent(AudioSource); s.playOnAwake = false; this.sources.push(s); }
  }
  async init(): Promise<void> {
    try { this.entries = ((await loadR1('mvp/audio/manifest', JsonAsset)).json as any).assets; await this.clip('AUD_MUS_001'); }
    catch (e) { this.errors.push(String(e)); }
  }
  private clip(id: string): Promise<AudioClip | null> {
    if (!this.clips.has(id)) this.clips.set(id, (async () => {
      const e = this.entries.find(a => a.id === id); if (!e) return null;
      // MP3 fallback is preferred on mobile WebAudio; effects may already be WAV/MP3.
      for (const url of [...(e.fallbackResources || []), e.resource]) try { return await loadR1(url, AudioClip); } catch { /* Try the bundled codec alternative. */ }
      this.errors.push(`音频不可用：${id}`); return null;
    })());
    return this.clips.get(id)!;
  }
  gesture(): void { this.unlocked = true; }
  hide(): void { this.suspended = true; this.generation++; this.music.pause(); this.sources.forEach(s => s.stop()); }
  show(): void { this.suspended = false; this.track = ''; }
  update(dt: number, p: Profile, r: Run | null, inBattle: boolean): void {
    this.elapsed += Math.min(.25, dt); this.settings = p;
    const paused = this.suspended || !!(inBattle && r && (r.paused || r.rescue));
    const track = !p.music || !this.unlocked || paused ? '' : !inBattle || !r ? 'AUD_MUS_001' : r.status === 'victory' ? 'AUD_MUS_008' : r.status === 'defeat' ? 'AUD_MUS_009' : r.enemies.some(e => e.id.startsWith('RL')) ? 'AUD_MUS_006' : 'AUD_MUS_002';
    if (track !== this.track) {
      this.track = track; this.generation++; this.music.stop(); const generation = this.generation;
      if (track) void this.clip(track).then(clip => {
        if (!clip || this.dead || this.generation !== generation || this.suspended) return;
        this.music.clip = clip; this.music.loop = !['AUD_MUS_008', 'AUD_MUS_009'].includes(track); this.music.volume = .45; this.music.play();
      });
    }
    if (paused || !p.sound) this.sources.forEach(s => s.stop());
  }
  emit(event: string): void {
    if (this.dead || !this.unlocked || this.suspended || this.settings?.sound === false || this.elapsed - (this.last.get(event) ?? -10) < .1) return;
    this.last.set(event, this.elapsed);
    const ids = this.events.find(e => e.event === event)?.audioIds || [], at = this.elapsed, generation = this.generation;
    for (const id of ids.slice(0, 2)) void this.clip(id).then(clip => {
      if (!clip || this.dead || this.suspended || this.settings?.sound === false || this.generation !== generation || this.elapsed - at > .2) return;
      const voice = this.sources.find(s => !s.playing); if (!voice) return;
      voice.clip = clip; voice.volume = Math.min(.7, this.entries.find(a => a.id === id)?.gain ?? .6); voice.play();
    });
  }
  battleEvent(e: BattleEvent): void {
    const mapped: Record<string, string> = { deploy: 'hero_deploy', draft: 'card_reveal', 'card-picked': 'card_selected', wave: 'wave_first_spawn', 'enemy-death': 'enemy_final_death', 'ally-hit': 'hero_hit', revive: 'revive', summon: 'summon_spawn', 'boss-command': 'boss_command' };
    if (e.type === 'hero-attack' || e.type === 'hero-skill' || e.type === 'enemy-attack' || e.type === 'boss-skill') this.emit(e.source);
    else if (e.type === 'global-cast') this.emit('global_' + e.source);
    else if (mapped[e.type]) this.emit(mapped[e.type]);
  }
  destroy(): void { this.dead = true; this.generation++; this.music.stop(); this.sources.forEach(s => s.stop()); }
}
