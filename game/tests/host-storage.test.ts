import test from 'node:test';
import assert from 'node:assert/strict';
import { gameStorage } from '../assets/scripts/presentation/HostStorage';
import { R1Session, R1_SAVE_KEY, LEGACY_SAVE_KEY } from '../assets/scripts/domain/r1/session';

class WeChatStorage {
  values = new Map<string, unknown>(); writes = 0;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? ''; }
  setItem(key: string, value: string) { this.writes++; this.values.set(key, value); }
}

test('A new WeChat account can start, save, restore and detect concurrent updates', () => {
  const host = new WeChatStorage(), session = new R1Session(gameStorage(host));
  assert.equal(session.error, ''); assert.equal(host.writes, 0);
  assert.equal(session.start(1, 9301), true);
  const restored = new R1Session(gameStorage(host));
  assert.equal(restored.error, ''); assert.deepEqual(restored.data, session.data);
  const stale = new R1Session(gameStorage(host));
  assert.equal(restored.pause(true), true);
  const durable = host.getItem(R1_SAVE_KEY);
  assert.equal(stale.pause(true), false);
  assert.match(stale.error, /其它窗口已更新存档/);
  assert.equal(host.getItem(R1_SAVE_KEY), durable);
});

test('Existing empty and malformed host records stay protected from writes', () => {
  for (const key of [R1_SAVE_KEY, LEGACY_SAVE_KEY]) for (const value of ['', {}, '{broken']) {
    const host = new WeChatStorage(); host.values.set(key, value);
    const session = new R1Session(gameStorage(host));
    assert.notEqual(session.error, ''); assert.equal(session.start(1, 9302), false);
    assert.equal(host.writes, 0); assert.equal(host.getItem(key), value);
  }
});

test('WeChat migration retains the exact legacy save and hero levels', () => {
  const host = new WeChatStorage();
  const raw = JSON.stringify({ schema: 1, profile: { heroes: {
    H001: { level: 2 }, H002: { level: 3 }, H003: { level: 4 }, H004: { level: 5 },
  } } });
  host.values.set(LEGACY_SAVE_KEY, raw);
  const session = new R1Session(gameStorage(host));
  assert.equal(session.error, ''); assert.equal(session.data.legacyBackup, raw);
  assert.equal(session.data.migration, 'imported');
  assert.equal(session.start(1, 9303), true);
  assert.equal(host.getItem(LEGACY_SAVE_KEY), raw);
  assert.deepEqual(new R1Session(gameStorage(host)).data.profile.levels, session.data.profile.levels);
});
