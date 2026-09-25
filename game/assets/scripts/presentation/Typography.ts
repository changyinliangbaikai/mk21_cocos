import { Font, JsonAsset, Label, TTFFont, Vec2, resources } from 'cc';
import { color } from './ToyVisuals';

export type TextRole = 'body' | 'caption' | 'section' | 'name' | 'number' | 'button' | 'buttonBody' | 'cta' | 'nav' | 'titleOutline' | 'titleDepth' | 'titleFace';
type FontId = 'FONT_DISPLAY' | 'FONT_BODY';
interface FontEntry { id: FontId; resource: string; family?: string; sha256?: string }
interface TextStyle { font: FontId; lineHeight: number; fill?: string; outline?: { color: string; width: number }; shadow?: { color: string; x: number; y: number } }

// Semantic roles are deliberate; font weight and decoration never depend on a size threshold.
const STYLES: Record<TextRole, TextStyle> = {
  body: { font: 'FONT_BODY', lineHeight: 1.25 },
  caption: { font: 'FONT_BODY', lineHeight: 1.2 },
  section: { font: 'FONT_DISPLAY', lineHeight: 1.18, fill: '#092138' },
  name: { font: 'FONT_DISPLAY', lineHeight: 1.16, fill: '#092138' },
  number: { font: 'FONT_DISPLAY', lineHeight: 1.16 },
  button: { font: 'FONT_DISPLAY', lineHeight: 1.16 },
  buttonBody: { font: 'FONT_BODY', lineHeight: 1.14 },
  cta: { font: 'FONT_DISPLAY', lineHeight: 1.16, fill: '#071E34' },
  nav: { font: 'FONT_DISPLAY', lineHeight: 1.16, fill: '#071E34' },
  titleOutline: { font: 'FONT_DISPLAY', lineHeight: 1.1, fill: '#EE8D15', outline: { color: '#081B2C', width: 8 }, shadow: { color: '#071725', x: 0, y: -7 } },
  titleDepth: { font: 'FONT_DISPLAY', lineHeight: 1.1, fill: '#F39415', outline: { color: '#F39415', width: 3 } },
  titleFace: { font: 'FONT_DISPLAY', lineHeight: 1.1, fill: '#FFD53A', outline: { color: '#FFF2B5', width: 0.7 } },
};

/** Real bundled TTFs, loaded before the first game screen. No system-font substitution is reported as success. */
export class Typography {
  constructor(private resourceRoot = 'mvp/fonts') {}
  private fonts = new Map<FontId, Font>();
  private entries = new Map<FontId, FontEntry>();
  private errors: string[] = [];
  private familyOwners = new Map<string, FontId>();
  private webReadiness = new Map<FontId, { family: string; status: string; loadedFaces: number }>();
  private info = new WeakMap<Label, { role: TextRole; fontId: FontId; requestedSize: number }>();

