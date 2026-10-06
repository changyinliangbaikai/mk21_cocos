/** Cosmetic only: these values never feed the battle model or its random streams. */
export interface FlightStyle { size: number; wobble: number; frequency: number; roll: number; pulse: number; trailWidth: number }
export const FLIGHT_STYLES: Record<string, FlightStyle> = {
  RH02: { size: 146, wobble: 9, frequency: 16, roll: 70, pulse: .08, trailWidth: 56 },
  RH03: { size: 176, wobble: 3, frequency: 18, roll: 0, pulse: .14, trailWidth: 78 },
  RH04: { size: 154, wobble: 13, frequency: 15, roll: 300, pulse: .05, trailWidth: 50 },
  RH07: { size: 162, wobble: 8, frequency: 30, roll: 0, pulse: .1, trailWidth: 51 },
  RH08: { size: 162, wobble: 8, frequency: 16, roll: -65, pulse: .06, trailWidth: 58 },
  RH09: { size: 176, wobble: 15, frequency: 17, roll: 0, pulse: .12, trailWidth: 66 },
  RH10: { size: 172, wobble: 18, frequency: 10, roll: 30, pulse: .1, trailWidth: 62 },
};
export interface FlightSample { x: number; y: number; at: number; angle: number }
export const FLIGHT_TRAIL_LIMIT = 7;
export const FLIGHT_TRAIL_SECONDS = .2;
export function flightPose(id: string, age: number, remaining: number, seed: number): { frame: number; offset: number; roll: number; scaleX: number; scaleY: number } {
  const s = FLIGHT_STYLES[id], t = Math.max(0, age), phase = t * s.frequency + seed % 11;
  const envelope = Math.min(1, t / .08) * Math.min(1, Math.max(0, remaining) / 65);
  const pulse = Math.sin(phase) * s.pulse;
  return { frame: (Math.floor(t / .065) + seed % 6) % 6,
    offset: envelope ? Math.sin(phase) * s.wobble * envelope : 0,
    roll: s.roll ? t * s.roll : Math.sin(phase) * (id === 'RH09' ? 12 : id === 'RH07' ? 6 : 3),
    scaleX: 1 + pulse, scaleY: 1 - pulse * .6 };
}
/** Bounded history of already rendered positions. No points are invented ahead of the projectile. */
export function sampleFlight(samples: FlightSample[], point: FlightSample): void {
  const last = samples[samples.length - 1];
  if (last && point.at <= last.at) return; // pause, bullet time with no new tick, or duplicate render
  if (!last || point.at - last.at >= .022 && Math.hypot(point.x - last.x, point.y - last.y) >= 3) samples.push({ ...point });
  while (samples.length && (point.at - samples[0].at > FLIGHT_TRAIL_SECONDS || samples.length > FLIGHT_TRAIL_LIMIT)) samples.shift();
}
