import { R1Session } from '../domain/r1/session';
import { deployHero } from '../domain/r1/cards';
import { spawnEnemy } from '../domain/r1/waves';
import { HEROES } from '../domain/r1/config';
import { castHeroSkill } from '../domain/r1/combat';

/** Explicit browser QA routes only. This session never reads or writes player storage. */
export function visualFixture(scene: string): R1Session | null {
  if (/^melee-(?:windup|hit)-RH(?:01|05|06)$/.test(scene) || scene === 'melee-loop') {
    const memory = new Map<string, string>(), s = new R1Session({ getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); } });
    s.data.profile.clearedStage = 20; s.data.profile.sound = s.data.profile.music = false; s.start(1, 4401);
    const r = s.data.run!; r.drawQueue = []; r.candidates = []; r.wave = 15; r.released = r.plans[14].length;
    const roster = scene === 'melee-loop' ? ['RH01', 'RH05', 'RH06'] : [scene.slice(-4)];
    roster.forEach((id, i) => { const h = deployHero(r, id, roster.length === 1 ? 1 : [0, 1, 3][i]); h.skills = [3, 0, 0]; h.basicCooldown = .35 + i * .1; h.protectionUntil = 3600; });
    for (let i = 0; i < 18; i++) { const e = spawnEnemy(r, { id: 'RM01', x: .12 + (i % 6) * .145, trait: null }, 15); e.y = .52 + Math.floor(i / 6) * .05; e.hp = e.maxHp = 100000; e.rootUntil = e.cooldown = 3600; }
    return s;
  }
  if (/^flight-hero-RH(?:0[234789]|10)$/.test(scene)) {
    const memory = new Map<string, string>(), s = new R1Session({ getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); } });
    s.data.profile.clearedStage = 20; s.data.profile.sound = false; s.data.profile.music = false; s.start(1, 4301);
    const r = s.data.run!; r.drawQueue = []; r.candidates = []; r.wave = 15; r.released = r.plans[14].length;
    const h = deployHero(r, scene.slice('flight-hero-'.length), 1); h.skills = [3, 0, 0]; h.protectionUntil = 3600;
    for (let i = 0; i < 6; i++) { const e = spawnEnemy(r, { id: 'RM01', x: .65 + (i % 3) * .035, trait: null }, 15); e.y = .16 + Math.floor(i / 3) * .04; e.hp = e.maxHp = 100000; e.rootUntil = e.cooldown = 3600; }
    return s;
  }
  if (/^area-hero-RH(?:0[1-9]|10)$/.test(scene) || scene === 'area-cards') {
    const memory=new Map<string,string>(),s=new R1Session({getItem:k=>memory.get(k)??null,setItem:(k,v)=>{memory.set(k,v);}});
    s.data.profile.clearedStage=20;s.data.profile.sound=false;s.data.profile.music=false;s.start(1,4102);
    const r=s.data.run!;r.drawQueue=[];r.candidates=[];r.wave=15;r.released=r.plans[14].length;
    const heroes=scene==='area-cards'?['RH01','RH02','RH03']:[scene.slice('area-hero-'.length)];
    heroes.forEach((id,i)=>{const h=deployHero(r,id,scene==='area-cards'?i:1);h.skills=[scene==='area-cards'?1:3,0,0];h.basicCooldown=scene==='area-cards'?3600:.3;h.protectionUntil=3600;});
    for(let i=0;i<12;i++){const e=spawnEnemy(r,{id:i%3?'RM01':'RM02',x:.33+(i%4-1.5)*.045,trait:null},15);e.y=.68+Math.floor(i/4)*.04;e.hp=e.maxHp=100000;e.rootUntil=3600;e.cooldown=3600;}
    if(scene==='area-cards'){r.drawQueue=['energy'];r.candidates=heroes.map((id,i)=>({id:'area-card-'+i,kind:'skill',quality:'purple',heroId:id,skillSlot:1,level:2}));}
    return s;
  }
  if(scene==='loading-preview') { const memory=new Map<string,string>(); return new R1Session({getItem:k=>memory.get(k)??null,setItem:(k,v)=>{memory.set(k,v);}}); }
  if (!['entry-minions','entry-bosses','entry-aim-blue','entry-aim-purple','entry-aim-gold','impact-entry','incentive-new','incentive-menus','incentive-settlement','incentive-soak','effects', 'bosses', 'draft', 'menus', 'summons', 'targeting', 'crowds', 'impact-boxer', 'impact-chef', 'playtest', 'soak', 'support-control','roster','roster-soak','roster-victory','roster-effects','hero-RH07','hero-RH08','hero-RH09','hero-RH10'].includes(scene)) return null;
  const memory = new Map<string, string>();
  const session = new R1Session({ getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); } });
  session.data.profile.clearedStage = 20; session.data.profile.music = false; session.data.profile.sound = false;
  if(scene==='incentive-new'){session.data.profile.clearedStage=2;session.data.profile.fragments.RH02=8;return session;}
  if(scene==='incentive-menus'||scene==='incentive-soak'||scene==='incentive-settlement'){const p=session.data.profile;for(const h of HEROES){p.levels[h.id]=3;p.fragments[h.id]=8;p.incentive!.specializations[h.id]='A';}p.incentive!.storyClaimed=Array.from({length:20},(_,i)=>i+1);p.incentive!.beginnerDone=true;p.incentive!.expedition.unlockedTier=8;if(scene==='incentive-menus')return session;session.start(20,3417,false,{tier:3,contract:'shield'});if(scene==='incentive-settlement'){/* Layout-only terminal state; the soak route supplies real combat evidence. */const r=session.data.run!;r.status='victory';for(const id of ['first-burst','first-reserve','first-trial','perk-win','pull-combo','summon-guard'])r.incentive!.stats.goals[id]=id==='pull-combo'?10:1;session.tick(0);}return session;}
  if (scene === 'menus') return session;
  if (scene === 'playtest' || scene === 'soak') { session.data.profile.clearedStage=0;session.start(1,32042);return session; }
  if(scene==='roster'||scene==='roster-soak'||scene==='roster-victory'){
    session.start(6,33001);const r=session.data.run!;r.drawQueue=[];r.candidates=[];
    ['RH07','RH08','RH09','RH10'].forEach((id,i)=>deployHero(r,id,i));
    if(scene==='roster-victory'){r.status='victory';r.wave=15;r.released=r.plans[14].length;r.spawnedMinions=r.plans.flat().length;r.spawnedBosses=3;r.kills=r.spawnedMinions+r.spawnedBosses;session.data.settlement={runId:r.id,stage:6,rewards:[{key:'RH07',count:3},{key:'RH10',count:2}]};}
    return session;
  }
  session.start(1, 2801);
  const r = session.data.run!; r.drawQueue = []; r.candidates = []; r.wave = 15; r.released = r.plans[14].length;
  if(scene==='roster-effects'||scene.startsWith('hero-')){
    const roster=scene==='roster-effects'?['RH07','RH08','RH09','RH10']:[scene.slice(5)];
    roster.forEach((id,i)=>{const h=deployHero(r,id,i);h.skills=[3,3,3];h.cooldowns=[0,2+i*1.2,7+i*1.2];h.protectionUntil=3600;});
    for(let i=0;i<28;i++){const e=spawnEnemy(r,{id:i%2?'RM01':'RM02',trait:null,x:.12+(i%7)*.12},1);e.y=.30+Math.floor(i/7)*.14;e.hp=e.maxHp=100000;e.rootUntil=3600;}
    return session;
  }
  if(scene==='support-control'){
    ['RH03','RH04','RH05','RH06'].forEach((id,i)=>{const h=deployHero(r,id,i);h.hp=h.maxHp*.6;h.skills=[1,3,3];h.basicCooldown=3600;h.cooldowns=[0,2+i*1.2,8+i*1.2];h.protectionUntil=3600;});
    for(let i=0;i<20;i++){const e=spawnEnemy(r,{id:'RM02',trait:null,x:.2+(i%5)*.12},1);e.y=.6+Math.floor(i/5)*.04;e.hp=e.maxHp=100000;e.rootUntil=3600;}
    return session;
  }
  ['RH01', 'RH02', 'RH03', 'RH04'].forEach((id, i) => {
    const h = deployHero(r, id, i); h.protectionUntil = 3600;
    if (scene === 'bosses' || scene === 'summons') h.basicCooldown = 3600;
  });
  if (scene.startsWith('entry-')) {
    const ids = scene === 'entry-bosses' ? ['RS01','RS02','RL01','RL02'] : ['RM01','RM02','RM04','RM05'];
    ids.forEach((id,i) => { const e=spawnEnemy(r,{id,trait:null,x:.125+i*.25},15);e.hp=e.maxHp=100000;e.skillCooldown=e.commandCooldown=3600; });
    if(scene.startsWith('entry-aim-')) { r.globalSkill=scene.slice(10) as 'blue'|'purple'|'gold';r.aiming=true; }
    return session;
  }
  if (scene === 'crowds') {
    r.wave = 0; r.released = 0;
    for (const h of r.slots) if (h) { h.protectionUntil = 0; h.skills = [1, h.id === 'RH03' ? 1 : 3, 1]; h.cooldowns = [0, 4, 9]; }
    return session;
  }
  if (scene.startsWith('impact-')) {
    const h = r.slots[scene === 'impact-boxer' ? 0 : 1]!;
    for (const ally of r.slots) if (ally) ally.basicCooldown = 3600;
    h.skills = [1, 3, 1]; h.cooldowns = [0, 2, 6];
    for (let i = 0; i < 18; i++) {
      const e = spawnEnemy(r, { id: i % 3 ? 'RM01' : 'RM02', trait: null, x: .29 + i % 6 * .067 }, 1);
      e.y = (scene === 'impact-entry' ? 0 : .53) + Math.floor(i / 6) * .065; e.hp = e.maxHp = 100000; e.rootUntil = 3600;
    }
    return session;
  }
  if (scene === 'summons' || scene === 'targeting') {
    for (const h of r.slots) if (h) {
      const e = spawnEnemy(r, { id: 'RM02', trait: null, x: h.x }, 15);
      e.y = .62; e.hp = e.maxHp = 100000; e.rootUntil = 3600;
    }
    if (scene === 'summons') {
      const chef = r.slots[1]!, aunt = r.slots[3]!; chef.skills[2] = 5; aunt.skills[2] = 1;
      castHeroSkill(r, chef, 3); castHeroSkill(r, aunt, 3);
      // A distant boss makes each summon projectile visible; the nearby minions still attack the cabinet.
      const boss = spawnEnemy(r, { id: 'RL01', trait: null, x: .5 }, 15);
      boss.y = .15; boss.hp = boss.maxHp = 100000; boss.rootUntil = boss.skillCooldown = boss.commandCooldown = 3600;
    }
    return session;
  }
  const ids = scene === 'bosses' ? ['RS01', 'RS02', 'RL01', 'RL02'] : ['RM01', 'RM02'];
  ids.forEach((id, i) => {
    const e = spawnEnemy(r, { id, trait: null, x: scene === 'bosses' ? .15 + i * .23 : .3 + i * .4 }, 15);
    e.y = scene === 'bosses' ? .15 : .7; e.hp = e.maxHp = 100000; e.skillCooldown = e.commandCooldown = 3600;
  });
  if (scene === 'draft') {
    r.drawQueue = ['energy']; r.candidates = ['RH01', 'RH02', 'RH03'].map(id => ({ id: 'qa-' + id, kind: 'attribute', heroId: id, attribute: 'all', quality: 'blue' }));
  }
  return session;
}

/** Normal cards and stats, driven through the same session API; no direct battle boosts. */
export function driveSoak(session:R1Session):void {
  const r=session.data.run;if(!r||r.status!=='active')return;
  if(r.rescue){session.rescue(r.rescue==='grandpa'||!r.freeReviveUsed);return;}
  if(!r.candidates.length)return;
  const opening=r.drawQueue[0]==='opening',n=3-r.drawQueue.filter(s=>s==='opening').length;
  const rank=(c:typeof r.candidates[number])=>c.kind==='hero'?100:c.kind==='skill'?c.skillSlot===1?90:80:c.kind==='attribute'?70:60;
  const c=opening?(r.candidates.find(c=>c.kind==='hero'&&c.heroId===['RH01','RH02','RH03'][n])||r.candidates.find(c=>c.kind==='hero')!):[...r.candidates].sort((a,b)=>rank(b)-rank(a))[0];
  session.choose(c.id);
}
