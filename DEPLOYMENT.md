---
document_type: ai_deployment_runbook
schema_version: 1
release_channel: wechatgame
scope_updated_at: "2026-09-25"
runtime_version: "R1.0.4"
runtime_verified_at: "2026-09-25"
verified_at: "2026-09-15"
verified_source_commit: "2d1ba6a54a6d6d6296119e705e6e1e8eda9ea456"
repository: "https://github.com/changyinliangbaikai/mk21_cocos"
working_directory: repository_root
supported_execution_baseline: macOS_arm64
creator_version: "3.8.8"
---

# 超力英雄：AI 部署执行文档

本文面向接手本仓库的 AI 编程助手。当前唯一发布渠道为微信小游戏，Web 用于本地调试和截图；按用户指定范围推进预览、上传体验版、备案、提审或正式发布。所有相对路径和命令均以仓库根目录为起点；代码与脚本若发生变化，先核对实现，再更新本文件中的命令和判断条件。

当前分支入口为 R1.0.4。上方 `verified_source_commit` 与 `verified_at` 是历史部署基线，不代表当前R1代码；`runtime_verified_at` 对应本地逻辑、声明及Web验证。R1最新版本通过222项测试和32文件Cocos声明检查；当前构建和未完成的平台验收见 [R1 实现与验收](docs/development/R1实现与验收.md)。0.7.2 的历史上传记录不能用来证明 R1 已上传或已通过真机测试。

## 1. 执行约定与输入

先读取本文件、[README](README.md) 和 [发布进度](docs/release/小游戏发布推进.md)。仓库如新增 `AGENTS.md`，同时遵循其适用范围。历史上传结果仅作参考，不能代替本次构建与平台状态验证。

2026-09-17 用户明确要求后续不再考虑抖音，只关注微信。抖音资料及兼容代码仅作历史保留，不执行抖音或双平台构建，不安排抖音测试、补材料、提审或发布；恢复该渠道须有用户新的明确要求。

开始前确定以下输入；能从用户当前指令、已有配置和发布记录确定的内容直接沿用。只有缺失信息阻塞下一步时才向用户说明具体需要什么，并继续独立的准备工作。

| 输入 | 取值与规则 |
| --- | --- |
| `target` | 发布使用 `wechatgame`；本地调试或截图按需使用 `web-mobile`、`web-desktop`。未指定平台时使用微信。 |
| `requested_stage` | `build`、`preview`、`upload`、`review` 或 `publish`；按用户实际要求确定完成范围。体验版上传成功和正式发布分别取证。 |
| AppID | 小游戏构建必需；环境变量优先于根目录 `release.local.json`。最新用户指定值优先于文档中的历史值。 |
| 平台版本与备注 | 上传前确定；平台版本单独维护，不能从根 `package.json.version` 自动推导，也不能假定历史版本可再次使用。 |
| 执行环境 | Creator 路径、Node、FFmpeg，以及目标平台开发者工具的登录和项目权限。 |
| 公网 Web 目标 | 仅公网 Web 部署需要明确托管目标和发布方式。本仓库没有预配置云站点，`npm run serve` 只提供本机预览。 |

当前微信 AppID 为 `wx130a8544c32afd2c`。这是项目标识，不是登录凭据；构建脚本不使用 AppSecret。不要请求用户发送密码、AppSecret 或验证码。

执行时保留用户已有修改，记录本次提交 SHA、开始前差异和本次输出目录。构建与压缩使用现有脚本；不要重新生成 `.meta`/UUID、替换字体许可或在原始素材上批量压缩。需要扫码登录、身份核验或本人填写材料时，给出当前界面和具体操作步骤；已获授权的同一上传动作不重复征求许可。

## 2. 仓库事实与入口

