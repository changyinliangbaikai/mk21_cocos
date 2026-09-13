import { Color, Graphics, Label, LabelOutline, Layers, Mask, Node, Sprite, SpriteFrame, UITransform } from 'cc';
import { VfxEventRouter, advanceFeedbackTick, captureVfxState, chooseVfxSlot, feedbackLayers, type VfxFrame, type VfxIntent, type VfxPoint, type VfxSnapshot } from './VfxEvents';
export { captureVfxState } from './VfxEvents';
export interface TextureCatalog { image(id: string): SpriteFrame | null; vfxRecipes?(): any | null }
interface Quad {
  node: Node; sprite: Sprite; transform: UITransform; active: boolean; key: string; priority: number; serial: number;
  intent: VfxIntent; layer: any; texture: string; startReal: number; duration: number; index: number; count: number;
  from: VfxPoint; to: VfxPoint; width: number; height: number; persistent: boolean;
  graphic?: Graphics; label?: Label;
}
const mix = (a: number, b: number, p: number): number => a + (b - a) * p;
const clamp = (v: number): number => Math.max(0, Math.min(1, v));
const at = (p: VfxPoint): VfxPoint => ({ x: p.x, y: p.y });
// Preview HUD badge canvas (94, 88), with the unchanged battlefield canvas origin (0, 120).
const ENERGY_HUD_ANCHOR: VfxPoint = { x: 94, y: -32 };

/** Interprets the shipped vfx-kit recipes as real Sprite quads. Shapes remain in GameApp
 * for authoritative aiming geometry; this class never dispatches or updates game state. */
export class TextureEffects {
  private catalog?: TextureCatalog;
  private root?: Node;
  private fieldClip?: Node;
  private layer?: Node;
  private recipes = new Map<string, any>();
  private router = new VfxEventRouter();
  private latest?: VfxSnapshot;
  private slots: Quad[] = [];
  private serial = 0;
  private realTime = 0;
  private visualTick = 0;
  private hidden = false;
  private maxQuads = 96;
  private maxPerRecipe = 16;
  private emitted = 0;
  private peak = 0;
  private culled = 0;
  private exhausted = 0;
  private missing = new Set<string>();
  private played = new Map<string, number>();
  private project?: (point: VfxPoint) => VfxPoint;
  private energyHud = ENERGY_HUD_ANCHOR;
  private numberStyle?: (label: Label, size: number) => void;
  setNumberStyle(style: (label: Label, size: number) => void): void { this.numberStyle = style; }

  /** Map presentation positions with the same inverse contract as native targeting.
   * Values returned are 720×1280 top-left UI coordinates, never game state. */
  setProjection(project?: (point: VfxPoint) => VfxPoint, energyHud = ENERGY_HUD_ANCHOR): void { this.project = project; this.energyHud = energyHud; this.updateClip(); }
  private updateClip(): void {
    if (!this.fieldClip) return;
    const world = this.latest?.config?.world || { spawn_y: 32, base_y: 648 };
    const top = Math.max(125, this.screenPoint({ x: 360, y: world.spawn_y }).y - 70);
    const bottom = Math.min(850, this.screenPoint({ x: 360, y: world.base_y }).y + 23);
    this.fieldClip.getComponent(UITransform)!.setContentSize(720, Math.max(1, bottom - top));
    this.fieldClip.setPosition(0, 640 - (top + bottom) / 2);
  }
  private screenPoint(point: VfxPoint): VfxPoint {
    return this.project ? this.project(point) : { x: point.x, y: point.y + 120 };
  }

