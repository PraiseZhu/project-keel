> 移植自 pstack skills/poteto-mode/playbooks/autopilot-stack.md @ 190d287（MIT）。改写：policy：Same as autopilot-full.

**Keel 改写（优先于下文上游内容）**

跨多个 PR 的编排（orchestrate / autopilot-full / autopilot-stack）按用户既定流程：先用 `open-issue` 建总 issue 和子 issue，再「批准执行」（`approve-exec`）给每个子 issue 开一个 owner 会话，owner 会话用 `keel_run` 推进。Keel 不另起编排，`pstack_start` 命中这些 playbook 时只返回交接指引与所需输入。若用户明确要求在单会话内跑：每个 owner 停在 merge-ready，报告给用户，由用户在 GitHub 合并；一 PR 一 owner，并行走 `fanout({ op: "plan" })` 生成的 Orca 车道。

---

### Autopilot-stack

**You own the stack, never the landing. Hand the operator one linear stack of base-chained PRs to review and land.** **Autopilot-full** holds except for how verified work leaves. Each tick re-reads both playbooks from trunk, and this one wins where they differ.

1. **Run Autopilot-full's owners, minus the landing.** Owners report STACK-READY in place of merge-ready. They never rebase onto another branch, trunk included, and never retarget, merge, close a PR, or arm auto-merge, because the root owns the chain's topology and the operator owns the landing. When an item depends on another, its owner branches from that item's branch, not from trunk.
2. **Give the topology one writer.** Owners push only their own branches and report each tip and its intended parent. Only you rebase or retarget a link, because two writers on one chain undo each other. Append each clean PR in dependency order, with its base set to its parent's branch (`origin pr edit <pr> --base <parent-branch>` or `gh pr edit <pr> --base <parent-branch>`). Never require `gt`. An owner takes your push as its new base and lease, and on a conflict resolves its own slice for you to push.
3. **Absorb drift at the root.** Until landing starts, apply Autopilot-full step 5's test to each link and rebase the chain bottom-up where it calls for one. Then apply the patch-id rule link by link, since a link's base is its parent.
4. **Deliver the chain, then keep your hands off it.** Each link carries its verdict in its PR. Once landing starts, nobody writes to the chain except the post-merge retarget that `playbooks/shipping.md` sanctions, because a second writer breaks a landing in flight. A mid-landing problem goes through you to the operator, and any fix waits for the operator's go.

**Choosing between the autopilots.** Autopilot-full when the PRs are independent and landing authority is granted. Autopilot-stack when the operator wants review before landing, the work is sequenced or coupled, or merge authority is withheld.

**Reply:** catch the operator up per the **ketchup** skill, with links to the stack root and tip, a one-line verdict per link, and anything parked or excluded with the reason.