| 内容 | 权威位置与含义 |
| --- | --- |
| npm 命令和锁定依赖 | [package.json](package.json)、[package-lock.json](package-lock.json) |
| Creator 版本 | [game/package.json](game/package.json)：`3.8.8` |
| 游戏工程 / 入口 | `game/` / `game/assets/scenes/Boot.scene`，配套 `.meta` 的 importer 应为 `scene` |
| R1 规则 / 卡牌 | `game/assets/scripts/domain/r1/runtime-config.json` / `ui-cards.json`，无需读取被 Git 排除的设计库 |
| 历史运行配置 | `game/assets/resources/prototype-v0.5.json`；`config:sync` 仅同步旧规则，供回归测试 |
| 小游戏发布构建 | [tools/minigame-release.mjs](tools/minigame-release.mjs)；独立副本、资源压缩、分包与包体检查 |
| Web CLI 构建 | [tools/cocos-build.mjs](tools/cocos-build.mjs)；使用独立副本，成功后复制到主 `game/build/`，当前生成 debug 构建 |
| 本地 Web 服务 | [tools/serve.mjs](tools/serve.mjs)；绑定 `127.0.0.1`，默认端口 `7457` |
| 平台文案 / 已知问题 | [微信文案](docs/release/超力英雄-微信文案.md)、[待优化事项](docs/release/待优化事项.md) |

运行所需图片、音频、字体及 `.meta` 已包含在 `game/assets/`。当前小游戏方案使用本地 `resources` 分包，无需额外部署资源 CDN；自定义游戏代码没有业务服务器或数据库部署步骤。R1 的老爷爷与全灭复活均免费，不提供旧版 Web 模拟广告入口。小游戏构建副本会移除未使用的旧 `mvp/art`、`mvp/fonts`，保留旧音频供 R1 复用；主工程资源不删除。

## 3. 环境准备与源码检查

以下命令针对 macOS。已验证环境为 macOS arm64、Node `24.14.0`、Creator `3.8.8`；锁定的 `sharp 0.35.4` 要求 Node `>=20.9.0`。其他操作系统需要先适配 Creator 可执行文件及类型声明路径，不能直接复用 `.app/Contents/` 布局。

新机器首次获取源码：

```bash
git clone https://github.com/changyinliangbaikai/mk21_cocos.git
cd mk21_cocos
```

已有仓库跳过克隆，先检查分支和工作区。存在改动时先读差异；需要隔离构建时使用独立工作目录，不用 `git reset --hard` 或 `git clean` 清理用户文件。

```bash
git status --short --branch
git rev-parse HEAD
node --version
npm --version
```

安装真实 Cocos Creator 3.8.8，并为小游戏构建安装带 `libmp3lame` 编码器的 FFmpeg。非默认安装位置修改下面的路径；只运行 Web 时不需要 FFmpeg。

```bash
export COCOS_CREATOR_APP='/Applications/Cocos/Creator/3.8.8/CocosCreator.app'
export COCOS_CREATOR="$COCOS_CREATOR_APP/Contents/MacOS/CocosCreator"
export FFMPEG='ffmpeg'
test -x "$COCOS_CREATOR"
test -f "$COCOS_CREATOR_APP/Contents/Resources/resources/3d/engine/bin/.declarations/cc.d.ts"
"$FFMPEG" -version
"$FFMPEG" -hide_banner -encoders
```

确认编码器输出包含 `libmp3lame`。各脚本对变量的读取不同：

| 脚本 | 路径规则 |
| --- | --- |
| 小游戏构建 | 优先 `COCOS_CREATOR`；否则从 `COCOS_CREATOR_APP` 拼接可执行文件路径 |
| Web CLI 构建 | 只读取 `COCOS_CREATOR`，不读取 `COCOS_CREATOR_APP` |
| Cocos 类型检查 | 读取 `COCOS_CREATOR_APP`；也接受 `npm run typecheck:cocos -- /实际路径/CocosCreator.app` |
| 音频压缩 | 读取 `FFMPEG`，默认从 PATH 查找 `ffmpeg` |

不要同时让 Creator GUI 和 CLI 导入同一个工程目录。Web 脚本会检查部分已打开进程；小游戏脚本每次创建副本，仍需避免在它构建期间用 GUI 打开同一副本。若安装或首次启动需要账号本人操作，先完成源码与依赖检查，清楚交接剩余环境步骤。

## 4. 公共验证与 AppID 配置

```bash
npm ci
npm run verify
npm run typecheck:cocos
git diff --check
git status --short
```

