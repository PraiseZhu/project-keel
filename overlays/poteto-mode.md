**Keel 改写（优先于下文上游内容）**

本文件是 pstack 的路由与非协商规则。在 Keel 里，入口是 `pstack_start`（Jev J1 路由 + J2 深度），中文规则覆盖层在 `keel/MANUAL.md`，覆盖层与上游冲突时以覆盖层为准：统一 P0–P3 分级且只修 P0/P1；外发（推送、开 PR、回帖、转 Ready）须用户授权；永不合并；只改用户点名的仓；worktree 放 `<仓>/.worktrees/`；Orca 派工读 routing.json、Worker 一律 bypassPermissions。下文的 Cursor `Task`/subagent 调用，换成当前 harness 的原生只读 subagent，或经 `fanout_plan` 开 Orca Worker。

---
