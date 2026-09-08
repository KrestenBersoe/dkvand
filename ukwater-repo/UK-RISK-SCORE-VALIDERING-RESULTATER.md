# UK risk score — validation against real EA bathing-water samples

Generated: 2026-09-08, from a backtest run via `validate-uk-risk-score.js` against
16,855 real, dated lab samples (Southern Water's coastal bathing sites, 2015–2026),
scored with the real, unmodified `scoreSite()` cascade from
[krestenbersoe/ukwater](https://github.com/KrestenBersoe/ukwater)
(`server/risk/scoreSite.js`) — not a reimplementation. Full confusion matrices, PR
curves and calibration deciles are in `output/uk-risk-score-results-*.json` and
`output/uk-risk-score-summary.csv`. This document also compares the results
against `UK-MODEL-VALIDERING-RESULTATER.md`'s backtest of Southern Water's raw
EDM "Impact Status" field, run separately on the same 16,855 samples.

## Executive summary — in plain terms

**Does the app's risk score actually predict dirty water? Somewhat — but not
reliably enough to trust on its own, and raising or lowering its threshold
trades one problem for another.**

- When the score is high (top ~30% of scores it produces), it's genuinely
  meaningful: water flagged that high failed a real lab test about 14% of the
  time, roughly 2.5x more often than water picked at random.
- When the score is low-to-medium (the bottom ~70%), it tells you almost
  nothing — water scored "a little risky" failed no more often than water
  scored "not risky at all." The score only starts working once it gets high.
- At the threshold the app currently uses to warn people ("Medium" risk, score
  above 0.2), it catches about half of the real contamination events — but for
  every 10 warnings it gives, only about 1 is a real problem. Turning up that
  threshold makes each warning more trustworthy but means far more real
  problems go unflagged; turning it down (or leaving it as-is) means more
  warnings but a higher share of false alarms. There's no setting that avoids
  both.
- Compared to Southern Water's own simpler, already-published field — "was
  there a confirmed sewage discharge assessed as reaching this beach" — the
  full risk score is not clearly better at the app's current default
  threshold. It only pulls ahead when the threshold is turned up to be much
  stricter, and even then only modestly.
- This test used real historical weather and real recorded discharges, but
  **not** the app's best-case setup — the per-outlet rainfall thresholds it's
  designed to eventually use, calibrated from real spill history, weren't
  available for this test, so the version tested here defaults to a cruder,
  one-size-fits-most rainfall trigger. A properly calibrated version could
  plausibly do better, particularly in that uninformative low-to-medium range
  — this test can't rule that out either way.

## What was tested, and against what real data

Two separate things were validated against the same 16,855 real lab samples
(E. coli and intestinal enterococci, thresholds from the actual Bathing Water
Regulations 2013, [Schedule 5](https://www.legislation.gov.uk/uksi/2013/1675/schedule/5) —
coastal "Sufficient" standard, 500 cfu/100ml E. coli / 185 cfu/100ml
enterococci, a sample failing if either is exceeded):

1. **Southern Water's raw EDM field** — their own tidal/geographic "Impact
   Status" classification (Impacted / Not Impacted), used exactly as
   reported, no scoring involved. Covered in `UK-MODEL-VALIDERING-RESULTATER.md`.
2. **The real risk-score cascade** — `scoreSite()`, imported directly from a
   local clone of the actual product repository, fed with:
   - Real historical hourly rainfall per site, 2015–2026, from the
     [Open-Meteo historical weather archive](https://archive-api.open-meteo.com/v1/archive)
     — the same source the real product itself uses.
   - Each outlet's real live-EDM status *as of* each historical sample's exact
     timestamp, reconstructed from real recorded discharge start/end times
     (not simulated — see `validate-uk-risk-score.js`'s own header for the
     exact leakage-safe reconstruction method).
   - Real per-outlet spill-frequency counts, real site-to-outlet distances
     computed from Southern Water's own recorded assessment history.
   - No CMEMS current data and no flow-network data (neither has been fetched
     for the UK in this project) — both cascade layers that use them fall
     back to their own designed default (isotropic distance decay) rather
     than being skipped or faked.

## Risk-score results

Base rate (no model at all): 5.7% of samples failed (969/16,855).

| Threshold | Combined score — precision | Combined — recall | Bacterial sub-score — precision | Bacterial — recall |
|---|---|---|---|---|
| >0.2 (app's current "Medium" boundary) | 9.4% [8.6–10.2%] | 47.8% [44.7–50.9%] | 11.5% [10.5–12.7%] | 38.5% [35.5–41.6%] |
| >0.5 | 13.7% | 25.1% | 18.2% | 16.9% |
| >0.7 | 17.6% | 13.4% | 24.7% | 8.3% |
| >0.8 | 22.1% | 7.5% | 27.5% | 4.0% |

AUC-PR (threshold-independent ranking quality): **0.105 combined, 0.115
bacterial-only**. Only the bacterial sub-score was validated against anything
directly — the lab data measures bacterial contamination only, so the viral
sub-score (which uses a different, longer decay) has nothing here to check it
against, and was excluded from scoring on purpose.

**Calibration is not smooth across the score's range.** Splitting samples
into ten equal-sized buckets by score:

| Score range (combined) | Observed real fail rate |
|---|---|
| 0.000 (no signal at all) | 6.1% and 4.0% (two buckets) |
| 0.003 – 0.152 (low-mid) | 4.9%, 3.7%, 2.7%, 3.9%, 4.6% |
| 0.193 – 0.321 | 6.6% |
| 0.321 – 0.514 | 7.1% |
| 0.514 – 0.974 (top decile) | 13.9% |

The middle of that range is flat-to-noisy and sometimes sits *below* the
zero-score buckets — a score of 0.10 is not reliably worse than a score of
0.00 in this data. Real, monotonically increasing signal only appears from
roughly the 80th percentile up. This is the direct explanation for the
threshold table above: the app's 0.2 default sits right at the edge where
signal starts, not inside it, so much of what it flags at that setting is
drawn from the uninformative middle range along with the genuinely risky top.

## Head-to-head: risk score vs. Southern Water's raw Impact Status field

| Signal | AUC-PR | Precision | Recall |
|---|---|---|---|
| Raw EDM "Impacted" flag (24h lag) | 0.106 | 15.3% [12.0–19.3%] | 6.0% [4.7–7.7%] |
| Raw EDM "any event, any status" (24h lag) | 0.107 | 15.2% [12.3–18.7%] | 7.6% [6.1–9.5%] |
| Risk score, combined, at its default threshold (>0.2) | 0.105 | 9.4% [8.6–10.2%] | 47.8% [44.7–50.9%] |
| Risk score, bacterial-only, at its default threshold (>0.2) | 0.115 | 11.5% [10.5–12.7%] | 38.5% [35.5–41.6%] |
| Risk score, bacterial-only, at a stricter threshold (>0.7) | 0.115 | 24.7% | 8.3% |

Three findings from this comparison:

1. **On pure ranking quality (AUC-PR), the full risk score is not clearly
   better than Southern Water's own simplest field.** Combined score (0.105)
   is statistically indistinguishable from the raw Impacted flag (0.106); the
   bacterial sub-score (0.115) is modestly ahead of both, but not by a wide
   margin.
2. **At the app's own shipped default threshold, the raw EDM field is
   actually MORE precise** — 15.3% vs. 9.4–11.5% — because it's a much
   stricter, narrower trigger (an actual confirmed discharge assessed as
   reaching this exact site) than "rainfall pushed the score past 0.2,"
   which fires far more often.
3. **At a matched, comparable recall, the risk score does pull ahead.** The
   raw EDM flag catches 6.0% of real failures at 15.3% precision; the risk
   score's bacterial sub-score, turned up to a stricter threshold (>0.7),
   catches a similar 8.3% of real failures at 24.7% precision — clearly
   better at that operating point. The advantage of the fuller model shows up
   when it's tuned to behave selectively, not at the setting it currently
   ships with.

## What wasn't tested, and why that matters for reading these numbers

- **No real per-outlet calibrated rainfall threshold was available.** The
  real product's own three-tier priority (calibrated threshold → frequency
  heuristic → flat default,
  [`staticFrequencyBaseline.js`](https://github.com/KrestenBersoe/ukwater/blob/master/server/risk/staticFrequencyBaseline.js))
  fell through to the bottom two tiers for every outlet in this test, because
  the calibration pipeline (`pipeline/13`/`pipeline/14` in that repo) needs
  its own multi-year rainfall-history fetch and fit, which this project did
  not run. The flat/near-flat rainfall trigger this produces is a real
  candidate explanation for the noisy low-to-mid calibration range above —
  untested, not ruled out.
- **No CMEMS current data.** The coastal current-bias refinement
  (directional decay using measured sea-current vectors) fell back to plain
  isotropic distance decay for every outlet, every sample.
- **No flow-network data.** Irrelevant to this specific dataset regardless —
  every site here is `CoastalWater`, and that layer only applies to Lake/River
  sites.
- **`nearbyOutlets` was built from Southern Water's own real assessment
  history, not the real product's spatial index**, which this project doesn't
  have. Likely a reasonable stand-in (grounded in Southern Water's own
  judgement of relevance, and the model's own distance decay makes anything
  more than a few km away contribute almost nothing regardless) but not a
  byte-identical substitute.

## References

- [The Bathing Water Regulations 2013 (SI 2013/1675), Schedule 5](https://www.legislation.gov.uk/uksi/2013/1675/schedule/5) — coastal/transitional water quality standards, the source of the 500 cfu/100ml E. coli / 185 cfu/100ml enterococci "Sufficient" threshold used to label every sample.
- [Environment Agency Water Quality Explorer API](https://environment.data.gov.uk/water-quality) — source of all 253,812 real lab observation rows.
- [Open-Meteo Historical Weather API](https://archive-api.open-meteo.com/v1/archive) — source of all real hourly rainfall used by the risk-score backtest.
- [krestenbersoe/ukwater](https://github.com/KrestenBersoe/ukwater) — the real product repository; `server/risk/scoreSite.js` and its sibling modules are the exact, unmodified code scored in this backtest.

## Bottom line

The risk score contains real signal, but only in its upper range, and its
current default threshold sits at the boundary of that range rather than
inside it — which is why it currently trades away precision for recall
relative to Southern Water's own simpler field. It is not yet a clear,
unqualified improvement on that simpler field; it becomes one only when
tuned to a stricter, more selective operating point. Whether that trade
(fewer warnings, much more trustworthy warnings vs. many warnings, mostly
false alarms) is the right one is a product decision this data informs but
doesn't settle on its own — and the version tested here was run without the
real per-outlet calibration the product is designed to eventually use, so
this is a floor on what the model can do, not necessarily its ceiling.
