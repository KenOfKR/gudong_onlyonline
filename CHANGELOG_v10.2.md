# v10.2 — Evidence Calibration & Role-Contest Audit

## Changes driven by the supplied Round 2 trace
- Removed public phrases such as “角色後驗約 98% / 100%”. `mind.js` computes `probs` by softmax-normalizing role logits; it is a relative ranking signal, not a calibrated probability. Speech now says “優先核查候選” and explicitly notes that relative ranking is not a verdict.
- Fixed role-contest category selection. Previously `hasRoleContest` meant “at least one self-role claim exists”, which could produce a line like “兩人都說自己掌握關鍵能力” after only one role claimant. v10.2 distinguishes one claimant (`identityAudit`) from two or more distinct claimant IDs (`roleContestAudit`).
- Added diminishing returns for same-round correlated public accusations: repeated call-to-focus signals against the same player and repeated same-target/same-role accusations contribute less than the first one. They remain in the speech record; they simply do not count as equally independent evidence.
- Added 100 contextual lines across 10 new categories: identity audit, role contest audit, source independence, vote uncertainty, score tradeoffs, micro-signal analysis, claim consistency, crowd pressure audit, ballot commitment and endgame role tradeoff. Total dialogue bank: 324 lines / 30 categories.

## Validation
- `node --check` on changed JavaScript files.
- `node tests/tactics-smoke.js`.
- `node tests/sim.js 200` (paired 200-game test, A/A determinism and RNG isolation).
- `node tests/ui-smoke.js`.

## Test results from the v10.2 working copy
- `node tests/tactics-smoke.js`: passed; 324 lines / 30 categories, including one-vs-two role-claim classification, no uncalibrated percentage language, and diminishing returns for same-round repeated calls.
- `node tests/sim.js 200`: A/A reproducibility 25/25 seeds, 0 failures; game environment pairing 200/200; total failures 0. Frozen-gene good win rate 57.0%; learning-enabled good win rate 58.5%. Genuine role micro-signals: 735 / 715 (3.67 / 3.58 per game). The A/B is a within-version learning comparison, not v10.2-v10.1.
- `node tests/ui-smoke.js`: 66 renders, 0 failures, 8 review objects.

These results verify tested invariants and reproducibility, not that v10.2 wins more often than v10.1. No direct same-seed v10.1-v10.2 win-rate comparison has been run.
