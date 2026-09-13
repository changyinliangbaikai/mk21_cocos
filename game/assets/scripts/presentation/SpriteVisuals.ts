import { Color, Graphics, Label, Layers, Material, Node, Sprite, SpriteFrame, UITransform, gfx } from 'cc';
import { color, Palette as P, round, shape } from './ToyVisuals';
import { hitFeedback, visualAssetId } from './VfxEvents';

export type VisualAction = 'idle' | 'attack' | 'victory' | 'walk' | 'hit' | 'tell' | 'impact' | 'cane_raise' | 'cane_strike';
export type VisualFrame = { frame: SpriteFrame; duration: number };
export interface VisualCatalog {
  image(id: string): SpriteFrame | null;
  art(id: string): any;
  frames(id: string, action: string): VisualFrame[];
}

/** A loaded image, its ground anchor and its presentation-only action state. */
export class SpriteActor {
  readonly node: Node;
  readonly body: Node;
  readonly sprite: Sprite | null;
  readonly assetId: string;
  readonly maxWidth: number;
  readonly maxHeight: number;
  private readonly catalog: VisualCatalog;
  private readonly scale: number;
  private action: VisualAction = 'idle';
  private lastFrame: SpriteFrame | null = null;
  private hitKey = '';
  private hitStarted = -Infinity;
  private hitStrength = 1;
  private hitFlash = true;
  private hitState = hitFeedback(-Infinity);
  private glow?: Sprite;
  private static glowMaterial?: Material;
  private baseTint: string | null = null;

  constructor(catalog: VisualCatalog, parent: Node, name: string, assetId: string, x: number, y: number, width: number, height: number, groundShadow: boolean) {
    this.catalog = catalog; this.assetId = visualAssetId(assetId); this.maxWidth = width; this.maxHeight = height;
    this.baseTint = assetId === 'B002' ? '#FFD9AE' : null;
    this.node = new Node(name); this.node.layer = Layers.Enum.UI_2D; this.node.setParent(parent); this.node.setPosition(x, y);
    const rootTransform = this.node.addComponent(UITransform); rootTransform.setContentSize(width, height); rootTransform.setAnchorPoint(.5, .12);
    if (groundShadow) {
      const g = shape(this.node, 'GroundShadow', 0, 0, width, 16).g;
      g.fillColor = color('#253846', 32); g.ellipse(0, 0, width * .33, Math.max(4, width * .075)); g.fill();
    }
    this.body = new Node(`Sprite-${assetId}`); this.body.layer = Layers.Enum.UI_2D; this.body.setParent(this.node);
    const transform = this.body.addComponent(UITransform), frame = catalog.image(this.assetId), metadata = catalog.art(this.assetId);
    if (!frame) {
      // Missing production art is a labeled loading/missing state, never a drawn substitute character.
      transform.setContentSize(width, height * .6); this.body.setPosition(0, height * .28);
      const label = this.body.addComponent(Label); label.string = `${assetId}\n素材待接入`; label.fontSize = 19; label.lineHeight = 25;
      label.horizontalAlign = Label.HorizontalAlign.CENTER; label.verticalAlign = Label.VerticalAlign.CENTER;
      label.overflow = Label.Overflow.SHRINK; label.color = color(P.muted);
      this.sprite = null; this.scale = 1; return;
    }
    const natural = frame.originalSize, w = Math.max(1, natural.width), h = Math.max(1, natural.height);
    const anchor = Array.isArray(metadata?.anchor) ? metadata.anchor : [0.5, 0.12];
    transform.setAnchorPoint(anchor[0], anchor[1]); transform.setContentSize(w, h);
    this.scale = Math.min(width / w, height / h); this.body.setScale(this.scale, this.scale, 1);
    this.sprite = this.body.addComponent(Sprite); this.sprite.sizeMode = Sprite.SizeMode.CUSTOM; this.sprite.trim = false; this.sprite.spriteFrame = frame;
    this.lastFrame = frame;
    this.tint(null);
  }

