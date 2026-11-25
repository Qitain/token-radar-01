# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Qitain/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Qitain/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar v2 ranks 200 pre-token protocols from the sealed 2026-11-14 snapshot: all 40 watchlist protocols plus the original 160 below-floor selections. It fits comparable market capitalization from the snapshot, selects the curve with leave-one-out and listing-cohort holdouts, and tests all 32 combinations of the five v1 multipliers. A separate outer cohort audits the selection procedure.

The offline English dashboard shows predictive residual intervals, 200 bootstrap value/rank ranges, empirical token prevalence with Brier/log-loss validation, a complete 758-protocol accounting, and six-step farm plans. Farm payouts, fees, time and eligibility are explicit scenarios; net dollars per hour and a budget/time planner use the conservative P10 valuation scenario. Under the default assumptions every farm is SKIP; the page explains the result and exposes sensitivity controls.

## Run it

```sh
node --experimental-strip-types main.ts
node --experimental-strip-types scripts/verify-v2.ts
node scripts/verify-browser.mjs
```

Open `out/dashboard/index.html` directly. No network requests or dependencies are needed. `out/model-report.json` retains the complete holdout evidence; `out/audit.json` inventories the 416 issued and 142 excluded protocols. See `V2-NOTES.md` for methods, results and verification. Rebuilding refuses any input whose SHA-256 differs from the original seal. No submission, commit or publishing command is part of this workflow.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
