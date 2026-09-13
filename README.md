# 魔性英雄塔防 · Cocos 游戏工程

基于 **Cocos Creator 3.8.8** 的竖屏塔防原型，当前玩法版本 **v0.7**。包含 20 波战斗、四名英雄及永久养成、合成升星、技能卡、Boss、音效与中文界面。

## 安装与构建

```bash
npm ci
npm run verify
```

使用 Cocos Creator 3.8.8 打开 `game/`，等待资源导入完成，在构建发布面板选择 **web-mobile**。入口场景是 `assets/scenes/Boot.scene`。运行所需美术、音频、字体及其 `.meta` 已包含在 `game/assets/`，无需额外导入根目录的素材制作库。

本地曾出现独立 CLI 构建误改资源 importer 的问题，推荐使用编辑器构建；构建脚本保留用于受控环境，禁止同时用 GUI 和 CLI 导入同一工程。

完成构建后启动本地服务：

```bash
npm run serve
```

打开 [本地试玩入口](http://localhost:7457/)。服务读取 `game/build/web-mobile/`；新克隆的仓库须先构建。存档保存在浏览器本地存储。

## 玩法

- 保存编队后开始；点击英雄卡和空位召唤，同名同星英雄拖拽合成，最高三星。
- 首波手动开始；波末选卡后准备 1.2 秒自动开波。召唤和移动期间进入 0.2 倍布阵慢动作。
- 第 5、10、15 波出现小 Boss，第 20 波出现大 Boss，每只 Boss 奖励 200 能量。
- 点击英雄查看射程，技能按钮用于暂停瞄准；设置菜单可保存并返回营地。
- 旧 v0.5/v0.6 对局保留原规则，在营地开始新局后使用 v0.7 规则。永久养成保留。

广告目前使用明示 Web 模拟器；微信/抖音正式广告 SDK 和真机验收尚未完成。

## 开发检查

```bash
npm run verify          # 同步配置、逻辑类型检查、自动测试
npm run typecheck:cocos # 使用本机 Creator 的真实类型声明
npm run simulate        # 自动策略模拟，输出到本地 artifacts/
```

配置源是 `docs/design/configs/prototype-v0.5.json`，文件名为稳定资源入口，实际版本以 `design_version` 为准。修改后运行 `npm run config:sync` 并重新构建。历史配置用于旧存档兼容测试。

CLI 构建入口：`build:web`、`build:web-desktop`、`build:wechat`、`build:douyin`。默认使用 macOS Creator 3.8.8 安装路径；构建可通过 `COCOS_CREATOR` 指定可执行文件，类型检查可通过 `COCOS_CREATOR_APP` 指定应用路径。

## 版本管理范围

- `game/`：游戏源码、场景、运行资源、Cocos 设置和自动测试。
- `docs/design/`：玩法规则、数值配置和游戏设计说明。
- `tools/`：构建、服务、配置同步、模拟和测试辅助脚本。
- 根目录：依赖锁文件、TypeScript 配置及项目说明。

素材制作库 `assets/`、截图与浏览器记录 `output/`、构建及验收记录 `artifacts/`、历史评审和实施记录、一次性制作与验收脚本均保留在本地并由 `.gitignore` 排除。依赖、Creator 缓存和构建输出也不纳入 Git。字体许可随运行字体保存在 `game/assets/resources/mvp/fonts/`。
