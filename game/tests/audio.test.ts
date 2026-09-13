import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GameSession } from '../assets/scripts/domain/session';
import { AudioEventRouter, audioPlan, captureAudioState, chooseAudioSlot, type AudioIntent } from '../assets/scripts/presentation/AudioEvents';
import { AudioPlaybackLifetime, admitsAudioIntent, boundedAudioReady, closesCombatAudio, combatAudioPauseAction, readyAudioGroup, sampleAudioClocks } from '../assets/scripts/presentation/AudioPlayback';

const config = JSON.parse(readFileSync('docs/design/configs/prototype-v0.5.json', 'utf8'));
function session(): GameSession {
  let save: string | null = null;
  const g = new GameSession(config, { getItem: () => save, setItem: (_key, value) => { save = value; } });
  assert.ok(g.dispatch('newRun', { seed: config.sample_seed })); return g;
}
function secondFailure(): GameSession {
  const g = session(), r = g.data.run;
  g.battle!.beginWave(8, true); r.grandpaUsed = true; r.calmWave = 8;
  r.battle.baseHp = 0; r.battle.result = 'failed'; r.phase = 'battle'; g.advance(1 / 60);
  assert.equal(r.phase, 'secondFailure'); return g;
}
function act(router: AudioEventRouter, g: GameSession, name: string, payload?: any): AudioIntent[] {
  const before = captureAudioState(g.data), success = g.dispatch(name, payload);
  return router.command(name, payload, success, before, captureAudioState(g.data));
}
const ids = (intents: AudioIntent[]) => intents.map(e => e.id);

test('P6 audio wave-end: cards admits UI cues but rejects final combat sounds; unstarted pause cancels instead of false timeout', () => {
  const g = session(), r = g.data.run, router = new AudioEventRouter(); r.phase = 'battle';
  r.battle.queue = []; const enemy = g.battle!.spawn('M001', 1, 300); router.observe(g.data);
  g.battle!.damage(enemy.id, 9999, 'physical', { source: 'H004' }); g.battle!.flushDamage(); g.advance(1 / 60);
  const intents = router.observe(g.data); assert.equal(r.phase, 'cards'); assert.equal(router.plan?.combatPaused, true);
  const allowed = intents.filter(intent => admitsAudioIntent(intent.combat, router.plan!.combatPaused));
  assert.ok(ids(allowed).includes('AUD_SFX_007')); assert.ok(ids(allowed).includes('AUD_SFX_033'));
  for (const id of ['AUD_SFX_022', 'AUD_SFX_028', 'AUD_SFX_032']) assert.ok(!ids(allowed).includes(id), id + ' must not enqueue PLAY after wave pause');
  assert.equal(combatAudioPauseAction({ active: true, paused: false, started: false }, true), 'cancel');
  assert.equal(combatAudioPauseAction({ active: true, paused: false, started: true }, true), 'pause');
  assert.equal(combatAudioPauseAction({ active: true, paused: true, started: true }, false), 'resume');
  assert.equal(combatAudioPauseAction({ active: false, paused: false, started: false }, false), 'none');
});

test('P6 audio loop: batched public samples avoid Creator loop-getter drift caused by sparse follower reads', () => {
  const duration = 1645714 / 48000;
  let now = 0;
  // Reproduce the installed Creator 3.8.8 pal/audio/audio-timer.ts getter: its first
  // post-wrap read resets the origin to NOW, discarding the remainder for later reads.
  const source = () => {
    let origin = 0;
    return { get currentTime() { const elapsed = now - origin; if (elapsed >= duration) origin = now; return elapsed % duration; } };
  };
  const sparse = [source(), source(), source(), source()];
  const batched = Array.from({ length: 4 }, () => ({ source: source(), sampledTime: 0, sampledAt: 0 }));
  let sparseMax = 0, batchedMax = 0;
  for (let frame = 1; frame <= 60 * 220; frame++) {
    now = frame / 60;
    const leader = sparse[0].currentTime;
    sampleAudioClocks(batched, now);
    if (frame % 60 === 0) {
      for (let i = 1; i < 4; i++) {
        const distance = (a: number, b: number) => Math.min(Math.abs(a - b), Math.abs(duration - Math.abs(a - b)));
        sparseMax = Math.max(sparseMax, distance(leader, sparse[i].currentTime));
        batchedMax = Math.max(batchedMax, distance(batched[0].sampledTime, batched[i].sampledTime));
      }
    }
  }
  assert.ok(sparseMax > .04, 'Old leader/follower polling creates a false correction even for identical clocks');
  assert.equal(batchedMax, 0, 'Sampling all stems together spans six loop boundaries without false drift');
});

