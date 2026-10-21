> 移植自 pstack skills/why/references/sources/incident-postmortem.md @ 190d287（MIT）。改写：仅宿主名词替换

# Incident & Postmortem Context

- **Linear**: look for tickets labeled `incident`, `sev-*`, `postmortem-action-item`, `reliability`
- **Slack**: search `#sev-*` and `#incident-*` channels around the dates the target code was added
- **Git**: commits with messages like "fix for incident", "add defensive check", "revert" followed by "re-apply with..." are strong signals
