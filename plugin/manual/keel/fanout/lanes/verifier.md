# 车道模板：verifier（独立验证）

在 `{working_dir}` 上独立验证：{claim}。

真实运行目标路径（不是只跑编译/类型检查），记录命令、输出摘要、commit SHA。输出 `PASS` / `ISSUES` / `BLOCKED` 之一，缺 SHA 或验证方法即为缺口。
