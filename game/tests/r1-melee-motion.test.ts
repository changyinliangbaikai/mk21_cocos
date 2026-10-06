import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { MELEE_STYLES, meleeParts, meleeWindupProgress } from '../assets/scripts/presentation/MeleeStrikeMotion';

test('melee propagation stays on the source-target segment throughout the existing windup', () => {
  for (const id of Object.keys(MELEE_STYLES)) for (const length of [1, 50, 250, 600]) {
    for (let tick = 0; tick <= 15; tick++) {
      const progress = meleeWindupProgress(.25 - tick / 60, .25), parts = meleeParts(id, progress, length);
      assert.ok(parts.length <= 6);
      for (const p of parts) {
        assert.ok(p.at >= 0 && p.at <= 1);
        assert.ok(p.width > 0 && p.height > 0 && Number.isFinite(p.width + p.height));
        assert.ok(p.opacity >= 0 && p.opacity <= 1);
        if (progress < 1) assert.ok(p.at < 1);
      }
    }
    assert.equal(meleeParts(id, 0, length).length, 0);
    assert.equal(meleeWindupProgress(0, .25), 1);
  }
});
test('melee aftershock expires and wood eruption reveals progressively instead of all at once', () => {
  assert.ok(meleeParts('RH05', .2, 400).length < meleeParts('RH05', .8, 400).length);
  for (const id of Object.keys(MELEE_STYLES)) {
    assert.ok(meleeParts(id, 1, 400, 0).length > 0);
    assert.deepEqual(meleeParts(id, 1, 400, MELEE_STYLES[id].tail), []);
    assert.deepEqual(meleeParts(id, .5, 0), []);
  }
});
test('melee connector resources coexist with approved impact and flight atlases and stay in bounds', () => {
  const manifest = JSON.parse(readFileSync('game/assets/resources/r1/manifest.json', 'utf8'));
  assert.equal(manifest.areaFxRevision, 'C-042'); assert.equal(manifest.flightFxRevision, 'C-043'); assert.equal(manifest.meleeFxRevision, 'C-044');
  for (const id of Object.keys(MELEE_STYLES)) {
    const a = manifest.atlases.find((x: any) => x.id === 'FX-MELEE-' + id); assert.ok(a); assert.equal(a.frames.length, 9);
    const path = 'game/assets/resources/' + a.resource + '.png'; assert.ok(existsSync(path)); assert.ok(existsSync(path + '.meta'));
    const bytes = readFileSync(path), width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    for (const f of a.frames) { const [x, y, w, h] = f.rect; assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= width && y + h <= height); }
  }
});
