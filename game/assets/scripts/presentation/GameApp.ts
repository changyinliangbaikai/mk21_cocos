import { _decorator, BlockInputEvents, Button, Canvas, Component, EventTouch, game, Game, Graphics, Input, JsonAsset, Label, Layers, Mask, Node, profiler, resources, screen, Sprite, SpriteFrame, sys, UITransform, Vec3, view } from 'cc';
import { GameSession } from '../domain/session';
import { color, Palette as P, round, shape } from './ToyVisuals';
import { SpriteActor, SpriteVisuals, VisualAction } from './SpriteVisuals';
import { AssetCatalog } from './AssetCatalog';
import { Typography, TextRole } from './Typography';
import { AudioDirector } from './AudioDirector';
import { captureAudioState } from './AudioEvents';
import { TextureEffects, captureVfxState } from './TextureEffects';
import { battleCircleScreen, battleRangeDashes, battleProjectionContract, battleReserveScreen, battleScreenToWorld, worldToBattleScreen } from './BattleProjection';
import { fitMiniGameStage, menuLowerEdgeInView } from './MiniGameLayout';
import { douyinSidebar, HEALTHY_PLAY_NOTICE } from './PlatformRelease';
import { R1GameApp } from './R1GameApp';

const { ccclass } = _decorator;
const HERO_SHORT: Record<string, string> = { H001: '厨师', H002: '拳师', H003: '青蛙', H004: '阿姨' };
const HERO_ROLE: Record<string, string> = { H001: '爆炸范围 · 玉米连锁', H002: '穿透拳套 · 击退怪群', H003: '范围音波 · 减速易伤', H004: '追踪拖鞋 · 优先精英' };
const SKILL_NAME: Record<string, string> = { K001: '玉米大爆炸', K002: '都给我回去', K003: '全场蹦迪', K004: '祖传连环拖鞋', P001: '天降大拖鞋', P002: '全体起立', P003: '给我安静' };
const CARD_COPY: Record<string, string> = {
  C001: '厨师普攻与标记爆炸半径 +20%\n代价：普攻周期 +5%', C002: '厨师直接普攻伤害 +8%\n玉米标记爆伤 +25%（连锁需三星）',
  C003: '拳师索敌射程、拳套射线长度 +20%', C004: '拳师普攻与都给我回去击退 +20%\n仍受怪物控制抵抗和预算限制',
  C005: '青蛙普攻音波半径 +15%\n自动伤害 +10%', C006: '青蛙普攻与手动技能减速持续 +20%\n不增加减速强度与硬控时长',
  C007: '阿姨普攻目标死亡可改向一次\n普攻与手动技对精英/Boss伤害 +15%', C008: '阿姨普攻与手动技\n对精英/Boss伤害 +25%',
  C009: '击退沿途最多碰撞2只同路怪\n第1/2层造成10/15物理伤害，不递归', C010: '全体英雄普攻周期 ×0.97\n可重复叠选，不改变手动技能冷却',
  C011: '全体英雄索敌射程 +5%\n可重复叠选，不扩大技能范围', C012: '全体英雄自动及自动派生伤害 +10%\n可重复叠选，不提升K/P手动技能',
  C013: '解锁范围手动技：180物理伤害\n第2/3层伤害 +15%/+30%，不刷新冷却', C014: '解锁全场手动技：40能量伤害+击退\n第2/3层新冷却38/36秒',
  C015: '解锁范围手动技：基础硬控3秒\n第2/3层范围110/120，不刷新冷却',
};

type Animated = { node: Node; actor: SpriteActor; x: number; y: number; phase: number; heroId?: string; action: VisualAction };
type EnemyView = { node: Node; actor: SpriteActor; hp: Graphics; size: number };

/** All controls and drawing are native Cocos nodes; gameplay only changes through GameSession. */
@ccclass('GameApp')
export class GameApp extends Component {
  session!: GameSession;
  private stage!: Node;
  private page!: Node;
  private loadedConfig: any;
  private catalog!: AssetCatalog;
  private typography = new Typography();
  private visuals!: SpriteVisuals;
  private audio?: AudioDirector;
  private textureEffects?: TextureEffects;
  private ready = false;
  private layoutKey = '';
  private pendingResume = false;
  private visualRunId = '';
  private visualWave = 0;
  private visualFloorTick = 0;
  private get config(): any {
    const d: any = this.session?.data;
    return d && ['battle', 'result'].includes(d.screen) && d.run?.config ? d.run.config : this.loadedConfig;
  }
  private generation = 0;
  private signature = '';
  private elapsed = 0;
  private labels: Record<string, Label> = {};
  private avatars: Animated[] = [];
  private enemyViews = new Map<string, EnemyView>();
  private worldLayer: Node | null = null;
  private textureLayer: Node | null = null;
  private effectLayer: Graphics | null = null;
  private rangeLayer: Graphics | null = null;
  private selectedRangeHeroId: number | null = null;
  private selectedRangeRunId = '';
  private energyBadgeFrame: SpriteFrame | null = null;
  private cardRevealUntil = 0;
  private bulletBadge: Node | null = null;
  private localModal = '';
  private healthyPlayPending = !sys.isBrowser;
  private modalHero = '';
  private previewForm = '';
  private previewHero = '';
  private previewAction: VisualAction = 'idle';
  private summonHero = '';
  private movingHero = '';
  private aimingSkill = '';
  private aimTarget: any = null;
  private gesture: { id: string; touchId: number; x: number; y: number; dragging: boolean } | null = null;
  private tutorialKey = '';
  private dragHint = '';
  private dragPoint: { x: number; y: number } | null = null;
  private forecastExpanded = false;
  private effects: { x: number; y: number; untilTick: number; fill: string; size: number }[] = [];
  private rescueActor: SpriteActor | null = null;
  private rescueStartedAt = 0;
  private baseNormal: Node | null = null;
  private baseDamaged: Node | null = null;
  private cooldownViews: { [id: string]: Graphics } = {};
  private cooldownIcons: { [id: string]: Node | null } = {};
  private lastEnemyHp = new Map<string, number>();
  private titleInfo = new WeakMap<Node, string>();
  private controlInfo = new WeakMap<Node, { label: string; muted: boolean }>();
  private referenceInfo = new WeakMap<Node, { id: string; semanticLabel: string; fixedLettering: boolean }>();

  onLoad(): void {
    // Keep the Boot scene UUID stable while routing new sessions to the approved R1 implementation.
    this.enabled = false;
    this.node.addComponent(R1GameApp);
  }

  private loadLegacyPresentation(): void {
    // Creator debug builds may enable the profiler before the first scene.
    // Keep the play surface clear; QA reads state without a permanent HUD.
    profiler.hideStats();
    this.stage = new Node('PrototypeNativeUI'); this.stage.setParent(this.node); this.stage.layer = Layers.Enum.UI_2D;
    this.stage.addComponent(UITransform).setContentSize(720, 1280);
    this.stage.on(Node.EventType.TOUCH_START, this.onUserGesture, this, true);
    this.stage.on(Node.EventType.TOUCH_END, this.onUserGesture, this, true);
    this.resize();
    this.page = new Node('Loading'); this.page.setParent(this.stage);
    this.text('正在准备超力英雄…', 360, 600, 600, 80, 32);
    resources.load('prototype-v0.5', JsonAsset, async (error, asset) => {
      if (!this.isValid || !this.node.isValid) return;
      if (error) { this.text(`配置加载失败\n${error.message}`, 360, 720, 660, 220, 24, P.red); return; }
      try {
        if (!this.isValid || !this.node.isValid) return;
        this.loadedConfig = asset.json;
        this.catalog = new AssetCatalog();
        await Promise.all([this.catalog.load(), this.typography.load()]);
        if (!this.isValid || !this.node.isValid) return;
        this.visuals = new SpriteVisuals(this.catalog);
        this.session = new GameSession(this.loadedConfig, sys.localStorage);
        this.audio = new AudioDirector(); this.audio.initialize(this.catalog, this.node); this.audio.observe(this.session.data);
        this.textureEffects = new TextureEffects(); this.textureEffects.initialize(this.catalog);
        this.textureEffects.setNumberStyle((label,size)=>this.typography.apply(label,'number',size,'#FFF4AE'));
        this.textureEffects.observe(this.session.data);
        if (sys.isBrowser && typeof window !== 'undefined' && /(?:\?|&)qa(?:=1|&|$)/.test(window.location?.search || '')) {
          (window as any).__gameApp = this.session;
          (window as any).__gameUI = { refresh: () => this.render(), describe: () => this.describeUI() };
        }
        this.ready = true; this.render();
      } catch (e) { if (this.isValid && this.page?.isValid) this.text(`存档或配置无法打开\n${String(e)}`, 360, 760, 660, 240, 22, P.red); }
    });
    game.on(Game.EVENT_HIDE, this.onBackground, this);
    game.on(Game.EVENT_SHOW, this.onForeground, this);
  }

  onDestroy(): void { this.audio?.destroy(); this.textureEffects?.destroy(); this.energyBadgeFrame?.destroy(); game.off(Game.EVENT_HIDE, this.onBackground, this); game.off(Game.EVENT_SHOW, this.onForeground, this); }
  private onUserGesture(): void { this.audio?.userGesture(); }
  private onBackground(): void {
    this.cancelDrag(); this.clearRescueActor(); this.audio?.background(); this.textureEffects?.background();
    if(this.session&&this.ready){this.pendingResume=true;this.session.dispatch('pauseBackground');}
  }
  private onForeground(): void {
    profiler.hideStats(); this.visualFloorTick = this.session?.data.run?.battle.tick || 0; this.effects = [];
    this.audio?.foreground(); this.textureEffects?.foreground(); this.layoutKey = ''; this.resize(); this.signature = '';
  }
  private resumeSavedPhase(): void {
    if(!this.pendingResume)return;
    if(this.sendCommand('resumeBackground')){this.pendingResume=false;this.render();}
  }
  private resize(): void {
    const size = view.getVisibleSize(), origin = view.getVisibleOrigin(), viewport = view.getViewportRect();
    const key = [size.width, size.height, origin.x, origin.y, viewport.y, screen.windowSize.height].join(',');
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    const visible = { x: origin.x, y: origin.y, width: size.width, height: size.height };
    let safe = visible, menuEdge: number | undefined;
    if (!sys.isBrowser) {
      const host = (globalThis as any).tt || (globalThis as any).wx;
      if (host) {
        try { safe = sys.getSafeAreaRect(false); } catch { /* Older hosts keep the visible bounds. */ }
        try {
          const menu = host.getMenuButtonLayout?.() || host.getMenuButtonBoundingClientRect?.();
          const info = host.getSystemInfoSync?.();
          menuEdge = menuLowerEdgeInView(menu?.bottom, info?.windowHeight, screen.windowSize.height, viewport.y, view.getScaleY());
        } catch { /* Unsupported menu APIs do not prevent starting the game. */ }
      }
    }
    const layout = fitMiniGameStage(visible, safe, menuEdge);
    this.stage?.setScale(layout.scale, layout.scale, 1);
    this.stage?.setPosition(layout.x, layout.y, 0);
  }

  update(dt: number): void {
    if (!this.session || !this.ready) return;
    if (this.healthyPlayPending) { this.resize(); return; }
    const previousPhase = this.session.data.run?.phase;
    this.elapsed += dt; this.session.advance(dt); this.resize();
    if(previousPhase==='battle'&&this.session.data.run?.phase==='cards')this.cardRevealUntil=this.elapsed+.35;
    if(this.gesture?.dragging&&this.session.data.overlay!=='move')this.cancelDrag();
    this.audio?.observe(this.session.data); this.audio?.update(dt);
    this.textureEffects?.observe(this.session.data); this.textureEffects?.update(dt,this.session.combatTimeScale());
    this.checkTutorial();
    const sig = this.getSignature();
    if (sig !== this.signature && !this.gesture?.dragging) this.render();
    this.animate(dt); this.updateBattle();
  }

  private getSignature(): string {
    const d: any = this.session.data, r = d.run;
    return JSON.stringify([d.screen, d.overlay, d.selectedHero, d.rosterDraft, [d.profile.heroes,d.profile.roster,d.profile.trainingXp,d.profile.completedWaves,d.profile.settings], d.notice, d.tutorial, r?.phase, r?.battle.wave,
      r?.battle.heroes.map((h: any) => [h.id, h.type, h.star, h.slot]), r?.equipped, Object.keys(r?.skills || {}), r?.candidates, r?.cards,
      r?.ad, r?.pendingUnlocks, this.localModal, this.previewForm, this.previewAction, this.tutorialKey, this.forecastExpanded,this.pendingResume,this.selectedRangeHeroId,this.elapsed<this.cardRevealUntil,
      this.healthyPlayPending, douyinSidebar()?.available, douyinSidebar()?.fromSidebar, douyinSidebar()?.busy, douyinSidebar()?.error]);
  }

  private run(command: string, payload?: any): boolean {
    const ok = this.sendCommand(command, payload);
    if (!this.gesture?.dragging) this.render();
    return ok;
  }
  private sendCommand(command: string, payload?: any): boolean {
    const before = captureAudioState(this.session.data), beforeVfx = captureVfxState(this.session.data), ok = this.session.dispatch(command, payload);
    this.audio?.command(command, payload, ok, before, captureAudioState(this.session.data));
    this.textureEffects?.command(command, payload, ok, beforeVfx, captureVfxState(this.session.data));
    if (ok && command === 'grandpa') this.showRescueActor();
    if (ok && command === 'chooseCard') this.forecastExpanded=false;
    return ok;
  }

  private render(): void {
    if (!this.session) return;
    if (!this.inspectedRange()) this.selectedRangeHeroId = null;
    this.generation++;
    this.textureEffects?.attach(null);
    this.page?.destroy(); this.page = new Node(`Screen-${this.session.data.screen}`); this.page.setParent(this.stage); this.page.layer = Layers.Enum.UI_2D;
    this.page.addComponent(UITransform).setContentSize(720, 1280);
    this.labels = {}; this.avatars = []; this.enemyViews.clear(); this.worldLayer = null; this.textureLayer = null; this.effectLayer = null; this.rangeLayer = null; this.bulletBadge = null; this.baseNormal = null; this.baseDamaged = null;
    this.cooldownViews = {}; this.cooldownIcons = {};
    this.box(360, 640, 720, 1280, '#EAF1E6', 0);
    if (this.healthyPlayPending) {
      this.referenceImage('V4_BG_CAMP');
      this.modal('超力英雄', '', 700);
      this.displayText('健康游戏忠告', 360, 480, 580, 80, 34);
      this.text(HEALTHY_PLAY_NOTICE, 360, 645, 600, 240, 28);
      this.button('开始游戏', 360, 880, 540, 88, () => { this.healthyPlayPending = false; this.render(); }, P.lake, 30);
      this.signature = this.getSignature();
      return;
    }
    const backgroundId = this.session.data.screen === 'battle' ? 'BG_BATTLE' : this.session.data.screen === 'result' ? 'BG_RESULT' : this.session.data.screen === 'hero' && this.catalog.image('BG_GROWTH') ? 'BG_GROWTH' : 'BG_CAMP';
    const referenceBackground = this.session.data.screen === 'camp' ? 'V4_BG_CAMP' : this.session.data.screen === 'collection' ? 'V4_BG_COLLECTION' : '';
    if (referenceBackground && this.catalog.image(referenceBackground)) this.referenceImage(referenceBackground);
    else this.visuals.image(this.page, `Background-${backgroundId}`, backgroundId, 0, 0, 720, 1280, 'cover');
    const d: any = this.session.data;
    this.textureEffects?.setProjection(d.screen === 'battle' ? worldToBattleScreen : undefined,
      d.screen === 'battle' ? battleScreenToWorld({x:169*720/941,y:104*1280/1672}) : undefined);
    if (d.screen === 'camp') this.camp();
    else if (d.screen === 'collection') this.collection();
    else if (d.screen === 'hero') this.heroDetail();
    else if (d.screen === 'roster') this.roster();
    else if (d.screen === 'battle') this.battleScreen();
    else if (d.screen === 'result') this.resultScreen();
    if (d.screen !== 'battle') this.bottomNavigation();
    if (d.screen === 'battle') this.battleOverlay();
    if (d.screen === 'battle' && !d.overlay && ['cards', 'deploy', 'freeDeploy'].includes(d.run.phase) && this.forecastExpanded) this.forecastDialog();
    if (d.overlay === 'replace') this.replaceDialog();
    if (d.overlay === 'rosterDiscard' || d.overlay === 'discardRoster') this.discardDialog();
    if (d.overlay === 'settings') this.settingsDialog();
    if (d.overlay === 'background') this.backgroundDialog();
    this.localDialog();
    this.notice();
    if(this.pendingResume)this.backgroundDialog();
    const interfaceEffects = !this.worldLayer || ['firstFailure', 'secondFailure', 'adPending', 'victory', 'defeat'].includes(d.run?.phase);
    this.textureEffects?.attach(interfaceEffects ? this.makeNode('InterfaceTextureEffects', 360, 640, 720, 1280) : this.textureLayer || this.worldLayer);
    if (this.rescueActor?.node.isValid) this.rescueActor.node.setSiblingIndex(this.stage.children.length - 1);
    this.signature = this.getSignature();
    this.updateBattle();
  }

