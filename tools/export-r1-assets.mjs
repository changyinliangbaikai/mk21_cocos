#!/usr/bin/env node
/** Technical atlas export of C-026 approved artwork. Runtime never imports the ignored design library. */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
const root = resolve(import.meta.dirname, '..');
const source = resolve(process.argv[2] || resolve(root, 'design-library'));
const dest = resolve(root, 'game/assets/resources/r1');
// A base-art re-export must preserve independently reviewed roster expansions.
const expansionId = id => /^(?:FX-|PORTRAIT-|IC-)?RH(?:0[7-9]|10)$/.test(id);
const previous = existsSync(resolve(dest, 'manifest.json')) ? JSON.parse(readFileSync(resolve(dest, 'manifest.json'), 'utf8')) : { atlases: [] };
const cardsPath = resolve(root, 'game/assets/scripts/domain/r1/ui-cards.json');
const currentCards = existsSync(cardsPath) ? JSON.parse(readFileSync(cardsPath, 'utf8')) : [];
const expansionCards = currentCards.filter(c => /^RH(?:0[7-9]|10)$/.test(c.hero || ''));
// C-041 radius upgrades are runtime-owned copy; the original art catalog still describes target counts.
const areaCards = new Map(currentCards.filter(c => /-S1-L[2-5]$/.test(c.id) && c.lines?.some(line => line.includes('群攻半径'))).map(c => [c.id, c]));
const read = p => JSON.parse(readFileSync(resolve(source, p), 'utf8'));
mkdirSync(resolve(dest, 'art'), { recursive: true }); mkdirSync(resolve(dest, 'fonts'), { recursive: true });
const manifest = { schemaVersion: 1, approval: 'C-026', atlases: [], audioEvents: read('04-素材资产/audio/event-map.json').events };
const originals = read('04-素材资产/atlas-catalog.json').assets;
const all = [...originals, ...read('04-素材资产/production-v01/catalog.json').assets, ...read('04-素材资产/enemy-production-v01/catalog.json').assets];
for (const a of all) {
  const actor = ['hero', 'enemy', 'summon'].includes(a.kind), fx = a.kind.includes('fx');
  const id = (fx ? 'FX-' : '') + a.id;
  const cell = actor ? a.id.startsWith('RM') ? 96 : 192 : a.kind === 'icon' || a.id === 'UI-ICONS' ? 160 : fx ? a.id.startsWith('GLOBAL') ? 256 : 192 : a.id === 'UI-CARDS' ? 400 : a.id === 'UI-PANELS' || a.id === 'UI-VICTORY' ? 512 : 256;
  const image = readFileSync(resolve(source, a.file)), frames = [], layers = [];
  const refHeight = actor ? a.frames[a.kind === 'summon' ? 2 : 0].visibleRect[3] : 1;
  let cursorX = 2, cursorY = 2, rowHeight = 0, usedWidth = 0;
  for (const f of a.frames) {
    const [left, top, width, height] = f.visibleRect;
    const factor = Math.min((cell - 4) / width, (cell - 4) / height, 1), w = Math.max(1, Math.round(width * factor)), h = Math.max(1, Math.round(height * factor));
    if (cursorX + w + 2 > 1024) { cursorX = 2; cursorY += rowHeight + 4; rowHeight = 0; }
    const x = cursorX, y = cursorY;
    cursorX += w + 4; rowHeight = Math.max(rowHeight, h); usedWidth = Math.max(usedWidth, x + w + 2);
    const input = await sharp(image).extract({ left, top, width, height }).resize(w, h).png().toBuffer(); layers.push({ input, left: x, top: y });
    frames.push({ rect: [x, y, w, h], ratio: width / height, widthRatio: width / refHeight, heightRatio: height / refHeight,
      anchor: actor ? [(f.rect[0] + f.pivotInCell[0] - left) / width, (top + height - f.rect[1] - f.pivotInCell[1]) / height] : [.5, .5] });
  }
  const file = `art/${id}.png`;
  const height = cursorY + rowHeight + 2;
  if (height > 2048) throw new Error(`Atlas exceeds 2048: ${id}`);
  await sharp({ create: { width: usedWidth, height, channels: 4, background: '#00000000' } }).composite(layers).png({ compressionLevel: 9, palette: false }).toFile(resolve(dest, file));
  manifest.atlases.push({ id, resource: 'r1/' + file.replace('.png', ''), group: actor || fx ? 'battle' : 'ui', frames,
    kind: a.kind, clips: a.clips || {}, displayHeight: (a.displayHeightAt941pxWide || 100) * 720 / 941,
    sourceSha256: createHash('sha256').update(image).digest('hex'), bytes: statSync(resolve(dest, file)).size });
}
const singles = [{ id: 'BG-BATTLE', path: 'backgrounds/battle/v01/source.png', max: 1280 }, { id: 'BG-CAMP', path: 'backgrounds/camp/v01/source.png', max: 1280 },
  { id: 'LOGO', path: 'ui/logo/v01/source.png', max: 420 }, { id: 'GRANDPA', path: 'npc/grandpa/idle.png', max: 360 }];
