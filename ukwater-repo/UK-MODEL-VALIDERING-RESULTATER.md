# Southern Water EDM Impact Model — validation against real EA bathing-water samples

Generated: 2026-09-08, from a backtest run via `validate-uk-model.js` against
16,855 real, dated lab samples (Southern Water's coastal bathing sites, 2015–2026)
joined to 202,783 real, dated discharge-impact assessments from Southern Water's own
EDM export (387,789 source rows, 236,230 distinct events). Full confusion matrices,
PR curves and calibration deciles for every lag × signal × label × segment
combination are in `output/uk-validation-results-*.json` and
`output/uk-validation-summary.csv` — this file is the prose summary, not a
replacement for that data.

The backtest is leakage-safe and fits nothing to this data: Southern Water's own
event detection and tidal/geographic Impact Status are used exactly as reported,
with no threshold or parameter calibrated against the lab samples. Every result
below reports Wilson score confidence intervals, not a bare point estimate, and no
single "accuracy" number is used as a headline — precision, recall and AUC-PR
against real baselines throughout.

## Does the model beat trivial baselines? Partly — and which part matters is the finding.

Three signals were compared at each lag: the **model** (a genuine event Southern
Water's tidal model flagged "Impacted" for this specific site), a **site baseline**
(any genuine event assessed against this site, ignoring the Impacted/Not Impacted
call), and a **region baseline** (any genuine event anywhere in Southern Water's
territory). Base rate — the sample's own real exceedance rate with no model at
all — was 5.7% (969/16,855) for either determinand exceeding, 2.1% (357/16,855)
for E. coli alone, 5.2% (883/16,823) for enterococci alone.

| Lag | Signal | Precision | Recall | AUC-PR |
|---|---|---|---|---|
| 24h | Model | 15.3% [12.0–19.3%] | 6.0% [4.7–7.7%] | 0.106 |
| 24h | Site baseline | 15.2% [12.3–18.7%] | 7.6% [6.1–9.5%] | 0.107 |
| 24h | Region baseline | 8.9% [8.0–9.9%] | 34.2% [31.2–37.2%] | 0.092 |
| 48h | Model | 12.2% [9.8–15.0%] | 7.4% [5.9–9.3%] | 0.090 |
| 48h | Site baseline | 12.3% [10.2–14.8%] | 9.9% [8.2–11.9%] | 0.091 |
| 48h | Region baseline | 8.0% [7.3–8.8%] | 40.1% [37.1–43.3%] | 0.085 |
| 72h | Model | 9.8% [7.9–12.1%] | 7.8% [6.3–9.7%] | 0.078 |
| 72h | Site baseline | 10.0% [8.4–12.0%] | 10.6% [8.8–12.7%] | 0.080 |
| 72h | Region baseline | 7.2% [6.6–7.9%] | 43.3% [40.3–46.5%] | 0.076 |

Two separate comparisons are bundled in that table, and they point opposite ways:

**Site-specific information clearly beats no information.** Model precision's
confidence interval (12.0% lower bound at 24h) sits well clear of the 5.7% base
rate, and clear of the region baseline's precision (8.0–9.9% across all three
lags, no CI overlap with model/site-baseline at 24h or 48h). Knowing a discharge
was assessed against *this* bathing water, recently, is real signal.

**Southern Water's own "Impacted" classification adds nothing measurable over
"any event at this site."** Model and site-baseline are statistically
indistinguishable at every lag — their confidence intervals overlap almost
completely (15.3% vs 15.2% at 24h, 12.2% vs 12.3% at 48h, 9.8% vs 10.0% at 72h),
and AUC-PR alternates which one is marginally ahead (0.106 vs 0.107, 0.090 vs
0.091, 0.078 vs 0.080 — differences smaller than sampling noise at this n). The
tidal/geographic modeling that decides *which* bathing water a given outfall's
discharge reaches — the sophisticated, expensive part of Southern Water's own
pipeline — is not detectably improving on the far simpler "an outfall assessed
against this site discharged recently."

The region baseline's much higher recall (34–43% vs 6–11% for the other two) is a
precision/recall trade-off, not a sign it's a better predictor: a broader flag
catches more true positives by flagging far more samples overall, at roughly half
to a third the precision. Read the AUC-PR and precision comparisons above, not the
recall column alone, when judging which signal is actually informative.

## Where the site-specificity advantage comes from — and where it disappears

The model/site-baseline edge over the region baseline is not constant — it decays
with lag, and by 72h it is mostly gone. For enterococci (either determinand,
overall):

| Lag | Model AUC-PR | Site-baseline AUC-PR | Region-baseline AUC-PR |
|---|---|---|---|
| 24h | 0.097 | 0.099 | 0.088 |
| 48h | 0.084 | 0.084 | 0.081 |
| 72h | 0.072 | 0.073 | 0.071 |

At 24h there's a real gap between site-level signals and the region baseline
(0.097–0.099 vs 0.088). By 72h all three have converged to within noise of each
other (0.071–0.073). The likely mechanism: over a long enough window, almost
every sample has *some* regional discharge event in its history regardless of
which site it's near — storms and high-tide periods tend to trigger many outfalls
across a sub-area at once, so "an event happened somewhere in the region
recently" stops being much less informative than "an event happened at this
specific site recently" once the window is wide enough to average that
correlation out. Recency does the real work at longer lags, not site-targeting.

## Segment breakdown: determinand and geography both matter

**By determinand** — E. coli and enterococci tell different stories at the same
absolute numbers. Enterococci has the higher absolute precision (14.0% vs 7.9% at
24h, model), but E. coli shows the larger *relative* lift over its own base rate:
E. coli's base rate is only 2.1% against enterococci's 5.2%, so E. coli's 7.9%
precision is a ~3.7x lift versus enterococci's ~2.7x. E. coli exceedances are
rarer here, and proportionally better predicted by this model.

**By area** — Southern Water's territory splits into two areas in this dataset
(Solent & South Downs, n≈10,472; Kent & South London, n≈6,383), and Solent
consistently outpredicts Kent at every lag and every signal:

| Lag | Area | Model precision | Model AUC-PR |
|---|---|---|---|
| 24h | Solent & South Downs | 17.3% | 0.117 |
| 24h | Kent & South London | 10.2% | 0.078 |
| 48h | Solent & South Downs | 13.8% | 0.099 |
| 48h | Kent & South London | 8.6% | 0.073 |
| 72h | Solent & South Downs | 11.1% | 0.086 |
| 72h | Kent & South London | 7.0% | 0.064 |

A real, consistent geographic gap, not noise from one lag or one determinand — it
holds at every lag and both determinands. No obvious cause is established by this
backtest alone; the two areas differ in outfall density, coastal geometry, and
tidal regime, any of which could plausibly explain it, but distinguishing between
them would need a separate investigation.

## What the calibration curve and full PR curve say

Not reproduced here — see `output/uk-validation-results-*.json`'s
`calibrationCurve`/`precisionRecallCurve` fields per lag/signal/segment. The
count-based score used here (number of qualifying events in the lag window) is
coarser than a continuous risk score would be — most sample-events see 0, 1, or 2
qualifying events, so the calibration curve has few distinct buckets rather than
a smooth decile spread. Worth computing and reading properly before this score is
used for anything beyond ranking.

## Why: two findings, ranked by evidence strength

**1. Dated, event-level cause data genuinely predicts dated lab outcomes.** This
backtest fits nothing to the data — Southern Water's own event detection and
Impact Status are used exactly as reported, no threshold or parameter is
calibrated against the lab samples — and the base-rate lift (2.7–3.7x, confidence
interval clear of the base rate) is still real. Evidence strength [Certain] given
it holds across both determinands, both areas, and all three lags.

**2. The tidal/geographic "Impacted" classification is the part not proven to
add value.** Site-level information overall clearly beats no information, but the
specific Impacted/Not-Impacted refinement inside that site-level information does
not detectably improve on a cruder version of itself. Plausible mechanisms, none
confirmed by this backtest: genuine events cluster in storm episodes that trigger
many outfalls near a given site simultaneously, so "any event assessed against
site S" is already strongly correlated with "an Impacted event assessed against
site S," diluting the flag's incremental value; or the tidal model's binary
Impacted/Not-Impacted cut may not fully capture real contamination pathways
(surface wind transport, groundwater, model imprecision near the cut). Evidence
strength [Likely] — consistent across segments, but the *mechanism* is not tested
here.

## What's untested, not ruled out

- **`tidalModelVersion` segmentation** was not run. The join carries this field
  (multiple versions appear in the real data, e.g. "v4 (10/09/2025)") — if
  assessment accuracy changed materially between model versions, pooling them
  could be diluting the model signal specifically, which would change finding #2
  above. Worth checking before concluding the tidal model itself is uninformative
  rather than just its binary output as currently thresholded.
- **A continuous, decay-weighted score** (recency-weighted rather than a flat
  window count) was not tried, in either direction.
- **Non-discharge contamination sources** (birds, wildlife, agricultural runoff)
  aren't modeled. The EA sample data itself carries auxiliary determinants for
  some of this — seabird/horse/sheep/pig source-tracking markers,
  `9161`/`9156`/`8288`/`6360` counts of beach users/sewage debris/dogs/birds
  (see `fetch-ea-samples.js`'s filehead) — not yet joined into this backtest.
- **`Not Genuine`/`Under Review` events** (24.9% of all EDM events, `edm-diagnostics.json`)
  are excluded from every signal here, correctly per their own status — but
  their volume relative to Genuine events was not itself investigated as a
  potential predictor (e.g. does a period with many disputed events also see
  elevated failures, independent of the confirmed ones).
- **Chichester Harbour / Langstone Harbour** (20,812 of 223,598 impact rows —
  9.3% of all EDM impact assessments) have no EA bathing-water counterpart at
  all and are entirely absent from this backtest, confirmed as genuinely
  out-of-scope water body types (`check-site-match.js`), not a gap worth closing.

## Bottom line

Real, dated cause data predicts real, dated lab outcomes here. But the specific
piece of modeling this backtest was best positioned to test — Southern Water's
site-specific tidal impact classification — isn't earning its keep over the far
simpler question "did anything discharge near this beach recently." That
distinction narrows, and by 72h nearly disappears, as the lag window widens,
which is itself informative: whatever the tidal model is contributing, it's
contributing it at short range, not long. Site-level information matters more
than region-level; the *specific* Impacted/Not-Impacted call inside that
site-level information has not been shown to matter at all.
