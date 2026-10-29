# v10.0 Tactical Upgrade

## Strategy
- Added a public-information vote forecaster estimating votes, top-two likelihoods, and uncertainty from spoken calls, public claims, observed ballots, and remaining chips.
- Added ballot allocation optimization anchored on the bot's declared beast, with side-specific utility and the option to reserve chips for later rounds.
- Added score projection using revealed public rank-2 results plus each bot's own posterior estimate for hidden rank-1 results; final good-side person-vote decisions now consider whether the Lao bonus may be needed.
- Added explicit public role-hypothesis statements with estimated role probabilities, role-claim conflict tracking, cross-round role-change detection, and planned false-role bluffs.
- Added a high-risk planned false confession: a good bot may occasionally impersonate Zheng Guoqu and falsely say it confesses, but only when that exact action is in its plan and the output passes validation.
- Added a "平民" claim as a bluff phrase only. This is not a new game role and grants no new ability.

## Dialogue and review
- Added 120 curated dialogue lines across 12 tactical categories.
- Linked tactical lines to vote forecasts, score state, evidence conflicts, role contests, pressure, alliance, deception, defense, risk, and endgame context.
- Added review fields for the decision-time vote forecast, expected top-two probabilities, score projection, and chosen ballot allocation.

## Data integrity and validation
- Renaming a player without changing ID now synchronizes structured speaker names and vote-chip display names while preserving raw historical speech text.
- Historical vote descriptions are less likely to be parsed as current-round ballot calls.
- Local fallback speech for the real Fang role removes evidence parts that would violate the existing rule against publicly mentioning that role name.
- Fixed a `lie/follow` local-speech path where the planned declaration could be omitted after discussing a conflict.

## Verification in the uploaded-project working copy
- `node tests/tactics-smoke.js`: passed, including 120-line inventory, public vote forecast, score estimate, ballot optimizer, role bluff/fake-confession validation, role hypothesis wording, review diagnostics, and rename synchronization.
- `node tests/sim.js 200`: passed; 25-seed A/A determinism check had 0 failures, 200/200 paired environments aligned, total invariant failures 0.
- `node tests/ui-smoke.js`: passed; 69 renders, 0 failures, 8 review records.
- `node tests/gene-sweep.js 500` was attempted but did not finish within the execution time limit; it is not counted as a pass.

These simulations check determinism and invariants; they do not prove that v10.0 wins more often than the previous release. The A/B numbers in `tests/sim.js` compare learning-enabled and frozen-gene conditions within this working copy, not v9.0 against v10.0.
