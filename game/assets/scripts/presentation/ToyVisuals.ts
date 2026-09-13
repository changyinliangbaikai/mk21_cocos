import { Color, Graphics, Layers, Node, UITransform } from 'cc';

/** Standard native UI drawing helpers. Character art is supplied by SpriteVisuals. */
export const Palette = {
  ink: '#25354B', muted: '#627384', cream: '#FFF5DD', paper: '#FFFFFF',
  lake: '#28BCD2', deepLake: '#147C98', yellow: '#FFD45A', purple: '#9470DC',
  green: '#76C897', pale: '#EAF4EC', red: '#ED7880', line: '#C5B99E',
};

export function color(hex: string, alpha = 255): Color {
  const c = new Color(); Color.fromHEX(c, hex); c.a = alpha; return c;
}

export function shape(parent: Node, name: string, x: number, y: number, w: number, h: number): { node: Node; g: Graphics } {
  const node = new Node(name); node.setParent(parent); node.layer = Layers.Enum.UI_2D; node.setPosition(x, y);
  node.addComponent(UITransform).setContentSize(w, h);
  return { node, g: node.addComponent(Graphics) };
}

export function round(g: Graphics, x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string, line = 3): void {
  g.fillColor = color(fill); g.roundRect(x, y, w, h, r); g.fill();
  if (stroke) { g.strokeColor = color(stroke); g.lineWidth = line; g.roundRect(x, y, w, h, r); g.stroke(); }
}

