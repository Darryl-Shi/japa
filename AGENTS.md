# Agent directives

## Subagent models

- Every subagent (implementers, reviewers, re-reviewers, explorers, workflow agents) runs on **Opus 5.5 only**:
  `model: "anthropic/claude-opus-5-5"`. Never sonnet, haiku, or another Opus version, and never a fuzzy name
  like `"opus"` (it can resolve to a different version).
- Thinking level is **medium to xhigh only**: `thinking: "medium" | "high" | "xhigh"`. Never `off`, `minimal`,
  `low` or `max`. Always set it explicitly, so it isn't inherited.
- Pick within that range by difficulty: `medium` for small, mechanical fixes and scoped re-reviews; `high` for
  ordinary implementation and task reviews; `xhigh` for final whole-branch reviews and risky work (install,
  update, rollback, security).
- This overrides any skill's model-selection advice (e.g. "use the cheapest model").
