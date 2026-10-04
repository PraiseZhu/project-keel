# Step 12 旧 Jev 引用迁移（待 Key 与三机就绪）

状态：**未改任何引用文件**。前置条件（三台都装好 Keel、各自填 Key、`jev` 在三台各调用成功）目前只满足本机。

## 已交付

- `scripts/jev-refs-check.mjs`：扫描个人 profile `jevRefs` 列出的规则文件与仓库（git grep），统计非归档的 `typesafe-jev` 引用；为 0 时输出 `JEV_REFS_MIGRATED`。当前输出 `JEV_REFS_REMAINING 14`。
- `scripts/jev-migrate.mjs`：默认 dry-run，只改提到 Jev 插件的行（`typesafe-jev`→`keel`、`evaluate`→`jev`，参数不变），diff 写到 `_tmp/jev-migration.diff`（含本机路径，不入库）；`--apply` 才写文件。
- dry-run 结果：11 个文件、14 处引用。比计划列出的范围多两处，都在 approve-exec 仓：`SKILL.md` 第⑲段与 `references/owner-protocol.md`；另有 approve-exec 两个测试文件把 `typesafe-jev` / `tool=evaluate` 当作必含字符串，迁移会同步改断言。
- Cindy 托管的 `codex-home/skills/xdt-agents/jev-decision/SKILL.md` 只核对不手改：它由 Cindy 从源头生成，源头 jev-decision 改完后由 Cindy 重新下发。
- `jev-codex`（Python 直连 Typesafe）不依赖插件，保留。

## 执行顺序（就绪后）

1. 三台 `jev` 各调一次成功，`node scripts/triad-check.mjs` 输出 `TRIAD_OK 3`。
2. `node scripts/jev-migrate.mjs --apply`；在 approve-exec 仓跑 `node scripts/run-tests.mjs`，通过后按该仓本地提交流程提交。
3. 规则文件由现有三机对齐机制下发，在两台远端 `grep typesafe-jev` 复核。
4. 停用（不卸载）三台的 typesafe-jev 观察 7 天；异常就恢复旧插件并回滚引用。
5. 观察期无异常后，由用户在三台插件页卸载 typesafe-jev。

## 不在本轮做

- 修改 `workspace-triad-align.mjs`（把 triad-check 挂进每日对齐）：需用户单独确认。建议改法：在远端检查段末尾加一步“对每台 `sh scripts/triad-facts.sh`，汇总后跑 triad-check，不一致只报不改”。
- Syncthing 排除：远端 `Project Keel/` 目录（含 `.git`）正被 Syncthing 同步，与 git 构成双通道（远端 HEAD 停在旧提交）。建议在 `.stignore` 增加 `Project Keel/.git`、`node_modules`、`_tmp` 的排除后，远端只用 git 拉取；`.stignore` 由三机对齐脚本下发，同样需用户确认。