所有命令必须成功。`verify` 会同步运行配置、检查逻辑类型并运行测试；它可能改变运行配置文件，应检查差异是否符合本次设计配置。`typecheck:cocos` 使用真实引擎声明，成功日志应列出实际检查的 TS 文件数。本文基线曾通过 164 项测试及 17 个 TS 文件类型检查；未来以当前输出为准，不固定伪造计数。

小游戏可使用本地配置文件。仅在文件不存在时复制示例，然后填写目标平台的 AppID：

```bash
if [ ! -f release.local.json ]; then
  cp docs/release/release.local.example.json release.local.json
fi
```

也可以显式使用环境变量；下面示例对应当前记录的项目，运行其他项目时替换为用户指定值：

```bash
export WECHAT_APP_ID='wx130a8544c32afd2c'
```

优先级是环境变量 → `release.local.json` → 显式启用的测试值。切换 AppID 时检查已有环境变量，避免它覆盖刚修改的文件。当前只需配置 `wechatAppId` 或 `WECHAT_APP_ID`，无需抖音配置。`release.local.json` 已被 Git 忽略。

## 5. 小游戏构建

构建微信：

```bash
npm run build:wechat
```

`npm run build:minigames` 是微信构建的兼容入口，直接运行发布脚本而不指定平台时也默认微信。每次输出到新的 `artifacts/minigames/<时间戳>/`。以本次终端打印的 `Report:` 路径定位报告，不按目录名称猜测最新包，也不复用文档中的历史目录。

```text
artifacts/minigames/<本次时间戳>/
  release-report.json
  wechatgame.json
  wechatgame.log
  game/
    assets/                   # 压缩后的副本
    build/
      wechatgame/              # 导入微信开发者工具的目录
```

脚本将 PNG 调色板压缩、WAV/OGG 转 MP3、原生资源分包和引擎模块裁剪限制在副本内，保留资源 UUID、图片尺寸与帧裁剪信息。

没有正式 AppID 的本地调查可以显式运行 `npm run build:wechat -- --test-appid`。这个选项仅在 AppID 缺失时补入脚本内测试值，不会覆盖已配置 AppID。测试值能否被平台使用仍需开发者工具确认，不能据此上传正式版本。

`npm run build:wechat -- --prepare-only` 只准备副本，报告为 `prepared`，不会生成可上传构建；它仍需要 Creator 可执行文件、FFmpeg 和 AppID。准备模式没有后续“继续此副本”的命令，正式构建应重新运行完整命令。

### 5.1 构建完成的判定

Creator 子进程成功码为 `36`，npm 包装脚本成功码为 `0`。仅见到产物文件或 `stage: built` 还不够，必须同时满足：

- `release-report.json.stage === "built"`。
- `sourceUnchanged === true`，构建前后源哈希相同。
- 目标 `builds[]` 的 `exitCode === 36`、`status === "built-awaiting-ide-and-device-tests"`、`withinConservativeBudget === true`。
- 正式上传目标 `usesTestAppId === false`，报告、项目配置和当前目标 AppID 一致。
- `game.js`、`game.json`、`project.config.json` 存在，方向为 `portrait`，副本 Boot importer 仍为 `scene`。
- `builds[]` 仅包含微信目标，不把历史抖音候选列入本次验收。

当前微信构建的本地预算：主包 4 MiB，总包 30 MiB，单个分包 20 MiB。它们是仓库中的检查值，平台当前规则与最终上传计算以实际后台为准。0.7.2 微信包约主包 2.03 MiB / 总包 19.02 MiB；新包大小必须重新测量。

### 5.2 可执行的正式候选检查

保持第 4 节 AppID 配置生效。先将 `RELEASE_REPORT` 替换为本次真实路径，`RELEASE_TARGET` 固定为微信。此片段只读报告与文件，不上传。

