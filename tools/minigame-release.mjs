#!/usr/bin/env node
/** Prepare and build isolated mini-game packages; never uploads or edits source art. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { verifyStartupBranding } from './verify-startup-branding.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'game');
const target = process.argv[2] || 'wechatgame';
const platforms = target === 'all' ? ['wechatgame', 'bytedance-mini-game'] : [target];
if (platforms.some(p => !['wechatgame', 'bytedance-mini-game'].includes(p))) throw Error('Use all, wechatgame or bytedance-mini-game');
const testAppId = process.argv.includes('--test-appid');
const prepareOnly = process.argv.includes('--prepare-only');
const localFile = path.join(root, 'release.local.json');
const local = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : {};
const appIds = {
  wechatgame: process.env.WECHAT_APP_ID || local.wechatAppId,
  'bytedance-mini-game': process.env.DOUYIN_APP_ID || local.douyinAppId,
};
const testIds = { wechatgame: 'wx6ac3f5090a6b99c5', 'bytedance-mini-game': 'testappId' };
for (const platform of platforms) {
  if (!appIds[platform] && testAppId) appIds[platform] = testIds[platform];
  if (!appIds[platform]) throw Error(`Missing ${platform} AppID. Configure release.local.json; --test-appid is for local investigation only.`);
  const valid = platform === 'wechatgame' ? /^wx[0-9a-fA-F]{16}$/.test(appIds[platform]) : /^tt[A-Za-z0-9]{8,}$/.test(appIds[platform]);
  if ((!valid || appIds[platform] === testIds[platform]) && !(testAppId && appIds[platform] === testIds[platform])) throw Error(`Invalid or example AppID for ${platform}`);
}

const creatorApp = process.env.COCOS_CREATOR_APP || '/Applications/Cocos/Creator/3.8.8/CocosCreator.app';
const creator = process.env.COCOS_CREATOR || path.join(creatorApp, 'Contents/MacOS/CocosCreator');
if (!fs.existsSync(creator)) throw Error('Creator is required. Set COCOS_CREATOR_APP.');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
const MiB = 1024 * 1024;
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const output = path.join(root, 'artifacts/minigames', stamp);
const project = path.join(output, 'game');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.name === '.DS_Store' ? [] : entry.isDirectory() ? files(file) : [file];
  });
}
function treeHash(directory) {
  const hash = createHash('sha256');
  for (const file of files(directory)) { hash.update(path.relative(directory, file)); hash.update(fs.readFileSync(file)); }
  return hash.digest('hex');
}
const sourceHash = treeHash(path.join(source, 'assets'));
fs.mkdirSync(project, { recursive: true });
for (const name of ['assets', 'settings', 'package.json', 'tsconfig.json']) {
  const from = path.join(source, name);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(project, name), { recursive: true });
}
// Same opt-in recovery as cocos-build.mjs for Creator's intermittent '*' importer.
// Reuse only imported resources/database, never compiled scripts or old builds.
const importCacheSource = process.env.COCOS_IMPORT_CACHE ? path.resolve(process.env.COCOS_IMPORT_CACHE) : null;
if (importCacheSource) {
  const meta = path.join(importCacheSource, 'assets/scenes/Boot.scene.meta');
  if (!fs.existsSync(meta) || json(meta).importer !== 'scene'
    || !fs.existsSync(path.join(importCacheSource, 'library')) || !fs.existsSync(path.join(importCacheSource, 'temp/asset-db')))
    throw Error('COCOS_IMPORT_CACHE must point to an isolated project with valid scene imports.');
  for (const relative of ['library', 'temp/asset-db']) {
    fs.mkdirSync(path.dirname(path.join(project, relative)), { recursive: true });
    fs.cpSync(path.join(importCacheSource, relative), path.join(project, relative), { recursive: true });
  }
}
const resources = path.join(project, 'assets/resources');
const r1Build = fs.existsSync(path.join(resources, 'r1/manifest.json'));
const record = { createdAt: new Date().toISOString(), source, sourceHash, project, importCacheSource, stage: 'preparing',
  creatorVersion: json(path.join(source, 'package.json')).creator.version,
  designVersion: r1Build ? json(path.join(source, 'assets/scripts/domain/r1/runtime-config.json')).version : json(path.join(resources, 'prototype-v0.5.json')).design_version,
  textureEncoding: { format: 'png', palette: true, quality: 90, resize: false, sharpVersion: sharp.versions.sharp },
  audioEncoding: { format: 'mp3', effectsVbrQuality: 4, musicBitrate: '112k' }, images: [], audio: [], bundles: [], builds: [],
  limitations: ['AppID ownership and permissions require the platform backend', 'No real-device acceptance yet',
    'Rewarded ads remain disabled on mini-game hosts',
    ...(platforms.includes('bytedance-mini-game') ? ['Douyin sidebar navigation needs device acceptance for each new candidate'] : []),
    'Platform-specific qualification and filing requirements must be verified in the account backend before final submission'],
};
const recordPath = path.join(output, 'release-report.json');
if (r1Build) {
  // The R1 entry uses its own art/fonts. Remove unused legacy payload only from
  // this disposable build copy; legacy source, audio and save migration remain.
  record.excludedLegacyResources = ['mvp/art', 'mvp/fonts'];
  for (const relative of record.excludedLegacyResources) {
    fs.rmSync(path.join(resources, relative), { recursive: true, force: true });
    fs.rmSync(path.join(resources, `${relative}.meta`), { force: true });
  }
}
writeJson(recordPath, record);
console.log(`Preparing isolated mini-game project: ${project}`);

try {
  // Convert only the disposable release snapshot. Keep UUIDs, dimensions and frame rects.
  const cache = path.join(root, `artifacts/minigames/png-cache-q90-${sharp.versions.sharp}`);
  fs.mkdirSync(cache, { recursive: true });
  for (const file of files(resources).filter(file => file.endsWith('.png'))) {
    const input = fs.readFileSync(file), inputHash = createHash('sha256').update(input).digest('hex');
    const cached = path.join(cache, `${inputHash}.png`);
    if (!fs.existsSync(cached)) await sharp(input).png({ palette: true, quality: 90, effort: 10, compressionLevel: 9, dither: 0.75 }).toFile(cached);
    const before = await sharp(input).metadata(), after = await sharp(cached).metadata();
    if (before.width !== after.width || before.height !== after.height) throw Error(`Image dimensions changed: ${file}`);
    if (fs.statSync(cached).size < input.length) fs.copyFileSync(cached, file);
    record.images.push({ resource: path.relative(resources, file), inputSha256: inputHash, width: before.width, height: before.height, before: input.length, after: fs.statSync(file).size });
  }

  // Keep the existing MP3 resource UUIDs; encode music from the source OGG.
  const audioFile = path.join(resources, 'mvp/audio/manifest.json'), audio = json(audioFile);
  for (const entry of audio.assets) {
    if (!entry.file?.endsWith('.ogg')) continue;
    const mp3Resource = entry.fallbackResources?.find(url => fs.existsSync(path.join(resources, `${url}.mp3`)));
    if (!mp3Resource) continue;
    const oldResource = entry.resource;
    const old = path.join(resources, `${oldResource}.ogg`);
    const mp3File = path.join(resources, `${mp3Resource}.mp3`);
    const before = fs.statSync(mp3File).size;
    execFileSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', old, '-codec:a', 'libmp3lame', '-b:a', '112k', mp3File], { stdio: 'pipe' });
    record.audio.push({ id: entry.id, resource: mp3Resource, sourceResource: oldResource, before, after: fs.statSync(mp3File).size });
    entry.resource = mp3Resource; entry.file = `${mp3Resource}.mp3`;
    entry.fallbackResources = entry.fallbackResources.filter(url => url !== mp3Resource);
    const otherUsesOld = audio.assets.some(item => item.resource === oldResource || item.variants?.includes(oldResource) || item.fallbackResources?.includes(oldResource));
    if (!otherUsesOld && fs.existsSync(old)) {
      record.audio.push({ id: entry.id, resource: mp3Resource, removedDuplicateBytes: fs.statSync(old).size });
      fs.unlinkSync(old); if (fs.existsSync(`${old}.meta`)) fs.unlinkSync(`${old}.meta`);
    }
  }
  for (const file of files(path.join(resources, 'mvp/audio')).filter(file => file.endsWith('.wav'))) {
    const destination = file.replace(/\.wav$/, '.mp3'), before = fs.statSync(file).size;
    execFileSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-codec:a', 'libmp3lame', '-q:a', '4', destination], { stdio: 'pipe' });
    const metadata = json(`${file}.meta`);
    metadata.files = metadata.files.map(extension => extension === '.wav' ? '.mp3' : extension);
    writeJson(`${destination}.meta`, metadata);
    fs.unlinkSync(file); fs.unlinkSync(`${file}.meta`);
    record.audio.push({ resource: path.relative(resources, destination), before, after: fs.statSync(destination).size });
  }
  for (const entry of audio.assets) if (entry.file?.endsWith('.wav')) entry.file = entry.file.replace(/\.wav$/, '.mp3');
  writeJson(audioFile, audio);

  // Creator preloads the built-in resources bundle before Boot. Its native
  // subpackage loader preserves every existing resources.load path.
  const builderFile = path.join(project, 'settings/v2/packages/builder.json'), builder = json(builderFile);
  builder.bundleConfig ??= {}; builder.bundleConfig.custom ??= {};
  builder.bundleConfig.custom.release_subpackage = { displayName: 'Mini-game local resources', configs: {
    miniGame: { configMode: 'overwrite', fallbackOptions: { compressionType: 'merge_all_json', isRemote: false },
      overwriteSettings: Object.fromEntries(['wechatgame', 'bytedance-mini-game'].map(platform => [platform, { compressionType: 'subpackage', isRemote: false }])) },
    web: { preferredOptions: { compressionType: 'merge_all_json', isRemote: false } },
    native: { preferredOptions: { compressionType: 'merge_all_json', isRemote: false } },
  } };
  writeJson(builderFile, builder);
  const resourceMeta = json(`${resources}.meta`);
  resourceMeta.userData.bundleConfigID = 'release_subpackage';
  writeJson(`${resources}.meta`, resourceMeta);
  record.bundles.push({ name: 'resources', root: 'db://assets/resources',
    payloadBytes: files(resources).filter(file => !file.endsWith('.meta')).reduce((sum, file) => sum + fs.statSync(file).size, 0) });

  // The accepted game uses Cocos UI, audio, graphics and its own battle logic.
  // Remove unused engine integrations only in the release snapshot.
  const engineFile = path.join(project, 'settings/v2/packages/engine.json'), engine = json(engineFile);
  const unused = ['dragon-bones', 'particle-2d', 'physics-2d', 'physics-2d-box2d', 'spine', 'spine-3.8', 'tiled-map', 'video', 'webview'];
  for (const config of Object.values(engine.modules.configs)) {
    config.includeModules = config.includeModules.filter(module => !unused.includes(module));
    for (const module of unused) if (config.cache[module]) config.cache[module]._value = false;
  }
  writeJson(engineFile, engine); record.excludedEngineModules = unused;
  const scene = json(path.join(project, 'assets/scenes/Boot.scene.meta'));
  for (const platform of platforms) {
    const configPath = path.join(output, `${platform}.json`);
    const config = { name: '超力英雄', platform, buildPath: 'project://build', outputName: platform,
      taskName: `${platform}-release-probe`, debug: false, sourceMaps: false, md5Cache: true,
      startScene: scene.uuid, scenes: [{ url: 'db://assets/scenes/Boot.scene', uuid: scene.uuid }],
      packages: { [platform]: { appid: appIds[platform], orientation: 'portrait' } } };
    writeJson(configPath, config);
    const build = { platform, configPath, appid: appIds[platform], usesTestAppId: appIds[platform] === testIds[platform], status: 'prepared' };
    record.builds.push(build); writeJson(recordPath, record);
    if (prepareOnly) continue;
    build.logPath = path.join(output, `${platform}.log`);
    build.startedAt = new Date().toISOString();
    const log = fs.openSync(build.logPath, 'w');
    console.log(`Building ${platform}. Log: ${build.logPath}`);
    const code = await new Promise((resolve, reject) => {
      const child = spawn(creator, ['--project', project, '--build', `configPath=${configPath}`], { stdio: ['ignore', log, log] });
      child.on('error', reject); child.on('close', resolve);
    }).finally(() => fs.closeSync(log));
    build.exitCode = code; build.finishedAt = new Date().toISOString();
    if (code !== 36) throw Error(`Creator build failed (${code}); see ${build.logPath}`);
    if (json(path.join(project, 'assets/scenes/Boot.scene.meta')).importer !== 'scene') {
      build.status = 'failed-invalid-scene-importer';
      throw Error('Creator changed the Boot scene importer; this output is not a valid game build');
    }
    build.directory = path.join(project, 'build', platform);
    build.startupBranding = verifyStartupBranding(project, build.directory, platform);
    if (platform === 'bytedance-mini-game') {
      const entry = path.join(build.directory, 'game.js');
      const bootstrap = path.join(root, 'tools/templates/douyin-sidebar.js');
      fs.copyFileSync(bootstrap, path.join(build.directory, 'douyin-sidebar.js'));
      fs.writeFileSync(entry, `require('./douyin-sidebar.js');\n${fs.readFileSync(entry, 'utf8')}`);
      build.sidebarBootstrapSha256 = createHash('sha256').update(fs.readFileSync(bootstrap)).digest('hex');
    }
    const gameConfig = json(path.join(build.directory, 'game.json'));
    const projectConfig = json(path.join(build.directory, 'project.config.json'));
    if (gameConfig.deviceOrientation !== 'portrait' || projectConfig.appid !== appIds[platform]) throw Error('Generated platform configuration mismatch');
    const subpackages = gameConfig.subpackages || gameConfig.subPackages || [];
    if (subpackages.length !== record.bundles.length) throw Error(`Expected ${record.bundles.length} subpackages, received ${subpackages.length}`);
    const roots = subpackages.map(pkg => ({ name: pkg.name, root: pkg.root.replace(/\/$/, '') }));
    build.totalBytes = 0; build.mainBytes = 0; build.subpackages = roots.map(pkg => ({ ...pkg, bytes: 0 }));
    for (const file of files(build.directory)) {
      const relative = path.relative(build.directory, file), bytes = fs.statSync(file).size;
      const subpackage = build.subpackages.find(pkg => relative.startsWith(`${pkg.root}/`));
      build.totalBytes += bytes;
      if (subpackage) subpackage.bytes += bytes; else build.mainBytes += bytes;
    }
    build.budgetBytes = { main: 4 * MiB, total: (platform === 'wechatgame' ? 30 : 20) * MiB, subpackage: 20 * MiB };
    build.withinConservativeBudget = build.mainBytes <= build.budgetBytes.main && build.totalBytes <= build.budgetBytes.total && build.subpackages.every(pkg => pkg.bytes <= build.budgetBytes.subpackage);
    build.treeSha256 = treeHash(build.directory);
    build.status = build.withinConservativeBudget ? 'built-awaiting-ide-and-device-tests' : 'built-over-budget';
    console.log(`${platform}: main ${(build.mainBytes / MiB).toFixed(2)} MiB; total ${(build.totalBytes / MiB).toFixed(2)} MiB; ${build.status}`);
    writeJson(recordPath, record);
  }
  if (json(path.join(project, 'assets/scenes/Boot.scene.meta')).importer !== 'scene') throw Error('Boot scene importer changed during build');
  record.stage = prepareOnly ? 'prepared' : 'built';
  if (record.builds.some(build => build.withinConservativeBudget === false)) process.exitCode = 1;
} catch (error) {
  record.stage = 'failed'; record.error = String(error); process.exitCode = 1;
  console.error(error);
} finally {
  record.sourceHashAtEnd = treeHash(path.join(source, 'assets'));
  record.sourceUnchanged = record.sourceHashAtEnd === sourceHash;
  record.finishedAt = new Date().toISOString();
  if (!record.sourceUnchanged) { record.stage = 'source-changed-review-required'; process.exitCode = 1; }
  writeJson(recordPath, record);
  console.log(`Report: ${recordPath}`);
}
