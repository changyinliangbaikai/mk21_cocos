import { Asset, ImageAsset, JsonAsset, Rect, Size, SpriteFrame, Texture2D, resources } from 'cc';

export interface R1Frame { rect: number[]; ratio: number; widthRatio?: number; heightRatio?: number; anchor: number[] }
export interface R1Atlas { id: string; resource: string; group: string; kind: string; frames: R1Frame[]; displayHeight?: number; clips: Record<string, { frames: number[]; secondsPerFrame: number; loop?: boolean; holdLast?: boolean }> }
export interface R1Manifest { atlases: R1Atlas[]; audioEvents: { event: string; audioIds: string[] }[] }
export function loadR1<T extends Asset>(url: string, type: new (...args: any[]) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    let complete = false;
    const timer = setTimeout(() => { if (!complete) { complete = true; reject(new Error(`资源加载超时：${url}`)); } }, 15000);
    resources.load(url, type, (error, value) => {
      if (complete) return; complete = true; clearTimeout(timer);
      if (error || !value) reject(error || new Error(`缺少资源：${url}`)); else resolve(value);
    });
  });
}
export class R1Assets {
  manifest: R1Manifest = { atlases: [], audioEvents: [] };
  private frames = new Map<string, SpriteFrame[]>();
  private textures: Texture2D[] = [];
  private images: ImageAsset[] = [];
  private pending = new Map<string, Promise<void>>();
  async init(): Promise<void> { this.manifest = (await loadR1('r1/manifest', JsonAsset)).json as unknown as R1Manifest; await this.loadGroup('ui'); }
  async loadGroup(group: string): Promise<void> {
    const rows = this.manifest.atlases.filter(a => (a.group === group || group === 'ui' && ['RS01', 'RM01'].includes(a.id)) && !this.frames.has(a.id));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (cursor < rows.length) {
        const a = rows[cursor++];
        if (!this.pending.has(a.id)) this.pending.set(a.id, this.loadAtlas(a).finally(() => this.pending.delete(a.id)));
        await this.pending.get(a.id);
      }
    }));
  }
  private async loadAtlas(a: R1Atlas): Promise<void> {
    const image = await loadR1(a.resource, ImageAsset); image.addRef(); this.images.push(image);
    const texture = new Texture2D(); texture.image = image; this.textures.push(texture);
    const frames = a.frames.map(f => {
      const [x, y, w, h] = f.rect, sf = new SpriteFrame(); sf.texture = texture; sf.rect = new Rect(x, y, w, h); sf.originalSize = new Size(w, h);
      if (a.id === 'UI-PANELS' && (f === a.frames[0] || f === a.frames[2])) {
        const border = Math.min(w, h) * .16; sf.insetLeft = sf.insetRight = sf.insetTop = sf.insetBottom = border;
      }
      return sf;
    });
    this.frames.set(a.id, frames);
  }
  info(id: string): R1Atlas | undefined { return this.manifest.atlases.find(a => a.id === id); }
  frame(id: string, i = 0): SpriteFrame | null { return this.frames.get(id)?.[i] || null; }
  pose(id: string, action: string, time: number): number {
    const a = this.info(id), clip = a?.clips[action] || a?.clips.idle || a?.clips.move;
    if (!clip) return 0;
    const frame = Math.floor(Math.max(0, time) / clip.secondsPerFrame);
    return clip.frames[clip.loop ? frame % clip.frames.length : Math.min(clip.frames.length - 1, frame)];
  }
  report(): object { return { loadedAtlases: this.frames.size, expectedAtlases: this.manifest.atlases.length, textureBytes: this.textures.reduce((n, t) => n + t.width * t.height * 4, 0) }; }
  destroy(): void { for (const frames of this.frames.values()) frames.forEach(f => f.destroy()); this.frames.clear(); this.textures.forEach(t => t.destroy()); this.images.forEach(i => i.decRef()); }
}
