import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const bootstrap = fs.readFileSync(path.resolve(__dirname, '../../tools/templates/douyin-sidebar.js'), 'utf8');
const sidebarLaunch = { launch_from: 'homepage', location: 'sidebar_card', scene: '021036' };
function host(overrides: any = {}) {
  let show: (options: any) => void = () => {};
  let navigation: any;
  const calls: string[] = [];
  const tt = {
    onShow(callback: typeof show) { calls.push('onShow'); show = callback; },
    getLaunchOptionsSync() { calls.push('launch'); return {}; },
    checkScene(options: any) { calls.push('check'); assert.equal(options.scene, 'sidebar'); options.success({ isExist: true }); },
    navigateToScene(options: any) { navigation = options; }, ...overrides,
  };
  const context: any = { tt, GameGlobal: {} };
  vm.runInNewContext(bootstrap, context);
  return { state: context.GameGlobal.__heroDefenseSidebar, show: (options: any) => show(options), calls, context, navigation: () => navigation };
}

test('listener is registered before startup probing and receives warm entries after scene loading', () => {
  const h = host();
  assert.deepEqual(h.calls, ['onShow', 'launch', 'check']);
  assert.equal(h.state.available, true);
  h.show(sidebarLaunch);
  assert.equal(h.state.fromSidebar, true);
  h.show({ scene: '021001' });
  assert.equal(h.state.fromSidebar, false);
  h.show({ launch_from: 'homepage', location: 'not_sidebar' });
  assert.equal(h.state.fromSidebar, false);
});

test('initial sidebar entry is retained and a synchronous onShow wins over stale cold-launch data', () => {
  assert.equal(host({ getLaunchOptionsSync: () => sidebarLaunch }).state.fromSidebar, true);
  const h = host({ onShow: (cb: Function) => cb(sidebarLaunch) });
  assert.equal(h.state.fromSidebar, true);
  assert.equal(h.calls.includes('launch'), false);
});

test('absent, unsupported and failing host capabilities do not expose a dead entry', () => {
  for (const overrides of [
    { navigateToScene: undefined }, { onShow: undefined },
    { checkScene: (o: any) => o.success({ isExist: false }) },
    { checkScene: (o: any) => o.fail({}) }, { checkScene: () => { throw Error('unsupported'); } },
  ]) assert.equal(host(overrides).state.available, false);
  assert.doesNotThrow(() => vm.runInNewContext(bootstrap, {}));
});

test('navigation waits for real host entry and failure leaves a retryable state', () => {
  const h = host();
  let failures = 0;
  h.state.navigate(() => failures++);
  assert.equal(h.state.busy, true);
  assert.equal(h.navigation().scene, 'sidebar');
  h.navigation().success();
  assert.equal(h.state.fromSidebar, false);
  h.state.navigate(() => failures++);
  h.navigation().fail({});
  assert.equal(h.state.busy, false);
  assert.equal(failures, 1);
  assert.ok(h.state.error);
  h.state.navigate();
  h.show(sidebarLaunch);
  assert.equal(h.state.busy, false);
  assert.equal(h.state.error, '');
  assert.equal(h.state.fromSidebar, true);
});

test('reloading the bootstrap cannot accumulate lifecycle listeners', () => {
  const h = host();
  vm.runInNewContext(bootstrap, h.context);
  assert.equal(h.calls.filter(c => c === 'onShow').length, 1);
});
