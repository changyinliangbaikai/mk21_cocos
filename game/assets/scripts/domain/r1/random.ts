/** Saved, independent streams. Never use Math.random in gameplay or transactions. */
export type Stream = 'spawn' | 'card' | 'replacement' | 'reward';
export type RandomState = Record<Stream, number>;
export function streams(seed: number): RandomState {
  const mix = (salt: number) => ((seed ^ salt) >>> 0) || 0x6d2b79f5;
  return { spawn: mix(0x9e3779b9), card: mix(0x85ebca6b), replacement: mix(0xc2b2ae35), reward: mix(0x27d4eb2f) };
}
export function random(state: RandomState, key: Stream): number {
  let n = state[key]; n ^= n << 13; n ^= n >>> 17; n ^= n << 5;
  state[key] = n >>> 0; return state[key] / 0x100000000;
}
export function pick<T>(values: readonly T[], state: RandomState, key: Stream): T {
  if (!values.length) throw new Error('Cannot sample empty pool');
  return values[Math.floor(random(state, key) * values.length)];
}
export function weighted<T>(values: readonly { value: T; weight: number }[], state: RandomState, key: Stream): T {
  const valid = values.filter(v => v.weight > 0), total = valid.reduce((n, v) => n + v.weight, 0);
  if (!total) throw new Error('Cannot sample empty weighted pool');
  let roll = random(state, key) * total;
  for (const item of valid) { roll -= item.weight; if (roll < 0) return item.value; }
  return valid[valid.length - 1].value;
}
export function shuffle<T>(values: readonly T[], state: RandomState, key: Stream): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random(state, key) * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
