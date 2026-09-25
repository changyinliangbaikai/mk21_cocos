import { _decorator, BlockInputEvents, Color, Component, EventTouch, Game, Graphics, Label, Layers, Node, Sprite, UIOpacity, UITransform, Vec3, game, profiler, screen, sys, view } from 'cc';
import { HEROES, Quality, RULES, SKILLS, heroDef, permanentStats, skillDef, stageDef } from '../domain/r1/config';
import { BattleEvent, Card, Hero, Run, now } from '../domain/r1/model';
import { R1Session } from '../domain/r1/session';
import { upgradeCost, unlockedHeroes } from '../domain/r1/rewards';
import { skillArea } from '../domain/r1/geometry';
import { effectiveRate } from '../domain/r1/battle';
import { runTuning } from '../domain/r1/waves';
import { attributeBonuses } from '../domain/r1/cards';
import cardViews from '../domain/r1/ui-cards.json';
import { R1Assets } from './R1Assets';
import { R1Audio } from './R1Audio';
import { friendlyImpactVisual, friendlyProjectileVisual } from './R1CombatVisuals';
import { visualFixture } from './R1VisualFixture';
import { Typography } from './Typography';
import { fitMiniGameStage, menuLowerEdgeInView } from './MiniGameLayout';

const { ccclass } = _decorator;
const W = 941, H = 1672, Q: Quality[] = ['blue', 'purple', 'gold'];
const qualityNames = { blue: '蓝色', purple: '紫色', gold: '金色' };
const qualityColors = ['#248bf0', '#9d44da', '#e9a514'];
const toColor = (hex: string) => new Color().fromHEX(hex);
const cleanNumber = (n: number) => Number(n.toFixed(1)).toString();
type Page = 'camp' | 'stages' | 'heroes' | 'detail';
type Modal = '' | 'settings' | 'upgrade' | 'abandon' | 'ability' | 'help';
type CardView = (typeof cardViews)[number];
interface ActorView { node: Node; sprite: Sprite; bar: Graphics; trait: Sprite; shield: Graphics; ammo?: Label; action?: string; actionFrom?: number; lastX?: number; lastY?: number; lastTick?: number; moving?: boolean; atlas?: string; frame?: number }
interface FxView { node: Node; age: number; duration: number; size: number; tick: number; floating?: boolean; summonExit?: { id: string; action: 'spent' | 'despawn' | 'defeated' }; punch?: { fromX: number; fromY: number; toX: number; toY: number; glove: Node; spring: Node } }

/** Native Cocos 2D presentation. No preview canvas or HTML is used as the game. */
@ccclass('R1GameApp')
export class R1GameApp extends Component {
  session!: R1Session;
  private assets = new R1Assets();
  private typography = new Typography('r1/fonts');
  private audio?: R1Audio;
  private stage!: Node; private backdrop!: Node; private world!: Node; private ui!: Node; private effects!: Node;
  private page: Page = 'camp'; private modal: Modal = ''; private selectedHero = 'RH01';
  private selectedStage = 1; private selectedCard = ''; private previousPause = false;
  private ready = false; private loading = false; private assetError = ''; private elapsed = 0;
  private signature = ''; private eventCursor = 0; private runId = ''; private labels: Label[] = [];
  private actors = new Map<number, ActorView>(); private missiles = new Map<number, Node>(); private fx: FxView[] = [];
  private hud = new Map<string, Label>(); private hotzones: { label: string; x: number; y: number; width: number; height: number; enabled: boolean }[] = [];
  private actionUntil = new Map<number, { action: string; until: number; from: number }>();
  private aimPoint = { x: .5, y: .5, angle: 0 }; private aimGraphics?: Graphics;
  private qaScene = '';

