# v10.1 — Genuine Role Micro-Claims

## User goal
Reduce deduction-by-elimination against fake role claimants by letting real role holders sometimes hint at their true identity, while keeping the hint subtle instead of always directly saying the role name.

## Changes
- Added 104 new role-signal lines: 13 each for 許願、方震、姬雲浮、黃煙煙、木戶加奈、老朝奉、藥不然、鄭國渠. Existing 120 tactical lines remain, for 224 total across 20 categories.
- `strategy.js` probabilistically chooses a true-role signal using public role-claim pressure, direct accusations, turn number, role-specific evidence availability, genes, and whether the bot already signalled earlier. The baseline probability was tuned downward after simulation isolation; the hint is now occasional, and much more likely under a real role contest or direct pressure. A true signal suppresses simultaneous false-role jump planning for that round.
- For 許願, the signal is only eligible when two displayed inspections are available. For 方震, a signal needs a real recorded camp-check target. The lines do not explicitly say the role name or invent an unused ability outcome.
- `speech.js` includes the planned signal in Gemini instructions and local fallback output, then validates that the exact planned hint is present. Existing role-bluff validation and hard game rules remain in place.
- The round mind record stores the selected true-role signal for review and to avoid repetitive signalling in later rounds unless a role contest or direct pressure occurs. Role-signal logit nudges were reduced to 0.04–0.10 to keep hints weak rather than letting bots decode a scripted phrase as near-proof. The original role-bluff random draw is still consumed when a signal suppresses a false role-claim, preserving downstream RNG flow.
- Updated UI/README version to v10.1.

## Validation run on the delivered source tree
- `node --check` passed for the changed JavaScript/test files.
- `node tests/tactics-smoke.js`: passed, 224 lines / 20 categories; vote forecast, score projection, role bluff, rename sync, true-許願 and true-方震 signal paths covered.
- `node tests/sim.js 200`: A/A reproducibility 25/25 seeds, 0 failures; environment pairing 200/200. A (frozen genes): good win 56.5%, evil win 43.5%, 743 genuine micro-signals (3.71/game), 839 planned false role claims. B (learning on): good win 55.0%, evil win 45.0%, 739 genuine micro-signals (3.69/game), 865 planned false role claims. Total failures: 0.
- `node tests/ui-smoke.js`: 66 renders, 0 failures, 8 review objects.
- In an isolation run using the same working tree with true-signal selection disabled, the frozen / learning groups each had 57.5% good win. The feature-on run was 1.0 / 2.5 percentage points lower respectively in this 200-seed sample. This is not proof of a statistically reliable drop, but also means v10.1 must not be advertised as increasing win rate. The feature is primarily a role-play / game-variety upgrade and still needs larger direct paired evaluation.

## Limits
This adds a strategic option, not a guarantee that genuine role holders will reveal themselves every game. A signal is more likely under role-claim pressure or direct accusation, and some roles only signal when their real ability evidence exists. The 200-game A/B suite compares learning settings within this version; its output is not a claim that v10.1 wins more than v10.0. Compare old/new with larger paired seeded runs before treating any win-rate difference as reliable.
