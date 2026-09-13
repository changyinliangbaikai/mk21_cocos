#!/usr/bin/env node
/** Run the installed Creator, preserving its real exit code and a local build log. */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.argv[2] || 'web-mobile';
if (!['web-desktop', 'web-mobile', 'wechatgame', 'bytedance-mini-game'].includes(platform)) {
  throw new Error('Expected web-desktop, web-mobile, wechatgame or bytedance-mini-game.');
}
const editor = process.env.COCOS_CREATOR || '/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/MacOS/CocosCreator';
const project = resolve(root, 'game');
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const logDirectory = resolve(root, 'artifacts', 'cocos');
mkdirSync(logDirectory, { recursive: true });
const logPath = resolve(logDirectory, `${stamp}-${platform}.log`);
const summaryPath = logPath.replace(/\.log$/, '.json');
const configPath = logPath.replace(/\.log$/, '-config.json');
const options = `configPath=${configPath}`;
const args = ['--project', project, '--build', options];
const summary = { startedAt: new Date().toISOString(), editor, project, platform, args, logPath };
function sourceHash() {
  const hash = createHash('sha256');
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory).sort()) {
      if (name === '.DS_Store') continue;
      const path = resolve(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else { hash.update(path.slice(project.length)); hash.update(readFileSync(path)); }
    }
  };
  visit(resolve(project, 'assets'));
  return hash.digest('hex');
}
function blocked(message) {
  writeFileSync(logPath, `${message}\n`);
  writeFileSync(summaryPath, JSON.stringify({ ...summary, status: 'blocked', error: message }, null, 2));
  console.error(message);
  console.error(`Evidence: ${summaryPath}`);
  process.exit(1);
}
if (!existsSync(editor)) blocked(`Creator executable missing: ${editor}`);
// A GUI editor and a CLI importer must not write this project's asset database
// concurrently. Report only process IDs, never process environments or arguments.
if (process.platform === 'darwin') {
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pids = '';
  try {
    pids = execFileSync('/usr/bin/pgrep', ['-f', `^${escapeRegex(editor)} --project ${escapeRegex(project)}( |$)`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (error) { if (error.status !== 1) blocked('Unable to check existing Creator project processes.'); }
  if (pids) blocked(`This project is already open in Creator (PID ${pids.replaceAll('\n', ', ')}). Close that editor/build normally before running a standalone CLI build.`);
}
if (!existsSync(resolve(project, 'package.json'))) blocked('No editor-created game/package.json exists. Create/open the real Cocos project before building; this script does not create editor metadata.');
const metadata = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8'));
if (!metadata.creator?.version) blocked('game/package.json has no editor-created creator.version.');
const scene = resolve(project, 'assets/scenes/Boot.scene');
if (!existsSync(scene) || !existsSync(`${scene}.meta`)) blocked('The editor-created Boot scene and its metadata are required.');
const sceneMetadata = JSON.parse(readFileSync(`${scene}.meta`, 'utf8'));
if (!/^[0-9a-f-]{36}$/i.test(sceneMetadata.uuid || '')) blocked('Boot.scene.meta has no valid existing UUID.');
const buildConfig = { platform, debug: true, outputName: platform, buildPath: 'project://build',
  startScene: sceneMetadata.uuid, scenes: [{ url: 'db://assets/scenes/Boot.scene', uuid: sceneMetadata.uuid }] };
writeFileSync(configPath, JSON.stringify(buildConfig, null, 2));
summary.configPath = configPath;
summary.bootScene = { path: scene, uuid: sceneMetadata.uuid, importerBeforeBuild: sceneMetadata.importer };
summary.creatorVersion = metadata.creator.version;
summary.sourceHashAtStart = sourceHash();
const log = createWriteStream(logPath);
log.write(`${JSON.stringify(summary, null, 2)}\n`);
console.log(`Building ${platform} with Cocos Creator ${summary.creatorVersion}. Log: ${logPath}`);
const child = spawn(editor, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', chunk => { log.write(chunk); if (process.env.COCOS_VERBOSE === '1') process.stdout.write(chunk); });
}
child.on('error', error => {
  log.end(`${error.stack}\n`);
  writeFileSync(summaryPath, JSON.stringify({ ...summary, status: 'failed', error: error.message }, null, 2));
  process.exitCode = 1;
});
child.on('close', (code, signal) => {
  const entry = resolve(project, 'build', platform, platform.startsWith('web-') ? 'index.html' : 'game.js');
  const entryExists = existsSync(entry);
  // Creator's documented success exit code is 36, not the shell's usual 0.
  const sceneImporterAfterBuild = JSON.parse(readFileSync(`${scene}.meta`, 'utf8')).importer;
  const success = code === 36 && entryExists && sceneImporterAfterBuild === 'scene';
  const result = {
    ...summary, finishedAt: new Date().toISOString(), exitCode: code, signal,
    status: success ? 'built' : 'failed', entry, entryExists,
    entryBytes: entryExists ? statSync(entry).size : null,
    sceneImporterAfterBuild,
    sourceHashAtEnd: sourceHash(),
    entrySha256: entryExists ? createHash('sha256').update(readFileSync(entry)).digest('hex') : null,
  };
  result.sourceChangedDuringBuild = result.sourceHashAtEnd !== result.sourceHashAtStart;
  log.end(`\n${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(summaryPath, JSON.stringify(result, null, 2));
  console.log(`\nCreator exit ${code}; ${result.status}. Evidence: ${summaryPath}`);
  process.exitCode = success ? 0 : 1;
});
