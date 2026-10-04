# 日常 Jev

`jev` 工具随时可调，不读写仓库、不启动本地进程、不写 PR 台账；只调 Typesafe（`api.typesafe.ai`），并在插件私有目录记一行判断留痕（只存 state 的 sha256）。

## 两种写法

**简写（推荐日常用）**

```json
{ "question": "这次重构先拆模块还是先补测试？", "kind": "choice", "options": ["先拆模块", "先补测试"], "context": "现状：……" }
```

- `kind`: `choice`（选一个）/ `score`（按 `levels` 从低到高打分，缺省 低/中/高）/ `yesno`（为真概率）。
- `context` 放判断材料；只给与本次判断有关的内容。

**完整写法（与旧 typesafe-jev `evaluate` 完全相同）**

```json
{ "state": "…", "questions": { "pick": { "type": "choice", "instructions": "…", "criteria": { "a": null, "b": "说明" } } }, "model": "jev-latest" }
```

旧规则里的 `ghost_id=typesafe-jev, tool=evaluate` 只需改成 `ghost_id=keel, tool=jev`，参数不变。

## 读结果

- 返回 `{model, answers, usage}`（与旧插件同形），另加 `summary`（中文一句话）与 `confidence_hint`（是否达 0.75 执行线）。
- confidence ≥ 0.75 可以作为执行依据；低于阈值时补充上下文再问一次，仍低就选改动最小、可撤回的选项。
- Jev 是判断参考，不是事实证明；事实要靠代码与验证。

## 错误码

`INVALID_INPUT`、`INPUT_TOO_LARGE`（>256KB）、`NETWORK_ERROR`、`UPSTREAM_HTTP_ERROR`、`INVALID_RESPONSE`、`REQUEST_FAILED`，以及 `JEV_NOT_CONFIGURED`（未填 Key：去 Keel 插件详情页设置区填写）。