  private makeNode(name: string, x: number, y: number, w: number, h: number, parent = this.page): Node {
    const n = new Node(name.replace(/\//g, '·')); n.setParent(parent); n.layer = Layers.Enum.UI_2D; n.setPosition(x - 360, 640 - y); n.addComponent(UITransform).setContentSize(w, h); return n;
  }
  private box(x: number, y: number, w: number, h: number, fill = P.cream, radius = 22, stroke?: string, parent = this.page, skinId?: string): Node {
    const n = this.makeNode('Panel', x, y, w, h, parent), g = n.addComponent(Graphics);
    const skin = radius > 0 ? this.visuals?.sliced(n, skinId || (fill === P.cream ? 'UI_PANEL' : 'UI_PANEL_INSET'), w, h) : null;
    if (skin) return n;
    if (radius > 0) { g.fillColor = color('#354F56', 28); g.roundRect(-w / 2, -h / 2 - 5, w, h, radius); g.fill(); }
    round(g, -w / 2, -h / 2, w, h, radius, fill, stroke || (radius > 0 ? P.line : undefined), 2);
    if (radius > 0 && w > 140 && h > 60) { g.strokeColor = color('#FFFFFF', 145); g.lineWidth = 2; g.roundRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8, Math.max(3, radius - 4)); g.stroke(); }
    return n;
  }
  private text(value: string, x: number, y: number, w: number, h: number, size = 24, fill = P.ink, key?: string, parent = this.page, role: TextRole = 'body'): Label {
    const n = this.makeNode(key ? `Text-${key}` : `Text-${value.slice(0, 20)}`, x, y, w, h, parent);
    const l = n.addComponent(Label); l.string = value;
    this.typography.apply(l, role, size, fill);
    if (key) this.labels[key] = l; return l;
  }
  private displayText(value: string, x: number, y: number, w: number, h: number, size = 32, fill = P.ink, role: TextRole = 'section', key?: string): Label {
    return this.text(value, x, y, w, h, size, fill, key, this.page, role);
  }
  /** Reference fragments are single, aspect-preserving sprites, never stretched nine-slices.
   * Their native control and state remain independent from the painted lettering. */
  private referenceImage(id: string, rect?: [number, number, number, number], semanticLabel = '', parent = this.page): Node | null {
    const entry = this.catalog.art(id), source = rect || entry?.designRect;
    if (!source) return null;
    const canvas = rect ? [720, 1280] : entry?.referenceCanvas || [720, 1280];
    const [left, top, width, height] = source;
    const x = (left + width / 2) * 720 / canvas[0], y = (top + height / 2) * 1280 / canvas[1];
    const node = this.visuals.image(parent, `Reference-${id}`, id, x - 360, 640 - y, width * 720 / canvas[0], height * 1280 / canvas[1]);
    if (node) this.referenceInfo.set(node, { id, semanticLabel: semanticLabel || entry?.semanticLabel || '', fixedLettering: !!(semanticLabel || entry?.semanticLabel) });
    return node;
  }
  private referenceButton(id: string, label: string, onClick: () => void, rect?: [number, number, number, number], muted = false): Node | null {
    const node = this.referenceImage(id, rect, label);
    if (!node) return null;
    node.name = `Button-${label.replace(/\n/g, ' ').replace(/\//g, '·')}`;
    const button = node.addComponent(Button); button.target = node; button.transition = Button.Transition.SCALE; button.zoomScale = .97;
    button.interactable = !muted;
    if (muted) { const sprite = node.getComponent(Sprite); if (sprite) sprite.color = color('#C0C0C0'); }
    this.controlInfo.set(node, { label, muted });
    const generation = this.generation;
    node.on(Button.EventType.CLICK, () => { if (generation === this.generation && !muted) { this.audio?.userGesture(); onClick(); } });
    return node;
  }
  private button(value: string, x: number, y: number, w: number, h: number, onClick: () => void, fill = P.lake, size = 27, muted = false, iconId?: string | null, skinId?: string, textRole: TextRole = 'button'): Node {
    const vectorId = muted ? 'V4_BUTTON_DISABLED' : fill === P.purple ? 'V4_BUTTON_PURPLE' : fill === P.yellow ? 'V4_BUTTON_GOLD' : fill === P.cream ? 'V4_BUTTON_CREAM' : w / h > 4.7 ? 'V4_BUTTON_CYAN_WIDE' : 'V4_BUTTON_CYAN';
    const normalId = !skinId && this.catalog.image(vectorId) ? vectorId : muted ? 'UI_BUTTON_DISABLED' : skinId || (fill === P.purple ? 'UI_BUTTON_PURPLE' : fill === P.yellow || fill === P.cream ? 'UI_BUTTON_GOLD' : 'UI_BUTTON_LAKE');
    const n = this.box(x, y, w, h, muted ? '#D6E0DD' : fill, Math.min(24, h / 3), muted ? '#AABDB9' : fill === P.cream ? '#BDAD89' : '#315C72', this.page, normalId);
    const g = n.getComponent(Graphics)!;
    const skin = n.getChildByName(`Skin-${normalId}`);
    if (!skin && !muted && fill !== P.cream) { g.fillColor = color('#FFFFFF', 54); g.roundRect(-w / 2 + 7, h / 2 - 16, w - 14, 10, 5); g.fill(); }
    n.name = `Button-${value.replace(/\n/g, ' ').replace(/\//g, '·')}`; const b = n.addComponent(Button); b.transition = Button.Transition.SCALE; b.zoomScale = .96; b.interactable = !muted;
    if (skin) {
      b.target = skin; b.transition = Button.Transition.SPRITE;
      b.normalSprite = this.catalog.image(normalId); b.hoverSprite = b.normalSprite;
      const pressedId = /^UI_CARD_(CHEF|BOXER|FROG|AUNT)$/.test(normalId) ? normalId : normalId.startsWith('UI_CARD') ? 'UI_CARD_SELECTED' : normalId.startsWith('UI_SLOT') ? 'UI_SLOT_SELECTED' : `${normalId}_PRESSED`;
      b.pressedSprite = muted ? b.normalSprite : this.catalog.image(pressedId) || b.normalSprite;
      b.disabledSprite = this.catalog.image(normalId.startsWith('V4_') ? 'V4_BUTTON_DISABLED' : 'UI_BUTTON_DISABLED');
    }
    this.controlInfo.set(n, { label: value, muted });
    // Compact controls retain their full native label; a side icon would
    // consume the same horizontal space needed by “设置” or the speed value.
    iconId = iconId === null ? undefined : w < 140 ? undefined : iconId || this.navigationIcon(value);
    const icon = iconId ? this.icon(iconId, x - w * .32, y + 1, Math.min(h - 22, w * .25)) : null;
    const lines = value.split('\n').length, contentHeight = h - (lines > 1 ? 22 : 12);
    const textSize = lines > 1 ? Math.min(size, contentHeight / (lines * 1.14)) : size;
    const label = this.text(value, icon ? x + w * .15 : x, y - 1, icon ? w * .62 : w - 16, contentHeight, textSize, normalId.startsWith('V4_') && fill !== P.purple || fill === P.yellow || muted || fill === P.cream ? P.ink : '#FFFFFF', undefined, this.page, lines > 1 ? 'buttonBody' : textRole);
    if (lines > 1) label.lineHeight = textSize * 1.14;
    const generation = this.generation;
    n.on(Button.EventType.CLICK, () => { if (generation === this.generation) { this.audio?.userGesture(); onClick(); } });
    return n;
  }
  private navigationIcon(value: string): string | undefined {
    if (/设置|暂停|^Ⅱ$/.test(value)) return 'UI_SETTINGS';
    if (/技能库/.test(value)) return 'UI_LIBRARY';
    if (/编队/.test(value)) return 'UI_TEAM';
    if (/收藏/.test(value)) return 'UI_HEROES';
    if (/养成|升级/.test(value)) return 'UI_LEVEL_UP';
    if (/营地/.test(value)) return 'UI_HOME';
    if (/广告/.test(value)) return 'UI_AD';
    if (/复活/.test(value)) return 'UI_SHIELD';
    if (/^开始|^继续防守|^再次挑战/.test(value)) return 'UI_PLAY';
    if (/^返回|^‹/.test(value)) return 'UI_BACK';
    if (/^关闭|^取消/.test(value)) return 'UI_CLOSE';
    if (/说明|特性|预告/.test(value)) return 'UI_INFO';
    if (/^保存|已装|已穿戴/.test(value)) return 'UI_CHECK';
    return undefined;
  }
  private heading(title: string, sub = '', back = true): void {
    const titleId = ({ '英雄养成': 'V4_TITLE_GROWTH', '出战编队': 'V4_TITLE_ROSTER' } as Record<string, string>)[title];
    const referenceTitle = titleId ? this.referenceImage(titleId, undefined, title) : null;
    if (referenceTitle) this.titleInfo.set(referenceTitle, title); else this.titleWood(title, 360, 107, 574);
    if (sub) { this.box(360, 233, 670, 45, P.cream, 16); this.text(sub, 360, 231, 639, 33, 23, P.muted, undefined, this.page, 'caption'); }
    if (back && !this.referenceButton('V4_BACK', '‹ 返回', () => this.run('back'))) this.button('‹ 返回', 65, 67, 104, 76, () => this.run('back'), P.lake, 24);
    if (!this.referenceButton('V4_SETTINGS', '设置', () => this.run('settings'))) this.button('设置', 659, 67, 96, 76, () => this.run('settings'), P.lake, 24);
  }
  private titleWood(title: string, x: number, y: number, width: number): void {
    const meta: any = this.catalog.art('UI_TITLE_WOOD'), natural = this.catalog.image('UI_TITLE_WOOD')?.originalSize;
    const imageWidth = natural?.width || 1024, imageHeight = natural?.height || 384, height = width * imageHeight / imageWidth;
    if (!this.visuals.image(this.page, 'WoodTitle', 'UI_TITLE_WOOD', x - 360, 640 - y, width, height)) this.box(x, y + height * .15, width * .87, height * .51, '#CB9659', 22, '#7C512C', this.page, 'MissingWoodTitle');
    // The v002 safe rect was only 44 logical pixels tall and shrank the logo to body size.
    // Retain its optical centre, but reserve the whole plaque face for a real layered title.
    const rect = meta?.textSafeRect || [172, 187, 674, 79], scale = width / imageWidth;
    const cx = x + (rect[0] + rect[2] / 2 - imageWidth / 2) * scale;
    const cy = y + (rect[1] + rect[3] / 2 - imageHeight / 2) * scale + 8;
    const size = title.length <= 4 ? 94 : title.length <= 6 ? 65 : 54;
    // TTF spacingX is unsupported in Creator; space real glyph Labels explicitly.
    const glyphs = Array.from(title), gap = 2.5;
    const advances = glyphs.map(glyph => size * (/^[ -~]$/.test(glyph) ? .6 : 1));
    const total = advances.reduce((sum, advance) => sum + advance, 0) + gap * (glyphs.length - 1);
    const titleGroup = this.makeNode(`TitleGroup-${title}`, 360, 640, 720, 1280);
    this.titleInfo.set(titleGroup, title);
    for (const [role, offset] of [['titleOutline', -2], ['titleDepth', 3], ['titleFace', -2]] as [TextRole, number][]) {
      let cursor = cx - total / 2;
      glyphs.forEach((glyph, index) => {
        const label = this.displayText(glyph, cursor + advances[index] / 2, cy + offset, size + 42, 144, size, P.ink, role);
        label.node.name = `Title-${title}-${role}-${index}`; label.node.setParent(titleGroup);
        cursor += advances[index] + gap;
      });
    }
  }
  private avatar(id: string, form: string, x: number, y: number, size: number, action: VisualAction = 'idle', instanceId?: string, sizing?: { width: number; height: number; footY: number }): Node {
    const isBattle = instanceId !== undefined;
    const reserve = isBattle && this.session.data.run?.battle.heroes.find((h: any) => h.id === instanceId)?.slot.startsWith('R');
    const height = sizing?.height ?? (isBattle ? reserve ? 78 : 104 : size * 1.45);
    const footY = sizing?.footY ?? y + size * (reserve ? .32 : isBattle ? .24 : .36);
    const actor = this.visuals.actor(this.page, `Hero-${id}-${form}`, form, x - 360, 640 - footY, sizing?.width ?? (isBattle ? reserve ? 88 : 112 : size * 1.45), height);
    this.avatars.push({ node: actor.node, actor, x: x - 360, y: 640 - footY, phase: this.avatars.length * .7, heroId: instanceId, action });
    return actor.node;
  }
  private icon(id: string, x: number, y: number, size: number): Node | null { return this.visuals.image(this.page, `Icon-${id}`, id, x - 360, 640 - y, size, size); }
  private formName(id: string): string { return this.config.forms.find((f: any) => f.id === id)?.name || id; }
  private heroName(id: string): string { return this.config.heroes.find((h: any) => h.id === id)?.name || id; }
  private persistentRun(): boolean { const r: any = this.session.data.run; return !!r && !['victory', 'defeat'].includes(r.phase); }

  private bottomNavigation(): void {
    if (['hero', 'roster', 'result'].includes(this.session.data.screen)) return;
    const screen = this.session.data.screen, active = screen === 'roster' ? 'roster' : ['hero', 'collection'].includes(screen) ? 'collection' : 'camp';
    if (screen === 'camp' || screen === 'collection') {
      this.referenceImage(screen === 'camp' ? 'V4_NAV_BASE_CAMP' : 'V4_NAV_BASE_WOOD');
      const entries = screen === 'camp' ? [['camp', '营地', 'V4_NAV_CAMP_ACTIVE'], ['collection', '英雄', 'V4_NAV_HERO_IDLE'], ['roster', '出战', 'V4_NAV_ROSTER_IDLE']]
        : [['camp', '营地', 'V4_NAV_CAMP_IDLE'], ['collection', '英雄', 'V4_NAV_HERO_ACTIVE'], ['roster', '出战', 'V4_NAV_ROSTER_WOOD_IDLE']];
      entries.forEach(([target, label, id]) => { const control = this.referenceButton(id, label, () => { if (screen !== target) this.run('open', target); }); if (control) control.name = `Nav-${target}`; });
      return;
    }
    this.box(360, 1222, 720, 116, P.cream, 25, undefined, this.page, 'UI_NAV_BAR');
    [['camp', '营地', 'UI_HOME'], ['collection', '英雄', 'UI_HEROES'], ['roster', '出战', 'UI_TEAM']].forEach(([target, label, icon], i) => {
      const button = this.button(label, 124 + i * 236, 1219, 218, 87, () => { if (screen !== target) this.run('open', target); }, active === target ? P.lake : P.cream, 38, false, icon, undefined, 'nav');
      button.name = `Nav-${target}`;
    });
  }
  private heroCard(id: string, x: number, y: number, w: number, h: number, onClick?: () => void, selected = false): Node {
    const fills: Record<string, string> = { H001: '#FFE580', H002: '#FFB283', H003: '#7EEBE1', H004: '#C4A0F4' };
    const n = this.box(x, y, w, h, fills[id] || P.cream, 26, selected ? '#ECA936' : '#FFF3CB', this.page, ({H001:'UI_CARD_CHEF',H002:'UI_CARD_BOXER',H003:'UI_CARD_FROG',H004:'UI_CARD_AUNT'} as Record<string,string>)[id]);
    if (selected) { const g = n.getComponent(Graphics)!; g.strokeColor = color('#FFD35B'); g.lineWidth = 5; g.roundRect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 23); g.stroke(); }
    if (onClick) { n.addComponent(Button).transition = Button.Transition.NONE; const generation = this.generation; n.on(Button.EventType.CLICK, () => { if (this.generation === generation) { this.audio?.userGesture(); onClick(); } }); this.controlInfo.set(n, { label: this.heroName(id), muted: false }); }
    n.name = `HeroCard-${id}`; return n;
  }
  private stump(x: number, footY: number, width: number): void {
    const natural = this.catalog.image('UI_CAMP_STUMP')?.originalSize, height = width * (natural?.height || 288) / (natural?.width || 512);
    const meta: any = this.catalog.art('UI_CAMP_STUMP'), anchor = meta?.hero_ground_position_normalized_top_left || [.5, .33];
    const y = footY + height * (.5 - anchor[1]);
    if (this.visuals.image(this.page, 'CampStump', 'UI_CAMP_STUMP', x - 360 + width * (.5 - anchor[0]), 640 - y, width, height)) return;
    const g = this.makeNode('CampStump', x, y, width, width * .43).addComponent(Graphics);
    round(g, -width * .46, -width * .17, width * .92, width * .27, 10, '#98653C', '#62482F', 3);
    g.fillColor = color('#E4B66C'); g.ellipse(0, width * .08, width * .46, width * .13); g.fill(); g.strokeColor = color('#A77843'); g.lineWidth = 3; g.ellipse(0, width * .08, width * .35, width * .08); g.stroke();
  }

  private sourceRect(left: number, top: number, width: number, height: number): [number, number, number, number] {
    return [left * 720 / 941, top * 1280 / 1672, width * 720 / 941, height * 1280 / 1672];
  }
  private referenceText(value: string, rect: [number, number, number, number], sourceSize: number, fill = P.ink, role: TextRole = 'number', key?: string): Label {
    const [x, y, w, h] = this.sourceRect(...rect);
    return this.text(value, x + w / 2, y + h / 2, w, h, sourceSize * 720 / 941, fill, key, this.page, role);
  }
  private portraitReplacement(id: string, form: string, source: [number, number, number, number], preserveBackground = false): void {
    const [x, y, w, h] = this.sourceRect(...source), fills: Record<string, string> = { H001: '#FFDC55', H002: '#FFAA80', H003: '#38E7E0', H004: '#BE8DFA' };
    // Advanced forms have no original preview portrait. Replace the entire image
    // well, then crop a real animated actor to the same close-up framing.
    if (!preserveBackground) {
      const g = this.makeNode(`EquippedPortrait-${id}`, x + w / 2, y + h / 2, w, h).addComponent(Graphics);
      round(g, -w / 2, -h / 2, w, h, 7, fills[id] || P.cream);
    }
    const clip = this.makeNode(`PortraitClip-${id}`, x + w / 2, y + h / 2, w, h);
    clip.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;
    const actor = this.avatar(id, form, x + w / 2, y + h, 1, 'idle', undefined, { width: w * 2.6, height: h * 1.9, footY: y + h * 1.32 });
    actor.setParent(clip, true);
  }

  private camp(): void {
    const p: any = this.session.data.profile, r: any = this.session.data.run;
    const title = this.referenceImage('V4_TITLE_CAMP'); if (title) this.titleInfo.set(title, '超力英雄');
    this.referenceButton('V4_SETTINGS', '设置', () => this.run('settings'));
    this.referenceImage('V4_XP_PLATE');
    this.referenceImage('V4_LABEL_XP');
    this.referenceText(`${p.trainingXp}`, [874, 135, 44, 42], 30, P.ink, 'number', 'campXp');
    if (douyinSidebar()?.available) this.button('侧边栏再来玩', 120, 230, 198, 60, () => this.openLocal('sidebar'), P.cream, 24);
    this.referenceImage('V4_CAMP_CHALLENGE');
    this.referenceText(this.session.data.notice || (this.persistentRun() ? `当前防守 ${r.battle.wave}/20 波` : `累计完成 ${p.completedWaves} 波`), [202, 843, 539, 42], this.session.data.notice ? 23 : 35, '#785234', 'number', 'campProgress');
    this.referenceImage('V4_CAMP_ROSTER_PANEL');
    this.referenceImage('V4_LABEL_ROSTER');
    this.referenceText(`${p.roster.length}/4`, [245, 922, 102, 57], 48, '#D34B0D', 'number', 'campRosterCount');
    this.referenceButton('V4_ADJUST_ROSTER', '调整阵容', () => this.run('open', 'roster'));
    for (let i = 0; i < 4; i++) {
      const id = p.roster[i], left = [55, 267, 476, 687][i], rect = this.sourceRect(left, 986, 204, 211);
      if (id) {
        const progress = p.heroes[id], hero = this.config.heroes.find((h: any) => h.id === id);
        const card = this.referenceButton(`V4_CAMP_CARD_${id}`, `${this.heroName(id)} · Lv${progress.level}`, () => this.run('hero', id), rect);
        if (card) card.name = `HeroCard-${id}`;
        if (progress.equippedForm !== hero.default_form_id) this.portraitReplacement(id, progress.equippedForm, [left + 5, 990, 194, 163]);
        this.referenceText(`Lv.${progress.level}`, [left + 10, 1150, 184, 37], 35, P.ink, 'number', `rosterLevel${i}`);
      } else {
        const [x, y, w, h] = rect, slot = this.box(x + w / 2, y + h / 2, w, h, P.cream, 18);
        slot.name = `EmptyRoster-${i}`;
        this.referenceText('＋', [left + 22, 1011, 161, 98], 80, '#B9AA98', 'section');
        this.referenceText('空位', [left + 22, 1144, 161, 43], 33, '#998D7A', 'caption');
      }
    }
    this.referenceImage('V4_CAMP_GROWTH_PANEL');
    const upgradeable = this.config.heroes.find((h: any) => p.heroes[h.id].owned && p.heroes[h.id].level < this.config.progression.level_cap && p.trainingXp >= this.config.progression.level_costs[p.heroes[h.id].level - 1]);
    this.referenceText(upgradeable ? `${HERO_SHORT[upgradeable.id]}可以升级了` : '一起变强，守护营地！', [203, 1239, 444, 63], 35, '#684432', 'section', 'growthMessage');
    this.referenceButton('V4_GO_GROWTH', '去养成', () => this.run('hero', upgradeable?.id || p.roster[0] || 'H001'));
    this.referenceImage('V4_CTA_ACCENTS');
    if (this.persistentRun()) {
      const [x, y, w, h] = this.sourceRect(233, 1346, 474, 163);
      this.button('继续防守', x + w / 2, y + h / 2, w, h, () => this.run('continueRun'), P.lake, 57, false, null, undefined, 'cta');
      const [nx, ny, nw, nh] = this.sourceRect(722, 1420, 180, 67);
      this.button('开始新局', nx + nw / 2, ny + nh / 2, nw, nh, () => this.run('newRun'), P.cream, 23);
    } else this.referenceButton('V4_CTA_START', '开始防守', () => this.run('newRun'));
  }

