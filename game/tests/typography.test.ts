import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual presentation class with the two hosts' font-loading
// contracts. The WeChat simulator has a document but no CSS FontFace entries.
const source = fs.readFileSync(path.join(__dirname, '../assets/scripts/presentation/Typography.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
} }).outputText;
function fixture(isBrowser: boolean) {
  const module = { exports: {} as any };
  let cssReady = false, resourceFailure = false, cssReads = 0;
  const fonts = ['R1_DISPLAY', 'R1_BODY'];
  const faces = fonts.map(name => ({ family: `${name}_LABEL`, status: 'loaded' }));
  const cc = {
    Font: class {}, JsonAsset: class {}, Label: class {}, TTFFont: class {}, Vec2: class {},
    sys: { isBrowser },
    resources: { load(url: string, _type: any, done: (error: Error | null, value?: any) => void) {
      if (resourceFailure) return done(new Error('host font unavailable'));
      if (url.endsWith('/manifest')) return done(null, { json: { schemaVersion: 1, assets: fonts.map((name, i) => ({
        id: i ? 'FONT_BODY' : 'FONT_DISPLAY', resource: `r1/fonts/${name}`,
      })) } });
      done(null, { nativeUrl: `${url}.ttf`, name: url.split('/').pop() });
    } },
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, setTimeout, clearTimeout,
    require: (name: string) => { if (name === 'cc') return cc; if (name === './ToyVisuals') return { color: () => ({}) }; throw new Error(name); },
    document: { fonts: {
      forEach(callback: (face: any) => void) { cssReads++; if (cssReady) faces.forEach(callback); },
      async load(css: string) { return faces.filter(face => css.includes(face.family)); },
      check() { return cssReady; },
    } },
  });
  return { typography: new module.exports.Typography('r1/fonts'),
    cssReady() { cssReady = true; }, fail(value: boolean) { resourceFailure = value; }, cssReads: () => cssReads };
}

test('WeChat fonts use the successful host resource load despite an empty simulator FontFaceSet', async () => {
  const f = fixture(false); await f.typography.load();
  const report = f.typography.report();
  assert.equal(report.loaded.length, 2); assert.equal(report.errors.length, 0);
  assert.equal(f.cssReads(), 0);
});

test('Web fonts still require real loaded FontFace entries', async () => {
  const f = fixture(true); await f.typography.load();
  assert.equal(f.typography.report().loaded.length, 0);
  assert.match(f.typography.report().errors.join('\n'), /Creator CSS FontFace absent/);
  f.cssReady(); await f.typography.load();
  const report = f.typography.report();
  assert.equal(report.errors.length, 0); assert.equal(report.loaded.length, 2);
  assert.ok(report.fonts.every((font: any) => font.webReadiness.loadedFaces === 1));
});

test('A genuine host resource failure is reported and can recover on retry', async () => {
  const f = fixture(false); f.fail(true); await f.typography.load();
  assert.match(f.typography.report().errors.join('\n'), /host font unavailable/);
  assert.equal(f.typography.report().loaded.length, 0);
  f.fail(false); await f.typography.load();
  assert.equal(f.typography.report().errors.length, 0);
  assert.equal(f.typography.report().loaded.length, 2);
});