  /** Called with the authoritative event key and battle visual clock, never wall
   * time. Re-observing one hit cannot restart the flash or extend its lifetime. */
  hit(seconds: number, key: string, strength = 1, flashEnabled = true): void {
    this.hitFlash = flashEnabled;
    if (!Number.isFinite(seconds) || key === this.hitKey) return;
    this.hitKey = key; this.hitStarted = seconds; this.hitStrength = strength;
  }
  private applyHit(seconds: number): void {
    const pulse = hitFeedback(seconds - this.hitStarted, this.hitStrength, this.hitFlash);
    this.hitState = pulse;
    if (pulse.active) {
      const scale = this.body.scale;
      this.body.setScale(scale.x * pulse.scaleX, scale.y * pulse.scaleY, 1);
      this.body.setPosition(this.body.position.x + pulse.offsetX, this.body.position.y + pulse.offsetY);
    }
    if (pulse.flash > 0 && !this.glow && this.sprite) {
      const node = new Node('AuthoritativeHitFlash'); node.layer = Layers.Enum.UI_2D; node.setParent(this.body);
      const source = this.body.getComponent(UITransform)!;
      const transform = node.addComponent(UITransform); transform.setContentSize(source.contentSize); transform.setAnchorPoint(source.anchorPoint);
      this.glow = node.addComponent(Sprite); this.glow.sizeMode = Sprite.SizeMode.CUSTOM; this.glow.trim = false;
      if (!SpriteActor.glowMaterial) {
        const material = new Material(); material.initialize({ effectName: 'builtin-sprite', defines: { USE_TEXTURE: true } });
        material.overridePipelineStates({ blendState: { targets: [{ blend: true, blendSrc: gfx.BlendFactor.SRC_ALPHA,
          blendDst: gfx.BlendFactor.ONE, blendSrcAlpha: gfx.BlendFactor.ONE, blendDstAlpha: gfx.BlendFactor.ONE_MINUS_SRC_ALPHA }] } });
        SpriteActor.glowMaterial = material;
      }
      this.glow.customMaterial = SpriteActor.glowMaterial;
    }
    if (this.glow) {
      this.glow.node.active = pulse.flash > 0;
      this.glow.spriteFrame = this.sprite?.spriteFrame || null;
      this.glow.color = new Color(255, 255, 255, Math.round(pulse.flash * 255));
    }
  }

  pose(action: VisualAction, seconds: number, phase = 0, strength = 1): void {
    if (!this.node.isValid || !this.body.isValid || !this.sprite) return;
    this.action = action;
    const frames = this.catalog.frames(this.assetId, action) || [];
    if (frames.length > 1) {
      const total = frames.reduce((n, f) => n + Math.max(.016, f.duration), 0);
      let cursor = Math.max(0, seconds) % total, picked = frames[frames.length - 1].frame;
      for (const f of frames) { cursor -= Math.max(.016, f.duration); if (cursor < 0) { picked = f.frame; break; } }
      this.setFrame(picked);
      this.body.setPosition(0, 0); this.body.setScale(this.scale, this.scale, 1); this.body.angle = 0;
      this.applyHit(seconds);
      return;
    }
    this.setFrame(frames[0]?.frame || this.catalog.image(this.assetId));
    // Single-image MVP actions intentionally transform the real Sprite.
    // They do not claim hand-drawn frame animation and never invoke gameplay.
    const t = seconds + phase, amplitude = Math.min(1, Math.max(0, strength));
    let x = 0, y = 0, sx = 1, sy = 1, angle = 0;
    if (action === 'attack') {
      const kick = Math.sin(Math.min(1, Math.max(0, seconds) / .32) * Math.PI) * amplitude;
      const family = this.assetId.slice(0, 4);
      if (family === 'H001') { y = kick * this.maxHeight * .075; sx = 1 - kick * .075; sy = 1 + kick * .1; angle = -kick * 9; }
      else if (family === 'H002') { x = kick * this.maxWidth * .13; sx = 1 + kick * .16; sy = 1 - kick * .13; angle = -kick * 12; }
      else if (family === 'H003') { y = -kick * this.maxHeight * .04; sx = 1 + kick * .14; sy = 1 - kick * .11; }
      else { x = kick * this.maxWidth * .06; y = kick * this.maxHeight * .035; angle = -kick * 19; sx = 1 + kick * .06; sy = 1 - kick * .04; }
    } else if (action === 'victory') {
      const jump = Math.max(0, Math.sin(t * 5.5)); y = jump * this.maxHeight * .095 * amplitude;
      angle = Math.sin(t * 5.5) * 6 * amplitude; sx = 1 - jump * .025; sy = 1 + jump * .045;
    } else if (action === 'walk') {
      const step = Math.sin(t * 9); y = Math.abs(step) * this.maxHeight * .035 * amplitude;
      angle = step * 4 * amplitude; sx = 1 + Math.cos(t * 18) * .025 * amplitude; sy = 1 - Math.cos(t * 18) * .025 * amplitude;
    } else if (action === 'tell' || action === 'cane_raise') {
      sy = 1.035; sx = .975; angle = Math.sin(t * 18) * 1.4 * amplitude;
    } else if (action === 'impact' || action === 'cane_strike') {
      sx = 1.045; sy = .955; angle = -2;
    } else if (action === 'hit') {
      // The keyed hit envelope below supplies a single squash/rebound; no
      // periodic sine restarts when the same damage row remains visible.
    } else {
      const breath = Math.sin(t * 3); sy = 1 + breath * .016 * amplitude; angle = breath * .6 * amplitude;
    }
    this.body.setPosition(x, y); this.body.setScale(this.scale * sx, this.scale * sy, 1); this.body.angle = angle;
    this.applyHit(seconds);
  }