const bounds = read('04-素材资产/composed-v01/portrait-bounds.json');
for (let i = 1; i <= 6; i++) { const id = `RH0${i}`; singles.push({ id: 'PORTRAIT-' + id, path: `heroes/${id}/portrait/${i <= 4 ? 'reused' : 'v01'}/source.png`, max: 320, crop: bounds[id] }); }
for (const a of singles) {
  const input = readFileSync(resolve(source, '04-素材资产', a.path)); let pipe = sharp(input);
  if (a.crop) { const [x, y, right, bottom] = a.crop; pipe = pipe.extract({ left: x, top: y, width: right - x, height: bottom - y }); }
  const file = `art/${a.id}.png`; const info = await pipe.resize({ width: a.max, height: a.max, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toFile(resolve(dest, file));
  manifest.atlases.push({ id: a.id, resource: 'r1/' + file.replace('.png', ''), group: 'ui', kind: 'single', frames: [{ rect: [0, 0, info.width, info.height], ratio: info.width / info.height, anchor: [.5, .5] }], clips: {}, sourceSha256: createHash('sha256').update(input).digest('hex'), bytes: info.size });
}
// Fonts are rebuilt separately from actual runtime strings with build-r1-fonts.py.
// C-028 walking sheets use one shared scale and ground baseline across all four poses.
const walkCatalog = '04-素材资产/enemy-walk-c028/catalog.json';
if (existsSync(resolve(source, walkCatalog))) for (const a of read(walkCatalog).assets) {
  const input = readFileSync(resolve(source, '04-素材资产/enemy-walk-c028', a.file));
  const frames = [], layers = [], reference = manifest.atlases.find(x => x.id === a.id);
  const factor = Math.min(188 / a.referenceHeight, 188 / Math.max(...a.bounds.map(b => b[2])));
  const rowHeight = Math.ceil(a.referenceHeight * factor) + 4;
  for (let i = 0; i < 4; i++) {
    const [left, top, width, height] = a.bounds[i], w = Math.max(1, Math.round(width * factor)), h = Math.max(1, Math.round(height * factor));
    layers.push({ input: await sharp(input).extract({ left, top, width, height }).resize(w, h).png().toBuffer(), left: i * 192 + 2, top: 2 });
    const scale = reference.frames[11].heightRatio / a.referenceHeight;
    frames.push({ rect: [i * 192 + 2, 2, w, h], ratio: width / height, widthRatio: width * scale, heightRatio: height * scale,
      anchor: [.5, (top + height - a.baseline) / height] });
  }
  const file = `art/WALK-${a.id}.png`;
  await sharp({ create: { width: 768, height: rowHeight, channels: 4, background: '#00000000' } }).composite(layers).png().toFile(resolve(dest, file));
  manifest.atlases.push({ id: 'WALK-' + a.id, resource: 'r1/' + file.replace('.png', ''), group: 'battle', kind: 'enemy-walk', frames,
    clips: { move: { frames: [0, 1, 2, 3], secondsPerFrame: .14, loop: true } }, displayHeight: reference.displayHeight,
    sourceSha256: createHash('sha256').update(input).digest('hex'), bytes: statSync(resolve(dest, file)).size });
}
copyFileSync(resolve(root, 'assets/art/production/mvp-v1/typography-v003/LICENSE-ResourceHanRounded.txt'), resolve(dest, 'fonts/LICENSE.txt'));
// Reuse existing, already packaged audio by ID, including its codec fallbacks. No duplicate audio payload.
manifest.atlases.push(...previous.atlases.filter(a => expansionId(a.id) || /^FX-(AREA|FLIGHT|MELEE)-RH/.test(a.id)));
if (previous.areaFxRevision) manifest.areaFxRevision = previous.areaFxRevision;
if (previous.flightFxRevision) manifest.flightFxRevision = previous.flightFxRevision;
if (previous.meleeFxRevision) manifest.meleeFxRevision = previous.meleeFxRevision;
writeFileSync(resolve(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const cardKeys = ['id', 'family', 'kind', 'hero', 'quality', 'title', 'typeLabel', 'badge', 'lines', 'art', 'action', 'details'];
const cards = read('04-素材资产/composed-v01/catalog.json').cards.filter(c => c.kind !== 'attribute' || c.id.endsWith('-attack')).map(c => {
  if (c.kind === 'attribute') return { ...c, id: `${c.hero}-ATTR-all`, family: `${c.hero}-ATTR-all`, title: '全面强化',
    lines: ['攻击基础值+20%', '生命与防御基础值+15%', '同时补充新增生命'],
    art: { kind: 'attribute', hero: c.hero }, details: ['本局同时强化该英雄的攻击、生命上限、防御。', '加算永久等级基础值，可多次叠加；同时补充本次新增生命，不改变永久等级。'] };
  return areaCards.get(c.id) || c;
});
writeFileSync(cardsPath, JSON.stringify([...cards.map(c => Object.fromEntries(cardKeys.filter(k => k in c).map(k => [k, c[k]]))), ...expansionCards], null, 2) + '\n');
console.log(JSON.stringify({ atlases: manifest.atlases.length, regions: manifest.atlases.reduce((n, a) => n + a.frames.length, 0), imageMiB: manifest.atlases.reduce((n, a) => n + a.bytes, 0) / 1048576 }));
