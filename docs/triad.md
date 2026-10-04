# 三机一致性

- 日期：2026-10-04
- 方法：三台各跑一次 `scripts/triad-facts.sh`（远端经 cindy_ssh 只读执行），比较已安装 Keel 的版本与安装目录内容哈希、routing.json 是否存在。

| 机器 | Keel 版本 | 安装内容 sha256 | routing.json sha256 | Cindy | 工程目录 HEAD |
|---|---|---|---|---|---|
| 本机（标准机） | 0.1.0 | `080c0c351bed7857` | `21d4e38ce2eef725` | 0.1.97 | `c713c9c` |
| 远端 A（Mini） | 未安装 | — | `21d4e38ce2eef725` | 0.1.97 | `f6a400f` |
| 远端 B（Air） | 未安装 | — | `21d4e38ce2eef725` | 0.1.97 | `f6a400f` |

结论：远端 A（Mini）：未安装 Keel；远端 B（Air）：未安装 Keel。
