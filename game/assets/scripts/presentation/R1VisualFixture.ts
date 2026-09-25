import { R1Session } from '../domain/r1/session';
import { deployHero } from '../domain/r1/cards';
import { spawnEnemy } from '../domain/r1/waves';
import { castHeroSkill } from '../domain/r1/combat';

/** Explicit browser QA routes only. This session never reads or writes player storage. */
export function visualFixture(scene: string): R1Session | null {
  if (!['effects', 'bosses', 'draft', 'menus', 'summons', 'targeting'].includes(scene)) return null;
  const memory = new Map<string, string>();
  const session = new R1Session({ getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); } });
  session.data.profile.clearedStage = 20; session.data.profile.music = false; session.data.profile.sound = false;
  if (scene === 'menus') return session;
  session.start(1, 2801);
  const r = session.data.run!; r.drawQueue = []; r.candidates = []; r.wave = 15; r.released = 30;
  ['RH01', 'RH02', 'RH03', 'RH04'].forEach((id, i) => {
    const h = deployHero(r, id, i); h.protectionUntil = 3600;
    if (scene === 'bosses' || scene === 'summons') h.basicCooldown = 3600;
  });
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
