import { AudioClip, ImageAsset, JsonAsset, Rect, Size, SpriteFrame, Texture2D, resources } from 'cc';
import { firstAvailableAudio, type CallbackLoader } from './AssetLoadPolicy';

export interface ArtFrame { rect: [number, number, number, number]; duration: number }
export interface ArtEntry {
  id: string; kind: string; resource: string; file?: string; width?: number; height?: number;
  anchor?: [number, number]; border?: [number, number, number, number]; fps?: number;
  frames?: Record<string, ArtFrame[]>;
  designRect?: [number, number, number, number];
  referenceCanvas?: [number, number];
  semanticLabel?: string;
}
export interface AudioEntry {
  id: string; kind: 'audio'; resource: string; file?: string;
  bus: 'music' | 'sfx' | 'voice'; gain: number; loop: boolean; bpm?: number; syncGroup?: string;
  duration?: number; sampleRate?: number; channels?: number; loopStart?: number; loopEnd?: number;
  variants?: string[]; fallbackResources?: string[]; minInterval?: number; priority?: number;
  productionPriority?: string;
}
export interface CatalogReport {
  loaded: string[]; missing: string[]; errors: string[]; loadedArt: number; loadedAudio: number;
  warnings: string[]; fallbacksUsed: string[];
  loadedRecipes: number;
}
interface RuntimeManifest { schemaVersion: number; assets: (ArtEntry | AudioEntry)[]; expectedIds?: string[]; recipesResource?: string }
export interface LoadedArtFrame { frame: SpriteFrame; duration: number }

/** Presentation-only catalog. No gameplay commands, random numbers, or fabricated resource metadata. */
export class AssetCatalog {
  private readonly artEntries = new Map<string, ArtEntry>();
  private readonly audioEntries = new Map<string, AudioEntry>();
  private readonly images = new Map<string, SpriteFrame>();
  private readonly sequences = new Map<string, Record<string, LoadedArtFrame[]>>();
  private readonly clips = new Map<string, AudioClip[]>();
  private readonly status: CatalogReport = { loaded: [], missing: [], errors: [], loadedArt: 0, loadedAudio: 0, warnings: [], fallbacksUsed: [], loadedRecipes: 0 };
  private loading: Promise<void> | null = null;
  private audioDeadline = Infinity;
  private recipeData: any = null;

  load(): Promise<void> {
    if (!this.loading) this.loading = Promise.all([this.loadGroup('art'), this.loadGroup('audio')]).then(() => undefined);
    return this.loading;
  }
  image(id: string): SpriteFrame | null { return this.images.get(id) ?? null; }
  art(id: string): ArtEntry | undefined { return this.artEntries.get(id); }
  audio(id: string): AudioClip | null { return this.clips.get(id)?.[0] ?? null; }
  audioInfo(id: string): AudioEntry | undefined { return this.audioEntries.get(id); }
  audioVariants(id: string): AudioClip[] { return [...(this.clips.get(id) ?? [])]; }
  vfxRecipes(): any | null { return this.recipeData; }
  frames(id: string, action: string): LoadedArtFrame[] { return [...(this.sequences.get(id)?.[action] ?? [])]; }
  report(): CatalogReport {
    return { ...this.status, loaded: [...this.status.loaded], missing: [...this.status.missing], errors: [...this.status.errors], warnings: [...this.status.warnings], fallbacksUsed: [...this.status.fallbacksUsed] };
  }

