import test from 'node:test';
import assert from 'node:assert/strict';
import { battleCircleScreen, battleRangeDashes, battleScreenToWorld, worldToBattleScreen } from '../assets/scripts/presentation/BattleProjection';

test('reference battlefield maps touch coordinates back to the same authoritative target', () => {
  // Covers interpolation joins, extrapolated skill radii and a dense field grid.
  for (let x = -100; x <= 820; x += 11) for (let y = -120; y <= 800; y += 13) {
    const restored = battleScreenToWorld(worldToBattleScreen({ x, y }));
    assert.ok(Math.abs(restored.x - x) < 1e-8);
    assert.ok(Math.abs(restored.y - y) < 1e-8);
  }
});
test('road endpoints align while right-hand pads retain topology', () => {
  for (const [world, source] of [[140,250],[360,480],[580,730]])
    assert.ok(Math.abs(worldToBattleScreen({ x:world, y:32 }).x * 941 / 720 - source) < 1e-8);
  for (const [world, source] of [[32,235],[648,1055]])
    assert.ok(Math.abs(worldToBattleScreen({ x:140, y:world }).y * 1672 / 1280 - source) < 1e-8);
  assert.ok(worldToBattleScreen({ x:210, y:350 }).x > worldToBattleScreen({ x:140, y:350 }).x);
});
test('the same enemy has constant screen displacement per tick over the entire road', () => {
  for (const x of [140,360,580]) for (const speed of [28,46,64]) {
    const step = speed / 60, initial = worldToBattleScreen({x,y:32+step}).y - worldToBattleScreen({x,y:32}).y;
    // Includes every old slope boundary, not just the two endpoints.
    for (let y=32;y<648;y+=.73)
      assert.ok(Math.abs(worldToBattleScreen({x,y:y+step}).y-worldToBattleScreen({x,y}).y-initial)<1e-9);
  }
});
test('visible range dashes lie on the real range and leave gaps all around the hero', () => {
  const center={x:210,y:350},radius=220,dashes=battleRangeDashes(center,radius);
  assert.equal(dashes.length,48);
  for (let i=0;i<dashes.length;i++) {
    for (const p of dashes[i]) {
      const world=battleScreenToWorld(p);
      assert.ok(Math.abs(Math.hypot(world.x-center.x,world.y-center.y)-radius)<1e-8);
    }
    const end=dashes[i][2],next=dashes[(i+1)%dashes.length][0];
    assert.ok(Math.hypot(end.x-next.x,end.y-next.y)>1);
  }
});
test('projected area outline describes the actual world radius even across axis segments', () => {
  const center = { x: 360, y: 180 }, radius = 110;
  for (const point of battleCircleScreen(center, radius)) {
    const world = battleScreenToWorld(point);
    assert.ok(Math.abs(Math.hypot(world.x - center.x, world.y - center.y) - radius) < 1e-8);
  }
});
