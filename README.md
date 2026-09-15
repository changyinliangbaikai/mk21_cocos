# 超力英雄 · Cocos 游戏工程

基于 **Cocos Creator 3.8.8** 的竖屏塔防原型，当前玩法版本 **v0.7**。包含 20 波战斗、四名英雄及永久养成、合成升星、技能卡、Boss、音效与中文界面。

AI 接手构建与发布时，先阅读 [部署执行文档](DEPLOYMENT.md)，其中包含环境与 AppID 配置、微信/抖音/Web 操作步骤、构建报告检查、验收标准及故障处理。

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

广告目前使用明示 Web 模拟器；小游戏端已禁用模拟广告入口并保留免费复活，正式广告 SDK 尚未接入。抖音基础版本已获用户真机试玩确认，新增发布能力的验收见下文。

## 微信与抖音小游戏

小游戏构建使用独立工程副本，在副本中压缩 PNG 和音频、启用原生资源分包，并检查包体上限，原始素材保持不变。当前方案无需自行部署 CDN。

安装 FFmpeg 后，在根目录 `release.local.json` 配置 `wechatAppId`、`douyinAppId`，运行 `npm run build:minigames`。输出写入 `artifacts/minigames/<时间戳>/game/build/`，构建报告会区分测试 AppID、包体检查和待完成的真机验收。没有 AppID 时可显式加 `-- --test-appid` 做本地测试，脚本不自动上传。

抖音 0.7.0 测试版本已上传，包含侧边栏复访与健康游戏忠告。当前尚未提审或发布；资料草稿和用户反馈见 [小游戏发布推进](docs/release/小游戏发布推进.md)、[抖音提审材料](docs/release/抖音提审材料草稿.md)、[待优化事项](docs/release/待优化事项.md)。

微信 AppID 为 `wx130a8544c32afd2c`。“超力英雄”0.7.1 已上传成功，工具提示覆盖已有体验版；后台最终状态与新版手机试玩待确认。新版通过 164 项测试和 Cocos 类型检查；场景与玩法文案、三张同源码 Web 运行截图见 [微信文案与截图](docs/release/超力英雄-微信文案.md)。

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
- `docs/release/`：微信与抖音发布流程、构建配置示例和验收进度。
- `tools/`：构建、服务、配置同步、模拟和测试辅助脚本。
- 根目录：依赖锁文件、TypeScript 配置及项目说明。

素材制作库 `assets/`、截图与浏览器记录 `output/`、构建及验收记录 `artifacts/`、历史评审和实施记录、一次性制作与验收脚本均保留在本地并由 `.gitignore` 排除。依赖、Creator 缓存和构建输出也不纳入 Git。字体许可随运行字体保存在 `game/assets/resources/mvp/fonts/`。
