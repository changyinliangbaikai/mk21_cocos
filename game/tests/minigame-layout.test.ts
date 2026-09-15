import test from 'node:test';
import assert from 'node:assert/strict';
import { fitMiniGameStage, menuLowerEdgeInView } from '../assets/scripts/presentation/MiniGameLayout';

test('unchanged Web bounds keep the existing game composition', () => {
  assert.deepEqual(fitMiniGameStage({x:0,y:0,width:720,height:1280}), {x:0,y:0,scale:1});
});

test('letterboxed portrait content clears the native menu and keeps the whole UI visible', () => {
  const menuBottom = 104, ratio = 3, scaleY = 1170 / 720, viewportY = (2532 - 1280 * scaleY) / 2;
  const edge = menuLowerEdgeInView(menuBottom, 844, 2532, viewportY, scaleY)!;
  const layout = fitMiniGameStage({x:0,y:0,width:720,height:1280}, undefined, edge);
  const topInView = 640 + layout.y + 640 * layout.scale;
  const topInCss = (2532 - (topInView * scaleY + viewportY)) / ratio;
  assert.ok(topInCss >= menuBottom + 8 - 1e-8);
  assert.ok(640 + layout.y - 640 * layout.scale >= 0);
  assert.ok(layout.scale > 0.9);
});

test('notches and gesture insets contain all four UI corners at several viewport sizes', () => {
  for (const [width,height] of [[720,1280],[720,1560],[1000,1280]]) {
    const visible={x:10,y:20,width,height}, safe={x:34,y:60,width:width-48,height:height-160};
    const layout=fitMiniGameStage(visible,safe), cx=visible.x+width/2+layout.x, cy=visible.y+height/2+layout.y;
    assert.ok(cx-360*layout.scale >= safe.x-1e-8 && cx+360*layout.scale <= safe.x+safe.width+1e-8);
    assert.ok(cy-640*layout.scale >= safe.y-1e-8 && cy+640*layout.scale <= safe.y+safe.height+1e-8);
  }
});

test('unavailable or invalid platform geometry cannot hide the game', () => {
  const visible={x:0,y:0,width:720,height:1280};
  assert.equal(menuLowerEdgeInView(0,844,2532,0,1),undefined);
  assert.equal(menuLowerEdgeInView(104,0,2532,0,1),undefined);
  assert.deepEqual(fitMiniGameStage(visible,{x:0,y:0,width:0,height:0}),{x:0,y:0,scale:1});
});
