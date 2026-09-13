/** Cocos can leave its public readiness promise pending when a native player fails.
 * This fence accepts one result and ignores resolution after timeout/cancellation. */
export function boundedAudioReady<T>(pending: Promise<T>, timeoutMs: number,
  complete: (error?: string) => void): () => void {
  let settled = false;
  const finish = (error?: string): void => {
    if (settled) return;
    settled = true; clearTimeout(timer); complete(error);
  };
  const timer = setTimeout(() => finish(`AudioSource readiness timed out after ${timeoutMs} ms`), timeoutMs);
  pending.then(() => finish(), error => finish(String(error)));
  return () => { settled = true; clearTimeout(timer); };
}

export function readyAudioGroup<T extends { ready: boolean; error?: string }>(tracks: T[]): T[] | null {
  return tracks.some(track => !track.ready && !track.error) ? null : tracks.filter(track => track.ready && !track.error);
}

export const closesCombatAudio = (phase: string): boolean =>
  ['cards', 'firstFailure', 'secondFailure', 'victory', 'defeat'].includes(phase);

/** Creator 3.8's public AudioTimer getter mutates its loop origin on first read after
 * wrapping. Sample every source together; sparse follower reads create false drift. */
export function sampleAudioClocks<T extends { source: { currentTime: number }; sampledTime: number; sampledAt: number }>(
  tracks: T[], now: number): void {
  for (const track of tracks) { track.sampledTime = track.source.currentTime; track.sampledAt = now; }
}

/** A PLAY still waiting for STARTED is not an audible tail that can be resumed later.
 * Cancel it before pausing, otherwise Cocos may deliver STARTED after PAUSE and its
 * caller cannot distinguish that intentionally paused request from a loading failure. */
export function combatAudioPauseAction(slot: { active: boolean; paused: boolean; started: boolean },
  combatPaused: boolean): 'none' | 'cancel' | 'pause' | 'resume' {
  if (!slot.active) return 'none';
  if (combatPaused && !slot.paused) return slot.started ? 'pause' : 'cancel';
  if (!combatPaused && slot.paused) return 'resume';
  return 'none';
}

export const admitsAudioIntent = (combat: boolean, combatPaused: boolean): boolean => !combat || !combatPaused;

/** Foreground real-time lifetime. Loading never consumes a short clip's audible duration.
 * A resumed STARTED event does not grant the clip a second lifetime. */
export class AudioPlaybackLifetime {
  remaining = 0;
  loadingSeconds = 0;
  started = false;
  request(duration: number): void { this.remaining = duration; this.loadingSeconds = 0; this.started = false; }
  markStarted(): void { this.started = true; }
  advance(realDt: number, paused: boolean, loadingTimeout = 10): 'loading' | 'playing' | 'timeout' | 'ended' {
    if (!this.started) {
      this.loadingSeconds += realDt;
      return this.loadingSeconds >= loadingTimeout ? 'timeout' : 'loading';
    }
    if (!paused) this.remaining -= realDt;
    return this.remaining <= -.12 ? 'ended' : 'playing';
  }
  reset(): void { this.remaining = 0; this.loadingSeconds = 0; this.started = false; }
}
