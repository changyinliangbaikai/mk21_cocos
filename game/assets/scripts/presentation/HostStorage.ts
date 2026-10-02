import type { StoragePort } from '../domain/r1/session';

export interface HostStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): unknown;
  setItem(key: string, value: string): void;
}

/** Cocos' WeChat adapter returns '' for absent keys. Preserve existing empty or
 * malformed values so the session can reject them without erasing progress. */
export function gameStorage(host: HostStorage): StoragePort {
  return {
    getItem(key) {
      const value = host.getItem(key);
      if (value === '' || value == null) {
        let exists = false;
        for (let i = 0; i < host.length; i++) if (host.key(i) === key) { exists = true; break; }
        if (!exists) return null;
      }
      if (typeof value !== 'string') throw new Error('存档内容类型无效，已保留原始数据');
      return value;
    },
    setItem(key, value) { host.setItem(key, value); },
  };
}
