/** Pure callback/timeout boundary; it does not simulate any Creator asset or decoder. */
export interface LoadScheduler {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}
const timers: LoadScheduler = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export type CallbackLoader<T> = (resource: string, complete: (error: Error | null, asset?: T | null) => void) => void;

export function boundedCallbackLoad<T>(resource: string, loader: CallbackLoader<T>, timeoutMs: number, scheduler: LoadScheduler = timers): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { reject(new Error(`audio preload budget exhausted: ${resource}`)); return; }
    let settled = false;
    const finish = (error: Error | null, asset?: T | null): void => {
      if (settled) return;
      settled = true;
      scheduler.clear(timer);
      if (error || asset == null) reject(error ?? new Error(`empty audio resource: ${resource}`));
      else resolve(asset);
    };
    const timer = scheduler.set(() => finish(new Error(`audio load timed out after ${Math.ceil(timeoutMs)} ms: ${resource}`)), timeoutMs);
    try { loader(resource, finish); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

export interface LoadedCandidate<T> { value: T; resource: string; failures: string[] }
export async function firstAvailableAudio<T>(candidates: string[], loader: CallbackLoader<T>, timeoutMs: () => number, scheduler?: LoadScheduler): Promise<LoadedCandidate<T>> {
  const failures: string[] = [];
  for (const resource of candidates) {
    try { return { value: await boundedCallbackLoad(resource, loader, timeoutMs(), scheduler), resource, failures }; }
    catch (error) { failures.push(`${resource}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  throw new Error(failures.join('; ') || 'no audio resource candidates');
}