  async load(): Promise<void> {
    try {
      const manifest = await this.asset(`${this.resourceRoot}/manifest`, JsonAsset) as JsonAsset;
      const data = manifest.json as any;
      if (data?.schemaVersion !== 1 || !Array.isArray(data.assets)) throw new Error('invalid runtime font manifest');
      await Promise.all((['FONT_DISPLAY', 'FONT_BODY'] as FontId[]).map(async id => {
        try {
          const entry = data.assets.find((value: FontEntry) => value.id === id) as FontEntry | undefined;
          if (!entry || typeof entry.resource !== 'string' || !entry.resource.startsWith(`${this.resourceRoot}/`) || entry.resource.includes('..')) throw new Error(`invalid font entry ${id}`);
          this.entries.set(id, entry);
          const font = await this.asset(entry.resource, TTFFont) as Font;
          await this.waitForWebFont(id, font);
          this.fonts.set(id, font);
        } catch (error) { this.errors.push(`${id}: ${String(error)}`); }
      }));
    } catch (error) { this.errors.push(String(error)); }
  }
  private async waitForWebFont(id: FontId, font: Font): Promise<void> {
    if (typeof document === 'undefined' || !document.fonts) return;
    // Creator 3.8.8 font-loader.ts derives its CSS family from the native URL.
    // Its callback can report success after a timeout; inspect the real FontFaceSet too.
    const basename = font.nativeUrl.substring(font.nativeUrl.lastIndexOf('/') + 1);
    const ttf = basename.lastIndexOf('.ttf');
    if (ttf < 0) throw new Error(`${id}: expected a native TTF URL`);
    const family = `${basename.substring(0, ttf)}_LABEL`;
    const owner = this.familyOwners.get(family);
    if (owner && owner !== id) throw new Error(`${id}: font family collision with ${owner}; use unique TTF filenames`);
    this.familyOwners.set(family, id);
    const matching: FontFace[] = [];
    document.fonts.forEach(face => { if (face.family.replace(/^['"]|['"]$/g, '') === family) matching.push(face); });
    if (!matching.length) throw new Error(`${id}: Creator CSS FontFace absent (${family})`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const resolved = await Promise.race([
        document.fonts.load(`40px "${family}"`, '超力英雄0123456789Lv+%'),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${id}: browser FontFace readiness timed out`)), 6000); }),
      ]);
      if (!resolved.length || resolved.some(face => face.family.replace(/^['"]|['"]$/g, '') !== family || face.status !== 'loaded')) throw new Error(`${id}: expected actual loaded FontFace results`);
    } finally { if (timer) clearTimeout(timer); }
    const loadedFaces = matching.filter(face => face.status === 'loaded').length;
    this.webReadiness.set(id, { family, status: loadedFaces ? 'loaded' : 'not-loaded', loadedFaces });
    if (!loadedFaces || !document.fonts.check(`40px "${family}"`, '超力英雄0123456789Lv+%')) throw new Error(`${id}: real browser font not ready`);
  }
  private asset(url: string, type: any): Promise<Font | JsonAsset> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => { if (!settled) { settled = true; reject(new Error(`font load timeout: ${url}`)); } }, 6000);
      resources.load(url, type, (error: Error | null, asset: any) => {
        if (settled) return; settled = true; clearTimeout(timeout);
        if (error || !asset) reject(error || new Error(`font resource missing: ${url}`)); else resolve(asset);
      });
    });
  }
  apply(label: Label, role: TextRole, size: number, fill: string): void {
    const style = STYLES[role], font = this.fonts.get(style.font);
    label.fontSize = size; label.lineHeight = size * style.lineHeight;
    label.isBold = false; label.isItalic = false; label.cacheMode = Label.CacheMode.NONE;
    if (font) { label.font = font; label.useSystemFont = false; }
    else { label.useSystemFont = true; label.fontFamily = 'sans-serif'; }
    label.color = color(style.fill || fill);
    label.enableOutline = !!style.outline;
    if (style.outline) { label.outlineColor = color(style.outline.color); label.outlineWidth = style.outline.width; }
    label.enableShadow = !!style.shadow;
    if (style.shadow) { label.shadowColor = color(style.shadow.color); label.shadowOffset = new Vec2(style.shadow.x, style.shadow.y); label.shadowBlur = 0; }
    label.horizontalAlign = Label.HorizontalAlign.CENTER; label.verticalAlign = Label.VerticalAlign.CENTER;
    label.overflow = role.startsWith('title') ? Label.Overflow.CLAMP : Label.Overflow.SHRINK;
    label.enableWrapText = !role.startsWith('title');
    this.info.set(label, { role, fontId: style.font, requestedSize: size });
  }
  describe(label: Label): any {
    const info = this.info.get(label);
    return info ? { ...info, text: label.string, fontLoaded: this.fonts.has(info.fontId), isSystemFont: label.useSystemFont, systemFontFamily: label.fontFamily, renderFamily: this.webReadiness.get(info.fontId)?.family || this.entries.get(info.fontId)?.family, fontAsset: label.font?.name, fontSize: label.fontSize, actualFontSize: label.actualFontSize, lineHeight: label.lineHeight, isBold: label.isBold, outline: label.enableOutline ? { width: label.outlineWidth, color: label.outlineColor.toHEX() } : null, shadow: label.enableShadow, overflow: label.overflow } : null;
  }
  report(): any {
    return { loaded: Array.from(this.fonts.keys()), errors: [...this.errors], fonts: Array.from(this.entries.values()).map(entry => ({ ...entry, loaded: this.fonts.has(entry.id), assetName: this.fonts.get(entry.id)?.name, webReadiness: this.webReadiness.get(entry.id) || null })) };
  }
}
