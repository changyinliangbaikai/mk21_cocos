import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Creator can exit successfully after silently falling back to its default logo. */
export function verifyStartupBranding(project, directory, platform) {
  const expected = JSON.parse(readFileSync(join(project, 'settings/v2/packages/builder.json'), 'utf8'))['splash-setting'];
  if (expected?.logo?.type !== 'custom') return { required: false, verified: false };
  const file = readdirSync(join(directory, 'src')).find(name => /^settings(?:\.[\w-]+)?\.json$/.test(name));
  if (!file) throw Error('Missing startup settings; cannot verify the custom loading screen.');
  const actual = JSON.parse(readFileSync(join(directory, 'src', file), 'utf8')).splashScreen;
  if (actual?.logo?.type !== 'custom') throw Error('Custom splash was not enabled: Creator fell back to its default logo. Complete Project Settings > Splash Setting in Creator and rebuild.');
  if (platform === 'wechatgame') {
    const firstScreen = readFileSync(join(directory, 'first-screen.js'), 'utf8');
    if (!/let useDefaultLogo = false;/.test(firstScreen) || !/let useLogo = true;/.test(firstScreen))
      throw Error('WeChat first-screen still uses the default engine branding.');
  }
  return { required: true, verified: true, logo: actual.logo.type, settingsFile: file };
}