test('P6 audio loading: silent engine failure times out, late callbacks cannot revive it, and ready stems can continue', async () => {
  let resolve!: () => void;
  const pending = new Promise<void>(done => { resolve = done; });
  const good = { ready: true }, bad = { ready: false, error: undefined as string | undefined };
  assert.equal(readyAudioGroup([good, bad]), null);
  let calls = 0;
  await new Promise<void>(done => {
    boundedAudioReady(pending, 10, error => { calls++; bad.error = error; done(); });
  });
  assert.match(bad.error!, /timed out/); assert.deepEqual(readyAudioGroup([good, bad]), [good]);
  resolve(); await Promise.resolve(); assert.equal(calls, 1);
  let cancelResolve!: () => void;
  const canceled = new Promise<void>(done => { cancelResolve = done; });
  const cancel = boundedAudioReady(canceled, 10, () => { calls++; }); cancel(); cancelResolve();
  await Promise.resolve(); assert.equal(calls, 1, 'Destroy cancels readiness without a late success/failure callback');
});

test('P6 audio lifetime: first delayed short SFX receives its full audible duration only after real STARTED', () => {
  const clip = new AudioPlaybackLifetime(); clip.request(.08);
  assert.equal(clip.advance(2, false), 'loading'); assert.equal(clip.remaining, .08);
  clip.markStarted(); assert.equal(clip.advance(.05, false), 'playing'); assert.ok(Math.abs(clip.remaining - .03) < 1e-10);
  assert.equal(clip.advance(5, true), 'playing'); assert.ok(Math.abs(clip.remaining - .03) < 1e-10);
  clip.markStarted(); assert.equal(clip.advance(.2, false), 'ended', 'Resume STARTED cannot restart a clip lifetime');
  clip.request(.08); assert.equal(clip.advance(10, false), 'timeout', 'A missing STARTED must release the reserved voice');
  clip.reset(); assert.equal(clip.started, false); assert.equal(clip.remaining, 0);
});

test('P6 audio failure: both rescue prompts retire combat tails before free-deploy, while ordinary combat pause retains them', () => {
  assert.equal(closesCombatAudio('firstFailure'), true); assert.equal(closesCombatAudio('secondFailure'), true);
  assert.equal(closesCombatAudio('battle'), false); assert.equal(closesCombatAudio('freeDeploy'), false);
});

test('P6 audio: committed free revival has restore/stinger but never clear; completed/fallback share clear once', () => {
  for (const branch of ['free', 'completed', 'failed']) {
    const g = secondFailure(), router = new AudioEventRouter(); router.observe(g.data);
    let cues: AudioIntent[];
    if (branch === 'free') cues = act(router, g, 'freeRevive');
    else {
      act(router, g, 'adRequest'); cues = act(router, g, 'adResult', { id: g.data.run.ad.id, result: branch });
    }
    assert.ok(ids(cues).includes('AUD_MUS_011')); assert.ok(ids(cues).includes('AUD_SFX_036'));
    assert.equal(ids(cues).includes('AUD_SFX_035'), branch !== 'free');
    assert.ok(!ids(cues).includes('AUD_SFX_028')); assert.ok(!ids(cues).includes('AUD_SFX_032'));
    assert.deepEqual(router.observe(g.data), []);
    assert.deepEqual(act(router, g, 'adResult', { id: g.data.run.ad.id, result: 'completed' }), []);
  }
});

test('P6 audio: canceled/unknown ads never celebrate; unknown reload followed by explicit free result is authoritative', () => {
  for (const result of ['cancelled', 'unknown']) {
    const g = secondFailure(), router = new AudioEventRouter(); router.observe(g.data);
    assert.deepEqual(act(router, g, 'adRequest'), []);
    assert.deepEqual(act(router, g, 'adResult', { id: g.data.run.ad.id, result }), []);
    assert.equal(g.data.run.secondUsed, false);
    const restoredRouter = new AudioEventRouter(); assert.deepEqual(restoredRouter.observe(g.data), []);
    const cues = act(restoredRouter, g, 'freeRevive');
    assert.ok(ids(cues).includes('AUD_MUS_011')); assert.ok(!ids(cues).includes('AUD_SFX_035'));
  }
});

