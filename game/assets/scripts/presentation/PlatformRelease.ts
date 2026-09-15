declare const GameGlobal: { __heroDefenseSidebar?: SidebarBridge } | undefined;

export interface SidebarBridge {
  available: boolean;
  fromSidebar: boolean;
  busy: boolean;
  error: string;
  navigate(onFailure?: () => void): void;
}

/** The release entry captures platform events before the asynchronous scene load. */
export function douyinSidebar(): SidebarBridge | undefined {
  return (typeof GameGlobal !== 'undefined' && GameGlobal?.__heroDefenseSidebar)
    || (globalThis as any).__heroDefenseSidebar || undefined;
}

export const HEALTHY_PLAY_NOTICE = '抵制不良游戏，拒绝盗版游戏。\n注意自我保护，谨防受骗上当。\n适度游戏益脑，沉迷游戏伤身。\n合理安排时间，享受健康生活。';
