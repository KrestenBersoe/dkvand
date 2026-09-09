#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# train_alt_model.py — trains a gradient-boosted-tree model (XGBoost) and a
# logistic regression baseline on extract-ml-features.js's real, per-outlet
# feature table, then compares both against the hand-designed scoreSite()
# cascade's own rule-based scores (ruleBasedScoreNoCurrents, the
# best-evidenced tested config this session: shrinkage calibration, no
# currents; ruleBasedScoreWithCurrents; ruleBasedRainfallOnly) — all
# computed by the REAL scoreSite() on the exact same rows, so this is an
# apples-to-apples comparison, not a different sample set.
#
# Temporal holdout, matching this session's own established convention
# (compute-outlet-thresholds-shrinkage.js --events-before / validate-uk-
# risk-score.js --samples-after): train on samples before 2024-01-01, test
# only on 2024-01-01 onward — a period the model never saw during training,
# same split point already used and reported earlier this session.
#
# Kør: python3 train_alt_model.py [--features output/ml-features.ndjson]
# ═══════════════════════════════════════════════════════════════════════════
import argparse
import json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import average_precision_score, precision_recall_curve
import xgboost as xgb

p = argparse.ArgumentParser()
p.add_argument('--features', default='output/ml-features.ndjson')
p.add_argument('--split-date', default='2024-01-01')
p.add_argument('--label', default='eitherExceeds')
args = p.parse_args()

SPLIT_MS = pd.Timestamp(args.split_date, tz='UTC').value // 10**6

rows = []
with open(args.features) as f:
    for line in f:
        rows.append(json.loads(line))
df = pd.DataFrame(rows)
print(f"Loaded {len(df):,} rows from {args.features}")

df = df[df[args.label].notna()].copy()
y = df[args.label].astype(int)
print(f"{len(df):,} rows with a real '{args.label}' label, base rate {y.mean()*100:.1f}%")

feature_cols = [c for c in df.columns if c.startswith('f_')]
print(f"{len(feature_cols)} feature columns: {feature_cols}")

X = df[feature_cols].copy()
for c in X.columns:
    X[c] = pd.to_numeric(X[c], errors='coerce')
# Distance/current columns are legitimately missing when fewer than TOP_K
# outlets exist near a site (not measurement noise) — filled with values a
# tree can split cleanly around; standardized-then-imputed for logistic
# regression, which can't handle NaN or an arbitrary big sentinel gracefully.
DIST_FILL = 50_000  # metres — far beyond any real nearby-outlet distance, a tree learns "no Nth outlet exists" from this
X_tree = X.copy()
for c in X_tree.columns:
    if 'distanceM' in c:
        X_tree[c] = X_tree[c].fillna(DIST_FILL)
    else:
        X_tree[c] = X_tree[c].fillna(0)

train_mask = df['tsMs'] < SPLIT_MS
test_mask = ~train_mask
print(f"Train (before {args.split_date}): {train_mask.sum():,} rows, {y[train_mask].mean()*100:.1f}% positive")
print(f"Test  (from {args.split_date}):   {test_mask.sum():,} rows, {y[test_mask].mean()*100:.1f}% positive")

X_train, X_test = X_tree[train_mask], X_tree[test_mask]
y_train, y_test = y[train_mask], y[test_mask]

results = {}

def evaluate(name, scores_test):
    ap = average_precision_score(y_test, scores_test)
    base = y_test.mean()
    lift = ap / base if base > 0 else None
    precision, recall, thresh = precision_recall_curve(y_test, scores_test)
    # Flag-rate-matched comparison: precision/recall at the threshold that
    # flags roughly the same SHARE of test samples as the rule-based score's
    # own 0.2 cutoff does, rather than assuming a learned model's score is
    # on the same 0-1 scale/meaning as the rule-based probability.
    results[name] = {'aucPr': ap, 'baseRate': base, 'liftOverBaseRate': lift}
    print(f"  {name:32s} AUC-PR={ap:.4f}  lift={lift:.2f}x" if lift else f"  {name:32s} AUC-PR={ap:.4f}")

print("\n=== Rule-based scoreSite() cascade (comparison baseline, same rows) ===")
for col in ['ruleBasedScoreNoCurrents', 'ruleBasedScoreWithCurrents', 'ruleBasedRainfallOnly']:
    evaluate(col, df.loc[test_mask, col].fillna(0))

print("\n=== Logistic regression (same raw features, learned weights) ===")
scaler = StandardScaler()
X_train_s = scaler.fit_transform(X_train)
X_test_s = scaler.transform(X_test)
logreg = LogisticRegression(max_iter=2000, class_weight='balanced')
logreg.fit(X_train_s, y_train)
evaluate('logistic_regression', logreg.predict_proba(X_test_s)[:, 1])

print("\n=== XGBoost gradient-boosted trees (same raw features, learned combination) ===")
pos_weight = (len(y_train) - y_train.sum()) / max(1, y_train.sum())
xgb_model = xgb.XGBClassifier(
    n_estimators=300, max_depth=4, learning_rate=0.05,
    subsample=0.8, colsample_bytree=0.8,
    scale_pos_weight=pos_weight, eval_metric='aucpr', random_state=42,
)
xgb_model.fit(X_train, y_train)
evaluate('xgboost', xgb_model.predict_proba(X_test)[:, 1])

print("\n=== Feature importance (XGBoost, top 15) ===")
imp = sorted(zip(feature_cols, xgb_model.feature_importances_), key=lambda x: -x[1])[:15]
for name, val in imp:
    print(f"  {name:32s} {val:.4f}")

print("\n=== Summary (test period, from {}) ===".format(args.split_date))
base = results['ruleBasedScoreNoCurrents']['aucPr']
for name, r in results.items():
    diff = r['aucPr'] - base
    print(f"  {name:32s} AUC-PR={r['aucPr']:.4f}  ({'+' if diff>=0 else ''}{diff:.4f} vs. shrinkage-only rule baseline)")

with open('output/alt-model-results.json', 'w') as f:
    json.dump({'splitDate': args.split_date, 'label': args.label, 'featureCols': feature_cols,
               'nTrain': int(train_mask.sum()), 'nTest': int(test_mask.sum()), 'results': results}, f, indent=2)
print("\nWrote output/alt-model-results.json")
