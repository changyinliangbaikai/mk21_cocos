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
  private burstAt = -10; private burstVoices = 0;
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
  emit(event: string, overrideIds?: string[], priority = false): void {
    if (this.dead || !this.unlocked || this.suspended || this.settings?.sound === false || this.elapsed - (this.last.get(event) ?? -10) < .1) return;
    this.last.set(event, this.elapsed);
    const ids = overrideIds || this.events.find(e => e.event === event)?.audioIds || [], at = this.elapsed, generation = this.generation;
    if (this.elapsed - this.burstAt >= .06) { this.burstAt = this.elapsed; this.burstVoices = 0; }
    for (const id of ids.slice(0, 2)) void this.clip(id).then(clip => {
      if (!clip || this.dead || this.suspended || this.settings?.sound === false || this.generation !== generation || this.elapsed - at > .2) return;
      if (!priority && this.burstVoices >= 3) return;
      const voices = priority ? this.sources.slice(6) : this.sources.slice(0, 6);
      const voice = voices.find(s => !s.playing); if (!voice) return;
      this.burstVoices++;
      voice.clip = clip; voice.volume = Math.min(priority ? .7 : .48, this.entries.find(a => a.id === id)?.gain ?? .6); voice.play();
    });
  }
  battleEvent(e: BattleEvent): void {
    const mapped: Record<string, string> = { deploy: 'hero_deploy', draft: 'card_reveal', 'card-picked': 'card_selected', wave: 'wave_first_spawn', 'enemy-death': 'enemy_final_death', 'ally-hit': 'hero_hit', revive: 'revive', summon: 'summon_spawn', 'boss-command': 'boss_command' };
    const expansion:Record<string,string[]>={RH07:['AUD_SFX_024'],RH08:['AUD_SFX_019'],RH09:['AUD_SFX_013'],RH10:['AUD_SFX_020']};
    if(e.type==='group-impact'){const sounds:Record<string,string>={RH01:'AUD_SFX_016',RH02:'AUD_SFX_013',RH03:'AUD_SFX_020',RH04:'AUD_SFX_022',RH05:'AUD_SFX_019',RH06:'AUD_SFX_017',RH07:'AUD_SFX_024',RH08:'AUD_SFX_019',RH09:'AUD_SFX_013',RH10:'AUD_SFX_020'};this.emit('group-'+e.source,[sounds[e.source.slice(0,4)]||'AUD_SFX_027']);}
    else if(['beam-hit','frost-cone','skill-pulse'].includes(e.type)||e.type==='area-impact'&&e.source==='RH09-S2')this.emit(e.source,expansion[e.source.slice(0,4)],true);
    else if(e.type==='hero-attack'&&expansion[e.source.slice(0,4)])this.emit(e.source,[e.source.startsWith('RH09')?'AUD_SFX_012':'AUD_SFX_018']);
    else if (e.type === 'hero-skill-windup') this.emit('cast-whoosh', [e.source.startsWith('RH01') ? 'AUD_SFX_015' : 'AUD_SFX_012']);
    else if (e.type === 'area-impact') this.emit('corn-impact', ['AUD_SFX_013'], true);
    else if (e.type === 'enemy-hit' && /-S1$/.test(e.source)) this.emit('light-impact', ['AUD_SFX_027']);
    else if (e.type === 'hero-skill' && e.source.startsWith('RH01')) this.emit(e.source, [e.source.endsWith('S3') ? 'AUD_SFX_017' : 'AUD_SFX_016'], true);
    else if (e.type === 'hero-skill' || e.type === 'boss-skill') this.emit(e.source, undefined, true);
    else if (e.type === 'chain-hit') this.emit('shoe-impact', ['AUD_SFX_022'], true);
    else if (e.type === 'hero-attack' || e.type === 'enemy-attack') this.emit(e.source);
    else if (e.type === 'global-cast') this.emit('global_' + e.source, undefined, true);
    else if (mapped[e.type]) this.emit(mapped[e.type]);
  }
  destroy(): void { this.dead = true; this.generation++; this.music.stop(); this.sources.forEach(s => s.stop()); }
}
