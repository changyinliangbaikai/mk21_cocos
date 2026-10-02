/** Presentation coordinates only. Normalized battle positions and combat timing
 * stay unchanged; every actor, hit effect and aim overlay shares this projection. */
export const R1_VIEW = { width: 941, height: 1672 } as const;
export const BATTLE_MODEL = { width: 656, height: 800 } as const;
export const BATTLE_VIEW = {
  x: 32 * R1_VIEW.width / 720,
  y: 460,
  width: BATTLE_MODEL.width * R1_VIEW.width / 720,
  height: 794,
} as const;
export const BATTLE_HUD_BOTTOM = 208;
export const BATTLE_EFFECT_TOP = 236;
export const BATTLE_EFFECT_BOTTOM = BATTLE_VIEW.y + BATTLE_VIEW.height;
export const BATTLE_EFFECT_SCALE_Y = (BATTLE_VIEW.height / BATTLE_MODEL.height) / (BATTLE_VIEW.width / BATTLE_MODEL.width);

export function battleX(x: number): number { return BATTLE_VIEW.x + x * BATTLE_VIEW.width; }
export function battleY(y: number): number { return BATTLE_VIEW.y + y * BATTLE_VIEW.height; }
export function battleAim(x: number, y: number): { x: number; y: number } {
  return { x: Math.max(0, Math.min(1, (x - BATTLE_VIEW.x) / BATTLE_VIEW.width)),
    y: Math.max(0, Math.min(1, (y - BATTLE_VIEW.y) / BATTLE_VIEW.height)) };
}
export function battlePixelPoint(x: number, y: number): { x: number; y: number } {
  return { x: battleX(x / BATTLE_MODEL.width), y: battleY(y / BATTLE_MODEL.height) };
}
export function battleRadius(radius: number): { x: number; y: number } {
  const x = radius * BATTLE_VIEW.width;
  return { x, y: x * BATTLE_EFFECT_SCALE_Y };
}
