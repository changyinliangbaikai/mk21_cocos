import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedCallbackLoad, firstAvailableAudio, type CallbackLoader, type LoadScheduler } from '../assets/scripts/presentation/AssetLoadPolicy';

function clock() {
  let nextId = 1;
  const jobs = new Map<number, () => void>();
  const scheduler: LoadScheduler = {
    set: fn => { const id = nextId++; jobs.set(id, fn); return id; },
    clear: id => { jobs.delete(id as number); },
  };
  return { scheduler, jobs, fire: () => { const first = jobs.entries().next().value; if (first) { jobs.delete(first[0]); first[1](); } } };
}
const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('successful, failed and throwing loaders all remove their timeout', async () => {
  const c = clock();
  assert.equal(await boundedCallbackLoad('good', (_, done) => done(null, 'real-result'), 100, c.scheduler), 'real-result');
  assert.equal(c.jobs.size, 0);
  await assert.rejects(boundedCallbackLoad('error', (_, done) => done(new Error('decoder error')), 100, c.scheduler), /decoder error/);
  assert.equal(c.jobs.size, 0);
  await assert.rejects(boundedCallbackLoad('throw', () => { throw new Error('sync failure'); }, 100, c.scheduler), /sync failure/);
  assert.equal(c.jobs.size, 0);
});

test('a never-settling codec advances to fallback; late primary callback cannot replace it', async () => {
  const c = clock(), attempts: string[] = [];
  let primaryDone: Parameters<CallbackLoader<string>>[1] | undefined;
  const loader: CallbackLoader<string> = (resource, done) => {
    attempts.push(resource);
    if (resource === 'primary-ogg') primaryDone = done;
    else done(null, 'decoded-mp3');
  };
  const pending = firstAvailableAudio(['primary-ogg', 'fallback-mp3'], loader, () => 100, c.scheduler);
  c.fire();
  const result = await pending;
  assert.deepEqual(attempts, ['primary-ogg', 'fallback-mp3']);
  assert.equal(result.value, 'decoded-mp3'); assert.equal(result.resource, 'fallback-mp3');
  assert.match(result.failures[0], /primary-ogg.*timed out/);
  primaryDone!(null, 'late-ogg'); primaryDone!(new Error('late-error'));
  await microtasks();
  assert.equal(result.value, 'decoded-mp3'); assert.equal(c.jobs.size, 0);
});

test('all codecs timing out reject with each resource instead of blocking startup forever', async () => {
  const c = clock();
  const pending = firstAvailableAudio(['AUD_MUS_002/main', 'AUD_MUS_002/fallback'], () => {}, () => 100, c.scheduler);
  const rejection = assert.rejects(pending, error => error instanceof Error && error.message.includes('AUD_MUS_002/main') && error.message.includes('AUD_MUS_002/fallback'));
  c.fire(); await microtasks(); c.fire();
  await rejection;
  assert.equal(c.jobs.size, 0);
});

test('exhausted global preload budget skips new decoders and reports the remaining resources', async () => {
  const c = clock(); let calls = 0;
  await assert.rejects(firstAvailableAudio(['one', 'two'], () => { calls++; }, () => 0, c.scheduler), /preload budget exhausted.*two/);
  assert.equal(calls, 0); assert.equal(c.jobs.size, 0);
});

test('the first successful callback wins and later callbacks create no extra timer', async () => {
  const c = clock();
  const result = await boundedCallbackLoad('duplicate', (_, done) => { done(null, 'first'); done(null, 'second'); done(new Error('duplicate error')); }, 100, c.scheduler);
  assert.equal(result, 'first'); assert.equal(c.jobs.size, 0);
});