test('P6 audio: changing 1x/2x changes only its click, never the music plan or saved combat state', () => {
  const g = session(), router = new AudioEventRouter(); g.dispatch('startWave'); router.observe(g.data);
  const beforePlan = audioPlan(captureAudioState(g.data)), tick = g.data.run.battle.tick;
  assert.deepEqual(ids(act(router, g, 'setSpeed', 2)), ['AUD_SFX_011']);
  assert.deepEqual(audioPlan(captureAudioState(g.data)), beforePlan); assert.equal(g.data.run.battle.tick, tick);
  const before = JSON.stringify(g.data); router.observe(g.data); router.observe(g.data);
  assert.equal(JSON.stringify(g.data), before, 'Audio observation must never mutate the game');
});

test('P6 audio: restore/background/wave changes discard event backlog; new events are deduplicated and clustered', () => {
  const g = session(), r = g.data.run;
  g.dispatch('summon', { heroId: 'H001', slot: 'L1-B' }); g.dispatch('startWave');
  const id = r.battle.heroes[0].id;
  r.battle.stats.effects.push({ tick: 0, kind: 'attack', heroId: id, enemyId: 999 });
  const router = new AudioEventRouter(); assert.deepEqual(router.observe(g.data), []);
  router.background(); r.battle.tick += 300;
  r.battle.stats.effects.push({ tick: r.battle.tick, kind: 'attack', heroId: id, enemyId: 999 });
  assert.deepEqual(router.observe(g.data), []); router.foreground(); assert.deepEqual(router.observe(g.data), []);
  r.battle.tick++; r.battle.stats.effects.push({ tick: r.battle.tick, kind: 'attack', heroId: id, enemyId: 999 });
  r.battle.stats.effects.push({ tick: r.battle.tick, kind: 'attack', heroId: id, enemyId: 1000 });
  assert.deepEqual(ids(router.observe(g.data)), ['AUD_SFX_012']); assert.deepEqual(router.observe(g.data), []);
  g.battle!.beginWave(2); assert.deepEqual(router.observe(g.data), []);
});

test('P6 audio: cold music wins over boss while hard-control cancellation never emits boss impact', () => {
  const g = session(), r = g.data.run;
  g.battle!.beginWave(20, true); r.calmWave = 20; r.phase = 'battle';
  const boss = g.battle!.spawn('B001', 2, 100); const router = new AudioEventRouter(); router.observe(g.data);
  assert.equal(router.plan?.family, 'calm');
  boss.bossWindupUntil = 60;
  assert.ok(ids(router.observe(g.data)).includes('AUD_SFX_045'));
  g.battle!.hardControl(boss, .4);
  assert.ok(!ids(router.observe(g.data)).includes('AUD_SFX_046'));
  const snapshot = captureAudioState(g.data); snapshot.phase = 'adPending';
  assert.equal(audioPlan(snapshot).suspended, true);
});

test('P6 audio: final loss stinger occurs once after both rescues; cold income and protected leaks do not create reward/damage cues', () => {
  const g = secondFailure(), router = new AudioEventRouter(); router.observe(g.data);
  act(router, g, 'freeRevive'); act(router, g, 'startWave');
  const r = g.data.run; r.battle.stats.leaked++;
  assert.ok(!ids(router.observe(g.data)).includes('AUD_SFX_030'));
  r.battle.baseHp = 0; r.battle.result = 'failed'; g.advance(1 / 60);
  const cues = ids(router.observe(g.data)); assert.ok(cues.includes('AUD_MUS_009'));
  assert.ok(!cues.includes('AUD_MUS_011')); assert.ok(!cues.includes('AUD_SFX_032'));
  assert.deepEqual(router.observe(g.data), []);
  const reloaded = new AudioEventRouter(); assert.deepEqual(reloaded.observe(g.data), []);
});

test('P6 audio: limiter enforces per-group/total polyphony and preserves more urgent P0 warnings', () => {
  const slots = Array.from({ length: 12 }, (_, i) => ({ id: 'ordinary', priority: i < 5 ? 2 : 3, started: i, active: i < 5 }));
  assert.equal(chooseAudioSlot(slots, 2, 'AUD_SFX_027'), -1, 'Five ordinary sounds already consume the ordinary group cap');
  assert.equal(chooseAudioSlot(slots, 0, 'AUD_SFX_031'), 5);
  slots.forEach((slot, index) => { slot.active = true; slot.priority = index < 2 ? 0 : index < 5 ? 1 : index < 10 ? 2 : 3; });
  slots[0].id = 'AUD_SFX_045'; slots[1].id = 'AUD_SFX_031';
  assert.equal(chooseAudioSlot(slots, 0, 'AUD_SFX_034'), -1, 'Cane decoration cannot evict more urgent warnings');
  assert.equal(chooseAudioSlot(slots, 0, 'AUD_SFX_045'), 1);
  assert.equal(chooseAudioSlot(slots, 2, 'AUD_SFX_027'), -1);
});
