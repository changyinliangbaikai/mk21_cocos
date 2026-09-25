"""Rebuild renamed OFL font subsets from runtime strings; no design-library dependency."""
from pathlib import Path
import hashlib
import json
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/art/production/mvp-v1/typography-v003/sources'
DEST = ROOT / 'game/assets/resources/r1/fonts'
inputs = list((ROOT / 'game/assets/scripts/domain/r1').glob('*.json'))
inputs += list((ROOT / 'game/assets/scripts/domain/r1').glob('*.ts'))
inputs += list((ROOT / 'game/assets/scripts/presentation').glob('R1*.ts'))
chars = set(chr(n) for n in range(32, 127))
for path in inputs:
    chars.update(c for c in path.read_text() if ord(c) >= 32 and not c.isspace())
report = {'schemaVersion': 1, 'assets': [], 'missing': []}
for role, weight in [('DISPLAY', 'Heavy'), ('BODY', 'Medium')]:
    font = TTFont(SOURCE / f'ResourceHanRoundedSC-{weight}.ttf', recalcTimestamp=False)
    missing = sorted(c for c in chars if ord(c) not in font.getBestCmap())
    if missing:
        raise ValueError('Missing source glyphs: ' + ''.join(missing))
    options = subset.Options()
    options.name_IDs = ['*']; options.name_legacy = True; options.name_languages = ['*']
    options.layout_features = ['*']; options.notdef_glyph = True; options.notdef_outline = True
    sub = subset.Subsetter(options=options); sub.populate(text=''.join(sorted(chars))); sub.subset(font)
    family = 'Chaoli R1 ' + role.title(); ps = family.replace(' ', '') + '-Regular'
    names = {1: family, 2: 'Regular', 3: ps + '-R1', 4: family, 5: 'Version 1.0; Chaoli R1 subset', 6: ps, 16: family, 17: 'Regular', 18: family}
    for rec in font['name'].names:
        if rec.nameID in names: rec.string = names[rec.nameID].encode(rec.getEncoding())
    for k, v in names.items(): font['name'].setName(v, k, 3, 1, 0x409)
    target = DEST / f'R1_{role}.ttf'; font.save(target)
    check = TTFont(target); assert all(ord(c) in check.getBestCmap() for c in chars)
    report['assets'].append({'id': 'FONT_' + role, 'resource': 'r1/fonts/R1_' + role, 'family': family, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'glyphs': len(check.getBestCmap())})
(DEST / 'manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
(DEST / 'charset.txt').write_text(''.join(sorted(chars)) + '\n')
print(json.dumps({'fonts': len(report['assets']), 'characters': len(chars), 'missing': []}))
