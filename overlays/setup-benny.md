**Keel 改写（优先于下文上游内容）**

Benny 的两条自动化（triage / reproduce）在 Cindy 里这样落地，语义与上游一致：

- **安装位置**：把整个 pack 合并进目标仓的 `.cindy/automations/benny/`（同样保留目标仓已有文件、冲突先看 diff 再合并）。不写 `.cursor/settings.json`：共享的 pstack 技能由已安装的 Keel 插件提供。用户自己的配置、feature map、routing map 放在 pack 之外，例如 `.cindy/benny/`。
- **Slack**：读写都走 Cindy 的 Slack 工具（`slack_list_tools` / `slack_call_tool`），以绑定用户身份执行。发帖前把内容给用户确认，只在原 thread 回复，规则同上游第 8 节。
- **建立自动化**：上游的 Cursor Automations editor 换成 Cindy 定时任务。每条自动化用 `schedule_create` 建一个计划，prompt 只写“读取并遵守 `<仓>/.cindy/automations/benny/<operational file>`”，不把操作文件正文抄进 prompt。建之前先把计划表（名称、频率、prompt、工作目录）给用户确认。
- **已有自动化**：用 `schedule_list` 找到同名计划后更新，不重复新建。
- **边界不变**：默认不 @ 人，只有配置的 owner 或确认的回归作者才 ping；派出的 worker 不得有 Slack 写权限；缺坐标、父消息已删、预检失败时不发帖也不建 tracker issue。

---