  initialize(catalog: TextureCatalog, recipes?: any): void {
    this.destroy(); this.catalog = catalog; this.router = new VfxEventRouter(); this.hidden = false;
    this.root = new Node('ProductionTextureEffects'); this.root.layer = Layers.Enum.UI_2D;
    this.fieldClip = new Node('BattleFeedbackClip'); this.fieldClip.layer = Layers.Enum.UI_2D; this.fieldClip.setParent(this.root);
    this.fieldClip.addComponent(UITransform).setContentSize(720, 700); this.fieldClip.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;
    this.updateClip();
    const pack = recipes || catalog.vfxRecipes?.();
    if (!pack?.recipes) { this.missing.add('vfx-recipes'); return; }
    this.maxQuads = Math.min(96, pack.particleBudget?.maxActiveTexturedQuads || 96);
    this.maxPerRecipe = Math.min(16, pack.particleBudget?.maxPerRecipe || 16);
    for (const recipe of pack.recipes) this.recipes.set(recipe.id, recipe);
    for (let i = 0; i < this.maxQuads; i++) {
      const node = new Node(`VfxQuad-${i}`); node.layer = Layers.Enum.UI_2D; node.setParent(this.root); node.active = false;
      const transform = node.addComponent(UITransform); transform.setAnchorPoint(.5, .5);
      const sprite = node.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM; sprite.trim = false;
      this.slots.push({ node, transform, sprite, active: false, key: '', priority: 3, serial: 0, intent: {} as VfxIntent,
        layer: {}, texture: '', startReal: 0, duration: 1, index: 0, count: 1, from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, width: 1, height: 1, persistent: false });
    }
  }
  /** Detach before destroying an old page. The same pool and event cursor survive attachment. */
  attach(layer: Node | null): void {
    this.layer = layer || undefined;
    if (this.root?.isValid) { this.root.setParent(layer); this.root.active = !!layer && !this.hidden; }
  }
  observe(data: any): void { this.consume(this.router.observe(data)); }
  command(name: string, payload: any, success: boolean, before: VfxSnapshot, after: VfxSnapshot): void {
    this.consume(this.router.command(name, payload, success, before, after));
  }
  background(): void { this.hidden = true; this.router.background(); this.clear(); if (this.root) this.root.active = false; }
  foreground(): void { this.hidden = false; this.router.foreground(); if (this.root) this.root.active = !!this.layer; }
  private clear(battleOnly = false): void {
    for (const slot of this.slots) if (!battleOnly || slot.intent.clock === 'battle') { slot.active = false; slot.node.active = false; }
  }
  private consume(frame: VfxFrame): void {
    if (!this.latest || this.latest.runId !== frame.snapshot.runId || this.latest.wave !== frame.snapshot.wave || frame.snapshot.tick < this.latest.tick) this.visualTick = frame.snapshot.tick;
    else this.visualTick = Math.max(this.visualTick, frame.snapshot.tick);
    if (this.latest && this.latest.runId !== frame.snapshot.runId) this.clear();
    this.latest = frame.snapshot;
    this.updateClip();
    if (frame.clearBattle) this.clear(true);
    if (this.hidden || !this.root?.isValid) return;
    const keep = new Set<string>();
    for (const intent of frame.persistent) this.emit(intent, keep);
    for (const slot of this.slots) if (slot.active && slot.persistent && !keep.has(slot.key)) { slot.active = false; slot.node.active = false; }
    for (const intent of frame.bursts) this.emit(intent);
    this.peak = Math.max(this.peak, this.slots.filter(s => s.active).length);
    this.render();
  }
  private emit(intent: VfxIntent, keep?: Set<string>): void {
    const recipe = this.recipes.get(intent.recipe);
    if (!recipe) { this.missing.add(`recipe:${intent.recipe}`); return; }
    let allocated = 0;
    const highLoad = this.slots.filter(s => s.active).length > this.maxQuads * .75;
    const layers = feedbackLayers(intent, recipe.layers);
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      if (layer.flashOnly && (intent.flash === false || this.latest?.flash === false)) continue;
      if (intent.emitters && layer.emitter && !intent.emitters.includes(layer.emitter)) continue;
      if (intent.textures && !intent.textures.includes(layer.texture)) continue;
      if (!intent.persistent && !intent.emitters && !intent.textures && ['survivingMarkedTargets', 'persistentArea', 'statusMarker'].includes(layer.emitter)) continue;
      if (!intent.emitters && intent.recipe === 'K002' && layer.emitter === 'eachAuthoritativeHit') continue;
      const texture = intent.replacements?.[layer.texture] || layer.texture;
      const sprite = layer.graphic ? null : this.catalog?.image(texture);
      if (!sprite && !layer.graphic) { this.missing.add(texture); continue; }
      let count = layer.count || 1;
      if (layer.emitter === 'clearedEnemyPositions') count = Math.min(8, intent.positions?.length || 0);
      if (intent.from && layer.laneCentersBinding) count = 1;
      if (highLoad && intent.priority >= 2) count = Math.max(1, Math.ceil(count * .5));
      count = Math.min(count, this.maxPerRecipe - allocated);
      for (let i = 0; i < count; i++) {
        const key = `${intent.key}:${li}:${i}`;
        let slot = this.slots.find(s => s.active && s.key === key);
        const existing = !!slot;
        if (!slot) {
          const index = chooseVfxSlot(this.slots, intent.priority);
          if (index < 0) { this.exhausted++; continue; }
          slot = this.slots[index];
        }
        if (keep) keep.add(key);
        const geo = this.geometry(intent, layer, i, count);
        if (!geo) { this.culled++; continue; }
        if (!existing) {
          slot.startReal = this.realTime; slot.serial = ++this.serial; this.emitted++;
          this.played.set(texture, (this.played.get(texture) || 0) + 1);
        }
        Object.assign(slot, { active: true, key, priority: intent.priority, intent, layer, texture,
          duration: intent.duration ?? (intent.endTick !== undefined && !intent.persistent ? Math.max(.016, (intent.endTick - intent.tick) / this.latest!.tickHz) : layer.lifetimeSeconds ?? 1),
          index: i, count, persistent: !!intent.persistent, ...geo });
        const combat = intent.recipe !== 'ENERGY' && (intent.clock === 'battle' || ['launch', 'cast', 'impact', 'death'].includes(intent.stage || ''));
        slot.node.setParent(combat ? this.fieldClip! : this.root!);
        slot.node.name = `VFX-${intent.recipe}-${texture}-${slot.serial}`;
        slot.sprite.enabled = !layer.graphic; slot.sprite.spriteFrame = sprite || null;
        if (layer.graphic && !slot.graphic) {
          const node = new Node('FeedbackShape'); node.layer = Layers.Enum.UI_2D; node.setParent(slot.node);
          node.addComponent(UITransform).setContentSize(slot.width, slot.height); slot.graphic = node.addComponent(Graphics);
        }
        if (slot.graphic) { slot.graphic.enabled = !!layer.graphic; slot.graphic.clear(); }
        if (slot.label) slot.label.enabled = layer.graphic === 'income';
        slot.transform.setContentSize(slot.width, slot.height); slot.node.active = true;
        allocated++;
      }
    }
  }
  private geometry(intent: VfxIntent, layer: any, index: number, count: number): any {
    const world = this.latest?.config?.world || { field_size: [720, 680], lane_centers_x: [140, 360, 580], base_y: 648, spawn_y: 32, road_width: 56 };
    let from = at(intent.from || intent.point), to = at(intent.to || intent.point);
    let width = layer.logicalSize?.[0] || 256, height = layer.logicalSize?.[1] || 256;
    if (layer.sizeBinding?.endsWith('Diameter')) width = height = (intent.radius || 50) * 2;
    else if (layer.sizeBinding === 'battlefieldSize') { width = world.field_size[0]; height = world.field_size[1]; }
    else if (layer.sizeBinding === 'battlefieldWidth') { width = world.field_size[0]; height = 150; }
    if (layer.widthBinding === 'laneWidth') { width = world.road_width * 2; height = 160; }
    if (layer.emitter === 'clearedEnemyPositions') from = to = at(intent.positions![index]);
    else if (layer.emitter === 'spawnQueueMarkers') from = to = { x: world.lane_centers_x[index % world.lane_centers_x.length], y: world.spawn_y };
    else if (layer.emitter === 'energyHud') from = to = at(this.energyHud);
    else if (layer.emitter === 'rewardSourceToEnergyHud') to = at(this.energyHud);
    else if (layer.fromOffset) { from = { x: intent.point.x + layer.fromOffset[0], y: intent.point.y + layer.fromOffset[1] }; to = at(intent.point); }
    else if (layer.emitter === 'laneSweep' || layer.emitter === 'laneTether') {
      from = { x: intent.point.x, y: world.base_y }; to = { x: intent.point.x, y: world.spawn_y };
    } else if (layer.emitter === 'screenSweep') { from = { x: world.field_size[0] / 2, y: world.base_y }; to = { x: from.x, y: world.spawn_y }; }
    else if (layer.laneCentersBinding && !intent.from) {
      from = { x: world.lane_centers_x[index % world.lane_centers_x.length], y: world.base_y }; to = { x: from.x, y: world.spawn_y };
    }
    if (layer.atOrigin) to = at(from);
    if (layer.atDestination) from = at(to);
    const moving = (!layer.atOrigin && !layer.atDestination && !!intent.from) || !!layer.path || layer.emitter === 'rewardSourceToEnergyHud';
    const spread = layer.spreadBinding ? intent.radius || 0 : layer.spreadRadius || 0;
    if (spread && !moving) {
      const angle = (index / Math.max(1, count) * 360 + 37) * Math.PI / 180;
      to = { x: from.x + Math.cos(angle) * spread * .75, y: from.y + Math.sin(angle) * spread * .75 };
    }
    if (layer.offset) { from = { x: from.x + layer.offset[0], y: from.y + layer.offset[1] }; to = { x: to.x + layer.offset[0], y: to.y + layer.offset[1] }; }
    if (from.x < -150 && to.x < -150 || from.x > world.field_size[0] + 150 && to.x > world.field_size[0] + 150 ||
      from.y < -180 && to.y < -180 || from.y > 1120 && to.y > 1120) return null;
    // World radii have to use the same affine projection as range/aim outlines.
    // Sprite/glyph dimensions remain in screen units for consistent readability.
    if (layer.sizeBinding?.endsWith('Diameter') && this.project) {
      const center = this.screenPoint(from), right = this.screenPoint({ x: from.x + width / 2, y: from.y });
      const bottom = this.screenPoint({ x: from.x, y: from.y + height / 2 });
      width = Math.abs(right.x - center.x) * 2; height = Math.abs(bottom.y - center.y) * 2;
    }
    return { from, to, width, height };
  }
  update(realDt: number, combatTimeScale?: number): void {
    if (!Number.isFinite(realDt) || realDt < 0 || this.hidden) return;
    this.realTime += realDt;
    // Authoritative ticks are ALREADY scaled by GameSession. Only interpolate
    // the fractional display tick; never multiply the observed tick a second time.
    const scale = combatTimeScale === undefined ? 0 : Math.max(0, combatTimeScale);
    if (this.latest) this.visualTick = advanceFeedbackTick(this.visualTick, this.latest.tick, realDt, this.latest.tickHz, scale);
    this.render();
  }
  private render(): void {
    if (!this.latest || this.hidden) return;
    const tick = this.visualTick, hz = this.latest.tickHz;
    for (const slot of this.slots) {
      if (!slot.active) continue;
      const intent = slot.intent, layer = slot.layer;
      if (layer.flashOnly && this.latest.flash === false) { slot.node.active = false; continue; }
      const age = (intent.clock === 'ui' ? this.realTime - slot.startReal : (tick - intent.tick) / hz) -
        (intent.delay || 0) - (layer.staggerSeconds || 0) * slot.index;
      if ((!slot.persistent && age >= slot.duration) || (slot.persistent && intent.endTick !== undefined && tick >= intent.endTick)) {
        slot.active = false; slot.node.active = false; continue;
      }
      if (age < 0) { slot.node.active = false; continue; }
      slot.node.active = true;
      let progress = clamp(age / slot.duration);
      if (slot.persistent) progress = intent.from && intent.endTick !== undefined ? clamp((tick - intent.tick) / Math.max(1, intent.endTick - intent.tick)) : .4 + Math.sin(tick / hz * 4) * .1;
      let x = mix(slot.from.x, slot.to.x, progress), y = mix(slot.from.y, slot.to.y, progress);
      if (layer.path === 'providedChaseArc') y -= Math.sin(progress * Math.PI) * 30;
      let sx = 1, sy = 1;
      if (Array.isArray(layer.scale)) sx = sy = mix(layer.scale[0], layer.scale[1], progress);
      const screenFrom = this.screenPoint(slot.from), screenTo = this.screenPoint(slot.to);
      let screen = this.screenPoint({ x, y });
      if (layer.path === 'energyArc') screen.x += Math.sin(progress * Math.PI) * (slot.index - 1) * 26;
      // Combat points are ground anchors. Center impacts above the feet; energy
      // reaches the exact HUD anchor without carrying that visual body offset.
      const energy = layer.emitter === 'rewardSourceToEnergyHud' || layer.emitter === 'energyHud';
      screen.y -= (energy ? (layer.emitter === 'rewardSourceToEnergyHud' ? 20 * (1 - progress) : 0) : layer.bodyOffset ?? 23) + (layer.rise || 0) * progress;
      let angle = layer.rotationDegrees || 0;
      if (layer.rotation === 'travelDirection' || layer.rotation === 'directionToDanger') angle = -Math.atan2(screenTo.y - screenFrom.y, screenTo.x - screenFrom.x) * 180 / Math.PI - 90;
      if (layer.emitter === 'tether' || layer.emitter === 'laneTether') {
        screen = { x: (screenFrom.x + screenTo.x) / 2, y: (screenFrom.y + screenTo.y) / 2 };
        slot.transform.setContentSize(Math.max(1, Math.hypot(screenTo.x - screenFrom.x, screenTo.y - screenFrom.y)), layer.width || 13);
        angle = -Math.atan2(screenTo.y - screenFrom.y, screenTo.x - screenFrom.x) * 180 / Math.PI;
      }
      angle += (layer.rotationSpeed || 0) * age;
      if (layer.graphic === 'speed') angle = -Math.atan2(screenTo.y - screenFrom.y, screenTo.x - screenFrom.x) * 180 / Math.PI;
      const opacityProgress = layer.opacityHold ? clamp((progress - layer.opacityHold) / (1 - layer.opacityHold)) : progress;
      const opacity = Array.isArray(layer.opacity) ? mix(layer.opacity[0], layer.opacity[1], opacityProgress) : layer.opacity ?? 1;
      const hex = (intent.tint || layer.tint || '#FFFFFF').replace('#', ''), rgb = Number.parseInt(hex, 16);
      slot.sprite.color = new Color((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, Math.round(clamp(opacity) * 255));
      const offsetY = slot.node.parent === this.fieldClip ? this.fieldClip!.position.y : 0;
      slot.node.setPosition(screen.x - 360, 640 - screen.y - offsetY); slot.node.setScale(sx, sy, 1); slot.node.angle = angle;
      if (layer.graphic) this.drawGraphic(slot, progress, clamp(opacity), rgb, screenFrom, screenTo);
    }
  }
  private drawGraphic(slot: Quad, p: number, opacity: number, rgb: number, _from: VfxPoint, _to: VfxPoint): void {
    const g = slot.graphic!; g.clear();
    const alpha = Math.round(opacity * 255), ink = new Color(34, 31, 64, alpha), white = new Color(255, 253, 230, alpha);
    const tone = new Color((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, alpha);
    const radius = slot.width / 2, h = slot.height / 2, type = slot.layer.graphic;
    const line = (points: number[][], stroke: Color, width: number, close = false, fill?: Color): void => {
      g.strokeColor = stroke; g.lineWidth = width;
      points.forEach(([x, y], i) => { if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      if (close) g.close(); if (fill) { g.fillColor = fill; g.fill(); } g.stroke();
    };
    const star = (n: number, outer: number, inner: number, rotation = 0): number[][] => Array.from({ length: n * 2 }, (_, i) => {
      const a = i * Math.PI / n + rotation, r = i % 2 ? inner : outer; return [Math.cos(a) * r, Math.sin(a) * r];
    });
    if (type === 'income') {
      if (!slot.label) {
        const node = new Node('CommittedEnergyDelta'); node.layer = Layers.Enum.UI_2D; node.setParent(slot.node);
        node.addComponent(UITransform).setContentSize(160, 40);
        slot.label = node.addComponent(Label); slot.label.fontSize = 26; slot.label.lineHeight = 32; slot.label.isBold = true;
        slot.label.horizontalAlign = Label.HorizontalAlign.CENTER;
        this.numberStyle?.(slot.label, 26);
        const outline = node.addComponent(LabelOutline); outline.width = 2.5; outline.color = new Color(35, 39, 57, 255);
      }
      slot.label.enabled = true; slot.label.string = `+${Math.round(slot.intent.amount || 0)}`; slot.label.color = new Color(255, 244, 174, alpha);
      slot.label.getComponent(LabelOutline)!.color = new Color(35, 39, 57, alpha); return;
    }
    if (type === 'ring') {
      g.lineWidth = slot.layer.lineWidth || 4; g.strokeColor = ink; g.ellipse(0, 0, radius, h); g.stroke();
      g.lineWidth = Math.max(2, g.lineWidth - 1); g.strokeColor = tone; g.ellipse(0, 0, radius - 1, Math.max(1, h - 1)); g.stroke();
      return;
    }
    if (type === 'popcornCore') {
      // One closed, filled scalloped contour; no overlapping outlined circles.
      // The real popcorn texture on top supplies the familiar individual kernel.
      const contour = (size: number): number[][] => Array.from({ length: 64 }, (_, i) => {
        const a = i * Math.PI * 2 / 64, r = size * (.85 + .15 * Math.cos(a * 7));
        return [Math.cos(a) * r, Math.sin(a) * r];
      });
      const orange = new Color(242, 139, 27, alpha), cream = new Color(255, 244, 182, alpha);
      line(contour(radius), new Color(103, 56, 22, alpha), 4.5, true, orange);
      line(contour(radius * .83), orange, 2, true, cream);
      return;
    }
    if (type === 'cornShock') {
      const orange = new Color(247, 154, 33, alpha), gold = new Color(255, 205, 66, alpha), brown = new Color(127, 65, 26, alpha);
      // Four separated tension arcs, with empty gaps so the target stays visible.
      for (let section = 0; section < 4; section++) {
        const points = Array.from({ length: 10 }, (_, i) => {
          const a = section * Math.PI / 2 + .17 + i / 9 * .9;
          return [Math.cos(a) * radius, Math.sin(a) * h];
        });
        line(points, brown, 8); line(points, orange, 6); line(points, gold, 2.5);
      }
      return;
    }
    if (type === 'cornKernels') {
      const orange = new Color(246, 153, 35, alpha), cream = new Color(255, 242, 167, alpha), brown = new Color(111, 57, 28, alpha);
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + .37 + p * .15, reach = radius * (.42 + p * .48);
        const x = Math.cos(a) * reach, y = Math.sin(a) * reach, w = radius * .09, ht = radius * .135;
        line([[x-w,y-ht*.35],[x-w*.72,y+ht*.75],[x+w*.2,y+ht],[x+w,y+ht*.15],[x+w*.7,y-ht*.7],[x-w*.1,y-ht]], brown, 3, true, orange);
        line([[x-w*.4,y],[x-w*.22,y+ht*.46],[x+w*.3,y+ht*.35]], cream, 3);
      }
      return;
    }
    if (type === 'castSeal') {
      line(star(8, radius, radius * .8, p), tone, 4, true);
      g.strokeColor = white; g.lineWidth = 2; g.circle(0, 0, radius * .65); g.stroke();
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; line([[Math.cos(a) * radius * .85, Math.sin(a) * radius * .85], [Math.cos(a) * radius * 1.13, Math.sin(a) * radius * 1.13]], tone, 6); }
      return;
    }
    if (type === 'impact' || type === 'punch' || type === 'slap') {
      const points = type === 'slap' ? [[-radius, 0], [-radius * .3, h * .17], [-radius * .18, h], [radius * .13, h * .25], [radius, h * .1], [radius * .28, -h * .13], [radius * .16, -h], [-radius * .12, -h * .3]] : star(type === 'punch' ? 6 : 4, radius, radius * .28, .2);
      line(points, ink, type === 'punch' ? 4 : 2.5, true, type === 'impact' ? white : tone);
      if (type !== 'impact') line(star(4, radius * .5, radius * .14), tone, 1, true, white);
      return;
    }
    if (type === 'speed') {
      for (let i = -2; i <= 2; i++) {
        const y = i * h * .27, length = radius * (i % 2 ? 1.25 : 1.7);
        line([[-length, y], [radius * .7, y * .5]], ink, i === 0 ? 5 : 3);
        line([[-length, y + 1], [radius * .7, y * .5 + 1]], tone, i === 0 ? 3 : 1.6);
      }
      return;
    }
    if (type === 'notes') {
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + .2 + p * .8, x = Math.cos(a) * radius * .78, y = Math.sin(a) * h * .75;
        g.fillColor = tone; g.strokeColor = ink; g.lineWidth = 2; g.ellipse(x, y, 6, 4); g.fill(); g.stroke();
        line([[x + 5, y], [x + 5, y + 20], [x + 15, y + 15]], ink, 4);
        line([[x + 5, y], [x + 5, y + 20], [x + 15, y + 15]], tone, 2);
      }
      return;
    }
    if (type === 'death') {
      for (let i = 0; i < 7; i++) {
        const a = i * Math.PI * 2 / 7, x = Math.cos(a) * radius * (.35 + p), y = Math.sin(a) * h * (.35 + p);
        const size = (1 - p) * 5 + 1;
        line([[x - size, y], [x, y + size * 1.5], [x + size, y], [x, y - size]], ink, 1.5, true, tone);
      }
      return;
    }
    if (type === 'trail') {
      g.fillColor = tone;
      for (let i = 0; i < 3; i++) { g.circle(-i * 7, -i * 4, 5 - i); g.fill(); }
      return;
    }
    // Warm popcorn shards / general outline splinters.
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4 + .15, inner = radius * (.15 + p * .55), outer = inner + radius * .2;
      line([[Math.cos(a) * inner, Math.sin(a) * inner], [Math.cos(a) * outer, Math.sin(a) * outer]], ink, 5);
      line([[Math.cos(a) * inner, Math.sin(a) * inner], [Math.cos(a) * outer, Math.sin(a) * outer]], tone, 3);
    }
  }
  status(): any {
    return { initialized: !!this.root, attached: !!this.layer, background: this.hidden, recipeCount: this.recipes.size,
      poolSize: this.slots.length, active: this.slots.filter(s => s.active).length, peak: this.peak, emitted: this.emitted,
      culled: this.culled, exhausted: this.exhausted, missing: Array.from(this.missing).sort(),
      renderedTextures: Object.fromEntries(this.played), realTime: this.realTime, tick: this.latest?.tick || 0, visualTick: this.visualTick,
      quads: this.slots.filter(s => s.active).slice(0, 24).map(s => ({ recipe: s.intent.recipe, texture: s.texture,
        spriteLoaded: !!s.sprite.spriteFrame, renderType: s.layer.graphic ? 'graphics' : 'sprite', graphic: s.layer.graphic || null, clock: s.intent.clock, persistent: s.persistent, priority: s.priority,
        key: s.key, position: { x: s.node.position.x, y: s.node.position.y }, opacity: s.sprite.color.a })) };
  }
  destroy(): void {
    this.root?.destroy(); this.root = undefined; this.fieldClip = undefined; this.layer = undefined; this.catalog = undefined;
    this.recipes.clear(); this.slots = []; this.latest = undefined; this.missing.clear(); this.played.clear();
  }
}
