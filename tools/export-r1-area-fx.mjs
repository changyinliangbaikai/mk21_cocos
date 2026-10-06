#!/usr/bin/env node
/** C042-C044: crop and pack image_gen pixels without repainting or synthesizing alpha. */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const flight = process.argv.includes('--flight');
const melee = process.argv.includes('--melee');
if (flight && melee) throw Error('Choose one asset family per export');
const source = resolve(root, 'design-library/10-群攻特效重制', melee ? 'melee-c044' : flight ? 'flight-c043' : '.');
const output = resolve(source, 'export');
const spec = JSON.parse(readFileSync(resolve(source, 'spec.json'), 'utf8'));
const manifest = { revision: melee ? 'C-044' : flight ? 'C-043' : 'C-042', atlases: [] };
const audit = { generator: 'built-in image_gen', originalAlphaPreserved: true, frames: 0, decodedBytes: 0, pngBytes: 0, sources: [] };
const cell = spec.layout.runtimeCell, inner = cell - 8;
mkdirSync(output, { recursive: true });

for (const hero of spec.heroes) {
  const file = `素材/${hero.id}-source-v1.png`, input = readFileSync(resolve(source, file));
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = (x, y) => data[(y * info.width + x) * 4 + 3];
  const cut = (axis, target, lo, hi) => {
    let best = target, bestScore = Infinity, opaque = Infinity;
    const search = info.width * (melee ? .08 : .02);
    for (let p = Math.round(target - search); p <= target + search; p++) {
      let solid = 0, softness = 0;
      for (let q = lo; q < hi; q++) { const a = axis === 'x' ? alpha(p, q) : alpha(q, p); solid += a > 128; softness += a; }
      const score = solid * 1e8 + softness * 10 + Math.abs(p - target);
      if (score < bestScore) { best = p; bestScore = score; opaque = solid; }
    }
    if (opaque) throw Error(`${hero.id}: no clear ${axis} gutter near ${target}`);
    return best;
  };
  const ys = [0, cut('y', Math.round(info.height / 3), 0, info.width), cut('y', Math.round(info.height * 2 / 3), 0, info.width), info.height];
  const xs = ys.slice(0, 3).map((y, row) => [0, cut('x', Math.round(info.width / 3), y, ys[row + 1]), cut('x', Math.round(info.width * 2 / 3), y, ys[row + 1]), info.width]);
  const nominal = Math.max(info.width, info.height) / 3, virtual = Math.ceil(nominal * (melee ? 1.5 : 1.16));
  const cells = [], layers = [], frames = [];
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] === 0) transparent++;
  if (transparent < info.width * info.height * .25) throw Error(`${hero.id}: missing transparent gutters`);
  for (let i = 0; i < 9; i++) {
    const column = i % 3, row = Math.floor(i / 3);
    const left = xs[row][column], top = ys[row];
    const width = xs[row][column + 1] - left, height = ys[row + 1] - top;
    let solid = 0, boundary = 0, clipped = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (alpha(left + x, top + y) <= 128) continue;
      solid++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        boundary++;
        // A solid edge next to a transparent source pixel is complete artwork, not a cut stroke.
        if (x === 0 && (left === 0 || alpha(left - 1, top + y) > 128)
          || x === width - 1 && (left + width === info.width || alpha(left + width, top + y) > 128)
          || y === 0 && (top === 0 || alpha(left + x, top - 1) > 128)
          || y === height - 1 && (top + height === info.height || alpha(left + x, top + height) > 128)) clipped++;
      }
    }
    if (solid < 500 || clipped) throw Error(`${hero.id} frame ${i}: empty/clipped solid artwork ${solid}/${clipped}`);
    // Follow transparent gutters, then restore the nominal grid pivot on one shared canvas.
    // This preserves frame registration and avoids cutting artwork that slightly overflows its ideal cell.
    const offsetX = Math.round(virtual / 2 + left - (column + .5) * info.width / 3);
    const offsetY = Math.round(virtual / 2 + top - (row + .5) * info.height / 3);
    if (offsetX < 0 || offsetY < 0 || offsetX + width > virtual || offsetY + height > virtual) throw Error(`${hero.id}: registration canvas too small`);
    const cropped = await sharp(input).extract({ left, top, width, height }).png().toBuffer();
    const registered = await sharp({ create: { width: virtual, height: virtual, channels: 4, background: '#00000000' } }).composite([{ input: cropped, left: offsetX, top: offsetY }]).png().toBuffer();
    if (melee && i >= 6) {
      // Route strips are independent pieces, not a registered body loop. Tighten transparent padding
      // so stretching a strip to the actual route length does not leave gaps or overshoot its ends.
      let l = width, t = height, r = -1, b = -1;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (alpha(left + x, top + y) > 8) { l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y); }
      l = Math.max(0, l - 4); t = Math.max(0, t - 4); r = Math.min(width - 1, r + 4); b = Math.min(height - 1, b + 4);
      const part = await sharp(input).extract({ left: left + l, top: top + t, width: r - l + 1, height: b - t + 1 }).resize(inner, inner, { fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
      const x = column * cell + 4, y = row * cell + 4;
      layers.push({ input: part.data, left: x, top: y });
      frames.push({ rect: [x, y, part.info.width, part.info.height], ratio: part.info.width / part.info.height, anchor: [.5, .5] });
    } else {
      const pixels = await sharp(registered).resize(inner, inner).png().toBuffer();
      layers.push({ input: pixels, left: column * cell + 4, top: row * cell + 4 });
      frames.push({ rect: [column * cell, row * cell, cell, cell], ratio: 1, anchor: [.5, .5] });
    }
    cells.push({ index: i, sourceRect: [left, top, width, height], solidBounds: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], solidPixels: solid, opaqueBoundaryPixels: boundary, clippedStrokePixels: clipped });
  }
  const id = `${melee ? 'FX-MELEE' : flight ? 'FX-FLIGHT' : 'FX-AREA'}-${hero.id}`, atlasWidth = cell * 3;
  const png = await sharp({ create: { width: atlasWidth, height: atlasWidth, channels: 4, background: '#00000000' } }).composite(layers).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(resolve(output, `${id}.png`), png);
  const sha = createHash('sha256').update(input).digest('hex');
  manifest.atlases.push({ id, resource: `r1/art/${id}`, group: 'battle', kind: melee ? 'melee-vfx' : flight ? 'flight-vfx' : 'area-vfx', frames,
    clips: melee ? { approach: { frames: [0, 1, 2, 3, 4, 5], secondsPerFrame: .04 }, trail: { frames: [6, 7, 8], secondsPerFrame: .05 } }
      : flight ? { projectile: { frames: [0, 1, 2, 3, 4, 5], secondsPerFrame: .065, loop: true }, trail: { frames: [6, 7, 8], secondsPerFrame: .06 } }
      : { projectile: { frames: [0, 1], secondsPerFrame: .09, loop: true }, impact: { frames: [2, 3, 4, 5, 6, 7, 8], secondsPerFrame: .08 } },
    effectScale: virtual / nominal * cell / inner, sourceSha256: sha, bytes: png.length });
  audit.sources.push({ id: hero.id, file, width: info.width, height: info.height, sha256: sha, transparentPixels: transparent, frames: cells });
  audit.frames += 9; audit.decodedBytes += atlasWidth * atlasWidth * 4; audit.pngBytes += png.length;
}
if (audit.decodedBytes > (melee ? 4 : flight ? 7 : 14) * 1048576) throw Error('VFX texture budget exceeded');
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(resolve(source, 'asset-technical-audit.json'), JSON.stringify(audit, null, 2) + '\n');
if (flight || melee) {
  // The review page uses the same motion formulas as Cocos, compiled without browser-specific copies.
  const ts = (await import('typescript')).default;
  const code = readFileSync(resolve(root, `game/assets/scripts/presentation/${melee ? 'MeleeStrikeMotion' : 'ProjectileMotion'}.ts`), 'utf8');
  writeFileSync(resolve(source, 'motion.js'), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
}

// Local review uses real packaged background, heroes and monsters; it does not change gameplay.
const runtime = resolve(root, 'game/assets/resources/r1');
const existing = JSON.parse(readFileSync(resolve(runtime, 'manifest.json'), 'utf8'));
const references = existing.atlases.filter(a => ['BG-BATTLE', 'RM01', 'RM02', ...spec.heroes.map(h => h.id)].includes(a.id));
mkdirSync(resolve(source, 'reference'), { recursive: true });
for (const a of references) copyFileSync(resolve(root, 'game/assets/resources', `${a.resource}.png`), resolve(source, 'reference', `${a.id}.png`));
writeFileSync(resolve(source, 'reference/manifest.json'), JSON.stringify({ atlases: references }, null, 2) + '\n');

if (process.argv.includes('--install')) {
  const gate = JSON.parse(readFileSync(resolve(source, 'asset-gate.json'), 'utf8'));
  if (!gate.visualReviewPassed || !gate.readyForIntegration || gate.sourceHashes.length !== spec.heroes.length || !audit.sources.every(s => gate.sourceHashes.includes(s.sha256))) throw Error('Current sources have not passed the visual gate');
  for (const a of manifest.atlases) {
    const target = resolve(runtime, 'art', `${a.id}.png`);
    copyFileSync(resolve(output, `${a.id}.png`), target);
    if (!existsSync(target + '.meta')) writeFileSync(target + '.meta', JSON.stringify({ ver: '1.0.27', importer: 'image', imported: false, uuid: randomUUID(), files: [], subMetas: {}, userData: { type: 'raw', fixAlphaTransparencyArtifacts: false, hasAlpha: true } }, null, 2) + '\n');
  }
  existing.atlases = existing.atlases.filter(a => !manifest.atlases.some(b => a.id === b.id)).concat(manifest.atlases);
  if (melee) existing.meleeFxRevision = 'C-044'; else if (flight) existing.flightFxRevision = 'C-043'; else existing.areaFxRevision = 'C-042';
  writeFileSync(resolve(runtime, 'manifest.json'), JSON.stringify(existing, null, 2) + '\n');
}
console.log(JSON.stringify({ atlases: manifest.atlases.length, frames: audit.frames, decodedMiB: audit.decodedBytes / 1048576, pngMiB: audit.pngBytes / 1048576, installed: process.argv.includes('--install') }));
