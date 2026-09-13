#!/usr/bin/env node
/** Read-only application check against the installed Creator's actual cc.d.ts. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const creator = path.resolve(process.argv[2] || process.env.COCOS_CREATOR_APP || '/Applications/Cocos/Creator/3.8.8/CocosCreator.app');
const engine = path.join(creator, 'Contents/Resources/resources/3d/engine');
const declaration = path.join(engine, 'bin/.declarations/cc.d.ts');
if (!fs.existsSync(declaration)) {
  console.error(`Creator 类型声明不存在：${declaration}`);
  console.error('请将真实 CocosCreator.app 路径作为第一个参数传入；本工具不创建或替代引擎声明。');
  process.exit(2);
}
const version = JSON.parse(fs.readFileSync(path.join(engine, 'package.json'), 'utf8')).version;
const scripts = path.join(root, 'game/assets/scripts');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}
const files = walk(scripts).sort();
if (!files.some(file => file.includes(`${path.sep}presentation${path.sep}`))) {
  console.error('尚无 presentation 源码，不能把空检查当作 Cocos UI 校验通过。');
  process.exit(2);
}
const program = ts.createProgram([...files, declaration], {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
  types: [], strict: true, esModuleInterop: true, skipLibCheck: true,
  experimentalDecorators: true, useDefineForClassFields: false, noEmit: true,
  resolveJsonModule: true,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  }));
  process.exit(1);
}
console.log(`Cocos Creator ${version} 实际声明检查通过：${files.length} 个项目 TS 文件。`);
console.log(`类型源：${declaration}`);
console.log('此检查只证明 TypeScript API 兼容；不代替编辑器导入、Web 运行或真机验收。');
