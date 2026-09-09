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
to base a swim/no-swim decision on alone, and making the inputs more
realistic did not clearly make the score better.**

- At its best, flagging the top ~20–30% of scores catches water that's
  genuinely dirtier than average — about 2–2.5x more likely to fail a real
  lab test than water picked at random.
- At the threshold the app actually uses to warn people ("Medium" risk,
  score above 0.2), across every version tested it flags something dirty
  roughly 1 time in 8 to 1 time in 9, and misses more than half of all real
  contamination events in its best-recall configuration — worse once real
  ocean-current data is added.
- Feeding the model more realistic inputs — a real per-outlet rainfall
  threshold instead of a generic one, and real measured sea currents instead
  of assuming pollution spreads evenly in every direction — made warnings
  somewhat more trustworthy when they fire, but made the score's overall
  ability to rank risky water above safe water measurably *worse*, and cut
  how many real problems it catches roughly in half. That's a genuine
  trade-off, not an upgrade.
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
4. **Investigate why the fuller cascade underperforms rainfall alone at
   Very High**, not just that it does. A plausible next step: check
   whether live-status/distance/current contributions are amplifying
   scores multiplicatively near the top of the range (pushing already-high
   rainfall-driven scores further up, past 0.8, via `Math.min(1, probability *
   decayFactor)`) rather than adding independent signal — that would
   directly explain "more flags, not more correct flags" without needing a
   new hypothesis.
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

## What's still untested or unresolved

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
