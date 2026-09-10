# UK risk score — validation against real EA bathing-water samples

Generated: 2026-09-08, from backtests run via `validate-uk-risk-score.js` and
`validate-uk-risk-score-traveltime.js` against 16,855 real, dated lab samples
(Southern Water's coastal bathing sites, 2015–2026), scored with the real,
unmodified `scoreSite()` cascade from
[krestenbersoe/ukwater](https://github.com/KrestenBersoe/ukwater)
(`server/risk/scoreSite.js` and its sibling modules) — not a reimplementation.
Five variants were run against the identical sample set to isolate what each
real input actually contributes. Full confusion matrices, PR curves and
calibration deciles for every variant are in each run's own
`output/uk-risk-score*-results-*.json` — this document is the prose summary,
not a replacement for that data.

## Executive summary — in plain terms

**Does the app's risk score actually predict dirty water? Weakly to
moderately — real signal exists, but nothing tested here is reliable enough
to base a swim/no-swim decision on alone. Richer inputs only help when
they're built to genuinely learn from data; the first attempt at two of
them (per-outlet rainfall calibration, real sea currents) made things
worse, and one of those has since been fixed and now measurably helps.**

- At its best, flagging the top ~20–30% of scores catches water that's
  genuinely dirtier than average — about 2–2.5x more likely to fail a real
  lab test than water picked at random.
- At the threshold the app actually uses to warn people ("Medium" risk,
  score above 0.2), across every version tested it flags something dirty
  roughly 1 time in 8 to 1 time in 9, and misses more than half of all real
  contamination events in its best-recall configuration — worse once real
  ocean-current data is added.
- **Real measured sea currents, even with the current-bias exclusion bug
  fixed, still cost a small amount of overall ranking quality** (~0.002
  AUC-PR) versus leaving currents out — a genuine, if now much smaller,
  trade-off rather than an upgrade. The original hard downstream-exclusion
  rule cost far more (roughly 80% of currents' total AUC-PR damage, 72% of
  its recall damage) and has an identified, tested fix.
- **The original per-outlet rainfall calibration was a genuine bug, not a
  trade-off: it never actually learned from real spill data.** It picked
  whichever rainfall level made an outlet's annual event *count* come out
  right, without ever checking the rainfall level at any real event —
  two outlets with the same count were calibrated identically regardless
  of whether one reliably spills at 4mm and the other at 20mm. A corrected
  version — reading real decayed rainfall at each genuine spill's own
  start time — measurably improves the score (+0.006 AUC-PR over no
  calibration, +0.009 over the broken version, confirmed on data the
  calibration never saw). It also happens to fix a second, unrelated-
  looking symptom: the app's top "Very High" alert tier was less reliable
  than rainfall alone specifically at sites with many nearby outlets,
  because the score takes the max across outlets rather than an average,
  so more outlets meant more chances for a false alarm. The corrected
  calibration suppresses exactly those false alarms.
- **The best configuration found so far is the corrected rainfall
  calibration on its own, with currents left off** — currents' remaining
  small cost isn't yet earned back by anything tested. The two fixes
  combine almost exactly additively, so this isn't a matter of one
  masking the other; currents just haven't paid for themselves yet.
- A physically-motivated fix — accounting for the fact that pollution takes
  real time to travel from an outlet to a beach, so a spill's impact arrives
  hours after it starts, not instantly — was built, verified to work
  correctly, and made almost no difference to the results. The travel-time
  gap in the model is real, but isn't what's limiting its performance here.
- It does not clearly beat the much simpler thing Southern Water already
  publishes — "was a confirmed sewage discharge assessed as reaching this
  beach" — at the settings the app currently ships with. It only pulls ahead
  at a much stricter threshold that also means far fewer warnings overall.

## What was tested

Every variant was scored against the identical 16,855 real lab samples (E.
coli and intestinal enterococci, thresholds from the real Bathing Water
Regulations 2013, [Schedule 5](https://www.legislation.gov.uk/uksi/2013/1675/schedule/5)
— coastal "Sufficient" standard, 500 cfu/100ml E. coli / 185 cfu/100ml
enterococci, a sample failing if either is exceeded), using the real
`scoreSite()` cascade, unmodified. What differs between variants is which
real inputs were available to it:

| Variant | Per-outlet threshold | Ocean currents | Timing |
|---|---|---|---|
| Baseline | Generic/frequency-heuristic fallback | None (isotropic decay) | Sample's exact timestamp |
| Calibration only | **Real, derived from each outlet's own spill history** | None | Sample's exact timestamp |
| Currents only | Generic/frequency-heuristic fallback | **Real historical CMEMS data** | Sample's exact timestamp |
| Both | Real | Real | Sample's exact timestamp |
| Travel-time corrected | Real | Real | **Shifted per outlet by real travel time** |

Real inputs behind all of this: 236,230 discharge events from Southern
Water's own EDM export, 874 distinct outlets, real per-outlet annual spill
rates (median 13/year once correctly computed), real historical hourly
rainfall per site from
[Open-Meteo](https://archive-api.open-meteo.com/v1/archive), real per-outlet
calibrated thresholds derived by running the actual
[`pipeline/14`](https://github.com/KrestenBersoe/ukwater/blob/master/pipeline/14-compute-outlet-thresholds.js)
peak-collapse fit (716 outlets got a direct threshold, 246 borrowed from
nearby outlets), and real historical ocean current data from CMEMS's
[`NWSHELF_MULTIYEAR_PHY_004_009`](https://data.marine.copernicus.eu/product/NWSHELF_MULTIYEAR_PHY_004_009)
reanalysis (`cmems_mod_nws_phy-uv_my_7km-3D_P1D-m`, 367 grid points, daily,
2015-01-01 to 2026-06-30).

## Headline results, all five variants

Base rate (no model at all): 5.7% of samples failed (969/16,855).

| Variant | AUC-PR (comb./bact.) | Precision @0.2 (comb./bact.) | Recall @0.2 (comb./bact.) |
|---|---|---|---|
| Baseline | 0.105 / 0.115 | 9.4% [8.6–10.2%] / 11.5% [10.5–12.7%] | 47.8% [44.7–50.9%] / 38.5% [35.5–41.6%] |
| Calibration only | 0.095 / 0.100 | 11.1% [10.1–12.2%] / 13.7% [12.2–15.3%] | 39.3% [36.3–42.4%] / 27.9% [25.1–30.8%] |
| Currents only | 0.088 / 0.096 | 10.8% [9.7–12.2%] / 13.3% [11.6–15.1%] | 26.6% [23.9–29.5%] / 20.1% [17.7–22.8%] |
| Both | 0.084 / 0.089 | 11.7% [10.4–13.2%] / 13.5% [11.7–15.6%] | 24.5% [21.9–27.3%] / 16.4% [14.2–18.9%] |
| Travel-time corrected | 0.078 / 0.084 | 9.3% [8.3–10.5%] / 13.0% [11.2–15.0%] | 26.7% [24.0–29.6%] / 16.3% [14.1–18.8%] |

**Every real input made ranking quality (AUC-PR) worse, not better, than the
crude baseline** — calibration alone (0.105→0.095), currents alone
(0.105→0.088), both together (→0.084). This holds for both the combined
score and the bacterial-only sub-score. More realistic inputs consistently
produced a *less* reliable ranking, not a more reliable one, in this dataset.

**Currents drives most of the recall collapse; calibration is a smaller,
real contributor.** Combined recall falls from 47.8% (baseline) to 39.3%
(calibration only) to 26.6% (currents only) to 24.5% (both). Currents alone
accounts for most of that drop. The most likely mechanism: the real current
model doesn't just discount a downstream/transverse outlet's contribution —
it **zeroes it out completely** (`currentBias.js`: `if (dot <= 0) return 0`).
That's physically correct in principle, but CMEMS's 7km native grid is
coarse relative to the actual small-scale coastal transport near individual
outlets and beaches — a wrong direction read from the coarse grid discards
real signal outright rather than merely discounting it.

**Precision gains from calibration and currents don't stack.** Each
individually improves precision by 1.4–2.2 percentage points over baseline;
combined isn't meaningfully better than either alone (11.7% vs. 11.1%/10.8%
combined). They appear to be correcting overlapping false positives, not
complementary ones.

## The travel-time correction: real, verified, and nearly inert

The real model computes a per-outlet travel time (distance ÷ measured
current speed) and uses it to discount **how much** of an outlet's
contribution reaches a site — but never shifts **when** that outlet's live
spill status and local rainfall are read; every outlet's status is checked
at the sample's exact timestamp regardless of distance. A spill an EDM
sensor reported as having ended more than 2 hours before a sample
(`FRESHNESS_HOURS` in `liveOverride.js`) is treated as stale and the model
falls back to a generic rainfall estimate — even when real travel time means
the contaminated water is still physically arriving at the beach.

A corrected variant (`validate-uk-risk-score-traveltime.js`) was built that
looks up each outlet's status at `sample_time − travel_time` instead, using
only real, unmodified formulas from the product's own code, restructured to
run per-outlet instead of per-site. Verified with a targeted check before
trusting the aggregate numbers: for a synthetic event that ended 6 hours
before a sample with ~5.56 hours of real travel time, the uncorrected
lookup fell back to a generic rainfall estimate (stale), while the corrected
lookup correctly landed in the "recently active, still partly relevant"
regime instead — proving the mechanism changes which real code path fires,
not just a number.

Despite that, the aggregate effect was small: AUC-PR 0.084→0.078 combined,
0.089→0.084 bacterial; most precision/recall figures moved by amounts within
or barely outside each other's confidence intervals. Most likely reason: the
correction only changes the outcome for a fairly narrow band of cases — an
event that ended between 2 hours and roughly "2 hours + travel time" before
the sample. Outside that band it changes nothing, and the aggregate result
is dominated by the rainfall-baseline layer, which decays over 12–72 hours —
a shift of a few hours barely moves its accumulated value. The travel-time
gap in the model is real and now demonstrably present, but it is not what's
limiting this model's aggregate performance in this dataset.

## Calibration curve: signal only in the top of the range (baseline variant)

Splitting the baseline variant's combined-score samples into ten equal-sized
buckets by score:

| Score range | Observed real fail rate |
|---|---|
| 0.000 (no signal at all) | 6.1% and 4.0% (two buckets) |
| 0.003 – 0.152 (low-mid) | 4.9%, 3.7%, 2.7%, 3.9%, 4.6% |
| 0.193 – 0.321 | 6.6% |
| 0.321 – 0.514 | 7.1% |
| 0.514 – 0.974 (top decile) | 13.9% |

The middle of the range is flat-to-noisy and sometimes sits *below* the
zero-score buckets — a score of 0.10 is not reliably worse than a score of
0.00 in the baseline variant. Real, roughly monotonic signal only appears
from about the 80th percentile up. This was not recomputed for the
calibration/currents/travel-time variants — worth doing before relying on
any variant's score as a literal probability, not just the baseline's.

## How much does the label definition matter? Threshold sensitivity and what happens without one

Two follow-up questions, both computed directly from real data (`ml-features-holdout.ndjson`, shrinkage calibration, no currents — the rule-based cascade's own score, not the alt-model), not simulated.

**1. Sufficient vs. Excellent regulatory threshold — real effect, and it cuts the opposite way intuition suggests.**

| Determinand | Threshold | Base rate | AUC-PR | Lift over base rate |
|---|---|---|---|---|
| E. coli | >500 cfu/100ml (Sufficient) | 2.1% | 0.056 | **2.63x** |
| E. coli | >250 cfu/100ml (Excellent) | 4.6% | 0.097 | 2.09x |
| Enterococci | >185 cfu/100ml (Sufficient) | 5.2% | 0.107 | **2.04x** |
| Enterococci | >100 cfu/100ml (Excellent) | 8.6% | 0.158 | 1.83x |

Raw AUC-PR roughly doubles at the looser Excellent threshold, but that's mostly just more positives available to find — lift over base rate, the fair comparison, actually goes *down* at the looser threshold for both determinands. The risk score is relatively better at catching genuinely severe regulatory failures than at catching mild exceedances — its strength is concentrated at the rare, extreme end of the distribution, not spread evenly across "any elevation at all."

**2. Removing the threshold entirely — and the result depends entirely on whether "average" means mean or median, which is not a minor detail on this data.**

| Label | Base rate | AUC-PR | Lift |
|---|---|---|---|
| E. coli > median (10 cfu/100ml) | 40.1% | 0.477 | **1.19x** |
| E. coli > mean (70.2 cfu/100ml) | 15.3% | 0.224 | 1.46x |
| Enterococci > median (10 cfu/100ml) | 35.4% | 0.441 | **1.24x** |
| Enterococci > mean (61.4 cfu/100ml) | 13.7% | 0.218 | 1.59x |

The mean is nowhere near the middle of this data: median E. coli is 10 cfu/100ml, but the mean is 70 — a handful of extreme spikes (max 14,000 cfu/100ml) drag it far above where "typical" water sits, so only 15% of samples exceed the mean, not ~50%. "Above mean" ends up behaving like a loose regulatory-style threshold, not a true above/below split.

**"Above median" is the real answer to "remove the threshold and split on average" — a genuine 50/50 split — and the result is the starkest finding in this document: lift collapses to ~1.2x, barely better than a coin flip.** The AUC-PR number alone (0.48) looks large only because a 40% base rate is a trivially easy target for ANY monotonic score, informative or not — this is exactly why `liftOverBaseRate`, not raw AUC-PR, has been the standard comparison throughout this document. This sharpens what the calibration-curve section above already hinted at into a hard number: **the model has essentially no signal for "is this water somewhat cleaner or dirtier than typical" — its entire real value is concentrated in flagging the rare, extreme pollution tail.** Take away the regulatory threshold and ask the softer question, and there is almost nothing left.

## Head-to-head: risk score vs. Southern Water's raw Impact Status field

| Signal | AUC-PR | Precision | Recall |
|---|---|---|---|
| Raw EDM "Impacted" flag (24h lag) | 0.106 | 15.3% [12.0–19.3%] | 6.0% [4.7–7.7%] |
| Raw EDM "any event, any status" (24h lag) | 0.107 | 15.2% [12.3–18.7%] | 7.6% [6.1–9.5%] |
| Risk score, bacterial, baseline variant, default threshold (>0.2) | 0.115 | 11.5% [10.5–12.7%] | 38.5% [35.5–41.6%] |
| Risk score, bacterial, baseline variant, stricter threshold (>0.7) | 0.115 | 24.7% | 8.3% |
| Risk score, bacterial, fully-real-inputs variant, default threshold (>0.2) | 0.089 | 13.5% [11.7–15.6%] | 16.4% [14.2–18.9%] |

Even with every real input now available, the risk score's ranking quality
(AUC-PR) never clearly separates from Southern Water's own raw field
(0.106–0.107). The one place the risk score demonstrably wins is the
baseline variant tuned to a strict threshold (24.7% precision at a
comparable 8.3% recall to the raw field's 6.0%) — but that comparison uses
the crude, uncalibrated baseline, not the more realistic variants, which
score lower on AUC-PR across the board.

## Very High band: is the top alert tier reliable?

The app's own top tier (`RISK_BANDS`, score >0.8 — see `server/risk/scoreSite.js`)
is presumably the strongest public-facing warning it issues. Precision
there — of every sample actually flagged Very High, how often was the
water actually polluted — for the combined score, either-determinand,
overall, across every variant tested this session:

| Variant | Precision | Recall | Flagged |
|---|---|---|---|
| Rainfall alone (no outlets, live-status, distance, or current) | **27.4%** | 8.9% | 314 |
| Baseline (no currents, no calibration) | 17.5% | 3.7% | 206 |
| Currents only, hard exclusion (real code) | 18.0% | 3.6% | 194 |
| Currents only, exclusion softened | 17.7% | 3.7% | 203 |
| Currents only, graduated trust | 17.3% | 3.6% | 202 |
| Calibration only | 11.4% | 2.4% | 201 |
| Both combined (calibration + currents) | 11.3% | 2.4% | 203 |
| Travel-time corrected | 10.8% | 2.7% | 241 |
| Sigmoid baseline probability (steepness=4) | 16.3% | 6.7% | 398 |

Two findings worth acting on:

- **The simplest possible signal beats every "smarter" combined variant at
  this tier.** Rainfall decay alone — no outlets, no live-EDM status, no
  distance decay, no current bias — gets 27.4% precision, comfortably
  ahead of every full-cascade variant (10.8–18.0%). This isn't just "the
  cascade doesn't help" (already established via AUC-PR throughout this
  document) — at the Very High tier specifically, the added layers are net
  *harmful*, not neutral. Whatever live-status/distance/current-bias are
  contributing at the top of the score range, on this dataset it's more
  noise than signal.
- **The sigmoid probability-curve fix (previous section) makes this tier
  WORSE, not better, despite improving precision at the app's Low/Medium
  boundary (>0.2).** Precision drops (17.5%→16.3% vs. the matched-config
  baseline) while the number of Very High flags nearly doubles (206→398).
  Mechanism: the sigmoid saturates faster once past `kMm` than the real
  exponential does, so more borderline-elevated samples get pushed into
  "Very High" that the exponential would have left in "High" (0.5–0.8).
  A curve change validated at ONE threshold moved the OTHER threshold in
  the wrong direction — the real risk-band boundaries (0.2/0.5/0.8) are
  not independent of each other, and any future probability-curve change
  needs to be checked against all three, not just the one it was designed
  around.
- The current-bias fixes (soften-exclusion, graduated-trust) are the only
  tested changes that improve the currents-on numbers broadly (see above)
  **without** damaging this tier (17.3–17.7% vs. the real code's 18.0% —
  a rounding-level difference, not a regression).
- **RESOLVED — the "fuller cascade underperforms rainfall alone" gap has a
  confirmed mechanism: MAX-of-N cascade amplification, and shrinkage
  calibration fixes it as a side effect.** `scoreSite()` combines every
  nearby outlet via MAX, not an average — so a site with more candidate
  outlets has more independent chances for one of them to clear a fixed
  threshold by luck, inflating flags without adding real signal. Splitting
  samples by nearby-outlet count (runtime median split, `outlets:few` /
  `outlets:many`) confirms this directly under the old tier-2 heuristic:
  many-outlet sites get flagged Very High ~3.7x more often proportionally
  (n=9,615, flagged=171, rate 1.78%, precision 17.0%) than few-outlet sites
  (n=7,240, flagged=35, rate 0.48%, precision 20.0%) — more outlets, worse
  precision, exactly what MAX-of-N inflation predicts. Under shrinkage
  calibration alone, the pattern **reverses**: many-outlet sites flag less
  often and precision more than quadruples (flagged=42, rate 0.44%,
  precision 35.7%) versus few-outlet sites (flagged=58, rate 0.80%,
  precision 8.6%) — the combined config (shrinkage + real currents +
  softened exclusion) confirms the same reversal (34.1% many vs. 10.5%
  few). Shrinkage calibration doesn't just raise AUC-PR in aggregate — it
  specifically suppresses the false positives that MAX-of-N inflation was
  generating at high-outlet-density sites, which is the mechanism-level
  answer to why the fuller cascade underperformed rainfall alone.

## Shrinkage calibration: a genuinely-learned per-outlet threshold

The original tier-1 calibration (`pipeline/14`'s `deriveThresholdForOutlet`)
never actually learns anything from EDM data — it picks whichever rainfall
peak makes an outlet's annual event *count* come out right, without ever
checking what rainfall level actually preceded any real event. Two outlets
with the same event count get calibrated identically regardless of whether
one reliably spills at 4mm and the other only at 20mm.

`compute-outlet-thresholds-shrinkage.js` fixes this: for each outlet, it
reads the real decayed rainfall accumulation *at each genuine event's own
start timestamp* (using the real `accumulateDecayed()`), and uses the
median of those values as an empirical per-outlet estimate — shrunk toward
a k-nearest-neighbor-borrowed prior in proportion to how much real data
exists (`threshold = (nOwn×ownMedian + PSEUDO_COUNT×neighborValue) / (nOwn+PSEUDO_COUNT)`,
so a single event pulls the estimate partway toward itself, not all the
way — no hard "enough events" cutoff, same graduated-not-stepped principle
as the current-bias fixes). `edm-outlet-coverage-stats.js` showed this had
real data to work with: 76.1% of outlets (665/874) have 10+ genuine events,
plenty for a real empirical median, not just a count.

Result — full backtest, currents off both times, combined score, either-
determinand, overall:

| Variant | AUC-PR | Precision @0.2 | Recall @0.2 |
|---|---|---|---|
| No calibration (tier 2 heuristic) | 0.098 | 10.0% | 43.2% |
| Old calibration (count-matched) | 0.095 | 11.1% | 39.3% |
| **Shrinkage calibration (event-onset)** | **0.104** | 10.0% | 45.9% |

Bacterial sub-score shows the same pattern, more strongly: 0.108 (no
calibration) → 0.100 (old calibration, worse) → **0.114** (shrinkage,
best of all three, and the best AUC-PR recorded anywhere in this
document). Unlike the sigmoid fix, this isn't a precision/recall trade —
recall improves substantially (+6.6 points combined, +6.8 bacterial vs.
old calibration) while precision moves only slightly (within ±1 point).
This is the single strongest, cleanest improvement found this session.

**RESOLVED — temporal holdout confirms this is real, not overfitting.**
Calibrated using only events before 2024-01-01
(`compute-outlet-thresholds-shrinkage.js --events-before`), then evaluated
only on samples from 2024-01-01 onward (`validate-uk-risk-score.js
--samples-after`) — a period the calibration never saw, against a fair
control (identical restricted sample set, no calibration). Combined
score, either-determinand, overall (n=4,333, smaller than the full
16,855-sample set, so wider confidence intervals than the headline
numbers): AUC-PR 0.076→0.086 (+0.010), precision +0.8pt, recall +4.8pt.
Bacterial: 0.082→0.094 (+0.012). The out-of-sample gain is as large as or
larger than the full-dataset in-sample gain (+0.006–0.007) — the opposite
of what overfitting would look like. One internal consistency check for
free: every rainfall-only row is numerically identical (Δ=0.000) between
the two runs, as expected since that score field never touches the
calibration file — confirms the two runs differed in nothing else.

**How much better, in plain terms — depends which baseline you ask against:**

- **vs. the original broken calibration**: AUC-PR +0.009 (~9% relative,
  combined) to +0.014 (~14% relative, bacterial), recall +6.6 to +6.8
  points, precision essentially flat.
- **vs. no calibration at all** (the fairer question, since "no
  calibration" was always a legitimate fallback, not a broken state):
  AUC-PR +0.006, recall +2.7 points, precision flat.
- **Keep this in proportion**: AUC-PR moved from ~0.10 to ~0.10–0.11 —
  still a modest absolute number, not a transformed model. This is the
  first calibration approach that measurably helps rather than hurts, not
  evidence the model is now good. It's the smallest and most defensible
  of the improvements found this session, not the biggest lever available
  — that's still the open question of why the fuller cascade underperforms
  rainfall alone at the Very High tier (see above; now resolved — see the
  Very High band section and "Does it stack with the current-bias fix?"
  below).

**Does it stack with the current-bias fix? Yes, almost exactly
additively — but that reveals a practical recommendation.**
`sweep-combined-fixes.js` ran all four combinations (baseline,
shrinkage-only, currentfix-only, combined) against the identical sample
set. Combined score, either-determinand, overall:

| Config | AUC-PR | Gain vs. baseline |
|---|---|---|
| Baseline | 0.0981 | — |
| Shrinkage-only | 0.1041 | +0.0060 |
| Currentfix-only | 0.0960 | −0.0022 |
| Combined | 0.1019 | +0.0037 |

Additive prediction (baseline + shrinkage gain + currentfix gain) =
0.1020; actual combined = 0.1019 — a diff of −0.0001, essentially exact
additivity. Bacterial sub-score matches: 0.1080 → 0.1140 (+0.0061) →
0.1048 (−0.0032) → 0.1108 (+0.0029), additive prediction 0.1109, diff
−0.0000.

The practical consequence: because real currents still cost a small
residual (~0.002 AUC-PR) even with the exclusion softened, **the
best-performing tested configuration right now is shrinkage calibration
alone with currents off — not the combined configuration.** Currents only
pay for themselves once whatever is causing that residual gap is found
and fixed; until then, shipping shrinkage calibration alone is the
higher-AUC-PR choice on this dataset.

## Alternative model: does a learned combiner beat the hand-designed cascade?

Everything above tunes or fixes pieces of `scoreSite()`'s own hand-designed
formula (MAX-of-outlets, saturating exponential, hard current exclusion).
None of it ever fits weights against the real labels. This tests the
obvious next question directly: given the exact same real ingredients
`hazardScore()` already computes — decayed rainfall (bacterial and viral),
each nearby outlet's own contribution/distance/baseline/live-status (top 5,
real `allContributors`), plus raw current vectors independent of the
cascade's own hard exclusion — does a model that LEARNS how to combine them
beat the hand-picked MAX?

**Method, leakage-safe throughout**: shrinkage-calibrated thresholds
recomputed using only pre-2024 events (`--events-before 2024-01-01` —
191/874 outlets had enough pre-2024 history to calibrate directly, fewer
than the full-history 874 since EDM monitoring itself only starts
Dec 2020); trained on samples before 2024-01-01 (n=12,522), tested only on
2024+ samples never seen in training (n=4,333) — same split point this
session's other holdout tests use. Two models: logistic regression (linear,
a sanity check on whether the gain is really about tree flexibility) and
XGBoost (gradient-boosted trees). Rule-based comparison scores
(`ruleBasedScoreNoCurrents`, `ruleBasedScoreWithCurrents`,
`ruleBasedRainfallOnly`) are the REAL `scoreSite()` output on the identical
rows — not a different sample set.

Combined score, either-determinand, test period only (2024-01-01 onward):

| Model | AUC-PR | Lift | Precision @matched flag rate | Recall @matched flag rate |
|---|---|---|---|---|
| Rule-based, shrinkage calib., no currents (this doc's best config) | 0.088 | 1.54x | 9.6% | 39.4% |
| Rule-based, with currents | 0.077 | 1.33x | 6.9% | 28.1% |
| Rule-based, rainfall alone | 0.097 | 1.68x | 9.4% | 38.6% |
| Logistic regression (same raw features) | 0.118 | 2.05x | 10.7% | 43.8% |
| XGBoost, untuned defaults (same raw features) | 0.122 | 2.12x | 10.2% | 41.8% |
| **XGBoost, nested-CV tuned (same raw features)** | **0.117** | **2.04x** | **11.0%** | **45.0%** |

("Matched flag rate" — the rule-based cascade's own >0.2 threshold flags
23.5% of the test set; every model's own threshold is set to flag that same
share, since a learned model's score isn't on the same 0-1 scale as the
rule-based probability, so comparing at "score > 0.2" for both would compare
different operating points, not a fair one.)

**Both learned models beat the best rule-based config by roughly the same
margin — logistic regression +0.030 AUC-PR (~34% relative), tuned XGBoost
+0.029 (~33%)** — bigger than every fix found earlier in this document,
shrinkage calibration included (+0.006 to +0.019). That plain logistic
regression matches tuned XGBoost says the gain isn't about tree flexibility
at all — it's that nobody had ever fit weights against the real labels
before. Precision/recall gains at the matched flag rate are real but far
more modest (+1 point precision, +2–5 points recall) than the AUC-PR gap
suggests — the learned models are better across the whole ranking, not
dramatically better at this one operating point.

**RESOLVED — nested-CV hyperparameter tuning: XGBoost's apparent edge over
logistic regression in the first pass was a single-split artifact, not a
real advantage.** Inner loop: `RandomizedSearchCV` (60 candidates) over
`TimeSeriesSplit` (4 time-ordered folds, training period only — never
touching the 2024+ test set); outer evaluation stays the one genuine
holdout, not a second shuffled outer loop, because the shrinkage-calibrated
thresholds baked into every feature were themselves computed from only
pre-2024 events — a second outer loop reaching further back within the
training period would let some folds' training rows reflect calibration
information from their own chronological future. Full detail in
`train_alt_model.py --tune`. Two results worth having found:

- **Properly tuned, XGBoost does not beat the untuned defaults, and lands
  statistically indistinguishable from plain logistic regression** (0.117
  vs. 0.118 AUC-PR — the earlier untuned XGBoost number, 0.122, was the
  best of this comparison by chance, not by a real edge). The search
  itself chose a much simpler model than the untuned default (`max_depth=2`
  vs. 4, meaningful L1/L2 regularization) — the tuning process correctly
  recognized that less complexity generalizes better forward in time on
  this dataset, it just didn't translate into beating the linear baseline.
- **The inner-CV score used to SELECT these hyperparameters (0.154) was
  itself well above the true holdout result (0.117) even after doing
  everything right** — time-ordered folds, no shuffling, hyperparameters
  chosen without ever touching the test set. This is a stronger version of
  the CV-overstatement caveat from the first pass (train-CV 0.207 vs. 0.122
  test for untuned XGBoost, 0.163 vs. 0.118 for logistic regression): even
  a methodologically correct inner-CV number, used for the thing it's
  supposed to be safe for (model/hyperparameter selection, not final
  reporting), still ran meaningfully hot relative to the real 2024+ period.
  The most defensible reading is real distribution shift between the
  training and test periods (weather patterns, EDM monitoring coverage,
  station changes over 2015–2026) that no amount of regularization
  corrects — not just ordinary variance from one split. The holdout number
  is the only one of these worth quoting as "how good is this," full stop.

**Feature importance (tuned XGBoost) reinforces an earlier finding, more
strongly than the untuned pass did**: rainfall (viral and bacterial,
baseline probability and decayed mm) dominates as expected, followed by
distance and isotropic-contribution features across multiple outlets — but
THREE current-related features now appear in the top 15
(`f_top0_currentDot`, `f_top1_currentDot`, `f_top0_currentSpeed`), computed
independently of `currentBias.js`'s own hard exclusion. That's a second,
independent hint (alongside the softened-exclusion isolation test elsewhere
in this document) that real usable signal exists in current direction which
the hard `dot≤0 → 0` rule throws away entirely rather than discounting.

**RESOLVED — replicated on a second, independent holdout (2025-01-01
cutoff, recalibrated on only pre-2025 events — 718/874 outlets, better
coverage than the 2024 split's 191/874). Direction replicates, magnitude
does not, and the replication itself surfaced a stranger problem with
inner-CV than the first pass found.**

| | AUC-PR | Lift | vs. rule baseline |
|---|---|---|---|
| Rule-based, no currents (n=2,751 test, 4.9% base rate) | 0.072 | 1.46x | — |
| Logistic regression | 0.088 | 1.78x | +0.016 (~22%) |
| XGBoost, nested-CV tuned | 0.090 | 1.82x | +0.018 (~24%) |

Learned models beat the rule-based cascade again — two-for-two, not a
single-cutoff fluke. XGBoost and logistic regression are again
statistically tied (0.090 vs. 0.088), confirming tree flexibility isn't
the driver. But the SIZE of the advantage roughly halved in relative terms
versus the first holdout (~33–34% → ~22–24%) — with only ~135 positives in
this later, shorter test window (2025-01-01 onward — less than the first
holdout's ~32 months remains past this later cutoff), that could be a
genuine shrinking edge or could just as easily be noise from a smaller
positive count; distinguishing the two would need bootstrapped confidence
intervals, not done here.

The sharper finding: **the inner-CV score used to select hyperparameters
was nearly identical across both holdouts (0.1535 vs. 0.1529) despite the
TRUE holdout AUC-PR differing substantially (0.117 vs. 0.090).** Inner-CV
isn't just running optimistic, as the first pass already showed — it's
tracking something about the training data's own internal structure that
barely moves between two different train/test splits, while the number it's
supposedly a proxy for (true forward performance) moves a lot. That makes
it a genuinely poor predictor of how well a configuration will do on the
actual future period, not merely a biased-but-monotonic one.

**What this does and doesn't establish**: it establishes, now on two
independent holdouts, that a learned combiner — either model, tree or
linear — beats the hand-designed cascade, and that gradient-boosted trees
over plain logistic regression doesn't matter once tuning is done
honestly. It does NOT establish a stable, quotable size for that advantage
(22–34% relative, and the honest answer is "somewhere in that range, not
pinned down more precisely without more holdouts or bootstrapping"), and
the absolute lift (1.5–2.0x) is still well short of what a swim/no-swim
decision would need (see this document's own gap estimate — roughly 3–5x
precision at comparable recall). This is evidence the rule-based cascade's
ceiling is lower than necessary, not evidence a deployable replacement
exists yet.

**Tested and NOT supported on this dataset: hour-of-day as a feature —
motivated by real published evidence, but the dataset itself can't test
it.** Wyer et al. 2018 (*Water Research X* 1:100006, Swansea Bay,
half-hourly sampling, n=1,303) found FIO concentrations at a UK bathing
water swing by a mean of 1 log10 order within a single day (largest cases
>2 log10) on a diurnal cycle independent of rainfall (their own bivariate
regression: r²=0.106 for E. coli, r²=0.000/p=0.755 for enterococci — no
relationship at all). Adding sin/cos-encoded hour-of-day (from the
existing `tsMs` field, no new data needed) to the alt-model's feature set
made logistic regression WORSE on both holdouts (0.118→0.111, 0.088→0.082)
and did nothing for XGBoost (+0.0003, +0.0008 — noise on both). Checked
why rather than left as an unexplained null: **85% of all 16,855 samples
in this dataset were collected between 10:00–13:00 UTC, standard deviation
of sample hour is 1.6 hours** — nothing like Wyer et al.'s deliberate
07:00–19:00 half-hourly design. There's essentially no within-day timing
variation for a model to learn from here, so this result doesn't
contradict the paper — it means this dataset structurally can't test its
claim.

**A sharper, more concerning question falls out of that same fact, unresolved**:
10:00–13:00 UTC is 11:00–14:00 local during the (BST) bathing season —
close to the low-concentration trough Wyer et al. reported (their low
period was roughly 11:00–16:00 GMT). If UK regulatory sampling schedules
systematically cluster in that window — plausible on its own, a normal
working-hours sampling round would land here regardless of any deliberate
choice — every label in this dataset could be systematically biased toward
under-ascertaining pollution, not just noisily scattered around the true
value. That's a different, more serious problem than ordinary label noise,
and this dataset has no way to check it: it would need repeated same-day
sampling at varied hours (like Swansea Bay's own study design), which
doesn't exist here.

## Suggestions for improvement

Ranked by strength of evidence gathered this session, not by effort:

1. **Adopt shrinkage calibration (event-onset rainfall + graduated blend) —
   now the single best-evidenced change in this document.** +0.009 to
   +0.014 AUC-PR over the old count-matched method across every
   scoreField/labelType combo, recall up substantially, precision roughly
   flat — and confirmed on a genuine temporal holdout (calibrated on
   pre-2024 events, tested only on 2024+ samples it never saw), where the
   gain held up (+0.010 to +0.019 AUC-PR) just as strongly as in-sample.
   Not an in-sample artifact — the strongest-evidenced recommendation in
   this document.
2. **Ship the current-bias exclusion fix (soften or graduated).** Recovers
   ~80% of the AUC-PR and ~72% of the recall that real currents otherwise
   cost, verified at full scale, and doesn't hurt the Very High tier
   (unlike the sigmoid change). Between the two: `graduated-current-trust`
   edges out `soften-exclusion` slightly and is closer to the real code's
   own logic outside the 500m–7km band, but the difference is small
   (~0.001 AUC-PR) against real added complexity — soften-exclusion is the
   simpler, easier-to-defend default unless a future test shows the
   500m–7km band specifically mattering.
3. **Do not ship the sigmoid probability-curve change as tested.** It
   trades recall for precision at 0.2 and does the reverse at 0.8 — net
   roughly a wash on AUC-PR, but actively worse at the tier that matters
   most for public trust. If a shape change is still worth pursuing, it
   needs its own multi-threshold validation (this document's own
   extract-veryhigh-precision.js / sweep-sigmoid-steepness.js pattern),
   not a single-threshold check.
4. **RESOLVED — the fuller cascade underperforms rainfall alone at Very
   High because of MAX-of-N cascade amplification, and shrinkage
   calibration already fixes it.** `scoreSite()` combines nearby outlets
   via MAX, not an average, so sites with more candidate outlets have more
   independent chances for one to clear a threshold by luck. Confirmed
   directly by splitting samples on nearby-outlet count: under the old
   heuristic, many-outlet sites flag Very High ~3.7x more often
   proportionally with worse precision (17.0% vs. 20.0% for few-outlet
   sites); under shrinkage calibration the pattern reverses and precision
   at many-outlet sites more than quadruples (35.7% vs. 8.6%). This is not
   a separate problem needing separate work — it's further, mechanism-
   level evidence for adopting shrinkage calibration (item 1). See the
   Very High band section for the full numbers.
5. **Document or derive real justification for RISK_BANDS' 0.2/0.5/0.8
   boundaries.** Already flagged as unsourced (see below), but the sigmoid
   result makes this more urgent, not less: this session just demonstrated
   that a change validated at one boundary can silently move the others in
   the wrong direction, which is a real risk for a set of thresholds with
   no documented rationale to check changes against.
6. **Prioritize the above over new input sources.** Given the old
   calibration and currents both reduced AUC-PR before their respective
   fixes, and neither the raw EDM field nor any tested risk-score variant
   achieves a convincing AUC-PR advantage over the other (0.106–0.115
   range across the board pre-shrinkage), fixing what's already in the
   cascade has shown a clearer, larger, more reliable return than any
   input added this session.
7. **Investigate a learned combiner (logistic regression or XGBoost — the
   tuning result shows the choice barely matters) as a longer-term
   replacement for the hand-designed MAX-of-outlets cascade — the single
   biggest AUC-PR gain found this session, REPLICATED on two independent
   temporal holdouts (2024-01-01 cutoff: +0.029-0.030, ~33-34% relative;
   2025-01-01 cutoff: +0.016-0.018, ~22-24% relative), but not yet ready to
   ship.** Same real per-outlet ingredients `hazardScore()` already
   computes, fed to a model that learns its own combination instead of
   being told MAX. Bigger than every rule-based fix above on both holdouts,
   and feature importance points at the same current-exclusion signal loss
   item 2 already targets. Nested-CV tuning (`train_alt_model.py --tune` —
   time-ordered inner folds, training period only, test set touched once)
   found XGBoost's initial edge over logistic regression was a
   single-split artifact, not real. The two-holdout comparison then found
   something sharper than the first pass's CV-overstatement caveat: the
   inner-CV score used to pick hyperparameters was nearly IDENTICAL across
   both holdouts (0.154 vs. 0.153) despite the true holdout AUC-PR
   differing substantially between them (0.117 vs. 0.090) — inner-CV isn't
   just optimistic, it barely tracks which period is actually being
   predicted, making it a poor guide to real forward performance even when
   used exactly as intended (selection only, never for final reporting).
   The direction of the finding (learned beats rule-based) is now
   well-evidenced; its exact size is not, and shouldn't be quoted more
   precisely than "somewhere in the 22-34% relative range" without further
   holdouts or bootstrapped confidence intervals. See "Alternative model"
   above for the full numbers and caveats.

## What's still untested or unresolved

- **Possible systematic (not random) bias in every label in this dataset,
  toward under-ascertaining pollution — unresolved, no data available to
  check it.** 85% of all 16,855 samples were collected 10:00–13:00 UTC
  (11:00–14:00 local in the BST bathing season), close to the daily
  low-concentration trough a real published study found at a UK bathing
  water (Wyer et al. 2018 — see "Alternative model" above and References).
  If regulatory sampling schedules generally land in that window — a
  plausible consequence of ordinary working-hours sampling rounds, not
  necessarily a deliberate choice — every "clean" label in this dataset
  could be systematically undercounting real risk, not just noisily
  scattered around it. Would need repeated same-day sampling at varied
  hours to check, which this dataset doesn't have.
- **The calibration curve was only computed for the baseline variant.**
  Whether the "signal only in the top ~30%" shape holds, sharpens, or
  flattens further under real calibration/currents is unknown.
- **Tested and NOT supported: CMEMS's 7km grid resolution as the explanation
  for currents reducing AUC-PR.** Sites were split into "close" (nearest
  outlet <7km, inside one CMEMS grid cell) and "far" (≥7km, several cells
  away) and re-scored with/without currents on each band
  (`isolate-distance-effect.js`, full 16,855-sample run). If coarse-grid
  current vectors were the driver, the far band should have degraded less.
  It didn't: ΔAUC-PR was -0.012 for close (n=14,259) vs -0.017 for far
  (n=897) — the opposite direction. But the far band is too thin to call
  this a clean refutation: baseline recall there was 0.0% (zero true
  positives flagged even before currents were added, so precision is
  undefined), meaning the far band already had no signal to lose. The grid-
  resolution theory is disfavored by this test, not ruled out.
- **RESOLVED: the actual driver is `currentBias.js`'s hard downstream
  exclusion rule** (`if (dot <= 0) return 0;` — a confirmed-downstream or
  transverse outlet contributes literally nothing, not a dampened amount).
  Isolated directly: `coastalContributionFactor()` was monkey-patched
  (real function, one line changed — `dot<=0` now falls back to the same
  isotropic decay already used for missing current data, instead of
  zeroing) and rerun against the exact same currents-only config as the
  original isolation run (`compare-runs.js`, full 16,855-sample run).
  Softening that one rule recovered most of the gap versus not using
  currents at all (combined score, either-determinand, overall):

  | Variant | AUC-PR | Recall @0.2 |
  |---|---|---|
  | No currents at all (baseline) | 0.098 | 43.2% |
  | Currents, hard exclusion (real code) | 0.088 | 26.6% |
  | Currents, exclusion softened | 0.096 | 38.6% |

  Hard exclusion accounts for 8 of the 10-point AUC-PR gap (80%) and 12 of
  the 16.6-point recall gap (72%) between "no currents" and "currents,
  real exclusion rule." A confirmed-downstream outlet being zeroed rather
  than merely discounted is a defensible modeling choice in principle
  (a downstream spill genuinely shouldn't reach the site) — but this
  dataset's own `nearbyOutlets` construction (Southern Water's real
  assessment history, not the real product's spatial index — see below)
  combined with day-scale current data means a real spill can plausibly
  still reach a site the "instantaneous" dot product currently rules out
  entirely. The remaining ~2-point AUC-PR / ~5-point recall gap (0.096 vs.
  0.098) is a smaller, still-unidentified secondary effect.
- **The isotropic-fallback asymmetry in the travel-time correction** — no
  measurable current means no data-supported travel time, so those outlets
  stay unshifted. Not quantified how many outlet-sample pairs this affects
  at full scale (a small self-test showed roughly half were classified
  directional, a quarter isotropic, a quarter excluded by direction, but
  this was on a 500-row sample, not the full 387,789-row export).
- **The app's own risk-band thresholds (0.2/0.5/0.8) have no documented
  justification anywhere in the codebase** — checked directly (comments,
  `docs/architecture.md`, visible commit history) — they read as round-number
  placeholders, not calibrated or cited values. That the real signal in the
  baseline variant's calibration curve starts almost exactly at 0.2 could be
  coincidence rather than deliberate tuning.
- **`nearbyOutlets` was built from Southern Water's own real assessment
  history**, not the real product's spatial index, which this project
  doesn't have — a reasonable stand-in, not a byte-identical substitute.
- **No flow-network data** — irrelevant to this specific dataset regardless,
  every site here is `CoastalWater`.

## References

- [The Bathing Water Regulations 2013 (SI 2013/1675), Schedule 5](https://www.legislation.gov.uk/uksi/2013/1675/schedule/5) — coastal/transitional water quality standards, the source of the 500 cfu/100ml E. coli / 185 cfu/100ml enterococci "Sufficient" threshold used to label every sample.
- [Environment Agency Water Quality Explorer API](https://environment.data.gov.uk/water-quality) — source of all 253,812 real lab observation rows.
- [Open-Meteo Historical Weather API](https://archive-api.open-meteo.com/v1/archive) — source of all real hourly rainfall.
- [CMEMS NWSHELF_MULTIYEAR_PHY_004_009](https://data.marine.copernicus.eu/product/NWSHELF_MULTIYEAR_PHY_004_009) (`cmems_mod_nws_phy-uv_my_7km-3D_P1D-m`) — source of all real historical current data, confirmed live via `copernicusmarine describe` before use, not guessed.
- [krestenbersoe/ukwater](https://github.com/KrestenBersoe/ukwater) — the real product repository; `server/risk/scoreSite.js` and its sibling modules (`rainfallDecay.js`, `baselineProbability.js`, `liveOverride.js`, `currentBias.js`, `distanceDecay.js`, `flowDecay.js`, `staticFrequencyBaseline.js`) are the exact, unmodified code scored throughout; `pipeline/14-compute-outlet-thresholds.js`'s real functions were used to derive the calibrated thresholds.
- Wyer, M.D., Kay, D., Morgan, H., Naylor, S., Clark, S., Watkins, J., Davies, C.M., Francis, C., Osborn, H., Bennett, S. (2018). [Within-day variability in microbial concentrations at a UK designated bathing water: Implications for regulatory monitoring and the application of predictive modelling based on historical compliance data](https://doi.org/10.1016/j.wroa.2018.10.003). *Water Research X*, 1, 100006 — source of the diurnal-variability/single-spot-sample findings discussed above.

## Bottom line

Real signal exists in this risk score — the top of its range genuinely
separates dirtier water from cleaner water, at roughly a 2–2.5x lift over
chance. But that signal comes almost entirely from rainfall: at the app's
own Very High tier, rainfall decay ALONE (27.4% precision) beats every
tested full-cascade variant (10.8–18.0%) — the live-status, distance, and
current-bias layers are net harmful at the top of the range on this
dataset, not just unhelpful. Across five variants, from the crude uncalibrated baseline to
one using every real input available (calibration, currents, and a verified
travel-time correction), nothing tested pushed it to a reliable predictor,
and feeding it more realistic inputs consistently made its ranking quality
*worse*, not better, while only modestly improving precision at the cost of
substantially more missed real problems. CMEMS's 7km grid resolution was
the leading candidate explanation for currents reducing AUC-PR, but a
direct test (close-vs-far distance bands) came out the wrong way for that
theory. The actual cause has since been found and quantified: the current
model's hard downstream-exclusion rule (`dot<=0` → contribution zeroed,
not dampened) accounts for roughly 80% of the AUC-PR loss and 72% of the
recall loss that currents otherwise cause, isolated by softening that one
real line of code and rerunning the identical backtest. Southern Water's
own much simpler published field remains at least as good a predictor, by
this measure, as any version of the fuller risk score tested here — but
the path to the risk score actually benefiting from real current data now
has a concrete, identified fix to evaluate (soften or remove the hard
exclusion), rather than an open question.
