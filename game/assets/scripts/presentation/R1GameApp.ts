import { _decorator, BlockInputEvents, Color, Component, EventTouch, Game, Graphics, Label, Layers, Mask, Node, Sprite, UIOpacity, UITransform, Vec3, game, profiler, screen, sys, view } from 'cc';
import { BattleTuning, HEROES, Quality, RULES, SKILLS, autoSkillCooldown, autoSkillRadius, heroDef, permanentStats, skillDef, stageDef, stageTuning } from '../domain/r1/config';
import { BattleEvent, Card, Hero, Run, now } from '../domain/r1/model';
import { CONTRACTS, EXPEDITION_HP, EXPEDITION_ATTACK, GOALS, SPECIALIZATIONS, Expedition, Specialization, milestoneName, progressPieces, rewardPreview } from '../domain/r1/incentives';
import { R1Session } from '../domain/r1/session';
import { upgradeCost, unlockedHeroes } from '../domain/r1/rewards';
import { skillArea } from '../domain/r1/geometry';
import { effectiveRate } from '../domain/r1/battle';
import { runTuning } from '../domain/r1/waves';
import { attributeBonuses } from '../domain/r1/cards';
import cardViews from '../domain/r1/ui-cards.json';
import { R1Assets } from './R1Assets';
import { R1Audio } from './R1Audio';
import { HERO_COLORS, attackFamily, feedbackRate, friendlyImpactVisual, friendlyProjectileVisual } from './R1CombatVisuals';
import { driveSoak, visualFixture } from './R1VisualFixture';
import { Typography } from './Typography';
import { gameStorage } from './HostStorage';
import { BATTLE_EFFECT_BOTTOM, BATTLE_EFFECT_SCALE_Y, BATTLE_EFFECT_TOP, BATTLE_MODEL, BATTLE_VIEW, R1_VIEW, battleAim, battlePixelPoint, battleRadius, battleX, battleY } from './R1BattleLayout';
import { fitMiniGameStage, menuLowerEdgeInView } from './MiniGameLayout';

const { ccclass } = _decorator;
const W = R1_VIEW.width, H = R1_VIEW.height, Q: Quality[] = ['blue', 'purple', 'gold'];
const qualityNames = { blue: '蓝色', purple: '紫色', gold: '金色' };
const qualityColors = ['#248bf0', '#9d44da', '#e9a514'];
const toColor = (hex: string) => new Color().fromHEX(hex);
const cleanNumber = (n: number) => Number(n.toFixed(1)).toString();
type Page = 'camp' | 'stages' | 'heroes' | 'detail' | 'growth' | 'specialization' | 'goals' | 'expedition';
type Modal = '' | 'settings' | 'upgrade' | 'abandon' | 'end-run' | 'ability' | 'help';
type CardView = (typeof cardViews)[number];
interface ActorView { node: Node; sprite: Sprite; bar: Graphics; trait: Sprite; shield: Graphics; aura?: Graphics; ammo?: Label; action?: string; actionFrom?: number; lastX?: number; lastY?: number; lastTick?: number; moving?: boolean; atlas?: string; frame?: number }
interface FxView { node: Node; age: number; duration: number; size: number; tick: number; floating?: boolean; poolKey?: string; kind?: string; source?: string;
  readable?: boolean; realTime?:boolean; verticalScale?: number;
  animate?: (t: number) => void; numberKey?: string; total?: number; label?: Label;
  summonExit?: { id: string; action: 'spent' | 'despawn' | 'defeated' }; punch?: { fromX: number; fromY: number; toX: number; toY: number; glove: Node; spring: Node } }

/** Native Cocos 2D presentation. No preview canvas or HTML is used as the game. */
@ccclass('R1GameApp')
export class R1GameApp extends Component {
  session!: R1Session;
  private assets = new R1Assets();
  private typography = new Typography('r1/fonts');
  private audio?: R1Audio;
  private stage!: Node; private backdrop!: Node; private world!: Node; private ui!: Node; private effects!: Node; private feedback!: Node; private arenaEffects!: Node;
  private page: Page = 'camp'; private modal: Modal = ''; private selectedHero = 'RH01'; private heroCollectionPage = 0;
  private planQuality:Quality='blue'; private goalPage=0; private expeditionTier=1; private expeditionContract:Expedition['contract']='shield'; private nextExpedition:Expedition|undefined;
  private selectedStage = 1; private selectedCard = ''; private previousPause = false;
  private ready = false; private loading = false; private assetError = ''; private elapsed = 0;
  private loadingTitle = ''; private loadingElapsed = 0; private loadingProgress = 0; private loadingArtReady = false;
  private loadingHeroes: Node[] = []; private loadingBar?: Graphics; private loadingLabel?: Label;
  private signature = ''; private eventCursor = 0; private runId = ''; private labels: Label[] = [];
  private actors = new Map<number, ActorView>(); private missiles = new Map<number, Node>(); private fx: FxView[] = [];
  private hud = new Map<string, Label>(); private hotzones: { label: string; x: number; y: number; width: number; height: number; enabled: boolean }[] = [];
  private actionUntil = new Map<number, { action: string; until: number; from: number }>();
  private reactions = new Map<number, { at: number; heavy: boolean }>();
  private fxPool = new Map<string, Node[]>(); private energyPulse = 0;
  private kick = 0; private pendingReserve=0;
  private aimPoint = { x: .5, y: .5, angle: 0 }; private aimGraphics?: Graphics;
  private qaScene = ''; private qaHeld = false; private qaEnabled = false; private soakChoiceWait = 0;
  private frameStamp = 0; private frameIntervals: number[] = []; private frameSeconds = 0; private frameReportAt = 0;
  private maxStallSequence = 0; private stallSequence = 0; private frameReport: object = {};