  private collection(): void {
    const p: any = this.session.data.profile;
    const title = this.referenceImage('V4_TITLE_COLLECTION'); if (title) this.titleInfo.set(title, '我的英雄');
    this.referenceImage('V4_COLLECTION_COUNTER');
    const owned = this.config.heroes.filter((h: any) => p.heroes[h.id].owned).length;
    this.referenceImage('V4_LABEL_UNLOCKED');
    this.referenceText(`${owned}/4`, [753, 207, 85, 66], 49, '#B6650A', 'number', 'collectionOwned');
    this.referenceImage('V4_COLLECTION_PANEL');
    this.config.heroes.forEach((h: any, i: number) => {
      const progress = p.heroes[h.id], asset = h.id === 'H004' ? progress.owned ? 'V4_CARD_H004_OWNED' : 'V4_CARD_H004_LOCKED' : `V4_CARD_${h.id}`;
      const source: [number, number, number, number] = [i % 2 ? 478 : 45, i < 2 ? 319 : 812, i % 2 ? 411 : 423, i < 2 ? 482 : 536];
      const card = this.referenceButton(asset, `${h.name} · ${progress.owned ? '查看与养成' : '查看免费解锁'}`, () => this.run('hero', h.id), this.sourceRect(...source));
      if (card) card.name = `HeroCard-${h.id}`;
      if (progress.owned && progress.equippedForm !== h.default_form_id) this.portraitReplacement(h.id, progress.equippedForm, [source[0] + 10, source[1] + 2, source[2] - 20, i < 2 ? 321 : 338]);
      if (!progress.owned) {
        const current = Math.min(p.completedWaves, h.unlock_completed_waves), target = h.unlock_completed_waves, percent = Math.floor(current / target * 100);
        this.referenceText(`累计完成${target}波（${current}/${target}）`, [source[0] + 23, source[1] + 427, 369, 37], 29, P.ink, 'number', 'unlockProgress');
        this.referenceImage('V4_PROGRESS_TRACK');
        if (current > 0) {
          const [x, y, w, height] = this.sourceRect(514, 1288, 276, 35), filled = w * current / target;
          const fill = this.makeNode('UnlockProgressFill', x + filled / 2, y + height / 2, filled, height);
          this.visuals.sliced(fill, 'V4_PROGRESS_FILL', filled, height);
        }
        this.referenceText(`${percent}%`, [source[0] + 316, source[1] + 473, 77, 39], 32, P.ink, 'number', 'unlockPercent');
      }
    });
    if (this.session.data.notice) this.referenceText(this.session.data.notice, [106, 1360, 734, 44], 25, '#676A6D', 'caption');
    else { this.referenceImage('V4_LABEL_CARD_HELP'); this.referenceText('—', [260, 1360, 70, 44], 32, '#AEA18F', 'caption'); this.referenceText('—', [643, 1360, 70, 44], 32, '#AEA18F', 'caption'); }
  }
  private heroDetail(): void {
    const d:any=this.session.data,id=d.selectedHero,h=this.config.heroes.find((v:any)=>v.id===id),p=d.profile.heroes[id];
    if(this.previewHero!==id){this.previewHero=id;this.previewForm=p.equippedForm||h.default_form_id;this.previewAction='idle';}
    if(!p.owned){this.lockedHeroDetail();return;}
    const forms=this.config.forms.filter((f:any)=>f.hero_id===id),selected=forms.find((f:any)=>f.id===this.previewForm)||forms[0];
    const cap=this.config.progression.level_cap,cost=this.config.progression.level_costs[p.level-1],xp=d.profile.trainingXp;
    const owns=p.ownedForms.includes(selected.id),equipped=p.equippedForm===selected.id,current=selected.id===p.equippedForm;
    this.box(360,640,720,1280,'#FFF3D2',0);this.v5oImage('BG_GROWTH');
    this.v5oTitle('GROWTH_TITLE','英雄养成');this.v5oButton('BACK','返回',()=>this.run('back'));
    this.v5oImage('GROWTH_XP');this.v5oLiveNumber(`${xp}`,[849,47,61,42],34,'#FFFFFF','growthXp');
    if(id==='H001')this.v5oImage('GROWTH_NAME_H001');else{this.v5oImage('NAME_PLATE');this.referenceText(h.name,[42,165,268,65],49,P.ink,'name');}
    this.v5oImage('GROWTH_LEVEL');this.v5oLiveNumber(`Lv.${p.level}`,[75,240,112,50],44,'#FFFFFF','permanentLevel',true);
    this.v5oButton(current?'GROWTH_TAB_CURRENT_ACTIVE':'GROWTH_TAB_CURRENT_IDLE','当前形态',()=>{this.previewForm=p.equippedForm;this.previewAction='idle';this.render();});
    this.v5oButton(current?'GROWTH_TAB_PREVIEW_IDLE':'GROWTH_TAB_PREVIEW_ACTIVE','升级预览',()=>{this.previewForm=(forms.find((f:any)=>f.unlock_level>p.level)||forms[forms.length-1]).id;this.previewAction='idle';this.render();});
    if(id==='H001')this.v5oImage('GROWTH_QUOTE_H001');else this.referenceText(HERO_ROLE[id].replace(' · ','\n'),[45,321,240,111],29,'#534A43','body');
    this.v5oImage('GROWTH_ACTOR_BACKDROP');this.v5oImage('GROWTH_STAGE');
    this.v5oActor(id,selected.id,[295,150,450,420],this.previewAction);
    this.v5oImage('GROWTH_FORM_BADGE');this.referenceText(selected.name,[358,559,226,43],33,P.ink,'name','previewFormName');
    this.v5oButton('GROWTH_STATE_BADGE',equipped?'当前已穿戴':owns?`穿戴 · ${selected.name}`:`此形态需 Lv${selected.unlock_level} 解锁`,()=>this.run('equipForm',{heroId:id,formId:selected.id}),undefined,!owns||equipped);
    this.referenceText(equipped?'当前穿戴':owns?'已拥有 · 点此穿戴':`Lv.${selected.unlock_level} 解锁`,[370,516,205,36],owns&&!equipped?24:29,'#FFFFFF','number','formOwnership');
    this.v5oImage('GROWTH_STATS');
    const damage=Math.round((this.config.progression.damage_multipliers_by_level[p.level-1]-1)*100);
    const nextDamage=p.level<cap?Math.round((this.config.progression.damage_multipliers_by_level[p.level]-1)*100):damage;
    this.v5oLiveNumber(`Lv.${p.level}`,[70,631,169,77],72,P.ink,'growthCurrentLevel');
    if(p.level<cap){this.v5oImage('GROWTH_LEVEL_ARROW');this.v5oLiveNumber(`Lv.${p.level+1}`,[329,631,163,77],71,'#FFE224','growthNextLevel',true);}
    else this.referenceText('已满级',[311,640,211, 60],48,'#EEA51C','section');
    this.v5oLiveNumber(`+${damage}%`,[565,665,131,51],51,P.ink,'growthDamage');
    if(p.level<cap){this.v5oImage('GROWTH_DAMAGE_ARROW');this.v5oLiveNumber(`+${nextDamage}%`,[744,660,150,59],55,'#F37508','growthNextDamage');}
    else this.referenceText('永久加成',[744,669,150,46],29,'#AD783B','caption');
    forms.forEach((f:any,i:number)=>{
      const left=[23,324,622][i],owned=p.ownedForms.includes(f.id),isEquipped=p.equippedForm===f.id;
      const card=this.v5oButton(`FORM_CARD_${i}`,`${f.name} · ${isEquipped?'当前穿戴':owned?'已拥有':`Lv${f.unlock_level}解锁`}`,()=>{this.previewForm=f.id;this.previewAction='idle';this.render();});if(card)card.name=`Form-${f.id}`;
      this.portraitReplacement(id,f.id,[left+11,739,274,219],true);
      if(!owned)this.avatars[this.avatars.length-1].actor.tint('#B9B9C4');
      if(selected.id===f.id)this.v5oImage('FORM_SELECTED',[left,729,297,321]);
      this.referenceText(f.name,[left+13,961,269,38],33,P.ink,'name');
      this.referenceText(isEquipped?`Lv.${f.unlock_level} 当前穿戴`:owned?`Lv.${f.unlock_level} 已拥有`:`Lv.${f.unlock_level} 解锁`,[left+17,1001,261,38],29,isEquipped?'#008F44':owned?'#159957':'#69717B','number');
      if(!owned){const [x,y,w,ht]=this.sourceRect(left+237,755,43,43);this.icon('UI_LOCK',x+w/2,y+ht/2,43*720/941);}
    });
    this.v5oImage('GROWTH_ACTION_PANEL');
    (['idle','attack','victory'] as VisualAction[]).forEach((action,i)=>{
      const left=[41,336,626][i];this.v5oImage(`ACTION_WELL_${i}`);
      const [cx,cy,cw,ch]=this.sourceRect(left+4,1117,177,158);const clip=this.makeNode(`ActionClip-${action}`,cx+cw/2,cy+ch/2,cw,ch);clip.addComponent(Mask).type=Mask.Type.GRAPHICS_RECT;
      const actor=this.v5oActor(id,selected.id,[left-21,1095,240,205],action);actor.setParent(clip,true);
      const play=this.v5oButton('PLAY',['待机','攻击','胜利'][i],()=>{this.previewAction=action;this.render();},[left+183,1148,81,89]);if(play)play.name=`ActionPreview-${action}`;
      this.v5oImage(`LABEL_${['IDLE','ATTACK','VICTORY'][i]}`);
      if(this.previewAction===action){const [x,y,w,ht]=this.sourceRect(left+179,1143,89,98);const g=this.makeNode(`ActionSelected-${action}`,x+w/2,y+ht/2,w,ht).addComponent(Graphics);g.strokeColor=color('#FFD42E');g.lineWidth=2.5;g.roundRect(-w/2,-ht/2,w,ht,28);g.stroke();}
    });
    this.v5oSkillStrip(id);
    const upgrade=()=>{const before=p.ownedForms.length;if(this.run('upgrade',{heroId:id,expectedLevel:p.level,transactionId:`ui-${id}-${p.level}`})&&(this.session.data.profile as any).heroes[id].ownedForms.length>before){this.modalHero=id;this.openLocal('formUnlock');}};
    const can=p.level<cap&&xp>=cost;
    const upgradeButton=this.v5oLiveButton(p.level>=cap?`已满级 Lv${cap}`:'',[108,1430,725,125],upgrade,P.lake, 50,!can);
    upgradeButton.name=p.level>=cap?'Button-已满级':`Button-升级至 Lv${p.level+1} · 消耗 ${cost}`;
    this.controlInfo.set(upgradeButton,{label:p.level>=cap?`已满级 Lv${cap}`:`升级至 Lv${p.level+1} · 消耗 ${cost}`,muted:!can});
    if(p.level<cap){this.v5oImage('UPGRADE_PREFIX');this.v5oLiveNumber(`${cost}`,[422,1453,67,72],60,'#FFDE1B','upgradeCost',true);this.v5oImage('UPGRADE_XP_LABEL');}
    this.referenceText(d.notice||(p.level>=cap?'所有等级收益已永久保留':can?`升级后剩余 ${xp-cost}`:`还差 ${cost-xp} 训练经验 · 继续攻略获得`),[184,1557,573,35],26,'#5B554B','caption','growthHint');
    this.v5oImage('GROWTH_FOOTNOTE');
  }
  private roster(): void {
    const d:any=this.session.data,p=d.profile,draft:string[]=d.rosterDraft;
    this.box(360,640,720,1280,'#E7F4BB',0);this.v5oImage('BG_ROSTER');this.v5oTitle('ROSTER_TITLE','出战编队');this.v5oButton('ROSTER_BACK','返回',()=>this.run('back'));
    this.v5oImage('ROSTER_PANEL');this.v5oImage('ROSTER_LABEL');this.v5oLiveNumber(`${draft.length}/4`,[530,304,91,61],52,P.ink,'rosterCount');
    for(let i=0;i<4;i++){
      const id=draft[i],left=42+i*216;
      if(!id){this.v5oImage('ROSTER_EMPTY',[left,385,211,291]);continue;}
      const hp=p.heroes[id],h=this.config.heroes.find((v:any)=>v.id===id);
      const card=this.v5oButton(`ROSTER_CARD_${id}`,`${h.name} · Lv${hp.level}`,()=>this.run('hero',id),[left,385,211,291]);if(card)card.name=`RosterCard-${id}`;
      if(hp.equippedForm!==h.default_form_id)this.portraitReplacement(id,hp.equippedForm,[left+11,397,189,183]);
      const chip=this.v5oLiveButton(`Lv.${hp.level}`,[left+16,399,73,36],()=>this.run('hero',id),P.cream,21);chip.name=`RosterLevel-${id}`;
      this.referenceText(`形态 ${hp.equippedForm.slice(-1)}`,[left+13,438,95,32],19,'#48505A','caption');
      const remove=this.v5oButton('ROSTER_REMOVE','移出',()=>this.run('rosterToggle',id),[left+146,385,65,65]);if(remove)remove.name=`RosterRemove-${id}`;
      [-1,1].forEach(direction=>{const n=this.v5oLiveButton(direction===-1?'向前':'向后',[left+13+(direction===1?95:0),628,91,43],()=>this.run('rosterMove',{id,direction}),P.cream,22,direction===-1?i===0:i===draft.length-1);n.name=`RosterMove-${id}-${direction}`;});
    }
    const roles=draft.slice(0,4),roleNames:any={H001:'范围爆破',H002:'击退控场',H003:'减速辅助',H004:'精英克星'};
    if(roles.length<=3)roles.forEach((id,i)=>{const x=66+i*277;this.v5oImage(`ROSTER_ROLE_${id}`,[x,693,257,70]);if(id==='H004')this.referenceText(roleNames[id],[x+12,703,233,47],35,P.ink,'name');});
    else roles.forEach((id,i)=>{this.v5oImage(`ROSTER_ROLE_${id}`,[47+i*215,697,202,55]);if(id==='H004')this.referenceText(roleNames[id],[52+i*215,702,192,42],28,P.ink,'name');});
    this.referenceText(draft.length===0?'至少选择 1 位英雄':!draft.includes('H004')?'可补充精英输出':'阵容已就绪 · 一起守住营地',[181,781,586,42],29,'#777065','caption');
    this.v5oImage('ROSTER_CANDIDATES');this.v5oImage('ROSTER_OPTION_LABEL');
    this.config.heroes.forEach((h:any,i:number)=>{
      const left=42+i*216,hp=p.heroes[h.id],selected=draft.includes(h.id);
      const card=this.v5oButton(`ROSTER_CARD_${h.id}`,`${h.name} · ${hp.owned?'查看与养成':'查看解锁'}`,()=>this.run('hero',h.id),[left,936,211,323]);if(card)card.name=`HeroCard-${h.id}`;
      if(hp.owned&&hp.equippedForm!==h.default_form_id)this.portraitReplacement(h.id,hp.equippedForm,[left+11,949,189,199]);
      this.v5oLiveNumber(hp.owned?`Lv.${hp.level}`:'未拥有',[left+15,951,92,34],22,hp.owned?P.ink:'#6A4D85',`candidateLevel-${h.id}`);
      if(hp.owned)this.referenceText(`形态 ${hp.equippedForm.slice(-1)}`,[left+96,951,95,32],19,'#48505A','caption');
      let n:Node|null;
      if(selected){n=this.v5oButton('ROSTER_ADD_SELECTED','已出战',()=>{},[left+14,1195,183,51]);if(n){n.getComponent(Button)!.interactable=false;this.controlInfo.set(n,{label:'已出战',muted:true});}}
      else if(hp.owned)n=this.v5oButton('ROSTER_ADD_ACTIVE','可加入',()=>this.run('rosterToggle',h.id),[left+14,1195,183,51]);
      else n=this.v5oLiveButton('查看解锁',[left+14,1195,183,51],()=>this.run('hero',h.id),P.purple,28);
      if(n)n.name=`RosterAdd-${h.id}`;
      if(!hp.owned){const [x,y,w,ht]=this.sourceRect(left+149,951,42,42);this.icon('UI_LOCK',x+w/2,y+ht/2,w);}
    });
    this.v5oButton('ROSTER_SAVE','保存阵容',()=>this.run('saveRoster'),undefined,draft.length===0);
    this.v5oButton('ROSTER_RETURN','返回营地',()=>this.run('back'));
    // The original says "本局"; preserve the reference composition but show the
    // confirmed rule precisely. Draft changes never mutate an existing run.
    this.referenceText(d.notice||'编队只决定下一新局可召唤的英雄',[184,1569,573,42],28,'#786D52','caption','rosterHint');
  }