```bash
export RELEASE_REPORT='artifacts/minigames/<本次时间戳>/release-report.json'
export RELEASE_TARGET='wechatgame'
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const target = process.env.RELEASE_TARGET;
assert.equal(target, 'wechatgame', 'Only WeChat is an active release channel');
const local = fs.existsSync('release.local.json') ? read('release.local.json') : {};
const expected = process.env.WECHAT_APP_ID || local.wechatAppId;
assert.ok(expected, 'Configure the expected AppID first');
const reportPath = path.resolve(process.env.RELEASE_REPORT || '');
const report = read(reportPath);
assert.equal(report.builds.length, 1, 'Expected a WeChat-only candidate');
const build = report.builds.find(item => item.platform === target);
assert.ok(build, 'Target is absent from this report');
assert.equal(report.stage, 'built');
assert.equal(report.creatorVersion, '3.8.8');
assert.equal(report.sourceUnchanged, true);
assert.equal(report.sourceHash, report.sourceHashAtEnd);
assert.equal(path.resolve(report.source), path.resolve('game'));
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap(entry => entry.name === '.DS_Store' ? [] : entry.isDirectory()
      ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
const assets = path.resolve('game/assets');
const hash = createHash('sha256');
for (const file of files(assets)) {
  hash.update(path.relative(assets, file));
  hash.update(fs.readFileSync(file));
}
assert.equal(hash.digest('hex'), report.sourceHash, 'Source assets changed; rebuild');
assert.equal(build.exitCode, 36);
assert.equal(build.status, 'built-awaiting-ide-and-device-tests');
assert.equal(build.withinConservativeBudget, true);
assert.equal(build.usesTestAppId, false);
assert.equal(build.appid, expected);
const project = path.join(path.dirname(reportPath), 'game');
const directory = path.join(project, 'build', target);
assert.equal(path.resolve(build.directory), directory);
assert.equal(read(path.join(project, 'assets/scenes/Boot.scene.meta')).importer, 'scene');
assert.equal(read(path.join(directory, 'project.config.json')).appid, expected);
const config = read(path.join(directory, 'game.json'));
assert.equal(config.deviceOrientation, 'portrait');
assert.equal((config.subpackages || config.subPackages || []).length, report.bundles.length);
const entry = fs.readFileSync(path.join(directory, 'game.js'), 'utf8');
console.log(JSON.stringify({ status: 'build_verified', target, appid: expected,
  directory, sourceHash: report.sourceHash, treeSha256: build.treeSha256,
  mainBytes: build.mainBytes, totalBytes: build.totalBytes }, null, 2));
NODE
```

此检查核对的是构建记录、必要文件及当前 `game/assets/`。报告的源哈希不覆盖构建脚本、依赖和工程设置，所以仍须记录构建时 Git SHA 和工作区差异。开发者工具可能改写项目配置；包内容被工具或人工改变时另外记录变化，不能把构建时 `treeSha256` 当成修改后包的哈希。

## 6. 平台预览与体验版上传

本仓库没有自动登录、上传、提审或发布脚本。以下流程通过本机平台开发者工具和账号后台完成；使用实际可用的官方 UI/CLI 能力，不编造仓库不存在的 npm 上传命令。

### 微信

1. 将报告中的 `build.directory` 导入微信开发者工具，核对 AppID、竖屏方向及“小游戏”项目类型。不要导入原始 `game/`、`artifacts/` 父目录或旧 `game/build/wechatgame/`。
2. 编译并确认开场名称为“超力英雄”、完整健康游戏忠告可见、点击开始后进入营地。继续执行第 8 节的模拟器与手机检查。
3. 需要预览时生成新的预览码，记录有效期和本次版本；让有权限的微信用户扫码。预览码可扫码仅证明预览链路可访问。
4. 用户要求上传时，填写本次平台版本和备注。若工具提示覆盖已有体验版，核对目标账号与用户要求后按授权继续。等待“代码上传成功”等明确成功结果。
5. 到账号后台核对新版本是否已被选为体验版；尚未选中时，在已授权范围内设置该版本。需要本人扫码或后台无法访问时，告诉用户具体版本、AppID 和剩余动作，并将体验版状态记为 `pending`。
6. 核对后台账号名称。修改代码和 Cocos 工程名不会自动修改账号基本资料；如名称仍旧，按改名任务范围同步处理。审核和公开发布只在用户要求的阶段推进，并分别保存平台结果。

当前记录的微信 `0.7.2` 已于 2026-09-16 上传，修正了营地主界面顶部图片中的游戏名称。微信模拟器已确认显示“超力英雄”，工具提示覆盖已有体验版并已确认，最终显示“代码上传成功”；后台最终标记及该版手机验收未独立确认。候选目录为 `artifacts/minigames/2026-09-16T01-11-25-040Z/`。继续操作前读取实际平台状态。