  onLoad(): void {
    profiler.hideStats(); this.stage = this.nodeAt('R1Stage', this.node, W / 2, H / 2, W, H); this.stage.setPosition(0, 0, 0);
    this.backdrop = this.nodeAt('Background', this.stage, W / 2, H / 2, W, H);
    this.world = this.nodeAt('BattleActors', this.stage, W / 2, H / 2, W, H);
    this.effects = this.nodeAt('BattleEffects', this.stage, W / 2, H / 2, W, H);
    this.arenaEffects = this.nodeAt('ArenaImpactClip', this.effects, W / 2, (BATTLE_EFFECT_TOP + BATTLE_EFFECT_BOTTOM) / 2, BATTLE_VIEW.width, BATTLE_EFFECT_BOTTOM - BATTLE_EFFECT_TOP);
    this.arenaEffects.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;
    this.feedback = this.nodeAt('BattleFeedback', this.stage, W / 2, H / 2, W, H);
    this.ui = this.nodeAt('UI', this.stage, W / 2, H / 2, W, H);
    this.stage.on(Node.EventType.TOUCH_START, () => this.audio?.gesture(), this, true);
    if (sys.isBrowser && typeof window !== 'undefined' && /(?:\?|&)qa=1(?:&|$)/.test(window.location.search)) { this.qaEnabled = true; this.qaScene = new URLSearchParams(window.location.search).get('qaScene') || ''; }
    this.session = visualFixture(this.qaScene) || new R1Session(gameStorage(sys.localStorage)); this.selectedStage = Math.min(20, this.session.data.profile.clearedStage + 1);
    this.qaHeld = this.qaScene.startsWith('entry-');
    game.on(Game.EVENT_HIDE, this.onHide, this); game.on(Game.EVENT_SHOW, this.onShow, this);
    this.resize(); void this.load();
  }
  private async load(): Promise<void> {
    this.loading = true; this.assetError = ''; this.renderLoading('正在准备超力英雄…');
    try {
      await Promise.all([this.assets.init((loaded,total) => this.setLoadingProgress(total ? loaded / total : 0)), this.typography.load()]);
      if (this.qaScene && this.session.inBattle) await this.assets.loadGroup('battle');
      if (!this.isValid) return;
      const fonts = this.typography.report(); if (fonts.errors.length) throw new Error(fonts.errors.join('\n'));
      this.audio = new R1Audio(this.node, this.assets.manifest.audioEvents); void this.audio.init();
      this.ready = true; this.loading = false;
      if(this.qaScene === 'loading-preview') { this.loading = true; this.renderLoading('正在准备超力英雄…'); this.loadingProgress = .64; }
      else this.render();
      if (sys.isBrowser && typeof window !== 'undefined' && /(?:\?|&)qa(?:=1|&|$)/.test(window.location.search)) {
        (window as any).__r1 = { session: this.session, ui: this, describe: () => this.describe(), refresh: () => this.render() };
      }
    } catch (e) { console.error('[R1] Startup resources failed', e); this.loading = false; this.assetError = String(e); this.renderLoading('资源加载失败，请重试'); }
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
  private heading(title: string, back: Page = 'camp'): void { this.image('LOGO', 0, 307, 45, 330, 142, true); this.icon(7, back==='detail'?'返回英雄详情':back==='growth'?'返回成长计划':back === 'heroes' ? '返回英雄列表' : '返回营地', 48, 50, () => { this.page = back; }); this.wood(title, 195); }
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
    this.clear(this.ui); this.labels = []; this.hotzones = []; this.loadingHeroes = []; this.loadingBar = undefined; this.loadingLabel = undefined;
    this.loadingTitle = title; this.loadingElapsed = 0; this.loadingProgress = 0;
    this.loadingArtReady = ['LOGO','PORTRAIT-RH01','PORTRAIT-RH02','PORTRAIT-RH03'].every(id => !!this.assets.frame(id));
    const background = this.nodeAt('LoadingBackground', this.ui, W / 2, H / 2, W, H).addComponent(Graphics);
    background.fillColor=toColor('#f5e6b6');background.rect(-W/2,-H/2,W,H);background.fill();
    const clip=this.nodeAt('LoadingArtClip',this.ui,W/2,H/2,W,H);clip.addComponent(Mask).type=Mask.Type.GRAPHICS_RECT;
    const decor = this.nodeAt('LoadingDecor', clip, W / 2, H / 2, W, H).addComponent(Graphics);
    decor.fillColor = toColor('#dfe5aa'); decor.circle(-410,-800,420); decor.circle(440,-830,430); decor.fill();
    decor.fillColor = toColor('#fff5d4'); decor.circle(345,670,175); decor.circle(-410,420,140); decor.fill();
    if (this.assets.frame('LOGO')) this.image('LOGO',0,161,346,620,266,true);
    else this.text('超力英雄',470,470,76,720,120,'title');
    if(this.loadingArtReady) ['RH01','RH02','RH03'].forEach((id,i) => {
      const x=276+i*195; this.round(x-57,881,114,18,'#d4c796');
      this.loadingHeroes.push(this.image('PORTRAIT-'+id,0,x-76,700,152,180,true));
    });
    this.text(title,470,1010,38,800,80);
    this.round(191,1082,560,26,'#d4c796');
    this.loadingBar=this.nodeAt('LoadingProgress',this.ui,W/2,H/2,W,H).addComponent(Graphics);
    this.loadingLabel=this.text('0%',470,1155,30,400,54);
    if (this.assetError) { this.text('请检查网络后重试', 470, 1225, 30, 790, 70); this.button('重新加载', 270, 1340, 400, 120, () => void this.load()); }
  }
  private setLoadingProgress(progress: number): void {
    if(!this.isValid || !this.loading)return;
    if(!this.loadingArtReady && ['LOGO','PORTRAIT-RH01','PORTRAIT-RH02','PORTRAIT-RH03'].every(id => !!this.assets.frame(id))) this.renderLoading(this.loadingTitle);
    // Loaded-atlas progress is real; reserve completion until all startup work resolves.
    this.loadingProgress=Math.max(this.loadingProgress,Math.min(.98,progress));
  }
  private animateLoading(dt: number): void {
    this.loadingElapsed+=Math.min(dt,.1);
    this.loadingHeroes.forEach((n,i) => {const base=790; n.setPosition(n.position.x,H/2-base+Math.max(0,Math.sin(this.loadingElapsed*5-i*.8))*18);});
    const g=this.loadingBar;if(!g)return;g.clear();g.fillColor=toColor('#eeb43b');
    const width=Math.max(10,556*this.loadingProgress);g.roundRect(193-W/2,H/2-1106,width,22,11);g.fill();
    if(this.loadingLabel)this.loadingLabel.string=`${Math.floor(this.loadingProgress*100)}%`;
    if(this.qaEnabled && sys.isBrowser && typeof document !== 'undefined') document.documentElement.dataset.r1Loading=JSON.stringify({version:RULES.version,title:this.loadingTitle,progress:this.loadingProgress,artReady:this.loadingArtReady,preview:this.qaScene==='loading-preview',heroY:this.loadingHeroes.map(n=>n.position.y)});
  }
  private background(camp: boolean): void {
    const id = camp ? 'BG-CAMP' : 'BG-BATTLE';
    if (this.backdrop.children[0]?.name !== id) { this.clear(this.backdrop); this.image(id, 0, 0, 0, W, H, false, this.backdrop); }
  }
  private render(): void {
    if (!this.ready || this.loading) return;
    if(this.qaEnabled && sys.isBrowser && typeof document !== 'undefined') delete document.documentElement.dataset.r1Loading;
    // Leave the battle only after its removal was durably committed, including a save retry.
    if (this.modal === 'end-run' && !this.session.data.run && !this.session.error) {
      this.modal = ''; this.page = 'camp'; this.selectedCard = ''; this.nextExpedition = undefined;
      this.selectedStage = Math.min(20, this.session.data.profile.clearedStage + 1);
      this.pendingReserve = 0; this.clearEffects();
    }
    this.clear(this.ui); this.labels = []; this.hotzones = []; this.hud.clear(); this.aimGraphics = undefined;
    const r = this.session.data.run, battle = this.session.inBattle && !!r;
    this.world.active = battle; this.effects.active = battle; this.feedback.active = battle; this.background(!battle && this.page !== 'stages');
    if (battle) this.renderBattle(r!); else if (this.page === 'camp') this.renderCamp(); else if (this.page === 'stages') this.renderStages(); else if (this.page === 'heroes') this.renderHeroes(); else if(this.page==='growth')this.renderGrowth();else if(this.page==='specialization')this.renderSpecializations();else if(this.page==='goals')this.renderGoals();else if(this.page==='expedition')this.renderExpedition();else this.renderDetail();
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
    const stage = ongoing ? r.stage : Math.min(this.selectedStage,p.clearedStage+1,20);
    if(!ongoing)this.selectedStage=stage;
    this.image('LOGO', 0, 272, 88, 405, 178, true); this.icon(15, '设置', 810, 54, () => this.openModal('settings'));
    const inc=p.incentive;
    if(inc){const id=inc.focusByQuality[inc.primary],pieces=progressPieces(p,id),ready=upgradeCost(p,id).available;
      this.panel(65,364,811,352);this.portrait(id,94,395,160,181);
      this.text(`培养${heroDef(id).name}`,560,415,38,560);this.text(p.levels[id]>=20?'培养完成 · 可选择新英雄':`Lv.${p.levels[id]} · 可用碎片 ${pieces}/10`,560,473,31,550);
      this.round(299,515,501,18,'#d4c49b');if(pieces)this.round(299,515,Math.max(8,501*Math.min(1,pieces/10)),18,'#62a86c');
      this.text(`队长：${heroDef(inc.captain).name} · 开局可选`,547,575,27,585);
      this.button(ready?'立即培养':'切换培养目标',111,600,349,83,()=>{this.selectedHero=id;this.page=ready?'detail':'growth';});
      this.button('成长与成就',487,600,340,83,()=>{this.page='goals';},true);
    }
    this.panel(44, 808, 853, 486); this.wood(ongoing ? '进行中的挑战' : '新的挑战', 749);
    this.round(168, 895, 605, 86); this.text(`第${stage}关 · ${this.difficulty(stage)}`, 470, 939, 56, 580, 84, 'name');
    const goal=GOALS.find(g=>g.id===p.incentive?.goal);
    this.text(ongoing ? `已暂停 · 第${r.wave||0}/15波` : goal?`${goal.name} · ${p.incentive!.goals[goal.id]||0}/${goal.target}`:`已通关${p.clearedStage}关`,470,1031,34,780);
    this.text(ongoing ? '本局进度已保留' : rewardPreview(p,stage), 470, 1091, 31, 780);
    this.button(ongoing ? `继续第${stage}关` : `挑战第${stage}关`, 129, 1150, 685, 127, () => {this.nextExpedition=ongoing?r?.incentive?.expedition:undefined;void this.enterBattle(!!ongoing);});
    this.panel(45, 1334, 418, 179); this.image('UI-ICONS', 8, 81, 1361, 102, 119, true); this.text('关卡选择', 310, 1425, 41, 254); this.hit('关卡选择', 45, 1334, 418, 179, () => { this.nextExpedition=undefined;this.page = 'stages'; });
    this.panel(479, 1334, 418, 179); this.portrait('RH01', 505, 1357, 130, 138); this.text('英雄培养', 750, 1425, 41, 254); this.hit('英雄培养', 479, 1334, 418, 179, () => { this.page = 'heroes'; });
    if(p.clearedStage>=20)this.button('精英远征',277,1540,388,94,()=>{this.expeditionTier=p.incentive?.expedition.unlockedTier||1;this.page='expedition';});
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
    this.text(locked ? `通关第${stage.id-1}关后开放\n${rewardPreview(this.session.data.profile,stage.id)}` : `15波 · 特性：${traits}\n${rewardPreview(this.session.data.profile,stage.id)}`,620,1300,25,415,145);
    const inc=this.session.data.profile.incentive;
    if(inc&&[10,20].includes(stage.id)&&!inc.storyClaimed.includes(stage.id)){for(const [n,route] of (['gold','purple'] as const).entries())this.button(`${inc.routes[String(stage.id)]===route?'✓ ':''}${route==='gold'?'养金':'养紫'}`,393+n*229,1380,210,83,()=>this.session.setRoute(stage.id,route),route!==inc.routes[String(stage.id)]);}
    this.button(locked ? '尚未解锁' : '开始挑战', 232, 1510, 476, 124, () => { if (this.session.data.run?.status === 'active') this.openModal('abandon'); else void this.enterBattle(false); }, false, !locked);
  }
  private renderHeroes(): void {
    this.heading('英雄收藏'); const p = this.session.data.profile, unlocked = unlockedHeroes(p); this.panel(33, 370, 875, 1142);
    this.text(`已解锁 ${unlocked.length}/${HEROES.length}`, 470, 422, 42, 780);
    this.round(94, 478, 753, 82, '#f2e1b8'); this.text(`通用紫色 ${p.fragments['universal-purple'] || 0}张 · 通用金色 ${p.fragments['universal-gold'] || 0}张`, 470, 519, 31, 720);
    HEROES.slice(this.heroCollectionPage*6,this.heroCollectionPage*6+6).forEach((h, i) => {
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
    const pages=Math.ceil(HEROES.length/6);
    this.button('上一页',60,1525,245,90,()=>{this.heroCollectionPage--;},false,this.heroCollectionPage>0);
    this.text(`${this.heroCollectionPage+1} / ${pages}`,470,1570,35,200);
    this.button('下一页',636,1525,245,90,()=>{this.heroCollectionPage++;},false,this.heroCollectionPage<pages-1);
    this.text('点击英雄查看技能与培养',470,1643,25,850);
  }
  private renderDetail(): void {
    const h = heroDef(this.selectedHero), p = this.session.data.profile, level = p.levels[h.id], stats = permanentStats(h.id, level), unlocked = unlockedHeroes(p).includes(h.id);
    this.heading(h.name, 'heroes'); this.panel(43, 369, 855, 1250); this.portrait(h.id, 90, 419, 300, 280);
    this.text(`${qualityNames[h.quality]} · Lv.${level}`, 632, 457, 45, 450);
    this.text(`生命 ${cleanNumber(stats.hp)}\n攻击 ${cleanNumber(stats.attack)}\n防御 ${cleanNumber(stats.defense)}`, 632, 583, 32, 410, 180);
    this.button(p.incentive?.focusByQuality[h.quality]===h.id?'已设培养目标':'设为培养目标',89,695,365,88,()=>this.session.setFocus(h.id),true);
    this.button(p.incentive?.captain===h.id?'当前队长':'设为队长',487,695,365,88,()=>this.session.setCaptain(h.id),false,unlocked);
    for (let i = 1; i <= 3; i++) {
      const s = skillDef(h.id, i), v = this.cardView({ id: '', kind: 'skill', quality: s.cardQuality, heroId: h.id, skillSlot: i, level: i === 1 ? 2 : 1 });
      const y = 825 + (i - 1) * 145; this.image(Number(h.id.slice(2))>=7?'IC-'+h.id:'IC-SKILLS', Number(h.id.slice(2))>=7?i-1:(i - 1) * 6 + HEROES.findIndex(a => a.id === h.id), 87, y, 102, 102, true);
      const lines=i>1?this.skillLines(v,h.id,i,1,stageTuning(1)):[`初始伤害×${s.damageAttackMultiplier[0]}`,'攻击1个目标'];
      this.text(s.name, 514, y + 22, 33, 602, 55, 'name'); this.text(lines.join(' · '), 518, y + 87, 25, 593, 86);
    }
    this.text(`专属碎片 ${p.fragments[h.id] || 0}${h.quality === 'blue' ? '' : ` + 通用 ${p.fragments['universal-' + h.quality] || 0}`}\n每10张升一级，优先消耗专属碎片`, 470, 1325, 29, 745, 102);
    this.button(!unlocked ? `第${h.unlockAfterStage}关解锁` : level >= 20 ? '已满级' : '升级英雄', 227, 1423, 485, 108, () => this.openModal('upgrade'), false, unlocked && level < 20 && upgradeCost(p, h.id).available);    this.button(level>=3?'选择英雄专精':'预览专精 · Lv3开放',227,1540,485,95,()=>{this.page='specialization';},true);

  }
  private renderGrowth():void {
    this.heading('培养计划');const p=this.session.data.profile,i=p.incentive!;
    this.panel(52,354,837,1268);
    Q.forEach((q,n)=>this.button(qualityNames[q],86+n*260,384,246,98,()=>{this.planQuality=q;},q!==this.planQuality));
    this.text('每品质保留1个目标 · 点击英雄切换',470,527,29,760);
    HEROES.filter(h=>h.quality===this.planQuality).forEach((h,n)=>{
      const y=575+n*188,selected=i.focusByQuality[this.planQuality]===h.id;
      const g=this.round(89,y,765,168,selected?'#d5edc4':'#f3e2b8');this.portrait(h.id,108,y+11,135,140);
      this.text(`${selected?'✓ ':''}${h.name} · Lv.${p.levels[h.id]}`,536,y+43,34,573);
      this.text(`可用碎片 ${progressPieces(p,h.id)}/10${h.unlockAfterStage>p.clearedStage?' · 第'+h.unlockAfterStage+'关解锁':''}`,536,y+99,27,575);
      this.hit('培养'+h.name,89,y,765,168,()=>this.session.setFocus(h.id),true,g.node);
    });
    const id=i.focusByQuality[this.planQuality];this.text('切换不损失碎片 · 已开始的对局保持原计划',470,1374,26,770);
    this.button('查看英雄',103,1450,344,115,()=>{this.selectedHero=id;this.page='detail';},true);
    this.button(i.captain===id?'当前队长':'设为队长',491,1450,344,115,()=>this.session.setCaptain(id),false,heroDef(id).unlockAfterStage<=p.clearedStage);
  }
  private renderSpecializations():void {
    const p=this.session.data.profile,id=this.selectedHero,level=p.levels[id],chosen=p.incentive?.specializations[id],available=level>=3&&heroDef(id).unlockAfterStage<=p.clearedStage;
    this.heading('英雄专精','detail');this.panel(48,353,845,1267);this.portrait(id,110,395,183,205);
    this.text(heroDef(id).name,581,442,46,510);this.text(`Lv.${level} · ${milestoneName(level)}`,581,510,30,525);
    this.text(available?'选择1项 · 局外免费切换 · 下局生效':'永久Lv3解锁，先看看新的打法',470,634,28,795);
    SPECIALIZATIONS[id].forEach((perk,n)=>{
      const y=690+n*377,choice:Specialization=n===0?'A':'B',selected=chosen===choice;
      this.round(80,y,781,338,selected?'#d5edc4':n===0?'#e2f1f5':'#eee0f6');
      const expanded=Number(id.slice(2))>=7;this.image(expanded?'IC-'+id:'IC-SKILLS',expanded?perk.slot-1:(perk.slot-1)*6+HEROES.findIndex(h=>h.id===id),111,y+40,93,93,true);
      this.text(`${choice} · ${perk.name}`,519,y+58,37,550);
      this.text(perk.description,516,y+144,29,585,103);
      this.text(perk.slot===3?'本局解锁3技能后生效':'改造2技能，自动施放',470,y+231,25,720);
      this.button(selected?'已装备':available?'装备专精'+choice:'Lv3解锁',260,y+262,420,79,()=>this.session.setSpecialization(id,choice),!selected,available);
    });
    const record=p.incentive?.heroRecords[id];this.text(`战术记录 · 胜利${record?.wins||0}次 · 单次技能最佳${record?.bestBurst||0}连破`,470,1495,27,790);
    this.text('Lv6名牌 · Lv10先锋 · Lv15精通 · Lv20宗师',470,1560,25,800);
  }
  private renderGoals():void {
    this.heading('成长实绩');const i=this.session.data.profile.incentive!;this.panel(51,355,839,1258);
    this.text('无时限 · 记录真实配合 · 直接解锁徽记',470,405,28,790);
    GOALS.slice(this.goalPage*5,this.goalPage*5+5).forEach((g,n)=>{
      const y=459+n*181,value=i.goals[g.id]||0,done=value>=g.target;
      this.round(90,y,762,158,done?'#d8edc8':i.goal===g.id?'#f8e5a6':'#eee1c0');
      this.image('UI-ICONS',done?4:8,110,y+33,68,76,true);
      this.text(`${done?'✓ ':''}${g.name} · ${value}/${g.target}`,519,y+42,33,628);
      this.text(g.hint,517,y+96,25,619,72);
      this.hit('关注'+g.name,90,y,762,158,()=>this.session.setGoal(g.id));
    });
    this.text('点选关注目标；战斗中不增加任务面板',470,1412,25,750);
    this.button('上一页',88,1470,238,102,()=>{this.goalPage--;},true,this.goalPage>0);
    this.text(`${this.goalPage+1}/2`,470,1523,34,200);
    this.button('下一页',610,1470,238,102,()=>{this.goalPage++;},false,this.goalPage<1);
  }
  private renderExpedition():void {
    this.heading('精英远征');const p=this.session.data.profile,i=p.incentive!,tier=this.expeditionTier;
    this.panel(48,352,845,1267);
    this.button('上一阶',84,384,221,96,()=>{this.expeditionTier--;},true,tier>1);
    this.text(`第${tier} / 8阶`,470,433,42,320);
    this.button('下一阶',636,384,221,96,()=>{this.expeditionTier++;},true,tier<8&&tier<i.expedition.unlockedTier);
    this.text(`生命×${EXPEDITION_HP[tier-1]} · 攻击×${EXPEDITION_ATTACK[tier-1]} · 以第20关为底`,470,523,27,800);
    CONTRACTS.forEach((c,n)=>{
      const y=590+n*239,selected=this.expeditionContract===c.id,key=`${tier}:${c.id}`,won=i.expedition.wins.includes(key);
      const card=this.round(82,y,779,213,selected?'#d7ebc6':'#f1e0bb');
      this.image('UI-PROGRESSION',6+n,110,y+45,111,116,true);
      this.text(`${selected?'✓ ':''}${c.name}${won?' · 已征服':''}`,537,y+45,38,580);
      this.text(c.hint,529,y+107,26,591,74);
      const record=i.expedition.bestTicks[key];this.text(record?`最佳 ${Math.round(record/60)}战斗秒`:'15波 · 每波9只特性怪',531,y+169,26,587);
      this.hit('选择'+c.name,82,y,779,213,()=>{this.expeditionContract=c.id;},true,card.node);
    });
    this.text(rewardPreview(p,20,{tier,contract:this.expeditionContract}),470,1337,28,795);
    const completed=CONTRACTS.filter(c=>i.expedition.wins.includes(`${tier}:${c.id}`)).length;
    this.text(`本阶徽记 ${completed}/3${completed===3?' · 远征旗帜已解锁':''}${i.expedition.firstWins.length===8?' · 超力统领':''}`,470,1393,26,800);
    this.button('开始远征',254,1460,434,120,()=>{this.nextExpedition={tier,contract:this.expeditionContract};this.selectedStage=20;if(this.session.data.run?.status==='active')this.openModal('abandon');else void this.enterBattle(false);},false,p.clearedStage>=20);
  }

  private async enterBattle(resume: boolean, abandon = false): Promise<void> {
    if (this.loading) return; this.loading = true; this.assetError = ''; this.renderLoading('正在准备战斗素材…');
    try {
      await this.assets.loadGroup('battle',(loaded,total) => this.setLoadingProgress(total ? loaded / total : 0)); if (!this.isValid) return;
      const ok = resume ? this.session.resume() : this.session.start(this.selectedStage, Date.now() >>> 0, abandon,this.nextExpedition);
      this.loading = false; if (ok) { this.modal = ''; this.selectedCard = ''; } this.render();
    } catch (e) { this.loading = false; this.assetError = String(e); this.render(); }
  }
  private renderBattle(r: Run): void {
    this.image('LOGO', 0, 37, 67, 230, 100, true); this.round(334, 69, 350, 66, '#294a35');
    this.hud.set('wave', this.text(r.wave ? `第 ${r.wave} / 15 波` : '准备 / 15 波', 509, 102, 35, 310, 65, 'hud')); this.round(326, 145, 366, 63, '#294a35');
    this.hud.set('energy', this.text(`能量 ${r.energy} / 100`, 510, 176, 27, 340, 60, 'hud'));
    this.image('UI-COMPONENTS', 11, 827, 76, 79, 79);
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
    // The draft/aim shield still blocks other HUD controls; pause must remain above it.
    if (r.status === 'active' && !r.rescue && !r.paused && !this.modal)
      this.hit('暂停', 810, 55, 113, 122, () => this.session.pause(true));
  }
  private cardView(card: Card): CardView {
    const id = card.kind === 'hero' ? 'HERO-' + card.heroId : card.kind === 'attribute' ? `${card.heroId}-ATTR-all` : card.kind === 'global' ? 'GLOBAL-' + card.quality : `${card.heroId}-S${card.skillSlot}-L${card.level}`;
    return cardViews.find(c => c.id === id)!;
  }
  private skillLines(c:CardView,id:string,slot:number,level:number,tuning:BattleTuning|undefined):string[]{
    const lines=c.lines.slice(0,2).map(line=>line.includes('战场宽')?`${id==='RH04'&&slot===2?'弹射范围':'范围半径'} ${cleanNumber(autoSkillRadius(tuning,id,slot,level)*100)}%`:line);
    return [...lines,`冷却 ${cleanNumber(autoSkillCooldown(tuning,id,slot,level))}秒`];
  }
  private artPack(id: string): string { return /^RH(?:0[1-9]|10)$/.test(id) ? 'FX-' + id : this.assets.info(id) ? id : 'FX-' + id; }
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
      const panel = this.image('UI-CARDS', q, x, y, 282, 560); this.text(card.kind==='hero'&&card.heroId===r.incentive?.captain&&opening?'队长候选':c.typeLabel, x + 141, y + 42, 28, 225, 48, 'type'); this.cardArt(c, x, y);
      if (card.kind === 'skill') this.text(heroDef(card.heroId!).name, x + 141, y + 277, 22, 222);
      this.text(c.title, x + 141, y + 306, 29, 230, 48, 'name'); this.round(x + 25, y + 331, 232, 43, ['#e0f5ff', '#f3e4ff', '#fff1ba'][q]); this.text(c.badge, x + 141, y + 352, 25, 219, 40, 'name');
      let lines = c.lines;
      if (card.kind === 'hero' && r.tuning?.feel) lines = [c.lines[0], `${skillDef(card.heroId!, 2).name} Lv.1`, '上阵自动释放'];
      if (card.kind === 'skill' && card.skillSlot! > 1) lines = this.skillLines(c,card.heroId!,card.skillSlot!,card.level!,r.tuning);
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
    const target = this.hit('技能瞄准区域', BATTLE_VIEW.x, BATTLE_EFFECT_TOP, BATTLE_VIEW.width, BATTLE_EFFECT_BOTTOM - BATTLE_EFFECT_TOP, () => undefined);
    const move = (e: EventTouch) => { const p = e.getUILocation(), local = this.stage.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
      const aim = battleAim(local.x + W / 2, H / 2 - local.y); this.aimPoint.x = aim.x; this.aimPoint.y = aim.y; this.aimPoint.angle = (this.aimPoint.x - .5) * 50; this.drawAim(); };
    target.on(Node.EventType.TOUCH_START, move); target.on(Node.EventType.TOUCH_MOVE, move);
    this.text(`瞄准中 · 覆盖${Math.round(RULES.globalSkills[r.globalSkill!].coverageAreaFraction * 100)}%`, 470, 1188, 34, 820, 66, 'hud');
    this.button('取消', 173, 1537, 277, 112, () => this.session.cancelAim(), true); this.button('释放技能', 482, 1537, 288, 112, () => this.session.cast(this.aimPoint.x, this.aimPoint.y, this.aimPoint.angle));
  }
  private drawAim(): void {
    const r = this.session.data.run, g = this.aimGraphics; if (!g || !r?.globalSkill) return;
    const area = skillArea(r.globalSkill, this.aimPoint.x, this.aimPoint.y, this.aimPoint.angle);
    const center = battlePixelPoint(area.center.x, area.center.y), radius = battleRadius(area.radius / BATTLE_MODEL.width);
    const x = center.x - W / 2, y = H / 2 - center.y;
    g.clear(); g.strokeColor = toColor(qualityColors[Q.indexOf(r.globalSkill)]); g.fillColor = new Color(g.strokeColor.r, g.strokeColor.g, g.strokeColor.b, 38); g.lineWidth = 5;
    if (area.quality === 'purple') { area.polygon.forEach((p, i) => { const point = battlePixelPoint(p.x, p.y), px = point.x - W / 2, py = H / 2 - point.y; if (!i) g.moveTo(px, py); else g.lineTo(px, py); }); g.close(); }
    else if (area.quality === 'gold') {
      // Radial waves are clipped to the effective battle; coverage is not a rectangular decal.
      for (const fraction of [.28, .61, .95]) {
        let connected = false;
        for (let i = 0; i <= 180; i++) {
          const angle = i / 180 * Math.PI * 2, px = area.center.x + Math.cos(angle) * area.radius * fraction, py = area.center.y + Math.sin(angle) * area.radius * fraction;
          if (px < 0 || px > BATTLE_MODEL.width || py < 0 || py > BATTLE_MODEL.height) { connected = false; continue; }
          const point = battlePixelPoint(px, py), dx = point.x - W / 2, dy = H / 2 - point.y;
          if (connected) g.lineTo(dx, dy); else g.moveTo(dx, dy); connected = true;
        }
      }
      g.stroke(); return;
    }
    else g.ellipse(x, y, radius.x, radius.y);
    g.fill(); g.stroke();
  }
  private renderRescue(r: Run): void {
    const grandpa = r.rescue === 'grandpa'; this.popup(grandpa ? '老爷爷救我' : '全员阵亡', grandpa ? '3名英雄阵亡' : '本次挑战尚未结束');
    if (grandpa) {
      this.image('GRANDPA', 0, 108, 538, 275, 316, true); this.text('复活3名英雄\n预支3次抽卡', 646, 701, 43, 377, 216);
      this.text('后续3次能量抽卡将抵扣\nBoss抽卡不受影响\n不占用全灭免费复活', 470, 934, 32, 682, 157); this.text('每局1次，拒绝也消耗机会', 470, 1063, 30, 695);
      this.button('拒绝援助', 111, 1110, 344, 101, () => this.session.rescue(false), true); this.button('接受援助', 483, 1110, 344, 101, () => this.session.rescue(true));
    } else {
      this.image('UI-ICONS', 4, 342, 571, 255, 240, true); this.text(r.freeReviveUsed ? `本局免费复活机会已使用\n结束后保留${(r.incentive?.checkpoint===10?2:r.incentive?.checkpoint===5?1:0)*(r.stage%10===0?2:1)}张储备碎片` : '满血复活全部已上阵英雄\n获得2秒保护，不额外赠卡\n本局还可免费复活1次', 470, 936, 34, 700, 189);
      if (r.freeReviveUsed) this.button('结束战斗', 252, 1100, 438, 112, () => this.session.rescue(false));
      else { this.button('结束战斗', 112, 1100, 342, 112, () => this.session.rescue(false), true); this.button('免费复活', 486, 1100, 342, 112, () => this.session.rescue(true)); }
    }
  }
  private renderPause(): void {
    this.popup('暂停'); this.button('继续战斗', 185, 560, 570, 118, () => this.session.pause(false));
    this.button('设置', 185, 728, 570, 118, () => this.openModal('settings'), true);
    this.button('保存并返回营地', 185, 896, 570, 118, () => { if (this.session.camp()) { this.page = 'camp'; this.clearEffects(); } }, true);
    this.button('结束本局', 185, 1064, 570, 118, () => this.openModal('end-run'), true);
  }
  private renderSettlement(r:Run):void {
    const settlement=this.session.data.settlement,p=this.session.data.profile,receipt=settlement?.receipt,won=r.status==='victory';
    this.block(true);this.panel(48,270,845,1255,true);this.text(won?'挑战成功':'挑战结束',470,362,60,780,90,'title');
    this.text(receipt?.expedition?`精英远征 ${receipt.expedition.tier}阶 · ${CONTRACTS.find(c=>c.id===receipt.expedition!.contract)!.name}`:`第${r.stage}关 · ${this.difficulty(r.stage)}`,470,439,32,730);
    this.text(receipt?.reason||(won?'通关补给':'本局没有碎片'),470,506,37,700);
    const rewards=settlement?.rewards||[];const width=145,start=(W-rewards.length*width)/2;
    rewards.forEach((reward,n)=>{const x=start+n*width,q=reward.key.startsWith('universal')?reward.key.slice(10) as Quality:heroDef(reward.key).quality;
      this.round(x+4,555,137,224,['#e0f5ff','#f3e4ff','#fff1ba'][Q.indexOf(q)]);
      if(reward.key.startsWith('universal')){this.image('UI-ICONS',12,x+40,579,62,65,true);this.text('通用'+qualityNames[q],x+73,701,26,132,36);}else{this.portrait(reward.key,x+10,568,125,110);this.text(heroDef(reward.key).name,x+73,701,26,132,36);}
      this.text('×'+reward.count,x+73,747,32,130,40);
    });
    if(!rewards.length)this.text(won?'正在保存奖励…':'未完整守住前5波，本局没有碎片',470,650,33,735,100);
    this.text(`本局共${rewards.reduce((n,x)=>n+x.count,0)}片${receipt?` / 上限${receipt.cap}`:''}${!won&&receipt?.checkpoint?' · 已完整守住'+receipt.checkpoint+'波':''}`,470,807,29,760);
    const focus=receipt?.focus||p.incentive?.focusByQuality[p.incentive.primary]||'RH02';
    this.portrait(focus,118,861,145,154);this.text(heroDef(focus).name+' · 培养进度',581,883,34,540);
    this.text(receipt?`${receipt.before} → ${receipt.after}片 · 当前可用${progressPieces(p,focus)}片`:`可用${progressPieces(p,focus)} / 10`,581,940,29,570);
    this.text(`永久Lv.${p.levels[focus]} · ${milestoneName(p.levels[focus])}`,581,995,27,570);
    if(receipt?.newHeroes.length){const id=receipt.newHeroes[0];this.text('新英雄：'+receipt.newHeroes.map(x=>heroDef(x).name).join('、'),470,1070,28,760);this.button('设为队长试阵',295,1105,350,89,()=>this.session.setCaptain(id),true);}
    else if(receipt?.newGoals.length){const names=receipt.newGoals.slice(0,2).map(id=>GOALS.find(g=>g.id===id)!.name).join(' · '),more=receipt.newGoals.length-2;this.text('新纪录：'+names+(more>0?`\n另${more}项已收入成长实绩`:''),470,1115,28,710,105);}
    const exit=()=>{if(this.session.camp()){this.page='camp';this.selectedStage=Math.min(20,p.clearedStage+1);this.clearEffects();}};
    this.button('返回营地',105,1360,333,116,exit,true);
    const ready=upgradeCost(p,focus).available;
    this.button(ready?'升级英雄':won?'继续挑战':'再次挑战',482,1360,350,116,()=>{
      if(ready){if(this.session.camp()){this.selectedHero=focus;this.page='detail';this.clearEffects();}}
      else {this.nextExpedition=receipt?.expedition?{...receipt.expedition,tier:won?Math.min(8,receipt.expedition.tier+1):receipt.expedition.tier}:undefined;this.selectedStage=this.nextExpedition?20:won?Math.min(20,r.stage+1):r.stage;void this.enterBattle(false);}
    });
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
    } else if (this.modal === 'end-run') {
      this.popup('结束本局');
      this.text('确认放弃当前对局？\n本局碎片与战斗储备不会领取。\n已获得的永久养成资源会保留。', 470, 790, 36, 690, 228);
      this.button('取消', 112, 1099, 342, 110, () => this.closeModal(), true);
      this.button('确认结束', 486, 1099, 342, 110, () => this.session.endRun());
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
    return JSON.stringify([this.session.inBattle, this.page, this.modal, this.selectedHero, this.selectedStage, this.selectedCard, this.session.error, this.assetError, this.session.data.profile,this.planQuality,this.goalPage,this.expeditionTier,this.expeditionContract,
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
  private placeActor(uid: number, id: string, x: number, feet: number, height: number, action: string, time: number, hp = 1, shield = 0, trait: string | null = null, protectedHero = false, buffedHero = false): void {
    const view = this.actor(uid), atlas = action === 'move' && this.assets.info('WALK-' + id) ? 'WALK-' + id : id;
    const index = this.assets.pose(atlas, action, time), a = this.assets.info(atlas), f = a?.frames[index]; if (!f) return;
    view.atlas = atlas; view.frame = index;
    const hit = this.reactions.get(uid), age = hit ? now(this.session.data.run!) - hit.at : 1;
    const recoil = hit && age < .18 ? Math.sin(Math.PI * Math.max(0, age) / .18) * (hit.heavy ? .21 : .1) : 0;
    view.node.setScale(1 + recoil, 1 - recoil * .65, 1); view.sprite.color = toColor(age < .065 ? '#ffe1ad' : '#ffffff');
    view.node.setPosition(x - W / 2, H / 2 - feet); const t = view.node.getComponent(UITransform)!;
    t.setContentSize((f.widthRatio || 1) * height, (f.heightRatio || 1) * height); t.setAnchorPoint(f.anchor[0], f.anchor[1]); view.sprite.spriteFrame = this.assets.frame(atlas, index); view.sprite.grayscale = hp <= 0;
    const bw = id.startsWith('RM') ? 55 : id.startsWith('RH') ? 88 : 130;
    view.bar.node.setPosition(x - W / 2, H / 2 - feet + height + 10); view.bar.clear();
    view.bar.fillColor = toColor('#243c35'); view.bar.roundRect(-bw / 2, 0, bw, 12, 6); view.bar.fill();
    if (hp > 0) { view.bar.fillColor = toColor(id.startsWith('R') && !id.startsWith('RH') ? '#fb7c68' : '#45e85e'); view.bar.roundRect(-bw / 2 + 2, 2, Math.max(1, (bw - 4) * Math.min(1, hp)), 8, 4); view.bar.fill(); }
    view.shield.node.setPosition(x - W / 2, H / 2 - feet + height + 26); view.shield.clear();
    if (shield > 0) { view.shield.fillColor = toColor('#6de4f1'); view.shield.roundRect(-bw / 2, 0, bw * Math.min(1, shield), 5, 2); view.shield.fill(); }
    view.trait.node.active = !!trait || protectedHero || buffedHero; view.trait.node.setPosition(x - W / 2 + height * .29, H / 2 - feet + height * .35);
    view.trait.node.getComponent(UITransform)!.setContentSize(height * .68, height * .68);
    view.trait.spriteFrame = protectedHero ? this.assets.frame('FX-RH06', 4) : trait ? this.assets.frame('FX-TRAIT-LOCAL', Number(trait.slice(1)) - 1) : buffedHero ? this.assets.frame('FX-RH03', 6) : null;
  }
  private updateWorld(r: Run): void {
    const living = new Set<number>(), time = now(r);
    r.slots.forEach(h => {
      if (!h) return; living.add(h.uid); const action = this.actionUntil.get(h.uid);
      this.placeActor(h.uid, h.id, h.x * W, 1427, (this.assets.info(h.id)?.displayHeight || 105) * W / 720,
        h.hp <= 0 ? 'defeated' : h.skillWindup ? 'cast' : action && action.until > time ? action.action : 'idle', h.hp <= 0 ? time - (h.deathTick || 0) / 60 : action && action.until > time ? time - action.from : time, h.hp / h.maxHp, h.shield / h.maxHp, h.weakUntil > time ? 'T07' : null, h.protectionUntil > time, h.buffUntil > time);
      if (h.skillWindup) this.actor(h.uid).node.setScale(1.06, .94, 1);
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
      this.placeActor(e.uid, e.id, battleX(e.x), battleY(e.y), height,
        action, time - (actor.actionFrom || 0), e.hp / e.maxHp, e.shield / e.maxHp, e.trait);
    }
    for (const s of r.summons) {
      if (s.hp <= 0) continue;
      living.add(s.uid); const x = battleX(s.x), feet = battleY(s.y), a = this.actionUntil.get(s.uid);
      const action = a && a.until > time ? a.action : s.fortressUntil > time ? 'ultimate' : 'idle';
      this.placeActor(s.uid, s.id, x, feet, 105, action, a && a.until > time ? time - a.from : time, s.hp / s.maxHp);
      const actor = this.actor(s.uid); actor.action = action;
      if (s.taunt || s.slow || s.fortressUntil > time) {
        if (!actor.aura) actor.aura = this.nodeAt('SummonArea', this.world, x, feet, 100, 100).addComponent(Graphics);
        const g = actor.aura; g.node.setPosition(x - W / 2, H / 2 - feet); g.clear();
        g.lineWidth = 4; const c = toColor(HERO_COLORS[s.id === 'SUM-WOOD' ? 'RH05' : 'RH06']); c.a = 90 + Math.round(Math.sin(time * 4) * 25); g.strokeColor = c;
        const radius = battleRadius(s.radius); g.ellipse(0, 0, radius.x, radius.y); g.stroke();
      } else actor.aura?.clear();
      if (s.id === 'SUM-BURST') {
        actor.bar.node.active = false;
        if (!actor.ammo) {
          actor.ammo = this.text(`余弹 ${s.shots}`, x, feet - 125, 28, 160, 42, 'hud', this.world);
          actor.ammo.overflow = Label.Overflow.NONE;
        }
        actor.ammo.string = `余弹 ${Math.max(0, s.shots)}`; actor.ammo.node.setPosition(x - W / 2, H / 2 - feet + 125);
      }
    }
    for (const [uid, a] of this.actors) if (!living.has(uid)) { a.node.destroy(); a.bar.node.destroy(); a.trait.node.destroy(); a.shield.node.destroy(); a.ammo?.node.destroy(); a.aura?.node.destroy(); this.actors.delete(uid); this.actionUntil.delete(uid); this.reactions.delete(uid); }
    const missiles = new Set<number>();
    for (const p of r.projectiles) {
      missiles.add(p.uid); let node = this.missiles.get(p.uid);
      if (!node) { const friendly = p.side === 'hero' ? friendlyProjectileVisual(p.effect) : null;
        if (p.side === 'hero' && !friendly) continue;
        const pack = friendly ? friendly.pack : p.effect.startsWith('RM') ? 'FX-ENEMY-MINION-ATTACK' : 'FX-ENEMY-BOSS-ATTACK';
        const frame = friendly ? friendly.frame : Math.max(0, ['RM01', 'RM02', 'RM04', 'RM05'].indexOf(p.effect)) * 3;
        const size = friendly ? friendly.size : 34;
        node = this.image(pack, frame, 0, 0, size, size, true, this.effects); this.missiles.set(p.uid, node); }
      let x = battleX(p.x), y = battleY(p.y);
      const target = p.side === 'hero' ? r.enemies.find(e => e.uid === p.target) : r.slots.find(h => h?.uid === p.target);
      if (p.launch && target) {
        const distance = (a:{x:number;y:number},b:{x:number;y:number}) => Math.hypot((a.x-b.x)*BATTLE_MODEL.width,(a.y-b.y)*BATTLE_MODEL.height);
        const fraction = Math.min(1, distance(p,target) / Math.max(1,distance(p.launch,target)));
        x += (p.launch.x * W - battleX(p.launch.x)) * fraction;
        y += (1360 - battleY(p.launch.y)) * fraction;
      }
      node.setPosition(x - W / 2, H / 2 - y);
      if (p.side === 'hero' && target) {
        const family = attackFamily(p.effect)!, angle = Math.atan2(-(battleY(target.y) - y), battleX(target.x) - x) * 180 / Math.PI - 90;
        node.angle = family === 'RH03' ? Math.sin(time * 12) * 12 : angle;
        if (!node.children.length) {
          const tail = this.image('FX-' + family, 1, W / 2 - 20, H / 2 - 12, 40, p.chain ? 130 : 70, false, node);
          tail.addComponent(UIOpacity).opacity = p.chain ? 155 : 95; tail.setSiblingIndex(0);
        }
      }
    }
    for (const [uid, node] of this.missiles) if (!missiles.has(uid)) { node.destroy(); this.missiles.delete(uid); }
    const wave = this.hud.get('wave'), energy = this.hud.get('energy');
    if (wave) wave.string = r.wave ? `第 ${r.wave} / 15 波` : '准备 / 15 波'; if (energy) energy.string = `能量 ${r.energy} / 100`;
    if (energy) { const pulse = Math.max(0, this.energyPulse - time) / .22; energy.node.setScale(1 + pulse * .09, 1 + pulse * .09, 1); energy.color = toColor(pulse ? '#ffe175' : '#fff8df'); }
  }
  private pooledFx(key: string, create: () => Node): Node {
    const node = this.fxPool.get(key)?.pop() || create(); node.active = true; node.angle = 0; node.setScale(1, 1, 1);
    const opacity = node.getComponent(UIOpacity) || node.addComponent(UIOpacity); opacity.opacity = 255; return node;
  }
  private releaseFx(f: FxView): void {
    if (!f.poolKey) { f.node.destroy(); return; }
    const pool = this.fxPool.get(f.poolKey) || [];
    const total = Array.from(this.fxPool.values()).reduce((n, list) => n + list.length, 0);
    if (pool.length >= 8 || total >= 48) { f.node.destroy(); return; }
    f.node.active = false; pool.push(f.node); this.fxPool.set(f.poolKey, pool);
  }
  private damageNumber(e: BattleEvent): void {
    if (!e.amount) return;
    const key = `${e.type}:${e.source}:${Math.floor(e.tick / 8)}:${Math.floor(e.x * 5)}:${Math.floor(e.y * 6)}`;
    const previous = this.fx.find(f => f.numberKey === key);
    if (previous) { previous.total = (previous.total || 0) + e.amount; previous.label!.string = (e.type === 'heal' ? '+' : '') + Math.ceil(previous.total); return; }
    if (this.fx.filter(f => f.floating).length >= 18) return;
    const node = this.pooledFx('damage-number', () => this.text('0', 0, 0, 27, 140, 50, 'hud', this.feedback).node), label = node.getComponent(Label)!;
    label.overflow = Label.Overflow.NONE;
    node.setPosition(battleX(e.x) - W / 2, H / 2 - battleY(e.y) + 50);
    label.string = (e.type === 'heal' ? '+' : '') + Math.ceil(e.amount); label.color = toColor(e.type === 'heal' ? '#94ff98' : e.type === 'ally-hit' ? '#ff9e7a' : '#fff4ae');
    this.fx.push({ node, age: 0, duration: .55, size: 40, tick: e.tick, floating: true, poolKey: 'damage-number', numberKey: key, total: e.amount, label });
  }
  private energyOrb(e: BattleEvent): void {
    if (!e.amount) return;
    const merged = this.fx.find(f => f.kind === 'energy' && f.age < .12);
    if (merged) { merged.total = (merged.total || 0) + e.amount; return; }
    if (this.fx.filter(f => f.kind === 'energy').length >= 6) return;
    const node = this.pooledFx('energy', () => {
      const n = this.nodeAt('EnergyOrb', this.feedback, W / 2, H / 2, 36, 36), g = n.addComponent(Graphics);
      g.fillColor = toColor('#ffb32f'); g.circle(0, 0, 11); g.fill(); g.fillColor = toColor('#fff4a6'); g.circle(-2, 2, 6); g.fill(); return n;
    });
    const x = battleX(e.x), y = battleY(e.y);
    const f: FxView = { node, age: 0, duration: .65, size: 30, tick: e.tick, poolKey: 'energy', kind: 'energy', total: e.amount };
    f.animate = t => {
      const travel = Math.max(0, (t - .12) / .88), ease = travel * travel;
      node.setPosition(x + (659 - x) * ease + Math.sin(travel * Math.PI) * 38 - W / 2, H / 2 - (y + (178 - y) * ease));
      const size = Math.min(1.8, 1 + Math.log2(Math.max(1, (f.total || 9) / 9)) * .2); node.setScale(size, size, 1);
      node.getComponent(UIOpacity)!.opacity = 255;
      if (t >= 1) { this.energyPulse = now(this.session.data.run!) + .22; this.audio?.emit('energy_gain'); }
    };
    this.fx.push(f);
  }
  /** All parts reuse the approved atlases; the event radius is the actual circular hit footprint. */
  private skillChoreography(e: BattleEvent): void {
    const windup = e.type === 'hero-skill-windup', family = attackFamily(e.source) || 'RH01', chef = family === 'RH02';
    const second = e.source.endsWith('S2'), pack = 'FX-' + family;
    const key = `skill:${e.source}:${windup ? 'windup' : 'impact'}`, radius = (e.radius || .15) * BATTLE_VIEW.width;
    const x = battleX(e.x), y = battleY(e.y);
    const count = windup ? 2 : chef ? 9 : family === 'RH01' ? 4 : 6;
    const root = this.pooledFx(key, () => {
      const node = this.nodeAt(key, windup ? this.effects : this.arenaEffects, W / 2, H / 2, W, H);
      for (let i = 0; i < count; i++) this.image(pack, 0, W / 2 - 50, H / 2 - 50, 100, 100, false, node);
      return node;
    });
    root.setPosition(x - W / 2, H / 2 - y - (windup ? 0 : this.arenaEffects.position.y));
    root.setScale(1, windup ? 1 : BATTLE_EFFECT_SCALE_Y, 1);
    const parts = root.children, h = this.session.data.run!.slots.find(h => h?.uid === e.target);
    const fromX = h ? h.x * W - x : 0, fromY = h ? y - 1360 : 130;
    const pose = (i: number, frame: number, px: number, py: number, width: number, height = width, angle = 0) => {
      const n = parts[i], sprite = n.getComponent(Sprite)!; sprite.spriteFrame = this.assets.frame(pack, frame);
      sprite.color = new Color(255, 255, 255, chef && !windup && i === 1 ? 165 : 255);
      // Airborne cues keep their proportions, but their full rotated bounds stay below the HUD.
      const extent = (Math.abs(Math.sin(angle * Math.PI / 180)) * width + Math.abs(Math.cos(angle * Math.PI / 180)) * height) / 2;
      n.setPosition(px, windup ? Math.min(py, y - BATTLE_EFFECT_TOP - extent) : py); n.getComponent(UITransform)!.setContentSize(width, height); n.angle = angle;
    };
    const f: FxView = { node: root, age: 0, duration: windup ? e.amount || .3 : .9, size: radius * 2, tick: e.tick, poolKey: key, kind: windup ? 'windup' : 'impact', source: e.source, readable: !windup };
    f.animate = t => {
      root.getComponent(UIOpacity)!.opacity = 255 * (windup ? 1 : Math.min(1, (1 - t) * 2.8));
      if (windup) {
        const ease = 1 - (1 - t) * (1 - t), arc = Math.sin(t * Math.PI) * (chef ? 150 : 75);
        if (chef) {
          pose(0, second ? 3 : 6, fromX * (1 - ease), fromY * (1 - ease) + arc, second ? 115 : 90, second ? 115 : 120, -20 + t * 40);
          pose(1, 1, fromX * (1 - ease), fromY * (1 - ease) + arc - 30, 24, 65 + t * 30, -20 + t * 40);
        } else if (second) {
          pose(0, 6, fromX * (1 - ease), fromY * (1 - ease) + arc, 98 + t * 22, 85 + t * 35, 55 - t * 160);
          pose(1, 1, fromX * (1 - ease), fromY * (1 - ease) + arc - 42, 27, 45 + t * 40, 55 - t * 160);
        } else {
          pose(0, 6, 0, 150 * (1 - t * t), 120, 145, 180);
          pose(1, 1, 0, 150 * (1 - t * t) + 85, 35, 50 + t * 65);
        }
      } else if (chef) {
        pose(0, second ? 3 : 7, 0, 0, radius * (second ? .85 : 1.25) * (1 - t * .3));
        pose(1, 5, 0, 0, radius * 2 * Math.min(1, .3 + t * 2.8));
        for (let i = 2; i < 8; i++) {
          const a = (i - 2) * Math.PI / 3 + .2, d = radius * (.15 + .73 * Math.sin(t * Math.PI / 2));
          pose(i, i % 2 ? 0 : 8, Math.cos(a) * d, Math.sin(a) * d, radius * .31 * (1 - t * .4), radius * .31 * (1 - t * .4), t * (i % 2 ? 180 : -130));
        }
        pose(8, 2, 0, 0, radius * 1.4 * (1 - t * .45));
      } else if (family === 'RH04') {
        pose(0, second ? 0 : 6, 0, (1 - Math.min(1, t * 5)) * 100, radius * (second ? 1 : .85), radius * (second ? 1 : 1.3), -t * 20);
        pose(1, second ? 2 : 4, 0, 0, radius * 2 * (.7 + .3 * t), radius * (second ? 2 : 1.1));
        pose(2, 8, 0, 15, radius * 1.4 * (1 - t * .3));
        for (let i = 3; i < count; i++) { const a = i * Math.PI * 2 / 3; pose(i, 7, Math.cos(a) * radius * t * .7, Math.sin(a) * radius * t * .7, radius * .35); }
      } else if (family === 'RH05' || family === 'RH06') {
        const wood = family === 'RH05';
        pose(0, wood ? second ? 0 : 6 : 4, 0, 80 * Math.max(0, 1 - t * 5), radius * .9, radius * 1.1, wood ? -15 + t * 20 : 0);
        pose(1, wood ? second ? 3 : 5 : second ? 3 : 7, 0, 0, radius * 2 * (.5 + .5 * Math.min(1,t*4)), radius * 2 * (.5 + .5 * Math.min(1,t*4)), wood && !second ? t*90 : 0);
        for (let i = 2; i < count; i++) { const a = i * Math.PI / 2; pose(i, wood ? second ? 8 : 7 : 8, Math.cos(a) * radius * t * .7, Math.sin(a) * radius * t * .7, radius * .38); }
      } else {
        const diameter = radius * 2;
        pose(0, second ? 3 : 7, 0, 0, diameter * (.65 + .35 * Math.min(1, t * 4)), diameter * (.65 + .35 * Math.min(1, t * 4)), second ? -60 + t * 300 : 0);
        pose(1, second ? 4 : 6, 0, 0, diameter * (second ? .6 : .48) * (1 - t * .2), diameter * .55, second ? t * 180 : 180);
        for (let i = 2; i < count; i++) pose(i, 8, (i === 2 ? -1 : 1) * radius * .6 * t, -radius * .3, radius * .42 * (1 + t), radius * .3 * (1 + t));
      }
    };
    f.animate(0); this.fx.push(f);
  }
  private skillCue(e: BattleEvent): void {
    const r = this.session.data.run!, id = e.source.slice(0, 4), h = r.slots.find(h => h?.id === id); if (!h) return;
    const key = 'cue:' + id, old = this.fx.findIndex(f => f.poolKey === key);
    if (old >= 0) this.releaseFx(this.fx.splice(old, 1)[0]);
    const slot = Number(e.source.slice(-1)), title = `${skillDef(id, slot).name.replace('终极·', '')} Lv.${h.skills[slot - 1]}`;
    const root = this.pooledFx(key, () => {
      const n = this.nodeAt(key, this.feedback, h.x * W, 1280, 190, 190);
      const g = n.addComponent(Graphics); g.lineWidth = 6; g.strokeColor = toColor(HERO_COLORS[id]); g.circle(0, -92, 49); g.stroke();
      if(h.level>=10){g.fillColor=toColor('#ffdd66');g.moveTo(-22,-62);g.lineTo(-25,-44);g.lineTo(-8,-53);g.lineTo(0,-36);g.lineTo(9,-53);g.lineTo(25,-44);g.lineTo(22,-62);g.close();g.fill();}
      this.text(title, W / 2, H / 2, 25, 182, 40, 'hud', n); return n;
    });
    root.setPosition(h.x * W - W / 2, H / 2 - 1270); root.children[0].getComponent(Label)!.string = title;
    const f: FxView = { node: root, age: 0, duration: .95, tick: e.tick, size: 190, poolKey: key, kind: 'cue', source: e.source, readable: true };
    f.animate = t => { root.setPosition(h.x * W - W / 2, H / 2 - 1270 + Math.sin(t * Math.PI) * 10); root.getComponent(UIOpacity)!.opacity = 255 * Math.min(1,(1-t)*3); };
    this.fx.push(f);
  }
  private supportPulse(e: BattleEvent): void {
    const h = this.session.data.run!.slots.find(h => h?.uid === e.target); if (!h || e.type === 'heal' && !e.amount) return;
    const heal = e.type === 'heal', key = heal ? 'heal-pulse' : 'buff-pulse';
    const root = this.pooledFx(key, () => { const n=this.nodeAt(key,this.feedback,W/2,H/2,180,180);
      for(let i=0;i<3;i++)this.image('FX-RH03',0,W/2-50,H/2-50,100,100,false,n); return n; });
    const f:FxView={node:root,age:0,duration:.95,tick:e.tick,size:180,poolKey:key,kind:key,source:e.source,readable:true};
    f.animate=t=>{
      root.setPosition(h.x*W-W/2,H/2-1370);
      root.getComponent(UIOpacity)!.opacity=255*Math.min(1,(1-t)*3);
      root.children.forEach((n,i)=>{const size=i===0?135+45*t:50;
        n.getComponent(Sprite)!.spriteFrame=this.assets.frame('FX-RH03',i===0?heal?3:6:i===1?heal?4:7:8);
        n.getComponent(UITransform)!.setContentSize(size,size);n.setPosition(i===2?35*Math.sin(t*6):0,i===0?0:45+t*60+i*12);n.angle=i===0?t*45:0;
      });
    }; f.animate(0);this.fx.push(f);
  }
  private burstReward(e: BattleEvent): void {
    if ((e.amount || 0) < 3 || this.fx.filter(f=>f.kind==='burst-reward').length>=3) return;
    this.kick = .13;
    const n = this.pooledFx('burst-reward',()=>this.text('连破 3',0,0,35,240,54,'hud',this.feedback).node);
    n.getComponent(Label)!.string = `连破 ${e.amount}`; n.getComponent(Label)!.overflow=Label.Overflow.NONE; n.getComponent(Label)!.color=toColor('#ffe37b');
    const x=battleX(e.x),y=Math.max(300,battleY(e.y)-80);
    const f:FxView={node:n,age:0,duration:.95,tick:e.tick,size:54,poolKey:'burst-reward',kind:'burst-reward',source:e.source,readable:true};
    f.animate=t=>{n.setPosition(x-W/2,H/2-y+t*32);n.setScale(1+Math.sin(Math.min(1,t*4)*Math.PI)*.18,1+Math.sin(Math.min(1,t*4)*Math.PI)*.18,1);n.getComponent(UIOpacity)!.opacity=255*Math.min(1,(1-t)*3);};
    this.fx.push(f);
  }
  private chainLink(e:BattleEvent):void {
    if(!e.from)return;
    const n=this.pooledFx('chain-link',()=>{const node=this.nodeAt('ChainLink',this.arenaEffects,W/2,H/2,W,H);node.addComponent(Graphics);return node;});
    n.setPosition(0,-this.arenaEffects.position.y);const g=n.getComponent(Graphics)!;g.clear();
    const x1=battleX(e.from.x)-W/2,y1=H/2-battleY(e.from.y),x2=battleX(e.x)-W/2,y2=H/2-battleY(e.y);
    g.lineWidth=9;g.strokeColor=toColor('#d675ee');g.moveTo(x1,y1);g.quadraticCurveTo((x1+x2)/2,(y1+y2)/2+18,x2,y2);g.stroke();
    g.lineWidth=3;g.strokeColor=toColor('#fff2ff');g.moveTo(x1,y1);g.quadraticCurveTo((x1+x2)/2,(y1+y2)/2+18,x2,y2);g.stroke();
    this.fx.push({node:n,age:0,duration:.4,tick:e.tick,size:0,poolKey:'chain-link',kind:'chain-link',source:e.source,readable:true,
      animate:t=>{n.getComponent(UIOpacity)!.opacity=255*(1-t);} });
  }
  /** Dedicated component choreography. Collision geometry is supplied by battle events. */
  private expansionEffect(e: BattleEvent): void {
    const id=e.source.slice(0,4),pack='FX-'+id,key='expansion:'+e.source+':'+e.type;
    // Draw in the model's uniform plane, then project the whole footprint once.
    const point=(x:number,y:number)=>({x:(x-.5)*BATTLE_VIEW.width,y:(.5-y)*BATTLE_MODEL.height*BATTLE_VIEW.width/BATTLE_MODEL.width});
    const at=point(e.x,e.y),origin=e.from?point(e.from.x,e.from.y):at;
    const shield=e.type==='hero-shield'||e.type==='hero-buff',warning=e.type==='skill-warning',windup=e.type==='hero-skill-windup';
    const root=this.pooledFx(key,()=>{const n=this.nodeAt(key,shield?this.effects:this.arenaEffects,W/2,H/2,W,H);n.addComponent(Graphics);for(let i=0;i<5;i++)this.image(pack,0,W/2-40,H/2-40,80,80,false,n);return n;});
    root.setPosition(shield?0:battleX(.5)-W/2,shield?0:H/2-battleY(.5)-this.arenaEffects.position.y);
    root.setScale(1,shield?1:BATTLE_EFFECT_SCALE_Y,1);
    const radius=(e.radius||.15)*BATTLE_VIEW.width,g=root.getComponent(Graphics)!,parts=root.children;
    const color=HERO_COLORS[id],f:FxView={node:root,age:0,duration:warning?Math.max(.15,e.amount||.2):windup?.22:.9,tick:e.tick,size:radius*2,poolKey:key,kind:warning?'warning':windup?'windup':'impact',source:e.source,readable:!warning&&!windup};
    const pose=(i:number,frame:number,x:number,y:number,w:number,h=w,angle=0)=>{const n=parts[i];n.active=true;n.getComponent(Sprite)!.spriteFrame=this.assets.frame(pack,frame);n.setPosition(x,y);n.getComponent(UITransform)!.setContentSize(w,h);n.angle=angle;};
    f.animate=t=>{
      g.clear();parts.forEach(n=>n.active=false);root.getComponent(UIOpacity)!.opacity=255*Math.min(1,(1-t)*3);
      g.strokeColor=toColor(color);g.lineWidth=4;
      if(shield){const h=this.session.data.run?.slots.find(h=>h?.uid===e.target);if(!h)return;const x=h.x*W-W/2,y=H/2-1335;pose(0,e.type==='hero-shield'?5:7,x,y,90*(.8+.2*Math.sin(t*Math.PI)));g.circle(x,y-10,58+14*t);g.stroke();return;}
      if(windup){pose(0,3,at.x,at.y,72+40*t,72+40*t,-15+30*t);return;}
      if(warning){g.circle(at.x,at.y,radius);g.stroke();g.lineWidth=2;g.moveTo(at.x-12,at.y);g.lineTo(at.x+12,at.y);g.moveTo(at.x,at.y-12);g.lineTo(at.x,at.y+12);g.stroke();return;}
      if(e.type==='beam-hit'){
        const dx=at.x-origin.x,dy=at.y-origin.y,len=Math.hypot(dx,dy),angle=Math.atan2(-dx,dy)*180/Math.PI;
        // Outline makes the true beam width readable against the sandy arena.
        g.lineWidth=radius*2;g.moveTo(origin.x,origin.y);g.lineTo(at.x,at.y);g.stroke();
        pose(0,4,(at.x+origin.x)/2,(at.y+origin.y)/2,radius*1.65,len,angle);
        pose(1,2,at.x,at.y,85*(1-t*.3));return;
      }
      if(e.type==='frost-cone'){
        const a=Math.atan2(at.y-origin.y,at.x-origin.x),half=(e.amount||25)*Math.PI/180;
        g.fillColor=new Color(65,162,232,35);g.moveTo(origin.x,origin.y);for(let i=0;i<=16;i++){const k=a-half+2*half*i/16;g.lineTo(origin.x+Math.cos(k)*radius,origin.y+Math.sin(k)*radius);}g.close();g.fill();g.stroke();
        for(let i=0;i<5;i++){const k=a-half+half*2*i/4,d=radius*(.36+.44*Math.min(1,t*3));pose(i,i===2?4:7,origin.x+Math.cos(k)*d,origin.y+Math.sin(k)*d,80+50*t,120+60*t,(k-Math.PI/2)*180/Math.PI);}return;
      }
      const second=e.source.endsWith('S2'),grow=.65+.35*Math.min(1,t*4);
      g.lineWidth=3;g.circle(at.x,at.y,radius*grow);g.stroke();
      pose(0,id==='RH09'?second?5:6:second?4:6,at.x,at.y,radius*2*grow,radius*2*grow,id==='RH07'?t*180:id==='RH08'?-t*80:t*20);
      for(let i=1;i<5;i++){const a=i*Math.PI/2+t*.6,d=radius*(.2+.62*t);pose(i,t>.65?8:7,at.x+Math.cos(a)*d,at.y+Math.sin(a)*d,radius*.45*(1-t*.4),radius*.45*(1-t*.4),t*80);}
    };
    f.animate(0);this.fx.push(f);
  }
  private effect(e: BattleEvent): void {
    const r = this.session.data.run!;
    if(e.type==='checkpoint'){this.pendingReserve=Math.max(this.pendingReserve,Number(e.source));return;}
    if(e.type==='perk-root'){this.skillChoreography({...e,type:'hero-skill'});return;}
    if(e.type==='skill-pulse'&&e.source==='RH02-S2'){this.skillChoreography({...e,type:'hero-skill'});return;}
    if (e.type === 'skill-result') { this.burstReward(e); return; }
    if (e.type === 'skill-upgraded') { this.skillCue(e); return; }
    if (e.type === 'hero-skill-windup' || e.type === 'hero-skill') {
      if (e.type === 'hero-skill' && !/^RH0[12]-S[23]$/.test(e.source) || e.type === 'hero-skill-windup') this.skillCue(e);
      if (e.type === 'hero-skill') this.fx = this.fx.filter(f => {if (f.kind === 'windup' && f.source === e.source) {this.releaseFx(f);return false;}return true;});
      const h=r.slots.find(h=>h?.id===e.source.slice(0,4));if(h)this.actionUntil.set(h.uid,{action:'cast',from:now(r),until:now(r)+.5});
      if(e.type==='hero-skill'&&e.source.startsWith('RH03'))return;
      if(e.type==='hero-skill'&&e.source==='RH04-S2'&&r.tuning?.feel)return;
      if(Number(e.source.slice(2,4))>=7){if(e.type==='hero-skill-windup')this.expansionEffect(e);return;}
    }
    if(['beam-hit','frost-cone','skill-pulse','skill-warning','hero-shield'].includes(e.type)||e.type==='area-impact'&&e.source==='RH09-S2'||e.type==='hero-buff'&&e.source.startsWith('RH10')){this.expansionEffect(e);return;}
    if(e.type==='hero-buff'){this.supportPulse(e);return;}
    if(e.type==='heal')this.supportPulse(e);
    if(e.type==='chain-link'){this.chainLink(e);return;}
    if(e.type==='chain-hit'){this.skillChoreography({...e,radius:.065});return;}
    if (['enemy-hit', 'ally-hit'].includes(e.type) && e.target !== undefined) this.reactions.set(e.target, { at: now(r), heavy: /-S[23]$/.test(e.source) || e.source === 'SUM-BURST' });
    if (e.type === 'enemy-death') this.energyOrb(e);
    if (e.type === 'hero-skill-windup' || e.type === 'hero-skill' || e.type === 'area-impact' && e.source === 'SUM-BURST') {
      if (this.fx.length >= 80) { const old = this.fx.findIndex(f => f.floating || f.kind === 'minor'); if (old >= 0) this.releaseFx(this.fx.splice(old, 1)[0]); }
      this.skillChoreography(e);
      if (e.type === 'hero-skill-windup' && e.target !== undefined) this.actionUntil.set(e.target, { action: 'cast', until: now(r) + (e.amount || .3), from: now(r) });
      return;
    }
    if (e.type === 'summon' || e.type === 'summon-attack' || e.type === 'ally-hit' && r.summons.some(s => s.uid === e.target && s.hp > 0)) {
      const action = e.type === 'summon' ? 'spawn' : e.type === 'summon-attack' ? 'action' : 'hit';
      if (e.target !== undefined) this.actionUntil.set(e.target, { action, until: now(r) + (action === 'hit' ? .24 : .4), from: now(r) });
    }
    if (e.type === 'summon-end' || e.type === 'summon-spent' || e.type === 'ally-death' && e.source.startsWith('SUM-')) {
      this.summonExit(e); return;
    }
    if (e.type === 'enemy-hit' && e.source === 'RH01-S1' && this.fx.length < 64) this.punch(e);
    if (['enemy-hit', 'ally-hit', 'heal'].includes(e.type)) this.damageNumber(e);
    if (e.type === 'hero-skill' || e.type === 'hero-attack' || e.type === 'revive') {
      const h = r.slots.find(h => h?.id === e.source.slice(0, 4)); if (h) this.actionUntil.set(h.uid, { action: e.type === 'revive' ? 'revive' : e.type === 'hero-skill' ? 'cast' : 'attack', until: now(r) + .5, from: now(r) });
    }
    let pack = '', frame = 0, size = 110, duration = .45;
    if (e.type === 'hero-skill') { pack = 'FX-' + e.source.slice(0, 4); frame = e.source.endsWith('S2') ? 3 : 6; size = Math.max(120, (e.radius || .16) * BATTLE_VIEW.width * 2); duration = .7; }
    if (e.type === 'enemy-hit') { const visual = friendlyImpactVisual(e.source); if (visual) { pack = visual.pack; frame = visual.frame; size = visual.size; duration = visual.duration; } }
    if (e.type === 'enemy-attack') { pack = e.source.startsWith('RM') ? 'FX-ENEMY-MINION-ATTACK' : 'FX-ENEMY-BOSS-ATTACK'; frame = Math.max(0, (e.source.startsWith('RM') ? ['RM01', 'RM02', 'RM04', 'RM05'] : ['RS01', 'RS02', 'RL01', 'RL02']).indexOf(e.source)) * 3 + 2; }
    if (e.type === 'enemy-death') { pack = e.source; frame = 7; size = (this.assets.info(e.source)?.displayHeight || 60) * W / 720; duration = .4; }
    if (e.type === 'global-cast') { pack = 'FX-GLOBAL-' + e.source; frame = 2; size = e.source === 'gold' ? 1050 : (e.radius || .3) * BATTLE_VIEW.width * 2; duration = .8; }
    if (e.type === 'boss-warning' || e.type === 'boss-skill') { pack = 'FX-BOSS-SKILLS'; frame = Math.max(0, ['RS01', 'RS02', 'RL01', 'RL02'].indexOf(e.source)) * 3 + (e.type === 'boss-warning' ? 0 : 2); size = (e.radius || .22) * BATTLE_VIEW.width * 2; duration = e.type === 'boss-warning' ? 1 : .5; }
    if (e.type === 'boss-command') { pack = 'FX-BOSS-COMMAND'; frame = 3; size = 340; duration = 1; }
    if (e.type === 'revive') { pack = 'FX-RH03'; frame = 4; size = 170; duration = .8; }
    if (!pack || this.fx.length >= 52 && e.type === 'enemy-hit') return;
    if (this.fx.length >= 80) { const old = this.fx.findIndex(f => f.kind === 'minor' || f.floating); if (old < 0) return; this.releaseFx(this.fx.splice(old, 1)[0]); }
    const x = battleX(e.x), y = battleY(e.y), clipped = e.type !== 'revive';
    const poolKey = clipped ? 'arena-sprite' : 'sprite', offset = clipped ? this.arenaEffects.position.y : 0;
    const verticalScale = ['global-cast','boss-warning','boss-skill','boss-command'].includes(e.type) ? BATTLE_EFFECT_SCALE_Y : 1;
    const n = this.pooledFx(poolKey, () => this.image(pack, frame, 0, 0, size, size, true, clipped ? this.arenaEffects : this.effects));
    const ratio = this.assets.info(pack)!.frames[frame].ratio;
    n.setPosition(x - W / 2, H / 2 - y - offset); n.setScale(1, verticalScale, 1); n.getComponent(Sprite)!.spriteFrame = this.assets.frame(pack, frame);
    n.getComponent(UITransform)!.setContentSize(ratio > 1 ? size : size * ratio, ratio > 1 ? size / ratio : size);
    const f: FxView = { node: n, age: 0, duration, size, tick: e.tick, poolKey, verticalScale, kind: e.type === 'enemy-hit' ? 'minor' : e.type };
    if (e.type === 'enemy-death') {
      f.duration = .46;
      f.animate = t => {
        const delay = (e.target || 0) % 4 * .05, fall = Math.max(0, (t - delay) / (1 - delay));
        n.setPosition(x - W / 2 + Math.sin((e.target || 0) * 7) * 15 * fall, H / 2 - y - offset + 8 * Math.sin(fall * Math.PI));
        n.setScale(1 + fall * .18, 1 - fall * .55, 1); n.angle = Math.sin((e.target || 0) * 9) * fall * 20;
        n.getComponent(UIOpacity)!.opacity = 255 * Math.min(1, (1 - fall) * 2);
      };
    }
    this.fx.push(f);
  }
  private summonExit(e: BattleEvent): void {
    const x = battleX(e.x), feet = battleY(e.y);
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
      punch: { fromX: h.x * W, fromY: 1360, toX: battleX(e.x), toY: battleY(e.y) - 20, glove, spring } });
  }
  private clearEffects(): void { this.fx.forEach(f => this.releaseFx(f)); this.fx = []; this.reactions.clear(); this.energyPulse = 0; for (const n of this.missiles.values()) n.destroy(); this.missiles.clear(); }
  update(dt: number): void {
    this.resize(); if (this.loading) { this.animateLoading(dt); return; } if (!this.ready) return;
    if(this.qaScene==='soak'||this.qaScene==='roster-soak'||this.qaScene==='incentive-soak'){
      this.soakChoiceWait+=dt;
      if(this.soakChoiceWait>=1.1){driveSoak(this.session);this.soakChoiceWait=0;}
    }
    this.elapsed += dt; this.session.tick(this.qaHeld ? 0 : dt); const r = this.session.data.run;
    if(this.qaEnabled){
      const stamp=typeof performance==='undefined'?Date.now():performance.now(),delta=stamp-this.frameStamp;this.frameStamp=stamp;
      if(this.elapsed>3&&this.session.inBattle&&!this.session.background&&!this.qaHeld&&r?.status==='active'&&!r.paused&&!r.rescue&&delta>0&&this.frameIntervals.length<7200){
        this.frameIntervals.push(delta);this.frameSeconds+=delta/1000;this.stallSequence=delta>100?this.stallSequence+1:0;this.maxStallSequence=Math.max(this.maxStallSequence,this.stallSequence);
      }
      if(this.elapsed-this.frameReportAt>=1){this.frameReportAt=this.elapsed;const a=[...this.frameIntervals].sort((a,b)=>a-b);
        this.frameReport={samples:a.length,seconds:this.frameSeconds,p95Ms:a[Math.ceil(a.length*.95)-1]||0,maxMs:a[a.length-1]||0,consecutiveOver100Ms:this.maxStallSequence,scenario:this.qaScene||'player'};
      }
    }
    this.audio?.update(dt, this.session.data.profile, r, this.session.inBattle);
    if (this.uiSignature() !== this.signature) this.render();
    if (r && this.session.inBattle) {
      if (r.id !== this.runId) { this.runId = r.id; this.pendingReserve=0; this.eventCursor = r.eventSequence; this.clearEffects(); this.actionUntil.clear(); }
      this.updateWorld(r);
      for (const e of r.events) if (e.seq > this.eventCursor) { this.effect(e); this.audio?.battleEvent(e); } this.eventCursor = r.eventSequence;
      if(this.pendingReserve&&r.status==='active'&&!r.paused&&!r.rescue&&!r.candidates.length&&!r.aiming&&this.fx.length<78){
        const pieces=(this.pendingReserve===10?2:1)*(r.stage%10===0?2:1),n=this.pooledFx('reserve',()=>this.text('',470,231,29,640,48,'hud',this.feedback).node);
        n.getComponent(Label)!.string=`战斗储备 ${pieces}/${r.stage%10===0?10:5} · 阵亡可保留`;
        this.fx.push({node:n,age:0,duration:.9,tick:r.tick,size:48,poolKey:'reserve',kind:'reserve',realTime:true});this.pendingReserve=0;
      }
      for (const [uid, hit] of this.reactions) if (now(r) - hit.at > .2) this.reactions.delete(uid);
      const scale = this.session.error || this.session.background || this.qaHeld ? 0 : effectiveRate(r);
      for (const f of this.fx) {
        const delta = Math.min(.25, dt) * (f.realTime?(scale>0?1:0):feedbackRate(scale, r.rate, !!f.readable)); f.age += delta; const t = Math.min(1, f.age / f.duration);
        f.node.getComponent(UIOpacity)!.opacity = 255 * (f.punch ? Math.min(1, (1 - t) * 4) : 1 - t);
        if (f.animate) f.animate(t);
        else if (f.punch) {
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
        } else { f.node.setScale(1 + t * .15, (1 + t * .15) * (f.verticalScale ?? 1), 1); if (f.floating) f.node.setPosition(f.node.position.x, f.node.position.y + delta * 80); }
      }
      this.fx = this.fx.filter(f => { if (f.age >= f.duration || r.status !== 'active') { this.releaseFx(f); return false; } return true; });
      this.kick = Math.max(0, this.kick - Math.min(.25,dt) * feedbackRate(scale,r.rate,true));
      const offset = this.kick > 0 ? Math.sin(this.kick/.13*Math.PI*2)*5 : 0; this.world.setPosition(0,offset); this.effects.setPosition(0,offset);
      // These memory-only QA scenes hold the first impact for repeatable native-render screenshots.
      if (this.qaScene.startsWith('impact-') && this.fx.some(f => f.kind === 'impact' && f.source?.endsWith('S2') && f.age >= .2)) this.qaHeld = true;
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
    return { version: RULES.version, incentiveVersion:'R1.2.0', progression:this.session.data.profile.incentive, fragments:this.session.data.profile.fragments, levels:this.session.data.profile.levels, settlement:this.session.data.settlement, page: this.session.inBattle ? 'battle' : this.page, modal: this.modal, status: this.session.data.run?.status, qaScene: this.qaScene, qaHeld: this.qaHeld, performance:this.frameReport,
      assetError: this.assetError, storageError: this.session.error, assets: this.assets.report(), fonts: this.typography.report(),
      labels: this.labels.filter(l => l.isValid).map(l => this.typography.describe(l)), buttons: this.hotzones, cardHeight: 560, cardTop: 556, cardBackdrop: false,
      actorNodes: this.actors.size, effects: this.fx.length, audioErrors: this.audio?.errors || [],
      feedback: { pooledRoots: Array.from(this.fxPool.values()).reduce((n, list) => n + list.length, 0), numbers: this.fx.filter(f => f.floating).length,
        energyOrbs: this.fx.filter(f => f.kind === 'energy').map(f => f.total), skills: this.fx.filter(f => ['windup','impact','heal-pulse','buff-pulse','chain-link'].includes(f.kind||'')).map(f => ({ source: f.source, phase: f.kind, progress: f.age / f.duration })),
        battleViewport:BATTLE_VIEW,impactClip:{left:BATTLE_VIEW.x,top:BATTLE_EFFECT_TOP,width:BATTLE_VIEW.width,height:BATTLE_EFFECT_BOTTOM-BATTLE_EFFECT_TOP}, readableRate:feedbackRate(this.session.data.run?effectiveRate(this.session.data.run):0,this.session.data.run?.rate||1,true) },
      summonExits: this.fx.filter(f => f.summonExit).map(f => ({ ...f.summonExit!, age: f.age })),
      actorVisuals: Array.from(this.actors.entries()).map(([uid, a]) => { const t = a.node.getComponent(UITransform)!; return { uid, atlas: a.atlas, frame: a.frame, action: a.action, healthBar: a.bar.node.active, ammo: a.ammo?.string,
        feet: H / 2 - a.node.position.y, top: H / 2 - a.node.position.y - t.height * (1-t.anchorY) * a.node.scale.y, healthTop: H / 2 - a.bar.node.position.y - 12 }; }),
      attackVisuals: { punches: this.fx.filter(f => f.punch).length, projectiles: Array.from(this.missiles.values()).map(n => ({ pack: n.name, width: n.getComponent(UITransform)!.width, height: n.getComponent(UITransform)!.height })) } };
  }
  onDestroy(): void {
    game.off(Game.EVENT_HIDE, this.onHide, this); game.off(Game.EVENT_SHOW, this.onShow, this);
    this.audio?.destroy(); this.assets.destroy();
    if (sys.isBrowser && typeof window !== 'undefined') delete (window as any).__r1;
  }
}