  private battleScreen(): void {
    const r: any = this.session.data.run, b = r.battle, overlay = this.session.data.overlay;
    if (overlay === 'aim') this.aimingSkill = r.aimSkill || this.aimingSkill;
    this.referenceImage('V5_B_BG');
    this.referenceImage('V5_B_HUD');
    this.energyBadge();
    this.referenceText(`${b.baseHp}/${this.config.run.base_max_hp}`, [125, 5, 125, 57], 39, P.ink, 'number', 'base');
    const energy = this.referenceText(`${Math.floor(b.energy)}`, [111, 80, 163, 48], 38, P.ink, 'number', 'energy');
    energy.horizontalAlign=Label.HorizontalAlign.LEFT;energy.enableWrapText=false;
    this.referenceText(`第${b.wave}/${this.config.run.total_waves || 20}波`, [329, 0, 289, 59], 46, P.ink, 'number', 'wave');
    const progress = this.makeNode('WaveProgress', 360, 640, 720, 1280).addComponent(Graphics);
    const start = {x: 312 * 720 / 941, y: 76 * 1280 / 1672}, end = {x: 626 * 720 / 941, y: 76 * 1280 / 1672};
    const ratio = Math.max(0, Math.min(1, (b.wave - 1) / 19));
    progress.lineWidth = 4; progress.strokeColor = color('#7E9595'); progress.moveTo(start.x - 360, 640 - start.y); progress.lineTo(end.x - 360, 640 - end.y); progress.stroke();
    progress.strokeColor = color('#077B97'); progress.moveTo(start.x - 360, 640 - start.y); progress.lineTo(start.x - 360 + (end.x - start.x) * ratio, 640 - start.y); progress.stroke();
    [0, ratio, 1].forEach((n, i) => { progress.fillColor = color(i === 1 ? '#168EA5' : '#9BB7B8'); progress.circle(start.x - 360 + (end.x - start.x) * n, 640 - start.y, i === 1 ? 7 : 6); progress.fill(); });
    this.referenceButton('V5_B_SPEED', `${r.speed || 1}×`, () => this.run('setSpeed', r.speed === 2 ? 1 : 2));
    this.referenceText(`${r.speed || 1}×`, [695, 22, 68, 45], 42);
    const [sx,sy,sw,sh]=this.sourceRect(657,82,216,43);this.bulletBadge=this.box(sx+sw/2,sy+sh/2,sw,sh,'#D9F6FF',12);
    this.referenceText('布阵慢动作',[665,84,200,38],25,'#12678A','section','bulletTime').node.setParent(this.bulletBadge,true);
    this.bulletBadge.active=this.session.combatTimeScale()>0&&this.session.combatTimeScale()<(r.speed||1);
    if(this.config.monsters.some((m:any)=>m.control_class==='boss'&&this.config.waves[b.wave-1]?.counts[m.id]))
      this.referenceText(this.bossWaveText(),[335,87,280,44],29,b.wave===20?'#B6205A':'#A36513','section','bossNotice');
    this.referenceButton('V5_B_PAUSE', 'Ⅱ', () => this.run('settings'));
    this.drawField();
    this.referenceImage('V5_B_TRAY');
    this.referenceImage('V5_B_RESERVE', undefined, '待部署');
    ['R1', 'R2', 'R3'].forEach((slot, i) => { const point = battleReserveScreen(i); this.drawSlot(slot, point.x, point.y, true); });
    const equipped: (string | null)[] = r.equipped;
    equipped.forEach((id, i) => {
      const rect: [number,number,number,number] = i ? [585,1207,209,173] : [374,1207,199,173];
      const newlyAvailable = Object.keys(r.skills).filter(skill => !equipped.includes(skill)).reverse()[0];
      const displayId = id || newlyAvailable, skin = i ? 'V5_B_SKILL_PURPLE' : 'V5_B_SKILL_GOLD';
      const label = id ? `${SKILL_NAME[id]}\n${this.skillTime(id)}` : newlyAvailable ? `装备到槽${i + 1}\n${SKILL_NAME[newlyAvailable]}` : `技能槽 ${i + 1}\n首次三星 / 卡牌解锁`;
      const control = this.referenceButton(skin, label, () => id ? this.beginAim(id) : newlyAvailable ? this.run('equipSkill', { id: newlyAvailable, slot: i }) : this.run('openSkills'), this.sourceRect(...rect));
      if (control) control.name = `SkillSlot-${i + 1}`;
      const cx = (rect[0] + rect[2] / 2) * 720 / 941;
      if (displayId) {
        this.icon(`V5_D_SKILL_ART_${displayId}`, cx, 1286 * 1280 / 1672, 108 * 720 / 941);
        const tag = displayId.startsWith('K') ? 'V5_B_TAG_STAR' : 'V5_B_TAG_CARD';
        this.referenceImage(tag, this.sourceRect(rect[0] + 10, 1216, 69, 44));
        this.referenceText(SKILL_NAME[displayId], [rect[0] + 9, 1327, rect[2] - 18, 42], 27, '#FFFFFF', 'number');
      } else {
        this.icon('UI_LOCK', cx, 1270 * 1280 / 1672, 48);
        this.referenceText('首次三星 / 卡牌', [rect[0] + 8, 1327, rect[2] - 16, 38], 19, '#FFFFFF', 'number');
      }
      if (id) {
        const remaining = this.session.skillRemaining(id);
        this.referenceText(remaining > 0 ? `${Math.ceil(remaining)}秒` : '就绪', [rect[0] + rect[2] - 87, 1213, 76, 42], 27, '#FFFFFF', 'number', `cooldown-${id}`);
        this.cooldownViews[id] = this.makeNode(`CooldownBar-${id}`, cx, 1372 * 1280 / 1672, 131, 5).addComponent(Graphics);
      } else if (newlyAvailable) this.referenceText('点按装入', [rect[0] + rect[2] - 91, 1215, 83, 35], 21, '#FFFFFF', 'number');
    });
    const library = this.referenceButton('V5_B_LIBRARY', '技能库', () => this.run('openSkills')); if (library) library.name = 'Button-技能库';
    this.referenceImage('V5_B_LABEL_SUMMON', undefined, '召唤英雄');
    this.referenceText('同名同星 2 合 1', [584,1388,309,33], 24, P.muted, 'body');
    Object.keys(r.snapshots).forEach((id, i) => {
      const left = [18,248,477,705][i], cost = this.config.heroes.find((h: any) => h.id === id).summon_energy;
      const rect: [number,number,number,number] = [left,1420,225,237];
      const card = this.referenceButton(`V5_B_SUMMON_${id}`, `${HERO_SHORT[id]}\n${cost}能量`, () => this.beginSummon(id), this.sourceRect(...rect));
      if (card) { card.name = `Summon-${id}`; this.controlInfo.set(card,{label:`${HERO_SHORT[id]}\n${cost}能量`,muted:b.energy<cost}); }
      if (r.snapshots[id].form !== `${id}-F01`) this.portraitReplacement(id, r.snapshots[id].form, [left + 15,1433,195,140]);
      this.referenceText(`${cost}`, [left + 100,1607,70,41], 36, b.energy >= cost ? P.ink : P.muted, 'number');
      if (this.summonHero === id && overlay === 'summon') {
        const [x,y,w,h] = this.sourceRect(...rect), g = this.makeNode('SelectedSummon',x+w/2,y+h/2,w,h).addComponent(Graphics);
        g.strokeColor = color('#F4C337'); g.lineWidth = 4; g.roundRect(-w/2+2,-h/2+2,w-4,h-4,18); g.stroke();
      }
    });
    this.textureLayer = this.makeNode('FieldTextureEffects', 360, 640, 720, 1280);
    const barY = 1139 * 1280 / 1672, barH = 65 * 1280 / 1672;
    if (overlay === 'summon' || overlay === 'move') {
      this.button('取消选位 · 不扣能量',360,barY,644,barH,()=>this.cancelSelection(),P.cream,24,false,null);
    } else if (overlay === 'aim') {
      this.button('取消瞄准',177,barY,297,barH,()=>{this.aimTarget=null;this.run('cancelAim');},P.cream,24,false,null);
      this.button('确认施放',523,barY,346,barH,()=>{if(this.run('cast',this.aimTarget||{confirm:true})){this.aimingSkill='';this.aimTarget=null;}},P.purple,26,false,null);
    } else if (this.session.autoWaveRemaining()!==null) {
      this.box(360,barY,644,barH,'#D4F4F5',17,'#4DAEB8');
      this.text(this.autoWaveText(),360,barY,610,barH-8,25,'#14677D','autoWave',this.page,'section');
    } else if (['deploy','freeDeploy'].includes(r.phase)) {
      this.button(r.phase==='freeDeploy'?`继续防守 · ${this.config.rescue.free_revive_protection_seconds}秒保护`:`开始第 ${b.wave} 波`,360,barY,644,barH,()=>this.run('startWave'),P.lake,27,false,null);
    }
    const inspection = this.inspectedRange();
    if (inspection && !overlay) {
      this.referenceText(`${HERO_SHORT[inspection.hero.type]} · 攻击范围 ${Math.round(inspection.radius)}`,[46,1035,466,45],27,'#FFFFFF','number','heroRange');
      this.button('移动英雄',496,810,180,42,()=>{this.movingHero=inspection.hero.id;this.run('beginMove',{id:inspection.hero.id});},P.cream,24,false,null);
      this.button('取消',650,810,84,42,()=>this.selectRangeHero(null),P.cream,21,false,null);
    } else this.referenceText(this.battleStatus(),[51,1018,839,70],24,'#FFFFFF','body','battleStatus');
    if (['deploy','freeDeploy'].includes(r.phase) && !overlay && this.session.autoWaveRemaining()===null) this.button(this.forecastExpanded?'收起波次预告':'展开波次预告',591,145,213,39,()=>{this.forecastExpanded=!this.forecastExpanded;this.render();},P.cream,19,false,null);
    if(this.tutorialKey&&!overlay&&['deploy','battle','freeDeploy'].includes(r.phase)){
      this.box(360,241,650,96,P.cream,20,undefined,this.page,'V5_D_SECTION_INSET');
      this.text((this.session.data as any).tutorial?.text||'首次操作提示',305,239,506,84,21);
      this.button('知道了',623,241,113,64,()=>{const key=this.tutorialKey;this.tutorialKey='';this.run('tutorialDismiss',key);},P.yellow,21,false,null);
    }
    if(r.pendingUnlocks?.length&&r.phase!=='battle')this.button(`新英雄已解锁 · ${this.heroName(r.pendingUnlocks[0])}`,360,285,584,60,()=>{this.modalHero=r.pendingUnlocks[0];if(this.sendCommand('showUnlock',this.modalHero))this.openLocal('unlockBattle');},P.purple,23,false,null);
  }

  /** Extend only the blank centre; the painted lightning and rounded ends keep their shape. */
  private energyBadge(): void {
    const source=this.catalog.image('V5_B_ENERGY');if(!source)return;
    if(!this.energyBadgeFrame){this.energyBadgeFrame=source.clone();this.energyBadgeFrame.insetLeft=64;this.energyBadgeFrame.insetRight=25;this.energyBadgeFrame.insetTop=12;this.energyBadgeFrame.insetBottom=12;}
    const [x,y,w,h]=this.sourceRect(44,76,250,60),n=this.makeNode('EnergyBadge',x+w/2,y+h/2,250,60);
    n.setScale(720/941,1280/1672,1);const sprite=n.addComponent(Sprite);sprite.sizeMode=Sprite.SizeMode.CUSTOM;sprite.type=Sprite.Type.SLICED;sprite.spriteFrame=this.energyBadgeFrame;
    this.referenceInfo.set(n,{id:'V5_B_ENERGY',semanticLabel:'局内能量',fixedLettering:false});
  }
  private autoWaveText(): string {
    const remaining=this.session.autoWaveRemaining();return `第 ${this.session.data.run?.battle.wave} 波即将开始 · ${Math.max(0,remaining||0).toFixed(1)} 秒`;
  }
  private bossWaveText(): string {
    const b:any=this.session.data.run.battle;
    const alive=b.enemies.some((e:any)=>!e.terminal&&e.hp>0&&this.config.monsters.find((m:any)=>m.id===e.type)?.control_class==='boss');
    return `${b.wave===20?'大首领':'小首领'}${alive?'登场':'挑战'}`;
  }

  private drawField(): void {
    const fieldInput = this.makeNode('BattleTargetSurface',360,498,720,832);
    fieldInput.on(Node.EventType.TOUCH_END,(event:EventTouch)=>{
      if(this.session.data.overlay==='aim')this.setAimPoint(this.point(event));
      else if(!this.session.data.overlay&&this.selectedRangeHeroId!==null)this.selectRangeHero(null);
    });
    const [rx,ry,rw,rh]=this.sourceRect(0,194,941,885);
    const clip=this.makeNode('HeroRangeClip',rx+rw/2,ry+rh/2,rw,rh);
    clip.addComponent(Mask).type=Mask.Type.GRAPHICS_RECT;
    const rangeNode=this.makeNode('HeroAttackRange',360,640,720,1280);
    rangeNode.setParent(clip,true);this.rangeLayer=rangeNode.addComponent(Graphics);
    this.config.world.pads.forEach((pad:any)=>{const point=worldToBattleScreen(pad);this.drawSlot(pad.id,point.x,point.y,false);});
    // Enemies emerge from the cave opening. Their heads/HP bars never enter the HUD,
    // while the ground anchor, range, trajectory and pointer inverse stay identical.
    const [ax,ay,aw,ah]=this.sourceRect(0,136,941,943);
    const actorClip=this.makeNode('ActorFieldClip',ax+aw/2,ay+ah/2,aw,ah);actorClip.addComponent(Mask).type=Mask.Type.GRAPHICS_RECT;
    this.worldLayer=this.makeNode('EnemyWorld',360,640,720,1280);this.worldLayer.setParent(actorClip,true);
    this.effectLayer=this.makeNode('BattleFeedbackOnly',360,640,720,1280).addComponent(Graphics);
  }

