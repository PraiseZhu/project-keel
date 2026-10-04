**Keel 改写（优先于下文上游内容）**

- 状态与等待用 `pr_status` / `pr_wait`（替代 watch-pr 与 /loop）；评审线程用 `pr_threads`（Jev J4 分级 + J5 机器人评论建议），回复用 `pr_reply`（每次弹确认）。
- **Keel 不合并、不开 merge-when-ready。** 下文提到 shipping / merge 的地方，一律改为：报告“可合并”与 PR 链接，由用户在 GitHub 合并。
- 按车道停：`personal` 车道到 `READY`（`pr_status` 判定 ready）即停并报告；`draft-gated-handoff` / `gated-handoff` 车道在门禁满足后 `pr_ready` 转 Ready 并写交接记录，**交接后作者会话停手**——之后推送、回帖、修 CI 的工具调用会返回 `LANE_HANDED_OFF`。
- 修复只针对确认成立的 P0/P1；P2/P3 记录不修（见 `keel/MANUAL.md` 用户规则覆盖层）。
- CI 红先跑确定性规则（重试一次、`git merge-base --is-ancestor` 判基线），不命中再看 `pr_status` 返回的 Jev J6 结论。

---
