import test from 'node:test';
import assert from 'node:assert/strict';
import { FLIGHT_STYLES, FLIGHT_TRAIL_LIMIT, FLIGHT_TRAIL_SECONDS, FlightSample, flightPose, sampleFlight } from '../assets/scripts/presentation/ProjectileMotion';

test('flight trails stay bounded during a long flight and retain only elapsed path positions', () => {
  const samples: FlightSample[] = [];
  for (let i = 0; i < 6000; i++) {
    const point = { x: i * 9, y: Math.sin(i) * 30, at: i / 60, angle: i % 360 };
    sampleFlight(samples, point);
    assert.ok(samples.length <= FLIGHT_TRAIL_LIMIT);
    assert.ok(samples.every(p => point.at - p.at <= FLIGHT_TRAIL_SECONDS && p.at <= point.at));
    point.x = -999; assert.ok(samples.every(p => p.x >= 0));
  }
});
test('paused or repeated render timestamps cannot move or grow a flight trail', () => {
  const samples: FlightSample[] = [];
  for (let i = 0; i < 10; i++) sampleFlight(samples, { x: i * 12, y: i * 4, at: i / 30, angle: 10 });
  const frozen = structuredClone(samples), last = samples[samples.length - 1];
  for (let i = 0; i < 120; i++) sampleFlight(samples, { x: 999, y: 999, at: last.at, angle: 90 });
  sampleFlight(samples, { x: 0, y: 0, at: last.at - 1, angle: 0 });
  assert.deepEqual(samples, frozen);
});
test('cosmetic flight sway is zero at launch and contact; animation has valid bounded phases', () => {
  for (const id of Object.keys(FLIGHT_STYLES)) {
    assert.equal(flightPose(id, 0, 500, 42).offset, 0);
    assert.equal(flightPose(id, 2, 0, 42).offset, 0);
    const frames = new Set<number>();
    for (let i = 0; i < 180; i++) {
      const pose = flightPose(id, i / 60, 180, 42); frames.add(pose.frame);
      assert.ok(pose.frame >= 0 && pose.frame <= 5 && Number.isInteger(pose.frame));
      assert.ok(Math.abs(pose.offset) <= FLIGHT_STYLES[id].wobble);
      assert.ok(pose.scaleX > 0 && pose.scaleY > 0 && Number.isFinite(pose.roll));
    }
    assert.equal(frames.size, 6);
  }
});
