# Badevand risk model — historical validation against lab samples

Generated: 2026-09-07, from a backtest run via `scripts/validate-badevand-model.js`
against 12,601 historical PULS lab samples (730-day window, 314 distinct
lab failures, 2.49% base rate). Full segment tables, PR curves, and
calibration deciles are in the timestamped JSON/CSV this script writes to
`scripts/validation-output/` — this file is the prose summary the
underlying task asked for, not a replacement for that data.

## Does the model beat the trivial baseline? No.

At every lag tested, a flat 25mm/48h rainfall cutoff — no per-outlet
threshold, no decay, no geometry — has an equal or higher AUC-PR than the
full cascade:

| Lag | Model AUC-PR | Baseline AUC-PR |
|---|---|---|
| sameDay | 0.055 | 0.060 |
| tMinus1 | 0.035 | 0.038 |
| max48h | 0.045 | 0.051 |

Both curves peak at the same lag (sameDay), for both model and baseline —
same-day rainfall predicts a same-day lab failure better than yesterday's
rainfall does, for either approach. That's a property of the underlying
data, not something the model's own decay/travel-time machinery is
contributing.

The gaps are small (0.003–0.006) relative to the sample sizes involved
(942 positive-lag-records total, ~258 scored per lag), and precision CIs
partially overlap — e.g. sameDay: model 5.7% [4.4–7.3%] vs. baseline 9.1%
[6.0–13.6%]. So this isn't a landslide loss. But it is a consistent one,
in the same direction, at every lag — the per-outlet calibration is not
earning its complexity over "did it rain today" on this data.

## Where it performs best and worst by segment

**By water body type** — this is the sharpest split in the data. For
**lakes** (soe, n=120 positives), the model modestly *beats* baseline
(0.050 vs. 0.039 sameDay AUC-PR) — though with wide CIs (recall 25.0%
[12.7–43.4%], n=28) that make this directional, not settled. For
**coastal sites** (kystvand, n=798 positives, 85% of all samples), baseline
wins (0.056 vs. 0.063 sameDay) — and since coastal dominates the sample
count, this is what drives the pooled result above. **Streams** (vandlob)
have only 3 positive samples total across the whole window — explicitly
too few to say anything.

**By the outlet's own threshold-calibration tier** — this is the least
flattering result, and the most important one. `thresholdTier=high`
(directly-derived thresholds from ≥10 real annual events, n=360
positives — the case where the model's calibration should be *most*
trustworthy) is where baseline beats the model by the widest margin of
any well-populated segment: 0.053 vs. 0.094 AUC-PR at sameDay, baseline
ahead at every lag. `borrowed` (91% of all outlets by count, n=177
positives) shows the same pattern at a smaller scale. The one tier where
the model wins — `medium` (n=60 positives, 20/lag) — is thin enough (heavily
overlapping CIs) that I'd call it a plausible signal, not a finding.
`low` (n=27 positives, 9/lag) is noise for both. In short: the model does
not perform better where its own confidence system says it should.

**By raw data quality** (`dataQualityCode` — real reported events vs.
volume-estimated vs. verified-zero) was added late in this investigation
specifically to test whether the underlying PULS event counts, not just
the threshold math, are the weak link. No run has been completed against
it yet — this is the one open thread from this validation, not a result.

**By season**: negligible difference between full-year and bathing-season
(May–Sep) restriction — the headline numbers barely move, so off-season
noise isn't distorting the result.

## What the calibration curve says: don't read the score as a probability

The model's own score is overconfident by roughly 10x at the high end.
The top predicted-score decile has a mean score of 0.46–0.56 depending on
lag, but the *observed* fail rate in that decile is only 4.5–5.6%. The
app's own "elevated risk" flag threshold (0.2) sits in a decile where the
real fail rate is closer to 4%, not 20%. The score does carry a real, if
noisy, ranking signal — fail rate does trend upward from the bottom
deciles to the top — so it's not meaningless for sorting relative risk.
It should never be presented to a user as a literal percentage chance of
failure.

## Why: three confirmed causes, ranked by evidence strength

**1. There is no official overflow event definition to calibrate
against — confirmed by reading the current binding standard end to end.**
`compute-puls-udloeb-taerskler.js` derives each outlet's rainfall
threshold by backing out the value that would reproduce that outlet's
reported annual overflow count. That only works if "annual overflow
count" means the same thing across every reporting utility. It doesn't:
DP02 "Datateknisk Anvisning for Regnbetingede Udløb" version 5 (effective
2025-01-01, the actual document utilities follow when reporting to PULS)
specifies the annual count field as simply "measured or model-calculated
number" — no duration or separation criterion, in any of its five
versions since 2014. A 2023 Miljøstyrelsen proposal to standardize this
("more than 5 hours" vs. "more than 24 hours" between overflows, plus a
5-minute minimum duration) was never adopted into DP02. The practical
consequence: the ground-truth labels this entire calibration rests on
were almost certainly produced under inconsistent per-utility conventions
— no single collapse-window constant in the code can fix that, because
there's no single correct answer to tune it against.

**2. Most thresholds don't rest on real event counts at all.** Only
14.4% of outlets have a directly-reported event count (`qualityCode=0`);
the majority are volume-estimated or borrowed from a nearby outlet's
threshold. `thresholdTier=high` requires ≥10 such events/year but says
nothing about whether that data was measured or modeled — the
`dataQualityCode` segmentation exists to separate these, pending the run
noted above.

**3. The threshold model's own prior validation already showed only
moderate signal.** `overflow-model-calibration-report-2026-07-30.json`
reports AUC 0.61 [95% CI 0.57–0.65] for predicting overflow yes/no from
rainfall, and the lending-validation in `PULS-TAERSKLER-RAPPORT.md` shows
13.8% median / 20.1% mean deviation on the derived thresholds themselves
— before the additional inferential step from "an overflow happened" to
"a specific downstream beach's bacteria count exceeded a legal limit that
day."

## What's untested, not ruled out

- **Current direction** (`--with-currents`) was off in every run —
  isotropic matching was used for all coastal sites, which is 85% of the
  sample. This is the highest-leverage untested factor: it could move the
  coastal numbers meaningfully in either direction, and hasn't been run.
- **Non-sewage bacteria sources** (birds, wildlife, agricultural runoff)
  aren't modeled at all. If a meaningful share of the 314 lab failures
  have nothing to do with sewer overflows, no improvement to the overflow
  model raises the ceiling on catching them.
- Several geometry constants (500m match buffer, 10km max distance, 0.3
  m/s assumed stream velocity) are self-flagged in `badevand-risk.js` as
  `[ANTAGELSE, IKKE MÅLT]` — unvalidated assumptions, not measured
  values — and could be adding independent noise to outlet-to-site
  matching regardless of the above.

## Bottom line

The cascade's added complexity — per-outlet thresholds, decay, distance
and current weighting — is not earning its keep over a flat rainfall
cutoff on this data, and loses most clearly on the segment (coastal,
high-confidence thresholds) where it should have the best shot at
winning. The most defensible explanation isn't a bug in this codebase's
math; it's that the annual overflow counts feeding the calibration were
never collected against a common definition, which no amount of parameter
tuning here can correct. The score should be trusted as a rough ranking
signal, not a calibrated probability, at any threshold.
