# 原型设计配置

当前数值版本 **v0.7**，第5/10/15波追加小Boss、第20波保留大Boss，维持v0.6普通怪曲线及每个Boss200奖励。`prototype-v0.5.json`与CSV文件名暂保留为稳定资源/工具入口，实际版本以JSON的`design_version`为准，避免无谓迁移Cocos资源ID。

- [prototype-v0.5.json](prototype-v0.5.json)：当前v0.7权威设计源。20波普通根怪8→46、每波+2；每波非Boss完整收益至少80，Boss本体200；召唤仍40。
- [wave-spawns-seed-20260912-v0.5.csv](wave-spawns-seed-20260912-v0.5.csv)：当前v0.7种子20260912的544条根怪记录，包含540普通根怪与4个Boss。23个分裂父体最多另外生成69子体；子体不预列，也不重复增加父族奖励预算。
- [history/prototype-v0.5.json](history/prototype-v0.5.json)、[旧CSV](history/wave-spawns-seed-20260912-v0.5.csv)：变更前v0.5原样存档，供旧局兼容和前后对照，不能作为新局配置重新同步。

当前普通收益5586+4个Boss800=6386，总根怪544、最多实体613。`expected_totals.ordinary_energy_budget`是旧兼容字段，含Boss通过正常击杀路径的奖励；排除Boss时读取新增`non_boss_energy_budget`。每波也提供`non_boss_root_count`、`non_boss_energy_budget`、`boss_energy_budget`，完整预算仍用`energy_budget`。M004整族12=3个子体各4，父正常死亡0，已击杀/漏出份额不能被救场重复发放。

新局克隆完整v0.7配置。老v0.5/v0.6局保持其原始配置快照、队列、余额和救场状态，不静默迁移，也不补发过去奖励。B002的`hp_by_wave`只对小Boss提供第5/10/15波320/480/720生命，`boss_tier`/`ui_title`提供小Boss/大Boss标识。`flow`仅0.7启用：选卡后自动开波、1.2真实秒准备、布阵0.2战斗时间系数；具体事务由系统规则和session实现。数值生效边界见[数值表](../数值与20波节奏表.md)；既有普通怪HP、移动速度、分段HP倍率和原目标时长本次均不变。

运行时类型/配置校验在`game/assets/scripts/domain/config.ts`，新回归用例在`game/tests/wave-economy.test.ts`。由整合负责人统一执行`npm run config:sync`，将此源复制到Cocos资源；仅改设计JSON并不代表运行包已同步或已构建。CSV秒数是tick/60展示值，比较以整数tick为准。

准确判定见[战斗空间与判定参数](../战斗空间与判定参数.md)；次数及救场事务见[系统规则](../系统规则与边界.md)。人类试玩、实际时长和平台真机验收仍需独立记录，不用算术或单元测试代替。

历史v0.6验证（2026-09-13）：新增8项经济回归通过，全量`npm test`为124/124通过，逻辑类型检查通过。`replay.test.ts`的4项历史录像明确使用归档v0.5，并核对录制版本、精确配置和原种子；它们不证明v0.6已经通关。v0.6经济测试现固定读取归档0.6，当前0.7由新增`boss-waves-v007.test.ts`覆盖四阶段Boss及544根/613实体账本。未执行`config:sync`，运行导入/最终GUI构建由整合方完成。

- [history/prototype-v0.6.json](history/prototype-v0.6.json)与[0.6 CSV](history/wave-spawns-seed-20260912-v0.6.csv)为真实0.6原样冻结，JSON SHA `58c2a6708cb20685445199bd22d6c77f36855a630556b63dbf338e270b99577e`，不会因现行legacy路径更新漂移。
- [Boss阶段与奖励-v0.7](../Boss阶段与奖励-v0.7.md)列本轮Boss参数、兼容与验证边界。

2026-09-13本轮v0.7验证：7项Boss专项及原归档经济测试通过，当前全量`npm test`148/148通过、逻辑类型检查通过。独立3策略×2速度的全Lv1合法模拟均20波满血通关、613实体全杀、无救场；固定自动准备22.8秒两档不变，战斗部分2×减半且状态一致。详见`artifacts/validation/lv1-automated-runs-v007.{json,md}`，不替代真人或平台验收。未由本组执行config:sync或构建。