抖音历史材料见 [归档草稿](docs/release/抖音提审材料草稿.md)，不作为当前部署步骤。微信备案与提审资料以微信账号实际表单为准，不把抖音历史待办沿用为微信要求。

## 7. Web 构建与本机预览

推荐使用 Creator 3.8.8 打开 `game/`，完成资源导入后在构建发布面板选择 `web-mobile`，入口保持 Boot。已具备受控 CLI 环境时，也可在关闭同工程 GUI 后运行：

```bash
npm run build:web
# 桌面目标：npm run build:web-desktop
```

检查本次终端 `Evidence:` 指向的 `artifacts/cocos/<时间戳>-<平台>.json`：`status` 为 `built`、`exitCode` 为 `36`、`entryExists` 为 `true`、`sceneImporterAfterBuild` 为 `scene`、`sourceChangedDuringBuild` 为 `false`。当前脚本比较主工程 `assets/` 的开始/结束哈希，变化即失败；`snapshotChangedDuringBuild` 单独记录副本导入产生的元数据变化，不等同于主源码改变。2026-09-24 早期报告中的旧 `sourceHash` 字段实际指副本，不能与新版字段含义混用。

构建成功后选择与产物对应的服务命令：

```bash
npm run serve
# 桌面产物：npm run serve -- game/build/web-desktop
# 端口占用时：PORT=7460 npm run serve
```

打开命令输出的本地 URL，执行第 8 节检查。服务只监听 `127.0.0.1`；仅启动服务不构成公网部署，也不能直接让手机通过局域网访问。完成后停止本次启动的服务进程，保留其他任务的服务。

公网 Web 交付需要用户指定托管目标后单独完成。Web CLI 当前设置 `debug: true`；若目标要求生产构建，应在 Creator 构建面板使用相应发布设置并重新验收。交付完整构建目录，保留资源相对路径和文件名，再验证真实站点的资源加载与玩法。本仓库未提供域名、云服务器或数据库部署配置。

## 8. 验收和状态记录

| 验收项 | 成功依据 |
| --- | --- |
| 资源与界面 | 名称、中文字体、图片、动画和音频正常；无阻塞启动的资源错误；平台菜单不遮挡关键按钮 |
| 基本玩法 | 营地进入新局，召唤、部署、移动/合成、首波战斗、强化选卡及后续波次正常 |
| 局外与生命周期 | 英雄养成和编队可打开；暂停、保存回营地、重新打开及切后台恢复符合预期 |
| 微信适配 | 开场忠告、平台胶囊与安全区域正常；小游戏端不兑现 Web 模拟广告奖励 |
| 手机验证 | 记录平台、版本、机型、系统、步骤、结果；没有测完整 20 波时明确覆盖范围 |
| 上传 / 体验版 | 上传成功提示与账号后台选中体验版分别记录，不能合并成一个未经核实的状态 |

只读命令和类型测试不能代替运行验收。Web 截图应标记为 Web，模拟器截图应标记为模拟器；不将它们记录为手机实机证据。已知 `UX-001` 引导遮挡和文字溢出按用户决定暂缓，不在部署任务中顺带改动。

将本次验收记录保存在本次 `artifacts/minigames/<时间戳>/acceptance.json`（Web 可保存在对应本地证据目录）。这是由执行者填写的补充记录，构建脚本不会自动生成。至少记录：

```json
{
  "recordedAt": null,
  "sourceCommit": null,
  "workingTreeChanges": [],
  "platform": "wechatgame",
  "appId": null,
  "version": null,
  "report": "release-report.json",
  "automatedChecks": { "testsPassed": null, "testsFailed": null, "cocosTypecheck": "pending" },
  "ide": { "version": null, "status": "pending", "evidence": [] },
  "realDevice": { "status": "pending", "device": null, "coverage": [] },
  "submission": { "uploadStatus": "pending", "experienceStatus": "pending", "reviewStatus": "pending", "publishStatus": "pending", "evidence": [] },
  "knownIssues": ["UX-001"]
}
```