  private missing(id: string): void { if (!this.status.missing.includes(id)) this.status.missing.push(id); }
  private async loadGroup(group: 'art' | 'audio'): Promise<void> {
    const url = `mvp/${group}/manifest`;
    try {
      const json = await new Promise<JsonAsset>((resolve, reject) => resources.load(url, JsonAsset, (error, asset) => error || !asset ? reject(error ?? new Error(`missing ${url}`)) : resolve(asset)));
      const manifest = json.json as unknown as RuntimeManifest;
      if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) throw new Error('unsupported runtime manifest; run tools/import-mvp-assets.mjs');
      const entries = manifest.assets;
      // A codec failure in Creator 3.8 can leave its callback pending forever. Audio cannot block the camp indefinitely.
      if (group === 'audio') this.audioDeadline = Date.now() + 12000;
      const seen = new Set<string>();
      for (const entry of entries) {
        if (!entry || typeof entry.id !== 'string' || typeof entry.resource !== 'string' || !entry.resource.startsWith(`mvp/${group}/`) || entry.resource.includes('..') || seen.has(entry.id)) throw new Error('invalid or duplicate runtime asset entry');
        seen.add(entry.id);
      }
      for (const id of manifest.expectedIds ?? []) if (!seen.has(id)) this.missing(id);
      // Bound decode concurrency: production audio contains dozens of files.
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < entries.length) {
          const entry = entries[cursor++];
          try {
            if (group === 'art') await this.loadArt(entry as ArtEntry);
            else await this.loadAudio(entry as AudioEntry);
            this.status.loaded.push(entry.id);
          } catch (error) {
            this.missing(entry.id);
            this.status.errors.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, entries.length) }, () => worker()));
      if (group === 'art' && manifest.recipesResource) {
        try {
          if (manifest.recipesResource !== 'mvp/art/vfx-recipes') throw new Error('unexpected VFX recipe resource path');
          const json = await new Promise<JsonAsset>((resolve, reject) => resources.load(manifest.recipesResource!, JsonAsset, (error, asset) => error || !asset ? reject(error ?? new Error('VFX recipes missing')) : resolve(asset)));
          const data = json.json as any;
          if (data?.schemaVersion !== 1 || !Array.isArray(data.recipes)) throw new Error('invalid VFX recipe schema');
          this.recipeData = data;
          this.status.loadedRecipes = data.recipes.length;
        } catch (error) {
          this.missing('vfx-recipes');
          this.status.errors.push(`vfx-recipes: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      this.missing(`manifest:${group}`);
      this.status.errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async loadArt(entry: ArtEntry): Promise<void> {
    this.artEntries.set(entry.id, entry);
    const asset = await new Promise<ImageAsset>((resolve, reject) => resources.load(entry.resource, ImageAsset, (error, image) => error || !image ? reject(error ?? new Error('image missing')) : resolve(image)));
    const texture = new Texture2D();
    texture.image = asset;
    const make = (rect: [number, number, number, number]): SpriteFrame => {
      const [x, y, width, height] = rect;
      if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > asset.width || y + height > asset.height) throw new Error('frame rectangle exceeds decoded image');
      const frame = new SpriteFrame();
      frame.texture = texture;
      // Creator 3.8 SpriteFrame UVs use texture top-left rect coordinates (no Y flip).
      frame.rect = new Rect(x, y, width, height);
      frame.originalSize = new Size(width, height);
      if (entry.border) [frame.insetLeft, frame.insetBottom, frame.insetRight, frame.insetTop] = entry.border;
      return frame;
    };
    const actions: Record<string, LoadedArtFrame[]> = {};
    for (const action of Object.keys(entry.frames ?? {})) actions[action] = entry.frames![action].map(frame => ({ frame: make(frame.rect), duration: frame.duration }));
    this.sequences.set(entry.id, actions);
    this.images.set(entry.id, actions.idle?.[0]?.frame ?? make([0, 0, asset.width, asset.height]));
    this.status.loadedArt++;
  }

  private async loadAudio(entry: AudioEntry): Promise<void> {
    this.audioEntries.set(entry.id, entry);
    const loader: CallbackLoader<AudioClip> = (url, complete) => resources.load(url, AudioClip, complete);
    const timeout = (): number => Math.min(3500, this.audioDeadline - Date.now());
    const alternatives = entry.fallbackResources ?? [];
    let candidates = [entry.resource, ...alternatives];
    // Public HTML API only; mini-game hosts without a DOM keep the normal bounded attempt/fallback order.
    if (entry.file?.toLowerCase().endsWith('.ogg') && alternatives.length && typeof document !== 'undefined') {
      try {
        const probe = document.createElement('audio');
        if (typeof probe.canPlayType === 'function' && probe.canPlayType('audio/ogg; codecs="vorbis"') === '') {
          candidates = [...alternatives, entry.resource];
          this.status.warnings.push(`${entry.id}: browser reports OGG/Vorbis unsupported; trying compatible fallback first`);
        }
      } catch { /* Capability probing is optional; the bounded loader remains authoritative. */ }
    }
    const loaded = await firstAvailableAudio(candidates, loader, timeout);
    for (const failure of loaded.failures) this.status.warnings.push(`${entry.id}: ${failure}`);
    if (loaded.resource !== entry.resource) this.status.fallbacksUsed.push(`${entry.id}: ${loaded.resource}`);
    const variants = [loaded.value];
    for (const url of entry.variants ?? []) {
      try { const clip = (await firstAvailableAudio([url], loader, timeout)).value; if (!variants.includes(clip)) variants.push(clip); }
      catch (error) { this.status.errors.push(`${entry.id} variant ${url}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.clips.set(entry.id, variants);
    this.status.loadedAudio++;
  }
}