  onLoad(): void {
    profiler.hideStats(); this.stage = this.nodeAt('R1Stage', this.node, W / 2, H / 2, W, H); this.stage.setPosition(0, 0, 0);
    this.backdrop = this.nodeAt('Background', this.stage, W / 2, H / 2, W, H);
    this.world = this.nodeAt('BattleActors', this.stage, W / 2, H / 2, W, H);
    this.effects = this.nodeAt('BattleEffects', this.stage, W / 2, H / 2, W, H);
    this.ui = this.nodeAt('UI', this.stage, W / 2, H / 2, W, H);
    this.stage.on(Node.EventType.TOUCH_START, () => this.audio?.gesture(), this, true);
    if (sys.isBrowser && typeof window !== 'undefined' && /(?:\?|&)qa=1(?:&|$)/.test(window.location.search)) this.qaScene = new URLSearchParams(window.location.search).get('qaScene') || '';
    this.session = visualFixture(this.qaScene) || new R1Session(sys.localStorage); this.selectedStage = Math.min(20, this.session.data.profile.clearedStage + 1);
    game.on(Game.EVENT_HIDE, this.onHide, this); game.on(Game.EVENT_SHOW, this.onShow, this);
    this.resize(); void this.load();
  }
  private async load(): Promise<void> {
    this.loading = true; this.assetError = ''; this.renderLoading('正在准备超力英雄…');
    try {
      await Promise.all([this.assets.init(), this.typography.load()]);
      if (this.qaScene && this.session.inBattle) await this.assets.loadGroup('battle');
      if (!this.isValid) return;
      const fonts = this.typography.report(); if (fonts.errors.length) throw new Error(fonts.errors.join('\n'));
      this.audio = new R1Audio(this.node, this.assets.manifest.audioEvents); void this.audio.init();
      this.ready = true; this.loading = false; this.render();
      if (sys.isBrowser && typeof window !== 'undefined' && /(?:\?|&)qa(?:=1|&|$)/.test(window.location.search)) {
        (window as any).__r1 = { session: this.session, ui: this, describe: () => this.describe(), refresh: () => this.render() };
      }
    } catch (e) { this.loading = false; this.assetError = String(e); this.renderLoading('资源加载失败，请重试'); }
  }
  private resize(): void {
    const size = view.getVisibleSize(), origin = view.getVisibleOrigin(), viewport = view.getViewportRect();
    const visible = { x: origin.x, y: origin.y, width: size.width, height: size.height };
    let safe = visible, edge: number | undefined;
    if (!sys.isBrowser) {
      const wx = (globalThis as any).wx;
      if (wx) try { safe = sys.getSafeAreaRect(false); edge = menuLowerEdgeInView(wx.getMenuButtonBoundingClientRect?.()?.bottom, wx.getSystemInfoSync?.()?.windowHeight, screen.windowSize.height, viewport.y, view.getScaleY()); } catch { /* Older hosts use the visible frame. */ }
    }
    const fit = fitMiniGameStage(visible, safe, edge); this.stage.setPosition(fit.x, fit.y); this.stage.setScale(fit.scale * 720 / W, fit.scale * 1280 / H, 1);
  }
  private nodeAt(name: string, parent: Node, x: number, y: number, w: number, h: number): Node {
    const n = new Node(name); n.layer = Layers.Enum.UI_2D; n.setParent(parent); n.addComponent(UITransform).setContentSize(w, h); n.setPosition(x - W / 2, H / 2 - y); return n;
  }
  private clear(parent: Node): void { for (const n of [...parent.children]) { n.removeFromParent(); n.destroy(); } }
  private image(id: string, index: number, x: number, y: number, w: number, h: number, fit = false, parent = this.ui): Node {
    const f = this.assets.info(id)?.frames[index];
    if (fit && f) { const ow = w, oh = h, ratio = f.ratio; if (w / h > ratio) w = h * ratio; else h = w / ratio; x += (ow - w) / 2; y += (oh - h) / 2; }
    const n = this.nodeAt(id, parent, x + w / 2, y + h / 2, w, h), sprite = n.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM; sprite.spriteFrame = this.assets.frame(id, index);
    n.getComponent(UITransform)!.setContentSize(w, h);
    if (id === 'UI-PANELS' && (index === 0 || index === 2)) sprite.type = Sprite.Type.SLICED;
    return n;
  }
  private text(s: string, x: number, y: number, size = 32, width = 850, height = size * 1.4, role = 'body', parent = this.ui): Label {
    const n = this.nodeAt('Text:' + s.slice(0, 22), parent, x, y, width, height), label = n.addComponent(Label); label.string = s;
    this.typography.apply(label, role === 'body' ? 'body' : 'number', size, '#122b47');
    label.enableWrapText = s.includes('\n'); label.overflow = Label.Overflow.SHRINK;
    if (['hud', 'wood', 'type', 'title', 'cta'].includes(role)) {
      label.color = toColor(role === 'title' ? '#ffdf64' : '#fff8df'); label.enableOutline = true; label.outlineWidth = size * .065;
      label.outlineColor = toColor(role === 'wood' ? '#432713' : '#16364c');
    }
    this.labels.push(label); return label;
  }
  private round(x: number, y: number, w: number, h: number, fill = '#ecdaab', parent = this.ui): Graphics {
    const n = this.nodeAt('Shape', parent, x + w / 2, y + h / 2, w, h), g = n.addComponent(Graphics); g.fillColor = toColor(fill); g.roundRect(-w / 2, -h / 2, w, h, Math.min(25, h / 2)); g.fill(); return g;
  }
  private panel(x: number, y: number, w: number, h: number, modal = false): void { this.image('UI-PANELS', modal ? 0 : 2, x, y, w, h); }
  private hit(label: string, x: number, y: number, w: number, h: number, action: () => void, enabled = true, visual?: Node): Node {
    // 130 design pixels remain at least 44 CSS pixels on a 320px-wide phone.
    if (w < 130) { x -= (130 - w) / 2; w = 130; }
    if (h < 130) { y -= (130 - h) / 2; h = 130; }
    const n = this.nodeAt('Tap:' + label, this.ui, x + w / 2, y + h / 2, w, h); n.addComponent(BlockInputEvents);
    this.hotzones.push({ label, x, y, width: w, height: h, enabled });
    const rest = () => visual?.setScale(1, 1, 1);
    n.on(Node.EventType.TOUCH_START, (e: EventTouch) => { e.propagationStopped = true; if (enabled && !this.loading) visual?.setScale(.97, .97, 1); });
    n.on(Node.EventType.TOUCH_CANCEL, rest);
    n.on(Node.EventType.TOUCH_END, (e: EventTouch) => { rest(); e.propagationStopped = true; if (!enabled || this.loading) return; this.audio?.gesture(); this.audio?.emit('ui_click'); action(); this.signature = ''; });
    return n;
  }
  private button(label: string, x: number, y: number, w: number, h: number, action: () => void, secondary = false, enabled = true): void {
    const n = this.image('UI-PANELS', secondary ? 4 : 3, x, y, w, h);
    if (!enabled) n.getComponent(Sprite)!.grayscale = true;
    this.text(label, x + w / 2, y + h / 2, Math.min(h * .4, w / (label.length + 1)), w - 30, h * .68, secondary ? 'name' : 'cta');
    this.hit(label, x, y, w, h, action, enabled, n);
  }
  private icon(i: number, label: string, x: number, y: number, action: () => void): void {
    this.panel(x, y, 102, 100); this.image('UI-ICONS', i, x + 20, y + 20, 62, 60, true); this.hit(label, x - 6, y - 8, 114, 116, action);
  }
  private block(dim = false): void {
    const n = this.nodeAt('ModalInputShield', this.ui, W / 2, H / 2, W, H); n.addComponent(BlockInputEvents);
    if (dim) { const g = n.addComponent(Graphics); g.fillColor = new Color(13, 36, 48, 100); g.rect(-W / 2, -H / 2, W, H); g.fill(); }
  }
  private popup(title: string, subtitle = ''): void {
    this.block(true); this.panel(64, 369, 813, 860, true); this.text(title, 470, 441, 64, 730, 90, 'title');
    if (subtitle) this.text(subtitle, 470, 510, 34, 706, 65, 'name');
  }
  private wood(title: string, y: number): void { this.image('UI-PANELS', 1, 185, y, 570, 145); this.text(title, 470, y + 77, 48, 440, 74, 'wood'); }
  private heading(title: string, back: Page = 'camp'): void { this.image('LOGO', 0, 307, 45, 330, 142, true); this.icon(7, back === 'heroes' ? '返回英雄列表' : '返回营地', 48, 50, () => { this.page = back; }); this.wood(title, 195); }
  private portrait(id: string, x: number, y: number, w: number, h: number): void {
    const a = this.assets.info('PORTRAIT-' + id)?.frames[0]; if (!a) return;
    const rw = Math.min(w, h * a.ratio), rh = rw / a.ratio; this.image('PORTRAIT-' + id, 0, x + (w - rw) / 2, y + (h - rh) / 2, rw, rh);
  }
  private openModal(modal: Modal): void {
    this.previousPause = this.session.data.run?.paused ?? false;
    if (this.session.inBattle && !this.previousPause) this.session.pause(true);
    this.modal = modal;
  }
  private closeModal(): void { this.modal = ''; if (this.session.inBattle && !this.previousPause) this.session.pause(false); }
  private renderLoading(title: string): void {
    this.clear(this.ui); this.labels = []; this.hotzones = []; this.round(0, 0, W, H, '#233d32'); this.text(title, 470, 725, 44, 860, 100, 'hud');
    if (this.assetError) { this.text('请检查网络后重试', 470, 845, 30, 790, 90, 'hud'); this.button('重新加载', 270, 1020, 400, 120, () => void this.load()); }
  }
  private background(camp: boolean): void {
    const id = camp ? 'BG-CAMP' : 'BG-BATTLE';
    if (this.backdrop.children[0]?.name !== id) { this.clear(this.backdrop); this.image(id, 0, 0, 0, W, H, false, this.backdrop); }
  }
  private render(): void {
    if (!this.ready || this.loading) return;
    this.clear(this.ui); this.labels = []; this.hotzones = []; this.hud.clear(); this.aimGraphics = undefined;
    const r = this.session.data.run, battle = this.session.inBattle && !!r;
    this.world.active = battle; this.effects.active = battle; this.background(!battle && this.page !== 'stages');
    if (battle) this.renderBattle(r!); else if (this.page === 'camp') this.renderCamp(); else if (this.page === 'stages') this.renderStages(); else if (this.page === 'heroes') this.renderHeroes(); else this.renderDetail();
    if (this.modal) this.renderModal();
    if (this.session.error) {
      this.popup('进度尚未保存', '当前操作已暂停'); this.text('保存失败，原有记录已保留。\n重试成功后继续；若其它窗口已更新，\n请退出此窗口并重新打开游戏。', 470, 745, 34, 660, 240);
      this.button('重试保存', 245, 1060, 450, 120, () => this.session.retrySave());
    }
    if (this.assetError && !this.session.error) { this.popup('资源加载失败'); this.text('请检查网络后重试', 470, 790, 36, 680); this.button('重试', 245, 1060, 450, 120, () => void this.enterBattle(true)); }
    this.signature = this.uiSignature();
  }
  private renderCamp(): void {
    const p = this.session.data.profile, r = this.session.data.run, ongoing = r?.status === 'active';
    const stage = ongoing ? r.stage : this.selectedStage;
    this.image('LOGO', 0, 272, 88, 405, 178, true); this.icon(15, '设置', 810, 54, () => this.openModal('settings'));
    this.panel(44, 808, 853, 486); this.wood(ongoing ? '进行中的挑战' : '新的挑战', 749);
    this.round(168, 895, 605, 86); this.text(`第${stage}关 · ${this.difficulty(stage)}`, 470, 939, 56, 580, 84, 'name');
    this.text(ongoing ? `已暂停 · 第${r.wave || 0}/15波` : `已通关${p.clearedStage}关`, 470, 1031, 38, 780);
    this.text(ongoing ? '本局进度已保留' : `15波怪物 · 通关最多${stage % 10 === 0 ? 10 : 5}张碎片`, 470, 1091, 31, 780);
    this.button(ongoing ? `继续第${stage}关` : `挑战第${stage}关`, 129, 1150, 685, 127, () => void this.enterBattle(!!ongoing));
    this.panel(45, 1334, 418, 179); this.image('UI-ICONS', 8, 81, 1361, 102, 119, true); this.text('关卡选择', 310, 1425, 41, 254); this.hit('关卡选择', 45, 1334, 418, 179, () => { this.page = 'stages'; });
    this.panel(479, 1334, 418, 179); this.portrait('RH01', 505, 1357, 130, 138); this.text('英雄培养', 750, 1425, 41, 254); this.hit('英雄培养', 479, 1334, 418, 179, () => { this.page = 'heroes'; });
    if (this.session.data.migration === 'imported' && p.clearedStage === 0) this.text('已继承旧版英雄等级 · 新关卡从第1关开始', 470, 1560, 27, 850);
  }
  private difficulty(stage: number): string { return { normal: '普通', hard: '困难', superhard: '超困难' }[stageDef(stage).difficulty]; }
  private renderStages(): void {
    this.heading('关卡选择'); this.panel(63, 342, 815, 782);
    ['普通', '困难', '超困难'].forEach((v, i) => { this.image('UI-PROGRESSION', 6 + i, 156 + i * 264, 353, 44, 44, true); this.text(v, 249 + i * 264, 378, 29, 175); });
    for (let i = 1; i <= 20; i++) {
      const x = 126 + (i - 1) % 4 * 197, y = 419 + Math.floor((i - 1) / 4) * 134, available = i <= this.session.data.profile.clearedStage + 1;
      const n = this.image('UI-PROGRESSION', i % 10 === 0 ? 8 : i % 5 === 0 ? 7 : 6, x - 19, y, 139, 122, true); n.getComponent(Sprite)!.grayscale = !available;
      this.text(String(i), x + 51, y + 63, 44, 90, 67, 'hud');
      if (!available) this.image('IC-GLOBAL-REWARD', 13, x + 81, y + 73, 32, 43, true);
      if (i <= this.session.data.profile.clearedStage) this.image('UI-DECOR', 7, x + 71, y + 80, 41, 39, true);
      if (i === this.selectedStage) {
        // The decorated atlas ring has off-centre rays. Outline the button's actual centre instead.
        const ring = this.nodeAt('SelectedStageRing', this.ui, x + 50.5, y + 61, 144, 144).addComponent(Graphics);
        ring.strokeColor = toColor('#805014'); ring.lineWidth = 10; ring.circle(0, 0, 67); ring.stroke();
        ring.strokeColor = toColor('#ffdc4c'); ring.lineWidth = 6; ring.circle(0, 0, 67); ring.stroke();
      }
      this.hit(`第${i}关`, x - 20, y, 145, 128, () => { this.selectedStage = i; });
    }
    const stage = stageDef(this.selectedStage), locked = stage.id > this.session.data.profile.clearedStage + 1;
    const traits = stage.traitPool.map(t => RULES.traits.find(a => a.id === t)!.name).join(' / ') || '无';
    this.panel(44, 1146, 853, 338); this.image('RS01', 0, 100, 1244, 165, 187, true); this.image('RM01', 0, 235, 1337, 115, 97, true);
    this.round(395, 1176, 455, 62, '#e7d2f5'); this.text(`第${stage.id}关 · ${this.difficulty(stage.id)}`, 622, 1207, 36, 425, 53);
    this.text(locked ? `通关第${stage.id - 1}关后开放\n15波 · 通关最多${stage.id % 10 === 0 ? 10 : 5}张碎片` : `15波 · 小怪450只\n小Boss${stage.id % 10 === 0 ? 4 : 2}只 · 大Boss1只\n特性：${traits}\n通关最多${stage.id % 10 === 0 ? 10 : 5}张碎片`, 620, 1355, 27, 410, 178);
    this.button(locked ? '尚未解锁' : '开始挑战', 232, 1510, 476, 124, () => { if (this.session.data.run?.status === 'active') this.openModal('abandon'); else void this.enterBattle(false); }, false, !locked);
  }
  private renderHeroes(): void {
    this.heading('英雄收藏'); const p = this.session.data.profile, unlocked = unlockedHeroes(p); this.panel(33, 370, 875, 1142);
    this.text(`已解锁 ${unlocked.length}/6`, 470, 422, 42, 780);
    this.round(94, 478, 753, 82, '#f2e1b8'); this.text(`通用紫色 ${p.fragments['universal-purple'] || 0}张 · 通用金色 ${p.fragments['universal-gold'] || 0}张`, 470, 519, 31, 720);
    HEROES.forEach((h, i) => {
      const x = 49 + i % 2 * 438, y = 589 + Math.floor(i / 2) * 291, q = Q.indexOf(h.quality);
      this.round(x + 10, y + 14, 409, 251, ['#e0f5ff', '#f3e4ff', '#fff1ba'][q]); this.image('UI-PROGRESSION', q, x, y, 423, 275);
      this.round(x + 23, y + 41, 166, 186, '#fff5d9'); this.portrait(h.id, x + 32, y + 51, 148, 166);
      this.text(h.name, x + 295, y + 73, 29, 217); this.image('UI-ICONS', { melee: 9, ranged: 10, support: 11 }[h.role], x + 206, y + 108, 29, 32, true);
      this.text({ melee: '近战', ranged: '远程', support: '辅助' }[h.role], x + 301, y + 125, 24, 148);
      this.round(x + 203, y + 153, 184, 43, '#f3e0b3'); this.text(`等级 ${p.levels[h.id]}`, x + 295, y + 175, 27, 166, 43);
      this.text(`碎片 ${p.fragments[h.id] || 0}/10`, x + 298, y + 213, 25, 207);
      if (!unlocked.includes(h.id)) { const cover = this.round(x + 11, y + 12, 400, 250, '#f6edcf'); cover.node.addComponent(UIOpacity).opacity = 222; this.image('IC-GLOBAL-REWARD', 13, x + 175, y + 48, 60, 77, true); this.text(`第${h.unlockAfterStage}关解锁`, x + 212, y + 185, 30, 366); }
      this.hit(h.name + '培养', x, y, 423, 275, () => { this.selectedHero = h.id; this.page = 'detail'; });
    });
    this.text('点击英雄查看技能与培养', 470, 1580, 31, 850);
  }
  private renderDetail(): void {
    const h = heroDef(this.selectedHero), p = this.session.data.profile, level = p.levels[h.id], stats = permanentStats(h.id, level), unlocked = unlockedHeroes(p).includes(h.id);
    this.heading(h.name, 'heroes'); this.panel(43, 369, 855, 1170); this.portrait(h.id, 90, 419, 300, 280);
    this.text(`${qualityNames[h.quality]} · Lv.${level}`, 632, 457, 45, 450);
    this.text(`生命 ${cleanNumber(stats.hp)}\n攻击 ${cleanNumber(stats.attack)}\n防御 ${cleanNumber(stats.defense)}`, 632, 583, 32, 410, 180);
    for (let i = 1; i <= 3; i++) {
      const s = skillDef(h.id, i), v = this.cardView({ id: '', kind: 'skill', quality: s.cardQuality, heroId: h.id, skillSlot: i, level: i === 1 ? 2 : 1 });
      const y = 748 + (i - 1) * 171; this.image('IC-SKILLS', (i - 1) * 6 + HEROES.findIndex(a => a.id === h.id), 87, y, 102, 102, true);
      this.text(s.name, 514, y + 22, 33, 602, 55, 'name'); this.text(v.lines.join(' · '), 518, y + 87, 25, 593, 86);
    }
    this.text(`专属碎片 ${p.fragments[h.id] || 0}${h.quality === 'blue' ? '' : ` + 通用 ${p.fragments['universal-' + h.quality] || 0}`}\n每10张升一级，优先消耗专属碎片`, 470, 1325, 29, 745, 102);
    this.button(!unlocked ? `第${h.unlockAfterStage}关解锁` : level >= 20 ? '已满级' : '升级英雄', 227, 1423, 485, 108, () => this.openModal('upgrade'), false, unlocked && level < 20 && upgradeCost(p, h.id).available);
  }
  private async enterBattle(resume: boolean, abandon = false): Promise<void> {
    if (this.loading) return; this.loading = true; this.assetError = ''; this.renderLoading('正在准备战斗素材…');
    try {
      await this.assets.loadGroup('battle'); if (!this.isValid) return;
      const ok = resume ? this.session.resume() : this.session.start(this.selectedStage, Date.now() >>> 0, abandon);
      this.loading = false; if (ok) { this.modal = ''; this.selectedCard = ''; } this.render();
    } catch (e) { this.loading = false; this.assetError = String(e); this.render(); }
  }
  private renderBattle(r: Run): void {
    this.image('LOGO', 0, 37, 67, 230, 100, true); this.round(334, 69, 350, 66, '#294a35');
    this.hud.set('wave', this.text(r.wave ? `第 ${r.wave} / 15 波` : '准备 / 15 波', 509, 102, 35, 310, 65, 'hud')); this.round(326, 145, 366, 63, '#294a35');
    this.hud.set('energy', this.text(`能量 ${r.energy} / 100`, 510, 176, 27, 340, 60, 'hud'));
    this.image('UI-COMPONENTS', 11, 827, 76, 79, 79); this.hit('暂停', 810, 55, 113, 122, () => this.session.pause(true));
    r.slots.forEach((h, i) => {
      const x = RULES.screen.heroCentersX[i] * W;
      if (!h) { this.image('UI-DECOR', 6, x - 42, 1346, 84, 68); this.text(this.selectedCard ? '点击上阵' : '待招募', x, 1461, 23, 160); }
      else { this.text(h.hp <= 0 ? '阵亡' : heroDef(h.id).name, x, 1461, 23, 178, 40, h.hp <= 0 ? 'hud' : 'body'); this.round(x - 21, 1491, 42, 6, qualityColors[Q.indexOf(heroDef(h.id).quality)]); }
      this.hit(`英雄槽${i + 1}`, x - 65, 1286, 130, 200, () => {
        if (this.selectedCard && !h) { if (this.session.choose(this.selectedCard, i)) this.selectedCard = ''; }
        else if (h) { this.selectedHero = h.id; this.openModal('ability'); }
      }, !r.rescue && (!this.selectedCard || !h));
    });
    this.image('UI-PANELS', 5, 404, 1311, 132, 132);
    if (r.globalSkill) this.image('FX-GLOBAL-' + r.globalSkill, 0, 425, 1332, 90, 88, true); else this.text('空', 470, 1375, 30, 95);
    this.text(r.globalSkill ? RULES.globalSkills[r.globalSkill].displayName : '技能空槽', 470, 1470, 29, 230);
    this.text(r.globalSkill ? '一次性' : '抽取后装载', 470, 1510, 23, 235);
    this.hit('中央技能槽', 404, 1311, 132, 132, () => { this.aimPoint = { x: .5, y: .5, angle: 0 }; this.session.aim(); }, !!r.globalSkill && !r.candidates.length && !r.rescue);
    if (!r.aiming) {
      this.round(264, 1555, 414, 73, '#294c37');
      ([1, 1.5, 2] as const).forEach((v, i) => { const x = 280 + i * 130; if (r.rate === v) this.round(x, 1567, 118, 49, '#f7efcd'); this.text(v + '×', x + 59, 1591, 29, 103, 48, r.rate === v ? 'name' : 'hud'); this.hit(v + '倍速度', x, 1545, 118, 96, () => this.session.speed(v)); });
    }
    if (r.drawDebt) this.text(`预支待抵扣 ${r.drawDebt}次`, 470, 304, 27, 490, 46, 'hud');
    if (r.status !== 'active') this.renderSettlement(r);
    else if (r.rescue) this.renderRescue(r);
    else if (r.paused && !this.modal) this.renderPause();
    else if (r.candidates.length) {
      if (this.selectedCard && r.candidates.some(c => c.id === this.selectedCard && c.kind === 'hero')) this.renderPlacement(r);
      else { this.selectedCard = ''; this.renderDraft(r); }
    } else if (r.aiming) this.renderAim(r);
  }
  private cardView(card: Card): CardView {
    const id = card.kind === 'hero' ? 'HERO-' + card.heroId : card.kind === 'attribute' ? `${card.heroId}-ATTR-all` : card.kind === 'global' ? 'GLOBAL-' + card.quality : `${card.heroId}-S${card.skillSlot}-L${card.level}`;
    return cardViews.find(c => c.id === id)!;
  }
  private artPack(id: string): string { return /^RH0[1-6]$/.test(id) ? 'FX-' + id : this.assets.info(id) ? id : 'FX-' + id; }
  private cardArt(c: CardView, x: number, y: number): void {
    const a = c.art as { kind: string; hero?: string; pack?: string; frame?: number };
    if (a.kind === 'portrait') { this.portrait(a.hero!, x + 28, y + 78, 226, 187); return; }
    if (a.kind === 'attribute') {
      this.portrait(a.hero!, x + 67, y + 80, 148, 141);
      [11, 9, 10].forEach((frame, i) => this.image('IC-GLOBAL-REWARD', frame, x + 42 + i * 70, y + 206, 59, 65, true)); return;
    }
    let pack = a.pack!, frame = a.frame || 0;
    if (c.kind === 'global' && c.quality === 'gold') { pack = 'IC-CARD-ART'; frame = 2; }
    else if (c.kind === 'global') {
      this.image(this.artPack(pack), c.quality === 'purple' ? 1 : 2, x + 28, y + 90, 226, 163, true).addComponent(UIOpacity).opacity = 140;
      this.image(this.artPack(pack), 0, x + 58, y + 88, 166, 167, true); return;
    }
    if (pack.startsWith('SUM-')) this.image('FX-' + a.hero, a.hero === 'RH06' ? 7 : 3, x + 33, y + 157, 216, 94, true).addComponent(UIOpacity).opacity = 140;
    else if (a.hero && pack !== 'IC-CARD-ART') this.image('FX-' + a.hero, 2, x + 40, y + 100, 202, 157, true).addComponent(UIOpacity).opacity = 61;
    this.image(this.artPack(pack), frame, x + 45, y + 87, 195, 178, true);
    if (c.family === 'RH04-S2') { this.image('FX-RH04', 0, x + 40, y + 158, 80, 70, true); this.image('FX-RH04', 0, x + 176, y + 82, 70, 70, true); }
  }
  private renderDraft(r: Run): void {
    this.block(false);
    const opening = r.drawQueue[0] === 'opening'; this.text(opening ? '招募一名英雄' : '选择一张卡牌', 470, 461, 55, 860, 83, 'title');
    const origin = { opening: '开局准备', energy: '能量抽卡', boss: '击败Boss', grandpa: '老爷爷预支' }[r.drawQueue[0]];
    this.text(`${origin} · ${opening ? `第${4 - r.drawQueue.filter(q => q === 'opening').length}/3次` : `待选${r.drawQueue.length}次`}`, 470, 516, 29, 820, 42, 'hud');
    r.candidates.forEach((card, i) => {
      const c = this.cardView(card), x = 33 + i * 297, y = 556, q = Q.indexOf(card.quality);
      const panel = this.image('UI-CARDS', q, x, y, 282, 560); this.text(c.typeLabel, x + 141, y + 42, 28, 225, 48, 'type'); this.cardArt(c, x, y);
      if (card.kind === 'skill') this.text(heroDef(card.heroId!).name, x + 141, y + 277, 22, 222);
      this.text(c.title, x + 141, y + 306, 29, 230, 48, 'name'); this.round(x + 25, y + 331, 232, 43, ['#e0f5ff', '#f3e4ff', '#fff1ba'][q]); this.text(c.badge, x + 141, y + 352, 25, 219, 40, 'name');
      let lines = c.lines;
      if (card.kind === 'attribute') {
        const h = r.slots.find(h => h?.id === card.heroId)!, delta = attributeBonuses(h);
        lines = [`攻击 ${cleanNumber(h.attack)} → ${cleanNumber(h.attack + delta.attack)}`, `生命 ${cleanNumber(h.maxHp)} → ${cleanNumber(h.maxHp + delta.hp)}`, `防御 ${cleanNumber(h.defense)} → ${cleanNumber(h.defense + delta.defense)}`];
      }
      this.text(lines.join('\n'), x + 141, y + 415, 23, 233, 92);
      this.image('UI-CARDS', q + 3, x + 26, y + 488, 230, 52); this.text(c.action, x + 141, y + 514, 25, 202, 44, 'cta');
      this.hit(c.title, x, y, 282, 560, () => { if (card.kind === 'hero') this.selectedCard = card.id; else this.session.choose(card.id); }, true, panel);
    });
    if (opening) this.text('完成3次选择后开始战斗', 470, 1170, 28, 820, 45, 'hud');
  }
  private renderPlacement(r: Run): void {
    const c = r.candidates.find(c => c.id === this.selectedCard)!;
    this.text(`为${heroDef(c.heroId!).name}选择空槽`, 470, 500, 50, 860, 85, 'title');
    this.button('返回选卡', 300, 1080, 340, 112, () => { this.selectedCard = ''; }, true);
  }
  private renderAim(r: Run): void {
    this.block(false);
    const n = this.nodeAt('SkillAim', this.ui, W / 2, H / 2, W, H); this.aimGraphics = n.addComponent(Graphics); this.drawAim();
    const target = this.hit('技能瞄准区域', 42, 209, 857, 1045, () => undefined);
    const move = (e: EventTouch) => { const p = e.getUILocation(), local = this.stage.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
      this.aimPoint.x = Math.max(0, Math.min(1, (local.x + W / 2 - 42) / 857)); this.aimPoint.y = Math.max(0, Math.min(1, (H / 2 - local.y - 209) / 1045)); this.aimPoint.angle = (this.aimPoint.x - .5) * 50; this.drawAim(); };
    target.on(Node.EventType.TOUCH_START, move); target.on(Node.EventType.TOUCH_MOVE, move);
    this.text(`瞄准中 · 覆盖${Math.round(RULES.globalSkills[r.globalSkill!].coverageAreaFraction * 100)}%`, 470, 1188, 34, 820, 66, 'hud');
    this.button('取消', 173, 1537, 277, 112, () => this.session.cancelAim(), true); this.button('释放技能', 482, 1537, 288, 112, () => this.session.cast(this.aimPoint.x, this.aimPoint.y, this.aimPoint.angle));
  }
  private drawAim(): void {
    const r = this.session.data.run, g = this.aimGraphics; if (!g || !r?.globalSkill) return;
    const area = skillArea(r.globalSkill, this.aimPoint.x, this.aimPoint.y, this.aimPoint.angle), scale = W / 720;
    const x = (32 + area.center.x) * scale - W / 2, y = H / 2 - (160 + area.center.y) * H / 1280;
    g.clear(); g.strokeColor = toColor(qualityColors[Q.indexOf(r.globalSkill)]); g.fillColor = new Color(g.strokeColor.r, g.strokeColor.g, g.strokeColor.b, 38); g.lineWidth = 5;
    if (area.quality === 'purple') { area.polygon.forEach((p, i) => { const px = (32 + p.x) * scale - W / 2, py = H / 2 - (160 + p.y) * H / 1280; if (!i) g.moveTo(px, py); else g.lineTo(px, py); }); g.close(); }
    else if (area.quality === 'gold') {
      // Radial waves are clipped to the effective battle; coverage is not a rectangular decal.
      for (const fraction of [.28, .61, .95]) {
        let connected = false;
        for (let i = 0; i <= 180; i++) {
          const angle = i / 180 * Math.PI * 2, px = area.center.x + Math.cos(angle) * area.radius * fraction, py = area.center.y + Math.sin(angle) * area.radius * fraction;
          if (px < 0 || px > 656 || py < 0 || py > 800) { connected = false; continue; }
          const dx = (32 + px) * scale - W / 2, dy = H / 2 - (160 + py) * H / 1280;
          if (connected) g.lineTo(dx, dy); else g.moveTo(dx, dy); connected = true;
        }
      }
      g.stroke(); return;
    }
    else g.circle(x, y, area.radius * scale);
    g.fill(); g.stroke();
  }
  private renderRescue(r: Run): void {
    const grandpa = r.rescue === 'grandpa'; this.popup(grandpa ? '老爷爷救我' : '全员阵亡', grandpa ? '3名英雄阵亡' : '本次挑战尚未结束');
    if (grandpa) {
      this.image('GRANDPA', 0, 108, 538, 275, 316, true); this.text('复活3名英雄\n预支3次抽卡', 646, 701, 43, 377, 216);
      this.text('后续3次能量抽卡将抵扣\nBoss抽卡不受影响\n不占用全灭免费复活', 470, 934, 32, 682, 157); this.text('每局1次，拒绝也消耗机会', 470, 1063, 30, 695);
      this.button('拒绝援助', 111, 1110, 344, 101, () => this.session.rescue(false), true); this.button('接受援助', 483, 1110, 344, 101, () => this.session.rescue(true));
    } else {
      this.image('UI-ICONS', 4, 342, 571, 255, 240, true); this.text(r.freeReviveUsed ? '本局免费复活机会已使用\n本次未通关，未获得碎片' : '满血复活全部已上阵英雄\n获得2秒保护，不额外赠卡\n本局还可免费复活1次', 470, 936, 34, 700, 189);
      if (r.freeReviveUsed) this.button('结束战斗', 252, 1100, 438, 112, () => this.session.rescue(false));
      else { this.button('结束战斗', 112, 1100, 342, 112, () => this.session.rescue(false), true); this.button('免费复活', 486, 1100, 342, 112, () => this.session.rescue(true)); }
    }
  }
  private renderPause(): void {
    this.popup('暂停'); this.button('继续战斗', 185, 607, 570, 120, () => this.session.pause(false));
    this.button('设置', 185, 797, 570, 120, () => this.openModal('settings'), true);
    this.button('保存并返回营地', 185, 1017, 570, 120, () => { if (this.session.camp()) { this.page = 'camp'; this.clearEffects(); } }, true);
  }
  private renderSettlement(r: Run): void {
    this.popup(r.status === 'victory' ? '挑战成功' : '挑战结束', `第${r.stage}关 · ${this.difficulty(r.stage)}`);
    if (r.status === 'victory') {
      this.image('UI-VICTORY', 0, 125, 555, 691, 259, true);
      const rewards = this.session.data.settlement?.rewards || [];
      const names = rewards.map(a => `${a.key.startsWith('universal') ? a.key === 'universal-gold' ? '通用金色' : '通用紫色' : heroDef(a.key).name}碎片 ×${a.count}`);
      this.text(names.join('\n') || '正在保存奖励…', 470, 949, 31, 690, 214);
    } else { this.image('UI-DECOR', 5, 326, 575, 290, 257, true); this.text('本次未通关，未获得碎片\n培养英雄后再次挑战吧', 470, 929, 37, 720, 175); }
    this.button('返回营地', 240, 1100, 461, 112, () => { if (this.session.camp()) { this.page = 'camp'; this.selectedStage = Math.min(20, this.session.data.profile.clearedStage + 1); this.clearEffects(); } });
  }
  private renderModal(): void {
    const p = this.session.data.profile;
    if (this.modal === 'settings') {
      this.popup('设置'); this.button(`音乐：${p.music ? '开启' : '关闭'}`, 180, 614, 580, 117, () => this.session.settings('music', !p.music), true);
      this.button(`音效：${p.sound ? '开启' : '关闭'}`, 180, 796, 580, 117, () => this.session.settings('sound', !p.sound), true); this.button('完成', 235, 1067, 470, 117, () => this.closeModal());
    } else if (this.modal === 'upgrade') {
      const h = heroDef(this.selectedHero), cost = upgradeCost(p, h.id), level = p.levels[h.id], before = permanentStats(h.id, level), after = permanentStats(h.id, Math.min(20, level + 1));
      this.popup('升级英雄', h.name); this.portrait(h.id, 140, 586, 210, 233);
      this.text(`Lv.${level} → Lv.${Math.min(20, level + 1)}\n生命 ${cleanNumber(before.hp)} → ${cleanNumber(after.hp)}\n攻击 ${cleanNumber(before.attack)} → ${cleanNumber(after.attack)}\n防御 ${cleanNumber(before.defense)} → ${cleanNumber(after.defense)}`, 603, 736, 32, 425, 273);
      this.text(`消耗专属碎片${cost.specific}张${cost.universal ? ` + 通用${cost.universal}张` : ''}\n已开始的对局保持原有属性`, 470, 977, 31, 720, 116);
      this.button('取消', 128, 1099, 314, 110, () => this.closeModal(), true); this.button('确认升级', 489, 1099, 324, 110, () => { if (this.session.upgrade(h.id)) { this.audio?.emit('permanent_upgrade'); this.closeModal(); } }, false, cost.available);
    } else if (this.modal === 'abandon') {
      this.popup('开始新的挑战'); this.text('当前对局尚未结束。\n开始新挑战将放弃本局进度，\n不会获得本局碎片奖励。', 470, 816, 38, 692, 247);
      this.button('保留旧局', 112, 1099, 342, 110, () => this.closeModal(), true); this.button('开始新局', 486, 1099, 342, 110, () => { this.modal = ''; void this.enterBattle(false, true); });
    } else if (this.modal === 'ability') {
      const h = this.session.data.run?.slots.find(h => h?.id === this.selectedHero); if (!h) return;
      this.popup(h.hp <= 0 ? '英雄阵亡' : '英雄能力', heroDef(h.id).name);
      this.text(`生命 ${Math.ceil(h.hp)}/${Math.ceil(h.maxHp)}    防御 ${cleanNumber(h.defense)}\n攻击 ${cleanNumber(h.attack)}    永久等级 ${h.level}`, 470, 631, 31, 713, 109);
      for (let i = 0; i < 3; i++) this.text(`${skillDef(h.id, i + 1).name}\n${h.skills[i] ? `Lv.${h.skills[i]}${i ? ` · 冷却${Math.ceil(h.cooldowns[i])}秒` : ''}` : '尚未解锁'}`, 470, 766 + i * 101, 30, 713, 94);
      this.button('返回战斗', 246, 1099, 447, 110, () => this.closeModal());
    }
  }
  private uiSignature(): string {
    const r = this.session.data.run;
    return JSON.stringify([this.session.inBattle, this.page, this.modal, this.selectedHero, this.selectedStage, this.selectedCard, this.session.error, this.assetError, this.session.data.profile,
      r?.status, r?.rescue, r?.paused, r?.aiming, r?.globalSkill, r?.rate, r?.drawDebt, r?.drawQueue, r?.candidates, r?.slots.map(h => h ? [h.id, h.hp <= 0] : null)]);
  }
  private actor(uid: number): ActorView {
    let actor = this.actors.get(uid); if (actor) return actor;
    const node = this.nodeAt('Actor:' + uid, this.world, 0, 0, 100, 100), sprite = node.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    const barNode = this.nodeAt('Health', this.world, 0, 0, 100, 20), bar = barNode.addComponent(Graphics);
    const traitNode = this.nodeAt('Trait', this.world, 0, 0, 50, 50), trait = traitNode.addComponent(Sprite); trait.sizeMode = Sprite.SizeMode.CUSTOM;
    const shieldNode = this.nodeAt('Shield', this.world, 0, 0, 100, 20), shield = shieldNode.addComponent(Graphics);
    actor = { node, sprite, bar, trait, shield }; this.actors.set(uid, actor); return actor;
  }
  private placeActor(uid: number, id: string, x: number, feet: number, height: number, action: string, time: number, hp = 1, shield = 0, trait: string | null = null, protectedHero = false): void {
    const view = this.actor(uid), atlas = action === 'move' && this.assets.info('WALK-' + id) ? 'WALK-' + id : id;
    const index = this.assets.pose(atlas, action, time), a = this.assets.info(atlas), f = a?.frames[index]; if (!f) return;
    view.atlas = atlas; view.frame = index;
    view.node.setPosition(x - W / 2, H / 2 - feet); const t = view.node.getComponent(UITransform)!;
    t.setContentSize((f.widthRatio || 1) * height, (f.heightRatio || 1) * height); t.setAnchorPoint(f.anchor[0], f.anchor[1]); view.sprite.spriteFrame = this.assets.frame(atlas, index); view.sprite.grayscale = hp <= 0;
    const bw = id.startsWith('RM') ? 55 : id.startsWith('RH') ? 88 : 130;
    view.bar.node.setPosition(x - W / 2, H / 2 - feet + height + 10); view.bar.clear();
    view.bar.fillColor = toColor('#243c35'); view.bar.roundRect(-bw / 2, 0, bw, 12, 6); view.bar.fill();
    if (hp > 0) { view.bar.fillColor = toColor(id.startsWith('R') && !id.startsWith('RH') ? '#fb7c68' : '#45e85e'); view.bar.roundRect(-bw / 2 + 2, 2, Math.max(1, (bw - 4) * Math.min(1, hp)), 8, 4); view.bar.fill(); }
    view.shield.node.setPosition(x - W / 2, H / 2 - feet + height + 26); view.shield.clear();
    if (shield > 0) { view.shield.fillColor = toColor('#6de4f1'); view.shield.roundRect(-bw / 2, 0, bw * Math.min(1, shield), 5, 2); view.shield.fill(); }
    view.trait.node.active = !!trait || protectedHero; view.trait.node.setPosition(x - W / 2 + height * .29, H / 2 - feet + height * .35);
    view.trait.node.getComponent(UITransform)!.setContentSize(height * .68, height * .68);
    view.trait.spriteFrame = protectedHero ? this.assets.frame('FX-RH06', 4) : trait ? this.assets.frame('FX-TRAIT-LOCAL', Number(trait.slice(1)) - 1) : null;
  }
  private updateWorld(r: Run): void {
    const living = new Set<number>(), time = now(r);
    r.slots.forEach(h => {
      if (!h) return; living.add(h.uid); const action = this.actionUntil.get(h.uid);
      this.placeActor(h.uid, h.id, h.x * W, 1427, (this.assets.info(h.id)?.displayHeight || 105) * W / 720,
        h.hp <= 0 ? 'defeated' : action && action.until > time ? action.action : 'idle', h.hp <= 0 ? time - (h.deathTick || 0) / 60 : action && action.until > time ? time - action.from : time, h.hp / h.maxHp, h.shield / h.maxHp, h.weakUntil > time ? 'T07' : null, h.protectionUntil > time);
    });
    for (const e of r.enemies) {
      if (e.hp <= 0) continue; living.add(e.uid);
      const a = this.assets.info(e.id), height = (a?.displayHeight || 60) * W / 720;
      const actor = this.actor(e.uid);
      // Inspect simulation steps, not render frames: slow motion can render the same tick repeatedly.
      if (actor.lastTick !== r.tick) {
        actor.moving = actor.lastY === undefined || Math.abs(e.x - actor.lastX!) + Math.abs(e.y - actor.lastY) > 1e-7;
        actor.lastX = e.x; actor.lastY = e.y; actor.lastTick = r.tick;
      }
      const action = e.residual ? 'defeated' : e.stunUntil > time || e.rootUntil > time ? 'controlled' : e.windup ? e.windup.kind === 'basic' ? 'attack' : 'special' : actor.moving ? 'move' : 'idle';
      if (actor.action !== action) { actor.action = action; actor.actionFrom = time; }
      this.placeActor(e.uid, e.id, (32 + e.x * 656) * W / 720, (160 + e.y * 800) * H / 1280, height,
        action, time - (actor.actionFrom || 0), e.hp / e.maxHp, e.shield / e.maxHp, e.trait);
    }
    for (const s of r.summons) {
      if (s.hp <= 0) continue;
      living.add(s.uid); const x = (32 + s.x * 656) * W / 720, feet = (160 + s.y * 800) * H / 1280, a = this.actionUntil.get(s.uid);
      const action = a && a.until > time ? a.action : s.fortressUntil > time ? 'ultimate' : 'idle';
      this.placeActor(s.uid, s.id, x, feet, 105, action, a && a.until > time ? time - a.from : time, s.hp / s.maxHp);
      const actor = this.actor(s.uid); actor.action = action;
      if (s.id === 'SUM-BURST') {
        actor.bar.node.active = false;
        if (!actor.ammo) {
          actor.ammo = this.text(`余弹 ${s.shots}`, x, feet - 125, 28, 160, 42, 'hud', this.world);
          actor.ammo.overflow = Label.Overflow.NONE;
        }
        actor.ammo.string = `余弹 ${Math.max(0, s.shots)}`; actor.ammo.node.setPosition(x - W / 2, H / 2 - feet + 125);
      }
    }
    for (const [uid, a] of this.actors) if (!living.has(uid)) { a.node.destroy(); a.bar.node.destroy(); a.trait.node.destroy(); a.shield.node.destroy(); a.ammo?.node.destroy(); this.actors.delete(uid); this.actionUntil.delete(uid); }
    const missiles = new Set<number>();
    for (const p of r.projectiles) {
      missiles.add(p.uid); let node = this.missiles.get(p.uid);
      if (!node) { const friendly = p.side === 'hero' ? friendlyProjectileVisual(p.effect) : null;
        if (p.side === 'hero' && !friendly) continue;
        const pack = friendly ? friendly.pack : p.effect.startsWith('RM') ? 'FX-ENEMY-MINION-ATTACK' : 'FX-ENEMY-BOSS-ATTACK';
        const frame = friendly ? friendly.frame : Math.max(0, ['RM01', 'RM02', 'RM04', 'RM05'].indexOf(p.effect)) * 3;
        const size = friendly ? friendly.size : 34;
        node = this.image(pack, frame, 0, 0, size, size, true, this.effects); this.missiles.set(p.uid, node); }
      node.setPosition((32 + p.x * 656) * W / 720 - W / 2, H / 2 - (160 + p.y * 800) * H / 1280);
    }
    for (const [uid, node] of this.missiles) if (!missiles.has(uid)) { node.destroy(); this.missiles.delete(uid); }
    const wave = this.hud.get('wave'), energy = this.hud.get('energy');
    if (wave) wave.string = r.wave ? `第 ${r.wave} / 15 波` : '准备 / 15 波'; if (energy) energy.string = `能量 ${r.energy} / 100`;
  }
  private effect(e: BattleEvent): void {
    const r = this.session.data.run!;
    if (e.type === 'summon' || e.type === 'summon-attack' || e.type === 'ally-hit' && r.summons.some(s => s.uid === e.target && s.hp > 0)) {
      const action = e.type === 'summon' ? 'spawn' : e.type === 'summon-attack' ? 'action' : 'hit';
      if (e.target !== undefined) this.actionUntil.set(e.target, { action, until: now(r) + (action === 'hit' ? .24 : .4), from: now(r) });
    }
    if (e.type === 'summon-end' || e.type === 'summon-spent' || e.type === 'ally-death' && e.source.startsWith('SUM-')) {
      this.summonExit(e); return;
    }
    if (e.type === 'enemy-hit' && e.source === 'RH01-S1' && this.fx.length < 64) this.punch(e);
    if (['enemy-hit', 'ally-hit', 'heal'].includes(e.type) && e.amount && this.fx.filter(f => f.floating).length < 24) {
      const x = (32 + e.x * 656) * W / 720, y = (160 + e.y * 800) * H / 1280 - 50;
      const label = this.text((e.type === 'heal' ? '+' : '') + Math.ceil(e.amount), x, y, 27, 140, 50, 'hud', this.effects);
      label.color = toColor(e.type === 'heal' ? '#94ff98' : e.type === 'ally-hit' ? '#ff9e7a' : '#fff4ae'); label.node.addComponent(UIOpacity);
      this.fx.push({ node: label.node, age: 0, duration: .55, size: 40, tick: e.tick, floating: true });
    }
    if (e.type === 'hero-skill' || e.type === 'hero-attack' || e.type === 'revive') {
      const h = r.slots.find(h => h?.id === e.source.slice(0, 4)); if (h) this.actionUntil.set(h.uid, { action: e.type === 'revive' ? 'revive' : e.type === 'hero-skill' ? 'cast' : 'attack', until: now(r) + .5, from: now(r) });
    }
    let pack = '', frame = 0, size = 110, duration = .45;
    if (e.type === 'hero-skill') { pack = 'FX-' + e.source.slice(0, 4); frame = e.source.endsWith('S2') ? 3 : 6; size = Math.max(120, (e.radius || .16) * 656 * W / 720 * 2); duration = .7; }
    if (e.type === 'enemy-hit') { const visual = friendlyImpactVisual(e.source); if (visual) { pack = visual.pack; frame = visual.frame; size = visual.size; duration = visual.duration; } }
    if (e.type === 'enemy-attack') { pack = e.source.startsWith('RM') ? 'FX-ENEMY-MINION-ATTACK' : 'FX-ENEMY-BOSS-ATTACK'; frame = Math.max(0, (e.source.startsWith('RM') ? ['RM01', 'RM02', 'RM04', 'RM05'] : ['RS01', 'RS02', 'RL01', 'RL02']).indexOf(e.source)) * 3 + 2; }
    if (e.type === 'enemy-death') { pack = e.source; frame = 7; size = (this.assets.info(e.source)?.displayHeight || 60) * W / 720; duration = .4; }
    if (e.type === 'global-cast') { pack = 'FX-GLOBAL-' + e.source; frame = 2; size = e.source === 'gold' ? 1050 : (e.radius || .3) * 656 * W / 720 * 2; duration = .8; }
    if (e.type === 'boss-warning' || e.type === 'boss-skill') { pack = 'FX-BOSS-SKILLS'; frame = Math.max(0, ['RS01', 'RS02', 'RL01', 'RL02'].indexOf(e.source)) * 3 + (e.type === 'boss-warning' ? 0 : 2); size = (e.radius || .22) * 656 * W / 720 * 2; duration = e.type === 'boss-warning' ? 1 : .5; }
    if (e.type === 'boss-command') { pack = 'FX-BOSS-COMMAND'; frame = 3; size = 340; duration = 1; }
    if (e.type === 'revive') { pack = 'FX-RH03'; frame = 4; size = 170; duration = .8; }
    if (!pack || this.fx.length >= 64 && e.type === 'enemy-hit') return;
    if (this.fx.length >= 80) { const old = this.fx.shift()!; old.node.destroy(); }
    const x = (32 + e.x * 656) * W / 720, y = (160 + e.y * 800) * H / 1280;
    const n = this.image(pack, frame, x - size / 2, y - size / 2, size, size, true, this.effects); n.addComponent(UIOpacity);
    this.fx.push({ node: n, age: 0, duration, size, tick: e.tick });
  }
  private summonExit(e: BattleEvent): void {
    const x = (32 + e.x * 656) * W / 720, feet = (160 + e.y * 800) * H / 1280;
    const node = this.nodeAt('SummonExit:' + e.source, this.effects, x, feet, 105, 105);
    const sprite = node.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM; node.addComponent(UIOpacity);
    this.fx.push({ node, age: 0, duration: e.type === 'summon-spent' ? .6 : .4, size: 105, tick: e.tick,
      summonExit: { id: e.source, action: e.type === 'summon-spent' ? 'spent' : e.type === 'ally-death' ? 'defeated' : 'despawn' } });
  }
  private punch(e: BattleEvent): void {
    const h = this.session.data.run!.slots.find(h => h?.id === 'RH01'); if (!h) return;
    const node = this.nodeAt('SpringPunch', this.effects, W / 2, H / 2, W, H); node.addComponent(UIOpacity);
    const spring = this.image('FX-RH01', 1, 0, 0, 40, 120, false, node);
    const glove = this.image('FX-RH01', 0, 0, 0, 112, 112, true, node);
    this.fx.push({ node, age: 0, duration: .38, size: 112, tick: e.tick,
      punch: { fromX: h.x * W, fromY: 1360, toX: (32 + e.x * 656) * W / 720, toY: (160 + e.y * 800) * H / 1280 - 20, glove, spring } });
  }
  private clearEffects(): void { this.fx.forEach(f => f.node.destroy()); this.fx = []; for (const n of this.missiles.values()) n.destroy(); this.missiles.clear(); }
  update(dt: number): void {
    this.resize(); if (!this.ready || this.loading) return;
    this.elapsed += dt; this.session.tick(dt); const r = this.session.data.run;
    this.audio?.update(dt, this.session.data.profile, r, this.session.inBattle);
    if (this.uiSignature() !== this.signature) this.render();
    if (r && this.session.inBattle) {
      if (r.id !== this.runId) { this.runId = r.id; this.eventCursor = r.eventSequence; this.clearEffects(); this.actionUntil.clear(); }
      this.updateWorld(r);
      for (const e of r.events) if (e.seq > this.eventCursor) { this.effect(e); this.audio?.battleEvent(e); } this.eventCursor = r.eventSequence;
      const scale = this.session.error || this.session.background ? 0 : effectiveRate(r);
      for (const f of this.fx) {
        const delta = Math.min(.25, dt) * scale; f.age += delta; const t = Math.min(1, f.age / f.duration);
        f.node.getComponent(UIOpacity)!.opacity = 255 * (f.punch ? Math.min(1, (1 - t) * 4) : 1 - t);
        if (f.punch) {
          const p = f.punch, reach = t < .28 ? .35 + .65 * t / .28 : t < .5 ? 1 : 1 - (t - .5) * 1.7;
          const dx = (p.toX - p.fromX) * reach, dy = (p.toY - p.fromY) * reach, angle = Math.atan2(-dy, dx) * 180 / Math.PI - 90;
          p.glove.setPosition(p.fromX + dx - W / 2, H / 2 - p.fromY - dy); p.glove.angle = angle;
          p.spring.setPosition(p.fromX + dx / 2 - W / 2, H / 2 - p.fromY - dy / 2); p.spring.angle = angle;
          p.spring.getComponent(UITransform)!.setContentSize(34, Math.max(12, Math.hypot(dx, dy) - 38));
        } else if (f.summonExit) {
          const exit = f.summonExit, finishingShot = exit.action === 'spent' && f.age < .2;
          const action = finishingShot ? 'action' : exit.action === 'defeated' ? 'defeated' : 'despawn';
          const frame = this.assets.pose(exit.id, action, finishingShot ? .2 : Math.max(0, f.age - (exit.action === 'spent' ? .2 : 0))), info = this.assets.info(exit.id)!.frames[frame];
          f.node.getComponent(Sprite)!.spriteFrame = this.assets.frame(exit.id, frame);
          const transform = f.node.getComponent(UITransform)!; transform.setContentSize((info.widthRatio || 1) * f.size, (info.heightRatio || 1) * f.size); transform.setAnchorPoint(info.anchor[0], info.anchor[1]);
          f.node.getComponent(UIOpacity)!.opacity = 255 * (finishingShot ? 1 : Math.min(1, (1 - t) * 2));
        } else { f.node.setScale(1 + t * .15, 1 + t * .15, 1); if (f.floating) f.node.setPosition(f.node.position.x, f.node.position.y + delta * 80); }
      }
      this.fx = this.fx.filter(f => { if (f.age >= f.duration || r.status !== 'active') { f.node.destroy(); return false; } return true; });
      this.labels = this.labels.filter(l => l.isValid);
    }
    if (sys.isBrowser && typeof document !== 'undefined' && /(?:\?|&)qa(?:=1|&|$)/.test(window.location.search)) {
      document.documentElement.dataset.r1 = JSON.stringify({ ...this.describe(), run: r ? { stage: r.stage, tuning: runTuning(r), wave: r.wave, tick: r.tick, status: r.status, rescue: r.rescue,
        heroes: r.slots.map(h => h ? { id: h.id, hp: h.hp, skills: h.skills } : null), candidates: r.candidates, energy: r.energy, kills: r.kills, debt: r.drawDebt, spawned: r.spawnedMinions,
        targets: r.slots.map(h => h ? { id: h.id, uid: h.uid, x: h.x, windup: h.windup?.targets || [] } : null),
        enemies: r.enemies.map(e => ({ uid: e.uid, id: e.id, hp: e.hp, x: e.x, y: e.y })),
        summons: r.summons.map(s => ({ uid: s.uid, id: s.id, hp: s.hp, shots: s.shots })),
        projectiles: r.projectiles.map(p => ({ uid: p.uid, effect: p.effect, target: p.target, retargeted: !!p.retargeted })),
        recentEvents: r.events.slice(-16).map(e => ({ type: e.type, source: e.source, target: e.target })) } : null });
    }
  }
  private onHide(): void { this.session.hide(); this.audio?.hide(); }
  private onShow(): void { this.session.show(); this.audio?.show(); this.resize(); }
  describe(): object {
    return { version: RULES.version, page: this.session.inBattle ? 'battle' : this.page, modal: this.modal, status: this.session.data.run?.status, qaScene: this.qaScene,
      assetError: this.assetError, storageError: this.session.error, assets: this.assets.report(), fonts: this.typography.report(),
      labels: this.labels.filter(l => l.isValid).map(l => this.typography.describe(l)), buttons: this.hotzones, cardHeight: 560, cardTop: 556, cardBackdrop: false,
      actorNodes: this.actors.size, effects: this.fx.length, audioErrors: this.audio?.errors || [],
      summonExits: this.fx.filter(f => f.summonExit).map(f => ({ ...f.summonExit!, age: f.age })),
      actorVisuals: Array.from(this.actors.entries()).map(([uid, a]) => ({ uid, atlas: a.atlas, frame: a.frame, action: a.action, healthBar: a.bar.node.active, ammo: a.ammo?.string })),
      attackVisuals: { punches: this.fx.filter(f => f.punch).length, projectiles: Array.from(this.missiles.values()).map(n => ({ pack: n.name, width: n.getComponent(UITransform)!.width, height: n.getComponent(UITransform)!.height })) } };
  }
  onDestroy(): void {
    game.off(Game.EVENT_HIDE, this.onHide, this); game.off(Game.EVENT_SHOW, this.onShow, this);
    this.audio?.destroy(); this.assets.destroy();
    if (sys.isBrowser && typeof window !== 'undefined') delete (window as any).__r1;
  }
}