  tint(value: string | null): void { if (this.sprite) this.sprite.color = value || this.baseTint ? color(value || this.baseTint!) : Color.WHITE; }
  get report(): any {
    const frames = this.catalog.frames(this.assetId, this.action)?.length || 0;
    const frame = this.sprite?.spriteFrame, transform = this.body.getComponent(UITransform);
    const size = transform?.contentSize, anchor = transform?.anchorPoint, scale = this.body.scale;
    return {
      id: this.assetId, nodeName: this.node.name, loaded: !!this.sprite, action: this.action, actionFrameCount: frames,
      mode: frames > 1 ? 'sequence' : frames === 1 ? 'action-frame-and-transform' : this.sprite ? 'single-sprite-transform' : 'missing',
      frameRect: frame ? { x: frame.rect.x, y: frame.rect.y, width: frame.rect.width, height: frame.rect.height } : null,
      originalSize: frame ? { width: frame.originalSize.width, height: frame.originalSize.height } : null,
      bodySize: size ? { width: size.width, height: size.height } : null,
      anchor: anchor ? { x: anchor.x, y: anchor.y } : null,
      baseScale: this.scale, bodyScale: { x: scale.x, y: scale.y }, bodyAngle: this.body.angle,
      displaySize: size ? { width: size.width * Math.abs(scale.x), height: size.height * Math.abs(scale.y) } : null,
      allocatedSize: { width: this.maxWidth, height: this.maxHeight },
      hit: { key: this.hitKey, started: this.hitStarted, strength: this.hitStrength, flashEnabled: this.hitFlash,
        ...this.hitState },
      tint: this.sprite ? { r: this.sprite.color.r, g: this.sprite.color.g, b: this.sprite.color.b } : null,
      position: { x: this.node.position.x, y: this.node.position.y },
    };
  }
  private setFrame(frame: SpriteFrame | null): void { if (frame && this.sprite && frame !== this.lastFrame) { this.sprite.spriteFrame = frame; this.lastFrame = frame; } }
}

export class SpriteVisuals {
  private readonly imageIds = new WeakMap<Node, string>();
  constructor(private readonly catalog: VisualCatalog) {}
  actor(parent: Node, name: string, assetId: string, x: number, y: number, width: number, height: number, shadow = true): SpriteActor {
    return new SpriteActor(this.catalog, parent, name, assetId, x, y, width, height, shadow);
  }

  /** Real raster art fitted without stretching. Cover crops the image, not UI controls. */
  image(parent: Node, name: string, assetId: string, x: number, y: number, width: number, height: number, fit: 'contain' | 'cover' = 'contain', alpha = 255): Node | null {
    const frame = this.catalog.image(assetId); if (!frame) return null;
    const n = new Node(name); n.layer = Layers.Enum.UI_2D; n.setParent(parent); n.setPosition(x, y);
    const ui = n.addComponent(UITransform), size = frame.originalSize, scale = fit === 'cover' ? Math.max(width / size.width, height / size.height) : Math.min(width / size.width, height / size.height);
    ui.setContentSize(size.width * scale, size.height * scale);
    const sprite = n.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM; sprite.trim = false; sprite.spriteFrame = frame; sprite.color = new Color(255, 255, 255, alpha);
    this.imageIds.set(n, assetId);
    return n;
  }

  /** A true Cocos nine-slice; production border metadata lives on its SpriteFrame. */
  sliced(parent: Node, assetId: string, width: number, height: number): Sprite | null {
    const frame = this.catalog.image(assetId); if (!frame) return null;
    const n = new Node(`Skin-${assetId}`); n.layer = Layers.Enum.UI_2D; n.setParent(parent);
    if (/^UI_CARD_(CHEF|BOXER|FROG|AUNT)$/.test(assetId)) {
      const size = frame.originalSize, scale = Math.min(width / size.width, height / size.height);
      n.addComponent(UITransform).setContentSize(size.width, size.height); n.setScale(scale, scale, 1);
      const sprite = n.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM; sprite.type = Sprite.Type.SIMPLE; sprite.spriteFrame = frame;
      this.imageIds.set(n, assetId); return sprite;
    }
    // Keep the art's border/shadow proportion at small logical heights. The
    // expanded skin is scaled back inside the unchanged parent hit rectangle.
    const scale = Math.min(1, height / Math.max(1, frame.originalSize.height));
    n.addComponent(UITransform).setContentSize(width / scale, height / scale);
    n.setScale(scale, scale, 1);
    const sprite = n.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM; sprite.type = Sprite.Type.SLICED; sprite.spriteFrame = frame;
    this.imageIds.set(n, assetId); return sprite;
  }
  assetId(node: Node): string | undefined { return this.imageIds.get(node); }

  starPlatform(parent: Node, x: number, y: number, width: number, star: number): void {
    const g = shape(parent, `StarPlatform-${star}`, x, y, width, 26).g;
    const fill = star === 3 ? '#C395F0' : star === 2 ? '#F4CD64' : '#90CBAB';
    g.fillColor = color(fill); g.ellipse(0, 0, width * .43, 10); g.fill();
    g.strokeColor = color(star === 3 ? '#7952AA' : '#638E77'); g.lineWidth = 2.5; g.ellipse(0, 0, width * .43, 10); g.stroke();
    if (star > 1) { g.strokeColor = color('#FFF6C2', 220); g.lineWidth = 3; g.ellipse(0, 2, width * .38, 8); g.stroke(); }
  }
}