仅对实际完成并有证据的项填写 `passed` 或 `success`；不适用填 `not_applicable`，未核验保持 `pending`。脱离原机器时，报告中的绝对路径和被忽略的产物不一定存在，应重新构建或取得对应证据。

## 9. 失败处理与回退

| 症状 | 下一步 |
| --- | --- |
| Creator 缺失 / 找不到 `cc.d.ts` | 检查 3.8.8 安装位置和第 3 节变量；不要创建假的引擎声明跳过检查 |
| `sharp` 加载或原生模块失败 | 核对 Node 版本与当前架构，在目标机器运行 `npm ci`；不要复制其他系统的 `node_modules` |
| FFmpeg 不存在或无法编码 MP3 | 检查 `FFMPEG` 指向的可执行文件及 `libmp3lame` 支持 |
| Missing / Invalid AppID | 检查目标平台、格式及环境变量优先级；调试测试值仅使用显式参数 |
| Creator 工程已打开 | 正常关闭同目录编辑器后再构建，或使用独立副本；不要直接终止用户其他工程 |
| Creator 非 36 退出 / 包体超限 | 阅读本次平台日志和报告 `error`；保留失败证据，修复后新建候选，不直接上传失败包 |
| Boot importer 被改变 / 源哈希变化 | 停止上传，检查 `.meta` 和源码差异，区分用户已有改动；用正确源码重新导入和构建，不修改 UUID 掩盖问题 |
| 微信工具识别为普通小程序 | 核实 AppID 对应的账号类型；换用真实小游戏 AppID 并重新构建，不能靠改配置伪装账号类型 |
| 图片缺失或启动空白 | 检查 `resources` 分包、PNG/MP3 文件和加载错误；历史 WebP 方案因平台未带入资源而弃用，当前沿用 PNG |
| 模拟器无法完成操作 | 保留错误与当前画面，缩小到具体步骤；Web 可辅助检查玩法，但平台与手机验收继续标记待确认 |
| Web 提示没有入口文件 | 先构建正确目标，再传入对应构建目录；服务不会生成替代页面 |
| 扫码失效 / 缺少权限 / 后台不可访问 | 生成当前预览码、核对体验者或开发者权限，必要时交由账号本人完成明确步骤；不绕过安全拦截 |

本地失败优先保留旧的可用包和报告，在新目录修复重建。需要回退已上传版本时，先确定已验证的源码提交与平台目标，再在独立工作目录重新构建并走上传/验收流程；不假定平台存在一键回退能力，也不自动覆盖用户存档或重置整个仓库。

## 10. GitHub 提交与最终交付

用户要求提交到 GitHub 时，提交源码、可复用脚本、必要发布文案和明确选定的素材。不要提交 `release.local.json`、依赖、Creator 缓存、构建包、日志、临时截图或浏览器数据；正式发布截图位于 `docs/release/materials/`，与临时证据区分。

提交前检查实际差异、暂存范围、`git diff --cached --check` 及是否包含凭据。按改动运行必要检查；只有文档变更时校验命令、路径、链接与示例，不必重跑完整游戏构建。推送后获取远端状态，核对本地 HEAD、远端跟踪分支和 `git ls-remote` 的 SHA。

当前远端为 `origin`，分支为 `main`，但执行时应读取实际配置。若 SSH 连接超时而 HTTPS 可用，可仅对本次 Git 命令切换传输方式，不改全局配置、不关闭证书校验、不强推：

```bash
GIT_TERMINAL_PROMPT=0 git -c url.https://github.com/.insteadOf=git@github.com: -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 fetch --prune origin
# 已确认本次提交与目标分支后：
GIT_TERMINAL_PROMPT=0 git -c url.https://github.com/.insteadOf=git@github.com: -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 push origin main
```

HTTPS 写入仍需有效认证；认证失败时交接登录步骤，不索取或在命令行拼接明文 token。远端有新提交时先审查差异和合并关系再继续，保留用户未提交修改。

最终答复必须给出目标平台/AppID/版本、源码提交、产物与报告位置、实际检查结果，以及上传/体验版/审核/发布分别达到的状态。尚需用户处理时仅列具体动作和原因；不要将本地构建成功描述为已经上架。
