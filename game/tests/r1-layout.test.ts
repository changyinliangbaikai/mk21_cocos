import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from '../assets/resources/r1/manifest.json';
import { inSkillArea, polygonArea, skillArea } from '../assets/scripts/domain/r1/geometry';
import { BATTLE_EFFECT_TOP, BATTLE_HUD_BOTTOM, BATTLE_MODEL, BATTLE_VIEW, R1_VIEW, battleAim, battlePixelPoint, battleRadius, battleX, battleY } from '../assets/scripts/presentation/R1BattleLayout';

test('C036 every enemy frame, health bar and shield clears the HUD at birth, including camera shake', () => {
  const atlases = manifest.atlases.filter(a => /^(WALK-)?R[MSL]\d\d$/.test(a.id));
  assert.equal(atlases.length, 12);
  for (const atlas of atlases) {
    const height = atlas.displayHeight! * R1_VIEW.width / 720;
    const bodyTop = Math.min(...atlas.frames.map(f => battleY(0) - ('heightRatio' in f ? f.heightRatio || 1 : 1) * height * (1 - f.anchor[1])));
    const shieldTop = battleY(0) - height - 31;
    assert.ok(Math.min(bodyTop, shieldTop) - 5 >= BATTLE_HUD_BOTTOM + 20, `${atlas.id} enters behind the HUD`);
  }
  assert.ok(BATTLE_EFFECT_TOP - 5 > BATTLE_HUD_BOTTOM + 20);
  assert.equal(battleY(1), 1254, 'the hero contact edge remains fixed');
});

test('C036 touch aiming follows the visible arena and clamps HUD and hero-zone taps', () => {
  for (const x of [0, .1, .5, .9, 1]) for (const y of [0, .1, .5, .9, 1]) {
    const aim = battleAim(battleX(x), battleY(y));
    assert.ok(Math.abs(aim.x - x) < 1e-12 && Math.abs(aim.y - y) < 1e-12);
  }
  assert.equal(battleAim(R1_VIEW.width / 2, BATTLE_HUD_BOTTOM).y, 0);
  assert.equal(battleAim(R1_VIEW.width / 2, 1427).y, 1);
});

test('C036 projected blue skill boundary matches combat hits at both arena edges and the center', () => {
  for (const aimY of [0, .5, 1]) {
    const area = skillArea('blue', .5, aimY), center = battlePixelPoint(area.center.x, area.center.y);
    const radius = battleRadius(area.radius / BATTLE_MODEL.width);
    assert.ok(Math.abs(Math.PI * radius.x * radius.y / (BATTLE_VIEW.width * BATTLE_VIEW.height) - .2) < 1e-12);
    for (let i = 0; i < 16; i++) for (const fraction of [.98, 1.02]) {
      const angle = i * Math.PI / 8;
      const point = { x: (area.center.x + Math.cos(angle) * area.radius * fraction) / BATTLE_MODEL.width,
        y: (area.center.y + Math.sin(angle) * area.radius * fraction) / BATTLE_MODEL.height };
      const renderedInside = Math.hypot((battleX(point.x) - center.x) / radius.x, (battleY(point.y) - center.y) / radius.y) <= 1;
      assert.equal(renderedInside, inSkillArea(area, point));
    }
  }
});

test('C036 purple coverage remains one half after projection and never crosses into the HUD', () => {
  for (const angle of [-25, 0, 25]) {
    const polygon = skillArea('purple', .5, .5, angle).polygon.map(p => battlePixelPoint(p.x, p.y));
    assert.ok(polygon.every(p => p.y >= BATTLE_VIEW.y - 1e-8 && p.y <= battleY(1) + 1e-8));
    assert.ok(Math.abs(polygonArea(polygon) / (BATTLE_VIEW.width * BATTLE_VIEW.height) - .5) < 1e-8);
  }
});
