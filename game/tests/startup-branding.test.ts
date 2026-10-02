import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('C037 release rejects a successful Creator build that silently restores Cocos branding', async () => {
  const { verifyStartupBranding } = await import(pathToFileURL(path.resolve(__dirname,'../../tools/verify-startup-branding.mjs')).href);
  const project=fs.mkdtempSync(path.join(os.tmpdir(),'r1-branding-')),build=path.join(project,'build');
  try {
    fs.mkdirSync(path.join(project,'settings/v2/packages'),{recursive:true}); fs.mkdirSync(path.join(build,'src'),{recursive:true});
    fs.writeFileSync(path.join(project,'settings/v2/packages/builder.json'),JSON.stringify({'splash-setting':{logo:{type:'custom'}}}));
    const settings=path.join(build,'src/settings.test.json');
    fs.writeFileSync(settings,JSON.stringify({splashScreen:{logo:{type:'default'}}}));
    assert.throws(()=>verifyStartupBranding(project,build,'web-mobile'),/fell back/);
    fs.writeFileSync(settings,JSON.stringify({splashScreen:{logo:{type:'custom'}}}));
    fs.writeFileSync(path.join(build,'first-screen.js'),'let useDefaultLogo = true;\nlet useLogo = true;');
    assert.throws(()=>verifyStartupBranding(project,build,'wechatgame'),/default engine branding/);
    fs.writeFileSync(path.join(build,'first-screen.js'),'let useDefaultLogo = false;\nlet useLogo = true;');
    assert.equal(verifyStartupBranding(project,build,'wechatgame').verified,true);
  } finally { fs.rmSync(project,{recursive:true,force:true}); }
});
