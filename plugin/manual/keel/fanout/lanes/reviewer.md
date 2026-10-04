# 车道模板：reviewer（interrogate 审查车道，只读）

审查对象：{scope}。评审标准：{rubric}。

只读，不改文件。每条发现输出一个 JSON 对象，放在一个 ```json 代码块的数组里：
`{"file": "...", "line": 0, "title": "...", "trigger": "触发条件", "impact": "实际影响", "evidence": "证据", "severity_guess": "P0|P1|P2|P3"}`。
没有可信触发路径的不要报成 P0/P1。
