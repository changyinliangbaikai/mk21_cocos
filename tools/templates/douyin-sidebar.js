/* Required synchronously at game.js entry, before Cocos loads its bundles. */
(function () {
  if (typeof tt === 'undefined') return;
  var root = typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis;
  if (root.__heroDefenseSidebar) return;
  var state = {
    available: false, fromSidebar: false, busy: false, error: '',
    navigate: function (onFailure) {
      if (!state.available || state.busy) return;
      state.busy = true;
      state.error = '';
      function failed() {
        state.busy = false;
        state.error = '暂时无法打开侧边栏，请稍后重试。';
        if (onFailure) onFailure();
      }
      try {
        tt.navigateToScene({ scene: 'sidebar', success: function () { state.busy = false; }, fail: failed });
      } catch (_) { failed(); }
    }
  };
  root.__heroDefenseSidebar = state;
  if (typeof globalThis !== 'undefined') globalThis.__heroDefenseSidebar = state;
  var receivedShow = false;
  function shown(options) {
    receivedShow = true;
    // Always replace the launch state: a previous sidebar visit is not a new visit.
    state.fromSidebar = !!options && options.launch_from === 'homepage' && options.location === 'sidebar_card';
    state.busy = false;
    state.error = '';
  }
  try { if (tt.onShow) tt.onShow(shown); } catch (_) { /* Unsupported hosts still run the game. */ }
  // The synchronous launch fallback is only used before the first onShow event.
  // Registration remains at entry so warm starts cannot be missed during loading.
  // getLaunchOptionsSync itself does not trigger an asynchronous operation.
  try { if (!receivedShow && tt.getLaunchOptionsSync) shown(tt.getLaunchOptionsSync()); } catch (_) {}
  try {
    if (tt.checkScene && tt.navigateToScene && tt.onShow) {
      tt.checkScene({ scene: 'sidebar', success: function (result) { state.available = result.isExist === true; },
        fail: function () { state.available = false; } });
    }
  } catch (_) { state.available = false; }
})();