  private drawSlot(slot: string, x: number, y: number, reserve: boolean): void {
    const r: any = this.session.data.run, h = r.battle.heroes.find((a: any) => a.slot === slot), overlay = this.session.data.overlay;
    const selected = (h?.id === this.movingHero && overlay === 'move') || (h && h.id === this.selectedRangeHeroId && !reserve);
    const highlighted = overlay === 'summon' ? !h : overlay === 'move';
    const size = reserve ? 75 : 125;
    const n = this.makeNode(`Slot-${slot}`, x, y, size, reserve ? 78 : 95);
    // Cover the visible hero, including its head, rather than only the turf below.
    if(h){const hit=n.getComponent(UITransform)!;hit.setContentSize(reserve?75:140,reserve?115:160);hit.setAnchorPoint(.5,reserve?.28:.22);}
    const platform = n.addComponent(Graphics);
    const padId = reserve ? 'V5_B_RESERVE_SLOT' : h ? 'V5_B_PAD_OCCUPIED' : 'V5_B_PAD_EMPTY';
    const art = this.visuals.image(n, reserve ? 'ReservePlatform' : 'FieldPlatform', padId, 0, 0, size, reserve ? 78 : 95);
    if (!art) {
      platform.fillColor = color(selected ? '#FBE181' : highlighted ? '#BFECC7' : reserve ? '#F7EED7' : h ? '#5CC278' : '#D4E6B6');
      if (reserve) platform.roundRect(-36, -43, 72, 86, 16); else platform.ellipse(0, -8, 48, 31);
      platform.fill(); platform.strokeColor = color(highlighted ? '#16BDCB' : '#7FA86D'); platform.lineWidth = 3;
      if (reserve) platform.roundRect(-36, -43, 72, 86, 16); else platform.ellipse(0, -8, 48, 31); platform.stroke();
    }
    if (highlighted || selected) { platform.strokeColor = color(selected ? '#FFD44F' : '#09BBD1'); platform.lineWidth = 4; platform.ellipse(0, -8, size / 2, reserve ? 34 : 32); platform.stroke(); }
    n.addComponent(Button).transition = Button.Transition.NONE;
    if (h) {
      const snapshot = r.snapshots[h.type];
      this.avatar(h.type, snapshot.form, x, y - 5, 53, 'idle', h.id, reserve ? {width:90,height:96,footY:y+14} : {width:118,height:126,footY:y+6});
      for (let star = 0; star < h.star; star++) this.icon('V5_B_STAR', x + (star - (h.star - 1) / 2) * (reserve ? 16 : 21), y + (reserve ? 33 : 23), reserve ? 18 : 25);
      this.text(`Lv${snapshot.level}`, x, y + (reserve ? 48 : 43), reserve ? 62 : 72, 23, reserve ? 16 : 17, '#244B39');
    } else if (!art) this.text('＋', x, y, size, 48, reserve ? 31 : 38, highlighted ? P.deepLake : '#88A574');
    n.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
      if (!h || this.session.data.overlay || this.gesture) return; const p = this.point(event); this.gesture = { id: h.id, touchId: event.touch!.getID(), x: p.x, y: p.y, dragging: false };
    });
    n.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => {
      if (!this.gesture || event.touch?.getID() !== this.gesture.touchId) return; const p = this.point(event);
      if (!this.gesture.dragging && Math.hypot(p.x - this.gesture.x, p.y - this.gesture.y) > 18) {
        this.selectedRangeHeroId=this.gesture.id as any; this.selectedRangeRunId=r.id;
        this.gesture.dragging = true; this.movingHero = this.gesture.id; this.sendCommand('beginMove', { id: this.movingHero });
      }
      if (this.gesture.dragging) {
        const avatar = this.avatars.find(a => a.heroId === this.gesture!.id); if (avatar) avatar.node.setPosition(p.x - 360, 640 - p.y);
        this.dragPoint = p;
        const targetSlot = this.nearestSlot(p), source = r.battle.heroes.find((v: any) => v.id === this.gesture!.id), target = r.battle.heroes.find((v: any) => v.slot === targetSlot);
        const starTwo: Record<string, string> = { H001: '植入玉米标记', H002: '拳套最多穿透3只', H003: '音波施加易伤', H004: '拖鞋追加返回段' };
        this.dragHint = !targetSlot ? '移出位置：松手取消，返回原位' : target?.id === source?.id ? '原位置：松手不移动' : !target ? `松手移动到 ${targetSlot}` : target.type === source.type && target.star === source.star && target.star < 3 ? `松手合成 ${target.star + 1} 星 · ${target.star === 2 ? '首次解锁手动技' : starTwo[source.type]}` : `松手交换：${HERO_SHORT[source.type]} ↔ ${HERO_SHORT[target.type]}`;
      }
    });
    n.on(Node.EventType.TOUCH_END, (event: EventTouch) => {
      if (this.gesture && event.touch?.getID() !== this.gesture.touchId) return;
      if (this.gesture?.dragging) { this.finishDrag(event); return; }
      this.gesture = null; this.dragPoint = null; this.dragHint = '';
      this.onSlot(slot, h);
    });
    n.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => {
      if (!this.gesture || event.touch?.getID() !== this.gesture.touchId) return;
      // Creator 3.8.8 maps a real release outside the source node to node-level
      // TOUCH_CANCEL. getEventCode() preserves the original system event type.
      // Actual system/deactivation cancellation must never confirm a placement.
      if (this.gesture.dragging && event.getEventCode() === Input.EventType.TOUCH_END) this.finishDrag(event);
      else this.cancelDrag();
    });
  }

  private finishDrag(event: EventTouch): void {
    const gesture = this.gesture;
    if (!gesture?.dragging || event.touch?.getID() !== gesture.touchId) return;
    const target = this.nearestSlot(this.point(event));
    this.gesture = null; this.dragPoint = null; this.dragHint = ''; this.movingHero = '';
    if (target) this.run('move', { id: gesture.id, slot: target }); else this.run('cancelMove');
  }
  private cancelDrag(): void {
    const dragged = this.gesture?.dragging;
    if (!this.gesture) return;
    this.gesture = null; this.dragPoint = null; this.dragHint = ''; this.movingHero = '';
    if (dragged && this.session?.data.overlay === 'move') this.sendCommand('cancelMove');
    if (this.session) this.render();
  }

  private point(event: EventTouch): { x: number; y: number } {
    const p = event.getUILocation(), local = this.stage.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
    return { x: local.x + 360, y: 640 - local.y };
  }
  private nearestSlot(p: { x: number; y: number }): string | null {
    const slots = this.config.world.pads.map((s: any) => ({ id: s.id, ...worldToBattleScreen(s) })).concat(['R1', 'R2', 'R3'].map((id, i) => ({ id, ...battleReserveScreen(i) })));
    const hit = slots.filter((s: any) => Math.hypot(s.x - p.x, s.y - p.y) <= (s.id.startsWith('R') ? 41 : 57)).sort((a: any, b: any) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    return hit?.id || null;
  }
  private onSlot(slot: string, h: any): void {
    const overlay = this.session.data.overlay;
    if (overlay === 'summon') { if (this.run('summon', { heroId: this.summonHero, slot })) this.summonHero = ''; }
    else if (overlay === 'move') { if (this.run('move', { id: this.movingHero, slot })) this.movingHero = ''; }
    else if (overlay === 'aim') {
      const p = this.config.world.pads.find((s: any) => s.id === slot); if (p) this.setAimPoint(worldToBattleScreen(p));
    } else if (h && ['battle', 'deploy', 'freeDeploy'].includes((this.session.data.run as any).phase)) {
      if(slot.startsWith('R')){this.selectedRangeHeroId=null;this.movingHero=h.id;this.run('beginMove',{id:h.id});}
      else this.selectRangeHero(this.selectedRangeHeroId===h.id?null:h.id);
    } else if(!overlay&&this.selectedRangeHeroId!==null)this.selectRangeHero(null);
  }
  private selectRangeHero(id: number | null): void {
    this.selectedRangeHeroId=id;this.selectedRangeRunId=this.session.data.run?.id||'';this.render();
  }
  private inspectedRange(): {hero:any;center:{x:number;y:number};radius:number} | null {
    const d=this.session?.data,r=d?.run;
    if(this.selectedRangeHeroId===null||d?.screen!=='battle'||r?.id!==this.selectedRangeRunId||
      !['deploy','freeDeploy','battle'].includes(r?.phase)||(d.overlay&&d.overlay!=='move')||this.pendingResume)return null;
    const hero=r.battle.heroes.find((h:any)=>h.id===this.selectedRangeHeroId),pad=this.config.world.pads.find((p:any)=>p.id===hero?.slot);
    return hero&&pad?{hero,center:{x:pad.x,y:pad.y},radius:this.session.battle!.range(hero)}:null;
  }
  private beginSummon(id: string): void { this.summonHero = id; this.movingHero = ''; this.run('beginSummon', { heroId: id }); }
  private cancelSelection(): void { this.summonHero = ''; this.movingHero = ''; this.run(this.session.data.overlay === 'summon' ? 'cancelSummon' : 'cancelMove'); }
  private beginAim(id: string): void {
    this.aimingSkill = id; this.aimTarget = this.config.skills.find((s: any) => s.id === id)?.target === 'global_confirm' ? { confirm: true } : null;
    this.run('aim', id);
  }
  private setAimPoint(point: { x: number; y: number }): void {
    const r: any = this.session.data.run; this.aimingSkill = r.aimSkill || this.aimingSkill;
    const skill = this.config.skills.find((s: any) => s.id === this.aimingSkill);
    const target = battleScreenToWorld(point);
    const x = Math.max(0, Math.min(720, target.x)), y = Math.max(0, Math.min(680, target.y));
    if (!skill) return;
    if (skill.target === 'area') this.aimTarget = { x, y };
    else if (skill.target === 'lane') this.aimTarget = { lane: Math.min(3, Math.max(1, Math.round((x - 140) / 220) + 1)) };
    else if (skill.target === 'enemy') {
      const enemy = r.battle.enemies.filter((e: any) => e.hp > 0 && !e.terminal).sort((a: any, b: any) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
      this.aimTarget = enemy && Math.hypot(enemy.x - x, enemy.y - y) < 80 ? { enemyId: enemy.id } : null;
    } else this.aimTarget = { confirm: true };
    this.updateBattle();
  }
  private skillTime(id: string): string { const n = this.session.skillRemaining(id); return n > 0 ? `冷却 ${Math.ceil(n)}秒` : '就绪 · 点按瞄准'; }
  private battleStatus(): string {
    const r: any = this.session.data.run;
    if (this.session.data.notice) return this.session.data.notice;
    const tempo=this.session.combatTimeScale()>0?'布阵慢动作 · 放置后恢复':'布阵中';
    if (this.session.data.overlay === 'summon') return `${tempo} · ${this.heroName(this.summonHero)}：点空位确认，成功才扣费`;
    if (this.session.data.overlay === 'move') return this.dragHint || `${tempo} · 同名同星合成，其它占位交换`;
    if (this.session.data.overlay === 'aim') return `瞄准已暂停 · ${SKILL_NAME[this.aimingSkill] || '技能'} · 点战场选目标，再确认`;
    if (r.calmWave === r.battle.wave) return '冷静波 · 本波怪物能量为0 · 波末恢复产能';
    if (this.session.autoWaveRemaining()!==null) return '选卡已生效 · 下一波自动开始';
    if (['deploy', 'freeDeploy'].includes(r.phase)) return '自由布阵 · 点英雄卡后选择空位';
    return `${this.phaseName(r.phase)} · 在场 ${r.battle.enemies.filter((e: any) => e.hp > 0 && !e.terminal).length} 只`;
  }
  private phaseName(phase: string): string { return ({ deploy: '布阵中', battle: '防守中', cards: '波末三选一', firstFailure: '等待老爷爷救场', secondFailure: '等待最后复活选择', adPending: sys.isBrowser ? '模拟广告待决' : '等待复活选择', freeDeploy: '免费复活布阵', victory: '已通关', defeat: '本局结束' } as any)[phase] || phase; }
  private forecastText(multiline = false): string {
    const f: any = this.session.forecast(); if (!f) return '第20波结束后直接结算，无第21波';
    const names: Record<string, string> = { M001: '果冻', M002: '纸箱', M003: '香肠', M004: '布丁', M005: '小鸡', B001: '巨鹅' };
    const monsters = Object.entries(f.counts).filter(([, n]) => Number(n) > 0).map(([id, n]) => `${names[id]}${n}`).join(' / ');
    if (multiline) return `第${f.wave}波 · 路线${f.lanes.join("/")}\n${monsters}\n本波怪物能量 ${f.calm ? 0 : f.budget}`;
    return `第${f.wave}波 · 路线${f.lanes.join("/")} · ${monsters} · 能量${f.calm ? 0 : f.budget}`;
  }
  private forecastDialog(): void {
    const f: any = this.session.forecast(); if (!f) return;
    const traits: Record<string, string> = { M001: '蹦迪果冻：正常移动', M002: '纸箱壮汉：物理减伤20%', M003: '溜冰香肠：移动较快', M004: '分裂布丁：死亡分成3只子体', M005: '指挥小鸡：为附近其它怪物加速', B001: '巨鹅指挥官：Boss，红圈前摇后群体加速' };
    const lines = Object.keys(f.counts).filter(id => f.counts[id] > 0).map(id => `${traits[id]} ×${f.counts[id]}`);
    this.modal(`第 ${f.wave} 波真实预告`, '组成与路线直接读取本局锁定配置与刷怪清单', 820);
    this.text(`真实路线 ${f.lanes.join(' / ')}\n\n${lines.join('\n\n')}\n\n${f.calm ? '冷静波：怪物能量0，波末恢复' : `本波完整怪物能量预算 ${f.budget}`}`, 360, 644, 594, 473, 23, P.deepLake);
    this.button('返回原页面', 360, 959, 588, 88, () => { this.forecastExpanded = false; this.render(); }, P.lake, 29);
  }

  private battleOverlay(): void {
    const d: any = this.session.data, r = d.run;
    if (d.overlay === 'skills') { this.skillsDialog(); return; }
    if (d.overlay === 'settings' || d.overlay === 'background') return;
    if (r.phase === 'cards') {
      if(this.elapsed<this.cardRevealUntil){const shield=this.makeNode('WaveClearFinish',360,640,720,1280);shield.addComponent(BlockInputEvents);return;}
      this.cardsDialog();
    }
    else if (r.phase === 'firstFailure') this.grandpaDialog();
    else if (r.phase === 'secondFailure') this.reviveDialog();
    else if (r.phase === 'adPending') this.adDialog();
  }
  private modal(title: string, subtitle = '', h = 1000, withSettings = false): void {
    const shade = this.box(360, 640, 720, 1280, '#243E4B', 0); const g = shade.getComponent(Graphics)!;
    g.clear(); g.fillColor = color('#152E3D', 195); g.rect(-360, -640, 720, 1280); g.fill();
    shade.name = 'ModalInputShield'; shade.addComponent(BlockInputEvents);
    this.box(360, 640, 674, h, P.cream, 30, '#D0DAD3', this.page, 'V5_D_MODAL_PANEL');
    const heading=this.displayText(title, withSettings ? 320 : 360, 640 - h / 2 + 64, withSettings ? 478 : 604, 77, title.length>10?35:42);
    heading.enableOutline=true;heading.outlineColor=color('#FFF8DD');heading.outlineWidth=2;
    this.titleInfo.set(heading.node,title);
    if (withSettings) this.button('设置', 638, 640 - h / 2 + 54, 96, 64, () => this.run('settings'), P.cream, 22);
    if (subtitle) this.text(subtitle, 360, 640 - h / 2 + 118, 606, 79, 23, P.muted);
  }

  private cardsDialog(): void {
    const r:any=this.session.data.run, f:any=this.session.forecast();
    if(this.d5CardDetail&&r.candidates.includes(this.d5CardDetail)){this.d5CardDetailsDialog();return;}
    this.d5CardDetail='';this.d5Shade();
    this.referenceImage('V5_D_CARDS_PANEL');this.cardRibbon();
    const digits=String(r.battle.wave), digitWidth=digits.length===1?60:112;
    const titleLeft=(941-(81+6+digitWidth+6+357))/2;
    this.referenceImage('V5_D_CARDS_TITLE_PREFIX',this.sourceRect(titleLeft,342,81,100));
    this.referenceImage('V5_D_CARDS_TITLE_SUFFIX',this.sourceRect(titleLeft+81+6+digitWidth+6,334,357,112));
    const title=this.d5Outlined(digits,[titleLeft+81+6,337,digitWidth,106],84,'#FFFFFF','#071332',7);
    title.enableWrapText=false;title.overflow=Label.Overflow.CLAMP;
    this.titleInfo.set(title.node,`第${r.battle.wave}波守住了！`);
    const summary:Record<string,string>={C001:'爆炸半径 +20%\n普攻周期 +5%',C002:'直接普攻伤害 +8%\n标记爆伤 +25%\n连锁需三星',C003:'射程 / 拳套长度\n+20%',C004:'普攻 / 手动击退\n+20%\n仍受控制抵抗限制',C005:'音波半径 +15%\n自动伤害 +10%',C006:'减速持续 +20%\n不增加减速强度',C007:'普攻可改向一次\n精英 / Boss伤害\n+15%',C008:'精英 / Boss伤害\n+25%',C009:'击退可碰撞同路怪\n最多2只 · 不递归',C010:'全体普攻周期\n×0.97\n不减手动技冷却',C011:'全体索敌射程\n+5%\n不扩大技能范围',C012:'全体自动伤害\n+10%\n不提升手动技',C013:'获得范围手动技\n180物理伤害\n叠选提升伤害',C014:'获得全场手动技\n40伤害 + 击退\n叠选缩短冷却',C015:'获得范围手动技\n基础硬控3秒\n叠选扩大范围'};
    const candidates:string[]=r.candidates||[];
    candidates.slice(0,3).forEach((id,i)=>{
      const c=this.config.cards.find((a:any)=>a.id===id);if(!c)return;
      const left=[44,333,615][i], width=[281,274,281][i], rect:[number,number,number,number]=[left,536,width,474];
      const card=this.referenceButton(`V5_D_CARD_${['ORANGE','CYAN','PURPLE'][i]}`,c.name,()=>this.run('chooseCard',id),this.sourceRect(...rect));
      if(card)card.name=`Card-${id}`;
      this.d5Outlined(c.name,[left+13,557,width-26,79],c.name.length>6?35:42,'#081631','#FFFFFF',3);
      if(['C003','C006','C013'].includes(id))this.referenceImage(`V5_D_CARD_ART_${id}`,this.sourceRect(left+(width-190)/2,639,190,189));
      else this.d5Icon(id,[left+44,638,width-88,188]);
      this.referenceText(summary[id]||'本局强化',[left+17,834,width-34,111],29,P.ink,'number');
      const picks=r.cards[id]||0;this.d5Button(`已选 ${picks} 层 · 详情`,[left+17,949,width-34,49],()=>{this.d5CardDetail=id;this.render();},P.cream,25);
    });
    if(!candidates.length){
      this.referenceText('暂时没有可选卡牌',[119,625,705,96],47,P.ink,'section');
      this.referenceText('候选卡牌暂未就绪，当前进度已保存。\n可以打开设置，保存回营地后继续本局。',[117,765,706,153],33,P.muted,'body');
    }
    this.referenceImage('V5_D_FORECAST_WELL');
    this.referenceText(f?`下一波 ${f.wave}/20`:'20波已完成',[265,1041,411,55],43,P.ink,'section');
    if(f){
      const counts=Object.entries(f.counts).filter(([,n])=>Number(n)>0), n=counts.length, itemWidth=Math.min(188,746/Math.max(1,n));
      counts.forEach(([id,count],i)=>{
        const left=470.5-n*itemWidth/2+i*itemWidth;const [x,y,w,h]=this.sourceRect(left+10,1101,itemWidth-20,126);
        this.box(x+w/2,y+h/2+14*720/941,w,h+40*720/941,'#F6EBD0',16,'#E5D2A8');
        this.avatar(id,id,x+w/2,y+h,1,'idle',undefined,{width:w*.86,height:h*.9,footY:y+h});
        this.referenceText(`${count}`,[left+12,1231,itemWidth-24,47],41,P.ink,'number');
      });
      const line=`路线 ${f.lanes.join('/')} · 怪物能量 ${f.calm?0:f.budget} · 本波训练经验 +1`;
      this.referenceText(line,[86,1287,770,35],27,'#796F5B','caption');
    }
    this.d5Hit('展开怪物特性与真实路线',[77,1035,788,271],()=>{this.forecastExpanded=true;this.render();});
    this.d5Button('设置',[769,1417,123,67],()=>this.run('settings'),P.cream,28);
  }

  /** Keep the painted tails/stars, rebuild the central face so old baked letters
   * cannot peek around a naturally spaced two-digit title. */
  private cardRibbon(): void {
    this.referenceImage('V5_D_CARDS_RIBBON');
    const g=this.makeNode('CardRibbonCleanFace',360,640,720,1280).addComponent(Graphics);
    const p=(x:number,y:number)=>({x:(137+x)*720/941-360,y:640-(307+y)*1280/1672});
    const move=(x:number,y:number)=>{const v=p(x,y);g.moveTo(v.x,v.y);};
    const line=(x:number,y:number)=>{const v=p(x,y);g.lineTo(v.x,v.y);};
    const curve=(x1:number,y1:number,x2:number,y2:number,x:number,y:number)=>{const a=p(x1,y1),b=p(x2,y2),c=p(x,y);g.bezierCurveTo(a.x,a.y,b.x,b.y,c.x,c.y);};
    move(75,47);curve(108,-7,514,-5,591,44);line(599,155);curve(450,128,242,127,78,158);g.close();
    g.fillColor=color('#2DCFF0');g.fill();g.strokeColor=color('#0B2138');g.lineWidth=6*720/941;g.stroke();
    move(84,48);curve(133,3,507,5,583,46);g.strokeColor=color('#A0F0FA',220);g.lineWidth=3.5*720/941;g.stroke();
    move(88,148);curve(261,120,432,123,590,146);g.strokeColor=color('#139FCB',190);g.lineWidth=5*720/941;g.stroke();
  }

  private skillsDialog(): void {
    const r:any=this.session.data.run, skills:string[]=Object.keys(r.skills), canReplace=['deploy','freeDeploy'].includes(r.phase);
    const pages=Math.max(1,Math.ceil(skills.length/4));this.d5SkillPage=Math.min(this.d5SkillPage,pages-1);this.d5Shade();this.referenceImage('V5_D_SKILLS_PANEL');
    this.referenceButton('V5_D_SKILLS_CLOSE','关闭技能库',()=>this.run('closeOverlay'));
    [0,1].forEach(slot=>{
      const left=slot?485:153, id=r.equipped[slot], selected=this.d5SelectedSlot===slot;
      this.referenceImage(`V5_D_SKILL_SLOT_${slot?'PURPLE':'GOLD'}`);
      if(id){this.d5Icon(id,[left+59,416,190,166]);this.d5Outlined(SKILL_NAME[id],[left+14,577,278,53],37);}
      else {this.d5Outlined('＋',[left+65,420,173,130],98,'#F5DCFF','#4D236F',2);this.referenceText('暂未装备',[left+16,578,274,48],36,'#FFFFFF','number');}
      this.referenceText(`槽位 ${slot+1}${selected?' · 当前选择':''}`,[left+14,386,278,42],30,'#FFFFFF','number');
      const [x,y,w,h]=this.sourceRect(left+15,650,277,53);this.box(x+w/2,y+h/2,w,h,selected?'#61FA8C':'#EEE2CC',24);
      this.referenceText(id?this.skillTime(id):'点击选择此槽',[left+15,652,277,49],31,P.ink,'number');
      this.d5Hit(`选择技能槽${slot+1}`,[left,370,308,340],()=>{this.d5SelectedSlot=slot;this.render();});
    });
    if(!skills.length){
      this.d5Outlined('还没有手动技能',[134,870,677,80],46,'#0D2540','#FFFFFF',2);
      this.referenceText('将同名同星英雄合成到三星，\n或选择手动技能卡，即可解锁。\n\n永久英雄等级不会提前赠送局内技能。',[138,972,665,231],33,P.muted,'body');
    }
    skills.slice(this.d5SkillPage*4,this.d5SkillPage*4+4).forEach((id,i)=>{
      const top=787+i*127, s=this.config.skills.find((v:any)=>v.id===id), slot=this.d5SelectedSlot, inSlot=r.equipped.indexOf(id), same=r.equipped[slot]===id, muted=!!r.equipped[slot]&&!canReplace&&!same;
      this.referenceImage('V5_D_SKILL_ROW',this.sourceRect(80,top,784,124));this.d5Icon(id,[101,top+12,102,100]);
      this.referenceText(SKILL_NAME[id],[234,top+9,388,51],38,P.ink,'name');
      const origin=id.startsWith('K')?`${HERO_SHORT[s.hero]}三星`:'卡牌';
      const remaining=this.session.skillRemaining(id);
      this.referenceText(`${origin} · ${remaining>0?`冷却 ${Math.ceil(remaining)}秒`:'就绪'}`,[235,top+64,385,40],25,'#8B4F35','caption');
      this.d5Button(same?'已装备':`装备到${slot+1}`,[637,top+26,198,78],()=>this.run('equipSkill',{id,slot}),same?P.cream:P.lake,31,muted||same);
    });
    this.referenceText(canReplace?'先点上方槽位，再装备 · 换装保留冷却':'战斗已暂停 · 已占槽位只能在波间替换',[114,1304,713,42],28,'#827A6A','caption');
    if(pages>1){
      const [x,y,w,h]=this.sourceRect(342,735,513,49);this.box(x+w/2,y+h/2,w,h,'#FFF8E3',0);
      this.referenceText(`共 ${skills.length} 个`,[346,740,202,39],28,'#827A6A','caption');
      this.d5Button('‹',[563,735,77,49],()=>{this.d5SkillPage=Math.max(0,this.d5SkillPage-1);this.render();},P.cream,33,this.d5SkillPage===0);
      this.referenceText(`${this.d5SkillPage+1} / ${pages}`,[650,736,106,47],29,'#827A6A','caption');
      this.d5Button('›',[769,735,77,49],()=>{this.d5SkillPage=Math.min(pages-1,this.d5SkillPage+1);this.render();},P.cream,33,this.d5SkillPage===pages-1);
    }
    this.referenceButton('V5_D_SKILLS_DONE','完成 · 返回原阶段',()=>this.run('closeOverlay'));
    this.d5Button('设置',[747,1519,130,65],()=>this.run('settings'),P.cream,28);
  }

  private grandpaDialog(): void {
    const r:any=this.session.data.run,wave=r.battle.wave,ledger=r.battle.ledger||[];
    const remaining=ledger.filter((v:any)=>v.wave===wave).reduce((n:number,v:any)=>n+Math.max(0,v.budget-v.claimed-v.voided),0);
    const advance=wave<20?this.config.waves[wave].energy_budget:0, hp=Math.ceil(this.config.run.base_max_hp*this.config.rescue.restore_hp_fraction);
    this.d5Shade();this.referenceImage('V5_D_GRANDPA_PANEL');
    this.d5Outlined(`恢复${hp}耐久`,[393,714,285,70],50,'#07142F','#FFFFFF',2);
    this.d5Outlined(`+${remaining}`,[646,908,131,70],60,'#FFD844','#07142F',3);
    this.d5Outlined(`+${advance}`,[646,987,131,70],60,'#FFD844','#07142F',3);
    this.referenceText('立即获得',[245,1084,222,75],49,P.ink,'number');
    this.d5Outlined(`${remaining+advance}`,[456,1069,137,95],90,'#FFCE2B','#07142F',5);
    this.referenceText('能量',[592,1085,127,73],49,P.ink,'number');
    this.referenceText(wave===20?'末波不预支，没有第21波\n恢复基地，清波后直接通关':`第${wave+1}波怪物能量为0\n该波结束后恢复 · 训练经验照常到账`,[153,1183,635,92],34,P.ink,'number');
    this.referenceButton('V5_D_GRANDPA_SUMMON',wave===20?'召唤老爷爷 · 清波并通关':'召唤老爷爷 · 清波救场',()=>this.run('grandpa'));
    this.referenceButton('V5_D_GRANDPA_END','结束本局',()=>this.run('endRun'));
  }

  private reviveDialog(): void {
    const r:any=this.session.data.run,hp=Math.ceil(this.config.run.base_max_hp*this.config.rescue.restore_hp_fraction),energy=this.config.rescue.second_revive_energy;
    this.d5Shade();this.referenceImage('V5_D_REVIVE_PANEL');this.referenceImage('V5_D_REVIVE_TITLE');
    this.referenceText(sys.isBrowser?'两种方式均可获得':'免费复活即可获得',[174,824,596,41],34,P.ink,'section');
    this.referenceText(`恢复${hp}耐久`,[229,875,212,61],39,P.ink,'number');
    this.referenceText(`获得${energy}能量`,[603,875,225,61],39,P.ink,'number');
    this.referenceButton('V5_D_REVIVE_FREE','免费复活 · 保留怪物 · 先布阵再继续',()=>this.run('freeRevive'));
    // The Web simulator cannot award pretend ad completions on a mini-game host.
    // Enable this route only after a real platform ad adapter has been validated.
    this.referenceButton('V5_D_REVIVE_AD',sys.isBrowser?'自愿模拟广告复活 · 额外清屏':'广告暂不可用',()=>this.run('adRequest'),undefined,!sys.isBrowser);
    this.referenceText('保留本波怪物\n先布阵，再继续',[111,1228,333,66],28,P.ink,'number');
    this.referenceText(sys.isBrowser?'额外清除本波怪物\n自愿模拟广告':'广告暂不可用\n请选择免费复活',[501,1228,333,66],28,P.ink,'number');
    if(r.calmWave===r.battle.wave)this.referenceText('冷静波仍获得固定补给；两路共用最后一次复活',[123,1510,696,53],28,'#FFFFFF','number');
    this.referenceButton('V5_D_REVIVE_END','结束本局',()=>this.run('endRun'));
  }
  private adDialog(): void {
    const r: any = this.session.data.run, status = r.ad?.status;
    if (!sys.isBrowser) {
      this.modal('复活选择', '广告暂不可用，战斗保持暂停', 650);
      this.text('可以直接免费复活。\n本波怪物会保留，布阵完成后继续防守。', 360, 575, 600, 160, 27);
      this.button('免费复活 · 保留怪物', 360, 790, 592, 92, () => this.run('freeRevive'), P.lake, 27);
      return;
    }
    this.modal('广告结果模拟器', 'Web原型专用 · 不连接广告平台 · 战斗保持暂停', 980);
    this.text(status === 'unknown' ? '结果未知：暂不兑现奖励\n可继续等待明确结果，或改用免费复活。' : '选择一个模拟返回状态，验证对应行为。\n真实微信 / 抖音广告留待 P7 接入。', 360, 403, 600, 126, 27);
    const resolve = (result: string) => this.run('adResult', { id: r.ad.id, result });
    this.button('完整观看 · 兑现清屏复活', 360, 552, 592, 83, () => resolve('completed'), P.purple, 26);
    this.button('主动取消 · 返回双路线选择', 360, 656, 592, 83, () => resolve('cancelled'), P.cream, 26);
    this.button('技术失败 · 按规则兑现清屏', 360, 760, 592, 83, () => resolve('failed'), P.purple, 25);
    this.button('结果未知 · 保持待决', 360, 864, 592, 83, () => resolve('unknown'), P.cream, 26);
    this.button('改用免费复活 · 保留怪物', 360, 1009, 592, 92, () => this.run('freeRevive'), P.lake, 27);
    this.text('不想等待，也可以免费复活；敌人会留在战场。', 360, 1120, 600, 56, 20, P.muted);
  }

  private resultScreen(): void {
    const r: any = this.session.data.run, p: any = this.session.data.profile, b = r?.battle;
    if (!r) { this.run('camp'); return; }
    const victory = r.phase === 'victory', ids = Object.keys(r.snapshots);
    this.referenceImage('V5_R_BG');
    if (victory) {
      const title = this.referenceImage('V5_R_TITLE'); if (title) this.titleInfo.set(title, '守住了！');
    } else {
      this.referenceImage('V5_R_DEFEAT_TITLE');
    }
    this.referenceImage('V5_R_SCORE');
    this.referenceText(`${r.completedWaves.length}/20波`, [315,279,319,76], 65, P.ink, 'number', 'resultScore');
    ids.forEach((id, i) => {
      const x = 470.5 + (i - (ids.length - 1) / 2) * 224;
      this.avatar(id, r.snapshots[id].form, x * 720 / 941, 605 * 1280 / 1672, 1, victory ? 'victory' : 'idle', undefined,
        { width: 278 * 720 / 941, height: 295 * 1280 / 1672, footY: 701 * 1280 / 1672 });
    });
    this.referenceImage('V5_R_STATS');
    this.referenceText(`${r.completedWaves.length}/20`, [153,803,137,54], 45, P.ink, 'number', 'resultWaves');
    const seconds = Math.floor(b.tick / r.config.clock.tick_hz), time = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
    this.referenceText(time, [450,803,138,54], 44, P.ink, 'number', 'resultTime');
    this.referenceText(`${r.grandpaUsed ? 1 : 0}次`, [763,803,124,54], 44, P.ink, 'number', 'resultGrandpa');
    this.referenceImage('V5_R_PANEL');
    this.referenceImage('V5_R_LABEL_ROSTER');
    ids.forEach((id, i) => {
      const x = 470.5 + (i - (ids.length - 1) / 2) * 222;
      this.referenceImage(`V5_R_HERO_${id}`, this.sourceRect(x - 105, 962, 210, 244));
      const star = Math.max(0, ...b.heroes.filter((h: any) => h.type === id).map((h: any) => h.star));
      if (star) {
        this.avatar(id, r.snapshots[id].form, x * 720 / 941, 1041 * 1280 / 1672, 1, victory ? 'victory' : 'idle', undefined,
          { width: 226 * 720 / 941, height: 216 * 1280 / 1672, footY: 1127 * 1280 / 1672 });
        for (let s = 0; s < star; s++) this.icon('V5_B_STAR', (x + (s - (star - 1) / 2) * 40) * 720 / 941, 1135 * 1280 / 1672, 42 * 720 / 941);
      } else {
        this.avatar(id, r.snapshots[id].form, x * 720 / 941, 1041 * 1280 / 1672, 1, 'idle', undefined,
          { width: 201 * 720 / 941, height: 194 * 1280 / 1672, footY: 1117 * 1280 / 1672 });
        this.referenceText('未召唤', [x-65,1120,130,33], 25, P.muted, 'body');
      }
    });
    this.referenceImage('V5_R_LABEL_BUILD');
    const builds = Object.keys(r.cards).sort((a: string,b: string) => r.cards[b] - r.cards[a]).slice(0,2);
    [0,1].forEach(i => {
      const x = i ? 653 : 289, id = builds[i];
      this.referenceImage(i ? 'V5_R_BUILD_GOLD' : 'V5_R_BUILD_PURPLE');
      if (id) {
        this.icon(id, (x - 103)*720/941, 1329*1280/1672, 87*720/941);
        this.referenceText(`${r.config.cards.find((c:any)=>c.id===id)?.name || id}${r.cards[id]>1 ? ' ×'+r.cards[id] : ''}`, [x-48,1289,214,75], 30, P.ink, 'name');
      } else {
        this.referenceText(i ? `三星英雄 ${b.heroes.filter((h:any)=>h.star===3).length} 位` : '本局未获得卡牌', [x-157,1292,314,69], 29, P.ink, 'name');
      }
    });
    this.referenceImage('V5_R_SAVED');
    // XP is granted through domain per completed wave, this is a report only.
    this.referenceText(`本局经验 +${r.completedWaves.length * r.config.progression.training_xp_per_completed_wave} 已到账`, [278,1460,385,34], 25, P.muted, 'body', 'resultXp');
    this.referenceButton('V5_R_REPLAY', '再来一局', () => this.run('newRun'));
    this.referenceButton('V5_R_CAMP', '返回大厅', () => this.run('camp'));
  }
  private replaceDialog(): void {
    this.modal('替换进行中的旧局？', '开始新局将使用最新等级、形态与编队', 670);
    this.text(`旧局：第 ${(this.session.data.run as any)?.battle.wave} / 20 波\n\n已到账训练经验与永久养成都会保留。\n未完成局内星级、技能、卡牌将被新局替换。`, 360, 586, 580, 247, 27);
    this.button('保留旧局', 199, 813, 286, 98, () => this.run('cancelReplace'), P.cream, 28);
    this.button('开始新局', 524, 813, 286, 98, () => this.run('newRun', { confirm: true }), P.lake, 28);
  }
  private discardDialog(): void {
    this.modal('编队尚未保存', '已保存编队和旧局均保持原状', 570);
    this.text('要继续编辑，还是放弃本次草稿？', 360, 584, 580, 126, 29);
    this.button('继续编辑', 199, 785, 286, 98, () => this.run('closeOverlay'), P.lake, 28);
    this.button('放弃改动', 524, 785, 286, 98, () => this.run('discardRoster'), P.cream, 28);
  }
  private settingsDialog(): void {
    const d:any=this.session.data,s=d.profile.settings,inBattle=d.screen==='battle',phase=d.run?.phase;
    this.d5Shade();this.referenceImage('V5_D_SETTINGS_PANEL');
    this.referenceButton('V5_D_SETTINGS_CLOSE','关闭设置并返回来源',()=>this.run('closeOverlay'));
    this.d5Button(`总静音\n${s.muted?'开启':'关闭'}`,[144,265,149,66],()=>this.run('setting',{key:'muted',value:!s.muted}),s.muted?P.cream:P.lake,25);
    ['music','sfx','voice'].forEach((key,i)=>this.d5VolumeSlider(key,395+i*117));
    ['vibration','shake'].forEach((key,i)=>this.referenceButton(s[key]?'V5_D_TOGGLE_ON':'V5_D_TOGGLE_OFF',`${key==='vibration'?'震动偏好':'画面晃动'}：${s[key]?'开':'关'}`,()=>this.run('setting',{key,value:!s[key]}),this.sourceRect(626,738+i*115,155,72)));
    const speed=d.run?.speed||s.speed||1, canSpeed=inBattle&&['deploy','freeDeploy','battle'].includes(phase);
    [1,2].forEach((value,i)=>this.d5Button(`${value}×`,[497+i*142,968,143,75],()=>this.run('setSpeed',value),speed===value?P.lake:P.cream,40,!canSpeed));
    if(!canSpeed)this.referenceText('布阵或防守时可切换',[491,1042,303,24],21,'#81735B','caption');
    this.d5Hit('重新查看操作说明',[138,1071,668,102],()=>this.openLocal('help'));
    const backName=!inBattle?'返回':d.overlaySource==='skills'?'返回技能库':phase==='battle'?'继续防守':phase==='cards'?'返回选卡':['deploy','freeDeploy'].includes(phase)?'返回布阵':'返回当前选择';
    if(backName==='继续防守')this.referenceButton('V5_D_SETTINGS_PRIMARY',backName,()=>this.run('closeOverlay'));
    else {this.referenceButton('V5_D_SETTINGS_PRIMARY_BLANK',backName,()=>this.run('closeOverlay'));this.referenceText(backName,[266,1218,410,81],56,P.ink,'button');}
    if(inBattle){this.referenceButton('V5_D_SETTINGS_SECONDARY_BLANK','保存并返回营地',()=>this.run('camp'));this.referenceText('保存并返回营地',[251,1350,438,65],42,P.ink,'button');}
    else {this.referenceImage('V5_D_SETTINGS_SECONDARY_BLANK');this.referenceText('音乐不随战斗倍速加快',[246,1347,451,64],31,'#766C59','caption');}
  }
  private backgroundDialog(): void {
    this.modal('进度已保存', '应用曾进入后台，战斗时间已冻结', 560);
    this.text('恢复将回到离开前的阶段。\n不会自动开始下一波，也不会补算离线收益。', 360, 620, 590, 154, 27);
    this.button('恢复原阶段', 360, 795, 580, 90, () => this.resumeSavedPhase(), P.lake, 30);
  }
  private openLocal(modal: string): void { this.localModal = modal; this.render(); }
  private closeLocal(): void { this.localModal = ''; this.render(); }
  private localDialog(): void {
    const d: any = this.session.data;
    if (d.overlay === 'unlock' && !this.localModal) { this.modalHero = d.unlockHero; this.unlockDialog(false); return; }
    if (this.localModal === 'sidebar') {
      const sidebar = douyinSidebar();
      this.modal('从侧边栏再来玩', '把营地留在首页，下次更方便找到', 800);
      this.text('① 点击下方「去首页侧边栏」\n\n② 在侧边栏找到「超力英雄」\n\n③ 点击游戏图标，返回营地继续玩', 360, 570, 584, 250, 27);
      this.text(sidebar?.error || (sidebar?.fromSidebar ? '已从侧边栏返回，欢迎回到营地！' : '下次可直接从当前应用的首页侧边栏进入'), 360, 760, 584, 90, 24, sidebar?.error ? P.red : P.muted);
      this.button(sidebar?.busy ? '正在打开…' : '去首页侧边栏', 360, 880, 566, 84, () => {
        if (!sidebar?.available || sidebar.busy) return;
        this.closeLocal();
        sidebar.navigate(() => { if (this.isValid) this.openLocal('sidebar'); });
      }, P.lake, 29, !sidebar?.available || sidebar.busy);
      this.button('返回营地', 360, 978, 566, 70, () => this.closeLocal(), P.cream, 27);
    } else if (this.localModal === 'help') {
      this.modal('怎么守住这座营地', '点选、拖动与手动技能，守住你的三路营地', 1020);
      this.text(`① 编队：选择1～4位已拥有英雄，保存用于新局。\n\n② 召唤：点英雄，再点空位，成功才扣${this.config.run.summon_cost}能量。\n\n③ 合成：同名同星拖到一起，也可逐次点选。\n    不同英雄或不同星级会交换；最高三星。\n\n④ 待部署：三个位置不自动战斗，可备战合成。\n\n⑤ 技能：本局首次三星 / 技能卡解锁，两槽装备。\n    点技能暂停瞄准，再确认；取消不耗冷却。\n\n⑥ 救场：先老爷爷，再${sys.isBrowser?'免费 / 自愿模拟广告':'免费复活'}。\n    第三次失败结算。每完成一波经验永久到账。\n\n⑦ 暂停→保存回营地；可升级和换形态，再开新局。`, 360, 658, 614, 658, 24);
      this.button('返回', 360, 1090, 586, 87, () => this.closeLocal(), P.lake, 30);
    } else if (this.localModal === 'praise') {
      this.praiseDialog();
    } else if (this.localModal === 'unlockBattle') this.unlockDialog(true);
    else if (this.localModal === 'formUnlock') {
      const id = this.modalHero, p = d.profile.heroes[id], forms = this.config.forms.filter((f: any) => f.hero_id === id && p.ownedForms.includes(f.id)), newest = forms[forms.length - 1];
      this.modal('新形态已永久拥有', `${this.heroName(id)} · ${newest.name} · 由你另行穿戴`, 850);
      this.stump(360, 637, 312);
      this.avatar(id, newest.id, 360, 530, 1, 'victory', undefined, { width: 312, height: 328, footY: 637 });
      this.text('升级已保存。新形态不会自动穿戴。\n所有形态只改变外观，不增加额外战斗数值。', 360, 729, 595, 114, 27);
      this.button('查看新形态', 360, 854, 591, 87, () => { this.previewForm = newest.id; this.closeLocal(); }, P.purple, 30);
      this.button('跳过演出', 360, 958, 591, 79, () => this.closeLocal(), P.cream, 27);
    }
  }
  private unlockDialog(fromBattle:boolean):void {
    const id=this.modalHero,d:any=this.session.data,p=d.profile.heroes[id];if(!p)return;
    const h=this.config.heroes.find((v:any)=>v.id===id);
    // Full-screen native result layer blocks the source page. The independently
    // extracted background is not a screenshot-backed interactive surface.
    const blocker=this.box(360,640,720,1280,'#DAF4CD',0);blocker.name='OutsideUnlockBlocker';blocker.addComponent(BlockInputEvents);
    this.v5oImage('BG_UNLOCKED');this.v5oImage('UNLOCKED_RAYS');
    this.v5oActor(id,p.equippedForm,[95,53,770,770],'victory');this.v5oTitle('UNLOCKED_TITLE','新英雄加入！');
    this.v5oImage('UNLOCKED_INFO');
    if(id==='H004'){this.v5oImage('UNLOCKED_NAME_H004');this.v5oImage('UNLOCKED_ROLE_H004');}
    else{this.referenceText(h.name,[205,880,438,96],65,P.ink,'name');this.referenceText(HERO_ROLE[id].split(' · ')[0],[329,983,283,44],31,'#642991','name');}
    this.v5oImage('UNLOCKED_LEVEL');this.v5oLiveNumber(`Lv.${p.level}`,[663,909,130,60],39,P.ink,'unlockedLevel');
    this.v5oImage('UNLOCKED_PERMANENT');
    if(id==='H004'){this.v5oImage('UNLOCKED_SKILL_ICON_H004');this.v5oImage('UNLOCKED_SKILL_COPY_H004');}
    else{const [x,y,w,ht]=this.sourceRect(108,1155,224,143);this.icon(h.player_skill_id,x+w/2,y+ht/2,Math.min(w,ht));this.referenceText(HERO_ROLE[id],[352,1165,456, 50],33,P.ink,'name');this.referenceText(`局内三星解锁${SKILL_NAME[h.player_skill_id]}`,[352,1222,456,59],31,P.ink,'body');}
    const acknowledge=()=>{this.localModal='';this.sendCommand('ackUnlock',id);if(fromBattle)this.sendCommand('camp');};
    if(fromBattle){this.v5oLiveButton('保存回营地 · 查看养成',[221,1344,500,147],()=>{acknowledge();this.run('hero',id);},P.lake,38);this.v5oLiveButton('返回波间选择',[232,1496,478,116],()=>{this.localModal='';this.run('ackUnlock',id);},P.cream,42);}
    else{this.v5oButton('UNLOCKED_TEAM','去搭配阵容',()=>{acknowledge();this.run('open','roster');});this.v5oButton('UNLOCKED_VIEW','查看英雄',()=>{acknowledge();this.run('hero',id);});}
    const close=this.v5oLiveButton('×',[847,342,69,69],()=>{this.localModal='';this.run('ackUnlock',id);},P.cream,42);close.name='Button-关闭解锁结果';
  }

  private notice(): void {
    const d: any = this.session.data;
    if (!d.notice) return;
    // Reference pages have dedicated live copy inside their panels, away from the CTA and navigation.
    if (['camp','collection','hero','roster','result'].includes(d.screen)) return;
    // During active field interaction the dedicated status line carries errors,
    // leaving the bottom confirm/cancel/start controls fully unobstructed.
    if (d.screen === 'battle' && ['battle', 'deploy', 'freeDeploy'].includes(d.run?.phase) && [null, 'aim', 'summon', 'move'].includes(d.overlay) && !this.localModal) return;
    const y = d.screen === 'battle' ? 782 : 1147, height = d.screen === 'battle' ? 28 : 34;
    this.box(360, y, 686, height, '#FBE5AC', 12);
    this.text(d.notice, 360, y - 1, 670, height - 3, 19, P.ink, undefined, this.page, 'caption');
  }

  private checkTutorial(): void {
    const d: any = this.session.data;
    this.tutorialKey = d.screen === 'battle' && d.tutorial ? d.tutorial.key : '';
  }

  private animate(_dt: number): void {
    const d: any = this.session.data, b = d.run?.battle, inBattle = d.screen === 'battle' && b;
    const battleSeconds = b ? b.tick / this.config.clock.tick_hz : 0;
    this.avatars.forEach(a => {
      if (!a.node.isValid || this.gesture?.dragging && a.heroId === this.gesture.id) return;
      let action: VisualAction = a.action, seconds = inBattle ? battleSeconds : this.elapsed;
      if (a.heroId && b) {
        const released = (b.stats.effects || []).filter((e: any) => e.kind === 'attack' && e.heroId === a.heroId && e.tick > this.visualFloorTick && b.tick - e.tick < this.config.clock.tick_hz * .35).slice(-1)[0];
        if (released) { action = 'attack'; seconds = (b.tick - released.tick) / this.config.clock.tick_hz; }
      }
      a.actor.pose(action, seconds, a.phase);
    });
    if (b) this.effects = this.effects.filter(e => e.untilTick > b.tick);
    if (this.rescueActor) {
      const age = this.elapsed - this.rescueStartedAt;
      if (age >= .9) this.clearRescueActor();
      else this.rescueActor.pose(age < .25 ? 'cane_raise' : 'cane_strike', age);
    }
  }

  private showRescueActor(): void {
    this.clearRescueActor(); this.rescueStartedAt = this.elapsed;
    this.rescueActor = this.visuals.actor(this.stage, 'Rescue-N001', 'N001', 0, -50, 215, 215);
    this.rescueActor.pose('cane_raise', 0);
  }
  private clearRescueActor(): void { this.rescueActor?.node.destroy(); this.rescueActor = null; }

  private worldPath(g: Graphics, points: {x:number;y:number}[], close = false): void {
    points.forEach((point,index)=>{const p=worldToBattleScreen(point);if(index===0)g.moveTo(p.x-360,640-p.y);else g.lineTo(p.x-360,640-p.y);});
    if(close)g.close();g.stroke();
  }
  private worldCircle(g: Graphics, center: {x:number;y:number}, radius: number): void {
    battleCircleScreen(center,radius).forEach((p,index)=>{if(index===0)g.moveTo(p.x-360,640-p.y);else g.lineTo(p.x-360,640-p.y);});g.close();g.stroke();
  }
  private updateBattle(): void {
    if(this.session.data.screen!=='battle'||!this.worldLayer)return;
    const r:any=this.session.data.run,b=r.battle;
    this.updateHeroRange();
    if(this.bulletBadge)this.bulletBadge.active=this.session.combatTimeScale()>0&&this.session.combatTimeScale()<(r.speed||1);
    if(this.visualRunId!==r.id||this.visualWave!==b.wave){this.visualRunId=r.id;this.visualWave=b.wave;this.visualFloorTick=b.tick;this.effects=[];this.lastEnemyHp.clear();}
    if(this.labels.base)this.labels.base.string=`${b.baseHp}/${this.config.run.base_max_hp}`;
    if(this.labels.energy)this.labels.energy.string=`${Math.floor(b.energy)}`;
    if(this.labels.battleStatus)this.labels.battleStatus.string=this.battleStatus();
    if(this.labels.autoWave)this.labels.autoWave.string=this.autoWaveText();
    if(this.labels.bossNotice)this.labels.bossNotice.string=this.bossWaveText();
    r.equipped.forEach((id:string)=>{
      if(!id)return;
      const remaining=this.session.skillRemaining(id),g=this.cooldownViews[id];
      if(this.labels[`cooldown-${id}`])this.labels[`cooldown-${id}`].string=remaining>0?`${Math.ceil(remaining)}秒`:'就绪';
      if(g){
        const lastCast=(b.stats.effects||[]).filter((effect:any)=>effect.kind==='skillCast'&&effect.skillId===id).slice(-1)[0];
        const total=lastCast?(r.skills[id].readyTick-lastCast.tick)/this.config.clock.tick_hz:this.config.skills.find((skill:any)=>skill.id===id).cooldown_seconds;
        g.clear();round(g,-65.5,-2.5,131,5,2,'#BEAFC8');round(g,-65.5,-2.5,131*(1-Math.min(1,remaining/Math.max(.001,total))),5,2,remaining>0?'#C9A9F0':'#44BDA2');
      }
    });
    const alive=new Set<string>();
    b.enemies.forEach((e:any)=>{
      if(e.hp<=0||e.terminal)return;alive.add(e.id);
      const def=this.config.monsters.find((m:any)=>m.id===e.type),point=worldToBattleScreen(e);
      let display=this.enemyViews.get(e.id);
      if(!display){
        const height=e.type==='B001'?162:e.type==='B002'?120:e.type==='M004-S'?49:Math.max(72,def.body_radius*3.1);
        const actor=this.visuals.actor(this.worldLayer!,`Enemy-${e.id}-${e.type}`,e.type,point.x-360,640-point.y,height,height);
        const hp=shape(actor.node,'Health',0,height*.88+3,Math.max(32,height*.64),7).g;
        display={node:actor.node,actor,hp,size:height};
        display.node.on(Node.EventType.TOUCH_END,()=>{if(this.session.data.overlay==='aim')this.setAimPoint(worldToBattleScreen(e));});
        this.enemyViews.set(e.id,display);
      }
      display.node.setPosition(point.x-360,640-point.y);
      const recentHit=(b.stats.damageLog||[]).filter((hit:any)=>hit.enemyId===e.id&&b.tick-hit.tick<8&&hit.tick>this.visualFloorTick).slice(-1)[0];
      if(recentHit)display.actor.hit(recentHit.tick/this.config.clock.tick_hz,`${recentHit.tick}:${e.id}:${recentHit.source}`,/^[KP]/.test(recentHit.source)?1.5:1,this.session.data.profile.settings.shake!==false);
      const pulse=def.pulse,pulseTick=pulse?(e.hastes||[]).find((haste:any)=>haste.source===`boss:${e.id}`)?.endTick-Math.round(pulse.duration_seconds*this.config.clock.tick_hz):-Infinity;
      const action:VisualAction=e.bossWindupUntil>b.tick?'tell':pulseTick>this.visualFloorTick&&b.tick-pulseTick<this.config.clock.tick_hz*.35?'impact':recentHit?'hit':e.hard?'idle':'walk';
      display.actor.pose(action,b.tick/this.config.clock.tick_hz,e.id*.31,e.hard?0:1);
      const hp=display.hp,hpWidth=Math.max(32,display.size*.64);hp.clear();round(hp,-hpWidth/2,-3,hpWidth,7,3,'#9C817F');
      round(hp,-hpWidth/2,-3,hpWidth*Math.min(1,e.hp/e.maxHp),7,3,e.type==='B001'?'#CB5F97':e.type==='B002'?'#E6A447':'#55B785');
      if(!this.textureEffects&&(this.lastEnemyHp.get(e.id)||e.hp)>e.hp)this.effects.push({x:e.x,y:e.y,untilTick:b.tick+10,fill:'#FFF1A5',size:def.body_radius+8});
      this.lastEnemyHp.set(e.id,e.hp);
    });
    this.enemyViews.forEach((value,id)=>{if(!alive.has(id)){value.node.destroy();this.enemyViews.delete(id);}});
    const g=this.effectLayer!;g.clear();
    this.effects.forEach(e=>{g.strokeColor=color(e.fill,Math.round(Math.max(0,e.untilTick-b.tick)/10*220));g.lineWidth=4;this.worldCircle(g,e,e.size);});
    const effects=this.textureEffects?[]:(b.stats.effects||[]).filter((e:any)=>e.tick>this.visualFloorTick&&b.tick-e.tick<18);
    effects.forEach((effect:any)=>{
      g.strokeColor=color(effect.kind==='attack'?'#FFF5C8':'#AA78D9',190);g.lineWidth=effect.kind==='attack'?4:3;
      if(effect.kind==='attack'){
        const hero=b.heroes.find((h:any)=>h.id===effect.heroId),pad=this.config.world.pads.find((p:any)=>p.id===hero?.slot);
        if(pad)this.worldPath(g,[pad,effect]);
      }else if(typeof effect.x==='number'&&typeof effect.y==='number')this.worldCircle(g,effect,(effect.radius||35)*(.6+(b.tick-effect.tick)/30));
      else if(Number.isInteger(effect.lane)&&effect.lane>=1&&effect.lane<=3){const x=this.config.world.lane_centers_x[effect.lane-1];this.worldPath(g,[{x,y:this.config.world.base_y},{x,y:this.config.world.spawn_y}]);}
      else if(effect.enemyId!==undefined){const target=b.enemies.find((enemy:any)=>enemy.id===effect.enemyId);if(target)this.worldCircle(g,target,47);}
      else if(effect.confirm||this.config.skills.find((skill:any)=>skill.id===effect.skillId)?.target==='global_confirm')this.worldPath(g,[{x:0,y:0},{x:720,y:0},{x:720,y:680},{x:0,y:680}],true);
    });
    b.enemies.filter((e:any)=>!this.textureEffects&&e.hp>0&&!e.terminal).forEach((e:any)=>{
      if(e.bossWindupUntil>b.tick){g.strokeColor=color('#E55C72');g.lineWidth=5;this.worldCircle(g,e,69+Math.sin(b.tick/this.config.clock.tick_hz*13)*4);}
      if(e.hard||e.slows?.length){g.strokeColor=color(e.hard?'#B49AE3':'#85D4EB');g.lineWidth=3;this.worldCircle(g,e,27);}
      if(e.mark){const point=worldToBattleScreen(e);g.fillColor=color('#F8D660');g.circle(point.x-349,661-point.y,6);g.fill();}
    });
    if(this.session.data.overlay==='aim'){
      const target=this.aimTarget,skill=this.config.skills.find((s:any)=>s.id===this.aimingSkill);g.strokeColor=color('#975CD3');g.lineWidth=5;
      if(target?.x!==undefined){this.worldCircle(g,target,skill.radius||100);this.worldPath(g,[{x:target.x-13,y:target.y},{x:target.x+13,y:target.y}]);this.worldPath(g,[{x:target.x,y:target.y-13},{x:target.x,y:target.y+13}]);}
      else if(target?.lane){const x=this.config.world.lane_centers_x[target.lane-1];this.worldPath(g,[{x:x-39,y:32},{x:x+39,y:32},{x:x+39,y:648},{x:x-39,y:648}],true);}
      else if(target?.enemyId){const enemy=b.enemies.find((e:any)=>e.id===target.enemyId);if(enemy)this.worldCircle(g,enemy,47);}
      else if(target?.confirm)this.worldPath(g,[{x:0,y:0},{x:720,y:0},{x:720,y:680},{x:0,y:680}],true);
    }
    if(this.gesture?.dragging&&this.dragPoint){
      const slot=this.nearestSlot(this.dragPoint),pad=this.config.world.pads.find((p:any)=>p.id===slot),reserveIndex=['R1','R2','R3'].indexOf(slot||'');
      if(pad||reserveIndex>=0){const point=pad?worldToBattleScreen(pad):battleReserveScreen(reserveIndex);g.strokeColor=color('#F8C957');g.lineWidth=7;g.ellipse(point.x-360,640-point.y,56,38);g.stroke();}
    }
  }

  private updateHeroRange(): void {
    const g=this.rangeLayer;if(!g)return;
    const selected=this.inspectedRange();g.clear();g.node.active=!!selected;if(!selected)return;
    const points=battleCircleScreen(selected.center,selected.radius,120);
    points.forEach((p,i)=>{if(i===0)g.moveTo(p.x-360,640-p.y);else g.lineTo(p.x-360,640-p.y);});
    g.close();g.fillColor=color('#85EFFF',25);g.fill();
    const dashes=battleRangeDashes(selected.center,selected.radius);
    for(const [stroke,width] of [['#134C63',5],['#B8F8FF',3]] as [string,number][]){
      g.strokeColor=color(stroke);g.lineWidth=width;
      dashes.forEach(segment=>{segment.forEach((p,i)=>{if(i===0)g.moveTo(p.x-360,640-p.y);else g.lineTo(p.x-360,640-p.y);});});g.stroke();
    }
  }

  private describeUI(): any {
    // Read-only QA surface: report actual native transforms, never dispatch input.
    // World-to-screen uses the real Canvas camera; CSS bounds account for backing
    // buffer size, device pixel ratio and any letterboxing around the canvas.
    const controls: any[] = [], renderedArt: any[] = [], semanticTitles: any[] = [], typography: any[] = [], referenceComponents: any[] = [], camera = this.node.getComponent(Canvas)?.cameraComponent;
    const canvas = game.canvas, css = canvas?.getBoundingClientRect();
    const stageTransform = this.stage.getComponent(UITransform)!;
    const shieldIndex = this.page.children.reduce((index, n, i) => n.getComponent(BlockInputEvents) ? i : index, -1);
    const bounds = (points: { x: number; y: number }[]) => {
      const xs = points.map(p => p.x), ys = points.map(p => p.y), x = Math.min(...xs), y = Math.min(...ys);
      const width = Math.max(...xs) - x, height = Math.max(...ys) - y;
      return { x, y, width, height, centerX: x + width / 2, centerY: y + height / 2 };
    };
    const clientPoint=(point:{x:number;y:number})=>{
      if(!camera||!canvas||!css)return null;
      const world=stageTransform.convertToWorldSpaceAR(new Vec3(point.x-360,640-point.y,0)),pixel=camera.worldToScreen(world);
      return{x:css.left+pixel.x*css.width/canvas.width,y:css.top+(canvas.height-pixel.y)*css.height/canvas.height};
    };
    const walk = (n: Node) => {
      const title = this.titleInfo.get(n);
      if (title && n.activeInHierarchy) semanticTitles.push({ text: title, nodeName: n.name });
      const label = n.getComponent(Label);
      if (label && n.activeInHierarchy) {
        const description = this.typography.describe(label), ui = n.getComponent(UITransform)!;
        if (description) typography.push({ ...description, nodeName: n.name, width: ui.width, height: ui.height, nodeScale:{x:n.scale.x,y:n.scale.y} });
      }
      const assetId = this.visuals.assetId(n);
      if (assetId && n.activeInHierarchy) renderedArt.push({ id: assetId, nodeName: n.name });
      const reference = this.referenceInfo.get(n);
      if (reference && n.activeInHierarchy) referenceComponents.push({ ...reference, nodeName: n.name, spriteType: n.getComponent(Sprite)?.type, width: n.getComponent(UITransform)?.width, height: n.getComponent(UITransform)?.height });
      const meta = this.controlInfo.get(n), button = n.getComponent(Button), ui = n.getComponent(UITransform);
      if ((meta || n.name.startsWith('Slot-')) && ui) {
        const size = ui.contentSize, anchor = ui.anchorPoint;
        const corners = [new Vec3(-size.width * anchor.x, -size.height * anchor.y), new Vec3(size.width * (1 - anchor.x), size.height * (1 - anchor.y))]
          .map(p => ui.convertToWorldSpaceAR(p));
        const designBounds = bounds(corners.map(p => { const local = stageTransform.convertToNodeSpaceAR(p); return { x: local.x + 360, y: 640 - local.y }; }));
        const pixels = camera && canvas ? corners.map(p => { const v = camera.worldToScreen(p); return { x: v.x, y: canvas.height - v.y }; }) : null;
        const canvasBounds = pixels ? bounds(pixels) : null;
        const clientBounds = pixels && canvas && css ? bounds(pixels.map(p => ({ x: css.left + p.x * css.width / canvas.width, y: css.top + p.y * css.height / canvas.height }))) : null;
        let top = n; while (top.parent && top.parent !== this.page) top = top.parent;
        const occludedByModal = top.getSiblingIndex() < shieldIndex;
        const buttonSprite = button?.target?.getComponent(Sprite);
        const skinState = buttonSprite?.spriteFrame === button?.disabledSprite ? 'disabled' : buttonSprite?.spriteFrame === button?.pressedSprite && button?.pressedSprite !== button?.normalSprite ? 'pressed' : 'normal';
        controls.push({ index: controls.length, name: n.name, label: meta?.label || n.name, active: n.activeInHierarchy,
          nativeInteractable: !!button?.enabledInHierarchy && !!button?.interactable, muted: meta?.muted || false, occludedByModal,
          available: n.activeInHierarchy && !!button?.enabledInHierarchy && !!button?.interactable && !occludedByModal,
          skin: buttonSprite ? { id: this.visuals.assetId(button!.target), mode: buttonSprite.type === Sprite.Type.SLICED ? 'nine-slice' : 'sprite', state: skinState } : null,
          designBounds, canvasBounds, clientBounds });
      }
      n.children.forEach(walk);
    };
    walk(this.page);
    const permissions: Record<string, boolean> = {};
    ['summon', 'move', 'startWave', 'chooseCard', 'equipSkill', 'aim', 'cast', 'grandpa', 'freeRevive', 'adRequest', 'upgrade', 'equipForm'].forEach(command => permissions[command] = this.session.can(command));
    const d:any=this.session.data,r=d.run;
    const pageReference=this.pendingResume?'A_background':this.localModal==='praise'?'D05':this.localModal==='unlockBattle'||d.overlay==='unlock'?'N06':this.localModal?`A_${this.localModal}`:
      d.overlay==='settings'?'D06':d.overlay==='skills'?'D02':d.overlay&&['replace','discardRoster','background'].includes(d.overlay)?`A_${d.overlay}`:
      d.screen==='battle'?r.phase==='cards'?'D01':r.phase==='firstFailure'?'D03':r.phase==='secondFailure'?'D04':r.phase==='adPending'?'A_AD':'S03':
      d.screen==='camp'?'N01':d.screen==='collection'?'N02':d.screen==='hero'?d.profile.heroes[d.selectedHero]?.owned?'N03':'N05':d.screen==='roster'?'N04':d.screen==='result'?'S04':'UNKNOWN';
    const position=(point:{x:number;y:number})=>{const design=worldToBattleScreen(point);return{world:{x:point.x,y:point.y},design,client:clientPoint(design)};};
    const selectedRange=this.inspectedRange();
    const battleGeometry=d.screen==='battle'&&r?{projection:battleProjectionContract,
      pads:this.config.world.pads.map((pad:any)=>({id:pad.id,...position(pad)})),
      reserves:['R1','R2','R3'].map((id,index)=>{const design=battleReserveScreen(index);return{id,design,client:clientPoint(design)};}),
      enemies:r.battle.enemies.filter((e:any)=>e.hp>0&&!e.terminal).map((enemy:any)=>({id:enemy.id,type:enemy.type,...position(enemy)})),
      selectedRange:selectedRange?{heroId:selectedRange.hero.id,slot:selectedRange.hero.slot,range:selectedRange.radius,
        center:position(selectedRange.center),active:!!this.rangeLayer?.node.active,
        dashes:battleRangeDashes(selectedRange.center,selectedRange.radius).map(segment=>segment.map(p=>({design:p,client:clientPoint(p)})))}:null,
      aimSkill:this.aimingSkill,aimTarget:this.aimTarget}:null;
    return { screen: this.session.data.screen, overlay: this.session.data.overlay, localModal: this.localModal, phase: this.session.data.run?.phase,
      pageReference,battleGeometry,pendingResume:this.pendingResume,
      flow:{configVersion:r?.configVersion,combatTimeScale:this.session.combatTimeScale(),autoWaveRemaining:this.session.autoWaveRemaining(),finishingWave:this.elapsed<this.cardRevealUntil},
      design: { width: 720, height: 1280 }, canvas: canvas && css ? { width: canvas.width, height: canvas.height, clientX: css.left, clientY: css.top, clientWidth: css.width, clientHeight: css.height } : null,
      controls, semanticTitles, typography, fonts: this.typography.report(), permissions, profilerVisible: profiler.isShowingStats(), native: 'Cocos Creator 3.8.8 Label/Button/Graphics/Sprite', assetReport: this.catalog.report(),
      renderedArt, referenceComponents, visualActors: this.avatars.map(a => a.actor.report).concat(Array.from(this.enemyViews.values(), v => v.actor.report), this.rescueActor ? [this.rescueActor.report] : []),
      audio: this.audio?.status(), vfx: this.textureEffects?.status(), placeholderArt: this.catalog.report().loadedArt === 0 };
  }

  private v5oImage(id: string, rect?: [number, number, number, number]): Node | null {
    return this.referenceImage(`V5_O_${id}`, rect ? this.sourceRect(...rect) : undefined);
  }
  private v5oButton(id: string, label: string, action: () => void, rect?: [number, number, number, number], muted = false): Node | null {
    return this.referenceButton(`V5_O_${id}`, label, action, rect ? this.sourceRect(...rect) : undefined, muted);
  }
  private v5oLiveButton(label: string, rect: [number, number, number, number], action: () => void, fill = P.lake, size = 30, muted = false): Node {
    const [x,y,w,h] = this.sourceRect(...rect);
    return this.button(label,x+w/2,y+h/2,w,h,action,fill,size*720/941,muted,null);
  }
  private v5oActor(id: string, form: string, rect: [number, number, number, number], action: VisualAction = 'idle', dim = false): Node {
    const [x,y,w,h] = this.sourceRect(...rect);
    const actor = this.avatar(id,form,x+w/2,y+h/2,1,action,undefined,{width:w,height:h,footY:y+h*.88});
    if (dim) this.avatars[this.avatars.length-1].actor.tint('#B9B9C4');
    return actor;
  }
  private v5oLiveNumber(value: string, rect: [number,number,number,number], size: number, fill = P.ink, key?: string, outlined = false): Label {
    const label = this.referenceText(value,rect,size,fill,'number',key);
    if (outlined) { label.enableOutline=true; label.outlineWidth=2.4; label.outlineColor=color('#071B34'); }
    return label;
  }
  private v5oTitle(id: string, title: string): void {
    const n=this.v5oImage(id); if(n)this.titleInfo.set(n,title);
  }
  private v5oSkillStrip(id: string): void {
    if(id==='H001') { this.v5oImage('GROWTH_SKILL_H001'); return; }
    this.v5oImage('SKILL_STRIP');
    const h=this.config.heroes.find((v:any)=>v.id===id), skill=h.player_skill_id;
    const [x,y,w,ht]=this.sourceRect(43,1301,185,110); this.icon(skill,x+w/2,y+ht/2,Math.min(w,ht));
    this.referenceText('局内三星技能：',[245,1311,288,45],34,'#FFFFFF','number');
    const skillLabel=this.referenceText(SKILL_NAME[skill],[512,1308,376,50],35,'#FFF33A','number');skillLabel.enableOutline=true;skillLabel.outlineWidth=1.2;skillLabel.outlineColor=color('#49287B');
    this.referenceText('每局合成三星后获得，可择机释放',[245,1363,641,41],29,'#FFFFFF','body');
  }
  private lockedHeroDetail(): void {
    const d:any=this.session.data,id=d.selectedHero,h=this.config.heroes.find((v:any)=>v.id===id),p=d.profile.heroes[id];
    const forms=this.config.forms.filter((f:any)=>f.hero_id===id),selected=forms.find((f:any)=>f.id===this.previewForm)||forms[0];
    this.box(360,640,720,1280,'#DFF0BE',0);this.v5oImage('BG_LOCKED');
    if(id==='H004')this.v5oTitle('LOCKED_TITLE_H004',h.name);else this.titleWood(h.name,360,83,430);
    this.v5oButton('LOCKED_BACK','返回',()=>this.run('back'));this.v5oImage('LOCKED_HERO_FRAME');
    if(id==='H004'&&selected.id===h.default_form_id)this.v5oImage('LOCKED_POSTER_H004');
    else{
      this.v5oImage('LOCKED_PREVIEW_WELL');
      this.v5oActor(id,selected.id,[231,225,480,495],this.previewAction,true);
      this.v5oLiveButton('尚未解锁',[327,666,289,81],()=>{},P.cream,38,true);
    }
    // N05 has no painted form controls. These independent chips extend the source
    // at its original role-strip position, while preserving a free preview path.
    forms.forEach((f:any,i:number)=>{const n=this.v5oLiveButton(`形态${i+1}${selected.id===f.id?' · 预览':''}`,[200+i*182,766,174,49],()=>{this.previewForm=f.id;this.previewAction='idle';this.render();},selected.id===f.id?P.purple:P.cream,23);n.name=`Form-${f.id}`;});
    if(selected.id===h.default_form_id&&id==='H004')this.v5oImage('LOCKED_ABILITY_H004');
    else this.referenceText(`${selected.name} · 英雄解锁后 Lv${selected.unlock_level} 获得`,[218,826,510,48],30,P.ink,'name');
    this.v5oImage('LOCKED_PROGRESS_PANEL');this.v5oImage('LOCKED_PROGRESS_LABEL');
    const target=h.unlock_completed_waves,current=Math.min(d.profile.completedWaves,target),ratio=target>0?current/target:1;
    this.referenceText(`累计完成${target}波`,[117,977,497, 50],39,P.ink,'section','unlockTarget');this.v5oLiveNumber(`${current}/${target}`,[704,978,116,48],43,'#B66A0B','unlockProgress');
    this.v5oImage('LOCKED_PROGRESS_TRACK');if(ratio>0){const [x,y,w,ht]=this.sourceRect(128,1035,682,28),filled=w*ratio;const fill=this.makeNode('LockedUnlockProgressFill',x+filled/2,y+ht/2,filled,ht);this.visuals.sliced(fill,'V5_O_LOCKED_PROGRESS_FILL',filled,ht);}
    if(id==='H004')this.v5oImage('LOCKED_SKILL_H004');else{this.v5oImage('SKILL_STRIP',[101,1087,740,199]);const [x,y,w,ht]=this.sourceRect(135,1110,190,150);this.icon(h.player_skill_id,x+w/2,y+ht/2,Math.min(w,ht));this.referenceText(SKILL_NAME[h.player_skill_id],[333,1120,463,71],39,'#FFF8D0','number');this.referenceText('局内合成三星解锁',[346,1202,438,50],32,'#FFFFFF','body');}
    if(this.persistentRun())this.v5oLiveButton(`继续第 ${d.run.battle.wave} 波攻略`,[187,1324,565,149],()=>this.run('continueRun'),P.lake,43);
    else this.v5oButton('LOCKED_CONTINUE','继续攻略',()=>this.run('camp'));
    this.v5oButton('LOCKED_PRAISE','夸夸作者提前解锁',()=>{this.modalHero=id;this.openLocal('praise');});
    if(d.notice)this.referenceText(d.notice,[177,1608,586,36],24,'#5D5443','caption');
  }

  private d5SkillPage = 0;
  private d5SelectedSlot = 0;
  private d5CardDetail = '';

  private d5Shade(): void {
    const n = this.box(360, 640, 720, 1280, '#152E3D', 0);
    const g = n.getComponent(Graphics)!; g.clear(); g.fillColor = color('#102430', 174); g.rect(-360, -640, 720, 1280); g.fill();
    n.name = 'ModalInputShield'; n.addComponent(BlockInputEvents);
  }
  private d5Hit(label: string, rect: [number, number, number, number], action: () => void, muted = false): Node {
    const [x,y,w,h] = this.sourceRect(...rect), n = this.makeNode(`Button-${label}`, x+w/2, y+h/2, w, h);
    const button=n.addComponent(Button); button.interactable=!muted; button.transition=Button.Transition.NONE;
    this.controlInfo.set(n,{label,muted}); const generation=this.generation;
    n.on(Button.EventType.CLICK,()=>{ if(generation===this.generation&&!muted){this.audio?.userGesture();action();} }); return n;
  }
  private d5Button(label: string, rect: [number,number,number,number], action: () => void, fill=P.lake, size=31, muted=false): Node {
    const [x,y,w,h]=this.sourceRect(...rect); return this.button(label,x+w/2,y+h/2,w,h,action,fill,size*720/941,muted,null);
  }
  private d5Outlined(value: string, rect: [number,number,number,number], size: number, fill='#FFFFFF', stroke='#081631', width=5): Label {
    const l=this.referenceText(value,rect,size,fill,'number'); l.enableOutline=true;l.outlineColor=color(stroke);l.outlineWidth=width*720/941;return l;
  }
  private d5Icon(id: string, rect: [number,number,number,number]): void {
    const artId=/^[KP]00[1-4]$/.test(id)?`V5_D_SKILL_ART_${id}`:id;
    const [x,y,w,h]=this.sourceRect(...rect),size=Math.min(w,h);this.visuals.image(this.page,`DialogIcon-${id}`,artId,x+w/2-360,640-y-h/2,artId===id?w:size,artId===id?h:size);
  }
  private d5CardDetailsDialog(): void {
    const r:any=this.session.data.run,id=this.d5CardDetail,c=this.config.cards.find((v:any)=>v.id===id);
    this.modal(c.name,`已选 ${r.cards[id]||0} 层 · ${c.max_picks==null?'可重复叠选':`最多 ${c.max_picks} 层`}`,980);
    this.icon(id,360,413,190);this.text(CARD_COPY[id],360,663,570,302,32,P.ink);
    this.button('选择这张卡',360,909,566,88,()=>{this.d5CardDetail='';this.run('chooseCard',id);},P.lake,33);
    this.button('返回三选一',360,1014,566,82,()=>{this.d5CardDetail='';this.render();},P.cream,29);
  }

  private praiseDialog(): void {
    const d:any=this.session.data,id=this.modalHero,p=d.profile.heroes[id];this.d5Shade();
    this.referenceImage('V5_D_PRAISE_PANEL');this.referenceImage('V5_D_PRAISE_TITLE');
    this.referenceButton('V5_D_PRAISE_CLOSE','关闭夸赞 · 暂不解锁',()=>this.closeLocal());
    const [x,y,w,h]=this.sourceRect(135,706,674,150);this.box(x+w/2,y+h/2,w,h,'#ECEAE4',24,'#C9C7BE');
    const [ax,ay,aw,ah]=this.sourceRect(156,707,199,145), clip=this.makeNode('PraiseHeroPortrait',ax+aw/2,ay+ah/2,aw,ah);clip.addComponent(Mask).type=Mask.Type.GRAPHICS_RECT;
    const actor=this.avatar(id,p?.equippedForm||id,ax+aw/2,ay+ah,1,'idle',undefined,{width:aw*1.65,height:ah*1.65,footY:ay+ah});actor.setParent(clip,true);
    this.referenceText(`提前解锁：${this.heroName(id)}`,[370,724,419,113],40,P.ink,'name');
    ['这游戏，有点东西！','你的创意我服了！','作者今天也很有才！'].forEach((label,i)=>this.referenceButton(`V5_D_PRAISE_${i+1}`,label,()=>{const hero=this.modalHero;this.localModal='';this.run('praise',hero);}));
  }

  private d5VolumeSlider(key:string, top:number): void {
    const s:any=this.session.data.profile.settings, [x,y,w,h]=this.sourceRect(375,top,401,60);
    const track=this.makeNode(`VolumeSlider-${key}`,x+w/2,y+h/2,w,h), g=track.addComponent(Graphics);
    const accessible=track.addComponent(Button);accessible.transition=Button.Transition.NONE;
    const knob=this.visuals.image(track,`VolumeKnob-${key}`,key==='voice'?'V5_D_SLIDER_CYAN_KNOB':'V5_D_SLIDER_GOLD_KNOB',0,0,46*720/941,51*720/941);
    const valueText=this.referenceText(`${Math.round(s[key]*100)}%`,[692,top-13,85,26],23,'#766A4C','caption');
    let selected=s[key]; const paint=(value:number)=>{g.clear();round(g,-w/2,-9*720/941,w,18*720/941,9*720/941,'#DED2B0','#CCBD99',1);if(value>0)round(g,-w/2,-9*720/941,w*value,18*720/941,9*720/941,'#00BFEA','#00A4C9',1);if(knob)knob.setPosition(-w/2+w*value,0);valueText.string=`${Math.round(value*100)}%`;};paint(selected);
    this.controlInfo.set(track,{label:`${key}音量滑杆`,muted:false});
    const read=(e:EventTouch)=>{const p=e.getUILocation(),local=track.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(p.x,p.y,0));selected=Math.max(0,Math.min(1,Math.round((local.x/w+.5)*10)/10));paint(selected);};
    track.on(Node.EventType.TOUCH_START,(e:EventTouch)=>{this.audio?.userGesture();read(e);});
    track.on(Node.EventType.TOUCH_MOVE,read);
    track.on(Node.EventType.TOUCH_END,(e:EventTouch)=>{read(e);this.run('setting',{key,value:selected});});
    track.on(Node.EventType.TOUCH_CANCEL,()=>this.render());
  }
}
