**Keel 改写（优先于下文上游内容）**

- 用 `pr_open` 开 PR，必须带 `authorization_source`（用户授权原话）。推送用 `push:true`，同样需要授权。
- Draft 跟车道走：`draft-gated-handoff` 车道强制 Draft（传 `draft:false` 也会被改回）；其余车道默认**非 Draft**（用户规则：不默认 Draft）。
- 标题与正文以目标仓规则为准：车道配置了 base 分支规则文件时，`pr_open` 会校验标题类型；正文按目标仓 PR 模板写在 `sections`。
- 开 PR 不自动 babysit；用户要盯再走 `playbooks/babysit.md`。只改用户当次点名的仓。

---
