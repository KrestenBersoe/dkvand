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
import time
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import average_precision_score, precision_recall_curve
from sklearn.model_selection import StratifiedKFold, cross_val_score, TimeSeriesSplit, RandomizedSearchCV
from scipy.stats import randint, uniform, loguniform
import xgboost as xgb

p = argparse.ArgumentParser()
p.add_argument('--features', default='output/ml-features.ndjson')
p.add_argument('--split-date', default='2024-01-01')
p.add_argument('--label', default='eitherExceeds')
p.add_argument('--tune', action='store_true', help='Nested-CV hyperparameter search for XGBoost (inner loop, training period only) before the final holdout evaluation.')
p.add_argument('--tune-iter', type=int, default=60, help='Candidate configurations sampled by RandomizedSearchCV.')
p.add_argument('--tune-splits', type=int, default=4, help='Time-ordered inner CV folds (TimeSeriesSplit) within the training period.')
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

# Flag-rate-matched precision/recall: a learned model's score isn't on the
# same 0-1 scale/meaning as the rule-based cascade's probability, so
# comparing precision/recall at "score > 0.2" for both would be comparing
# different operating points, not a fair test. Instead, find the threshold
# that flags the SAME SHARE of the test set the rule-based cascade's own
# app threshold (>0.2) flags, and compare precision/recall there.
rule_flag_rate = float((df.loc[test_mask, 'ruleBasedScoreNoCurrents'].fillna(0) > 0.2).mean())
print(f"Rule-based (shrinkage, no currents) flags {rule_flag_rate*100:.2f}% of the test set at >0.2 — matching every model's threshold to this same flag rate.")

def matched_precision_recall(scores_test, flag_rate):
    if flag_rate <= 0:
        return None, None
    n_flag = max(1, round(flag_rate * len(scores_test)))
    order = np.argsort(-np.asarray(scores_test))
    flagged = np.zeros(len(scores_test), dtype=bool)
    flagged[order[:n_flag]] = True
    tp = int((flagged & (y_test.values == 1)).sum())
    fp = int((flagged & (y_test.values == 0)).sum())
    fn = int((~flagged & (y_test.values == 1)).sum())
    precision = tp / (tp + fp) if (tp + fp) > 0 else None
    recall = tp / (tp + fn) if (tp + fn) > 0 else None
    return precision, recall

def evaluate(name, scores_test, cv_estimator=None, cv_X=None):
    scores_test = np.asarray(scores_test)
    ap = average_precision_score(y_test, scores_test)
    base = y_test.mean()
    lift = ap / base if base > 0 else None
    precision, recall = matched_precision_recall(scores_test, rule_flag_rate)
    cv_mean, cv_std = None, None
    if cv_estimator is not None:
        # 5-fold CV AUC-PR on the TRAIN period only (temporal split preserved —
        # this never touches the test period) — a sanity check for whether the
        # single train/test split result is stable or a lucky/unlucky draw.
        cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
        scores_cv = cross_val_score(cv_estimator, cv_X, y_train, cv=cv, scoring='average_precision')
        cv_mean, cv_std = float(scores_cv.mean()), float(scores_cv.std())
    results[name] = {'aucPr': ap, 'baseRate': base, 'liftOverBaseRate': lift,
                      'matchedFlagRatePrecision': precision, 'matchedFlagRateRecall': recall,
                      'trainCvAucPrMean': cv_mean, 'trainCvAucPrStd': cv_std}
    line = f"  {name:32s} AUC-PR={ap:.4f}"
    if lift:
        line += f"  lift={lift:.2f}x"
    if precision is not None:
        line += f"  @matched-flag-rate: precision={precision*100:.1f}% recall={recall*100:.1f}%"
    if cv_mean is not None:
        line += f"  train-CV AUC-PR={cv_mean:.4f}±{cv_std:.4f}"
    print(line)

print("\n=== Rule-based scoreSite() cascade (comparison baseline, same rows) ===")
for col in ['ruleBasedScoreNoCurrents', 'ruleBasedScoreWithCurrents', 'ruleBasedRainfallOnly']:
    evaluate(col, df.loc[test_mask, col].fillna(0))

print("\n=== Logistic regression (same raw features, learned weights) ===")
scaler = StandardScaler()
X_train_s = scaler.fit_transform(X_train)
X_test_s = scaler.transform(X_test)
logreg = LogisticRegression(max_iter=2000, class_weight='balanced')
logreg.fit(X_train_s, y_train)
evaluate('logistic_regression', logreg.predict_proba(X_test_s)[:, 1],
          cv_estimator=LogisticRegression(max_iter=2000, class_weight='balanced'), cv_X=X_train_s)

print("\n=== XGBoost gradient-boosted trees (same raw features, learned combination) ===")
pos_weight = (len(y_train) - y_train.sum()) / max(1, y_train.sum())
DEFAULT_XGB_PARAMS = dict(n_estimators=300, max_depth=4, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8)

if args.tune:
    # Nested CV, adapted to this dataset's one real constraint: the
    # shrinkage-calibrated thresholds baked into these features were
    # computed from ONLY pre-2024 events (compute-outlet-thresholds-
    # shrinkage.js --events-before 2024-01-01) — the one split point where
    # that's guaranteed leakage-free. A second, independently-shuffled
    # OUTER CV loop reaching further back into the training period would
    # silently let some inner folds' "test" rows sit chronologically BEFORE
    # calibration data their own training rows already reflect. So the
    # outer evaluation stays the single genuine 2024-01-01 holdout already
    # used throughout this document; nesting happens on the INNER loop
    # only — TimeSeriesSplit (time-ordered, never shuffled) restricted to
    # the training period, used purely to select hyperparameters. The test
    # set is touched exactly once, after the search, for the final number.
    train_order = np.argsort(df.loc[train_mask, 'tsMs'].values)
    X_train_sorted = X_train.iloc[train_order].reset_index(drop=True)
    y_train_sorted = y_train.iloc[train_order].reset_index(drop=True)

    param_dist = {
        'n_estimators': randint(100, 600),
        'max_depth': randint(2, 7),
        'learning_rate': loguniform(0.01, 0.3),
        'subsample': uniform(0.6, 0.4),
        'colsample_bytree': uniform(0.5, 0.5),
        'min_child_weight': randint(1, 10),
        'reg_alpha': loguniform(1e-3, 10),
        'reg_lambda': loguniform(1e-3, 10),
    }
    base_estimator = xgb.XGBClassifier(scale_pos_weight=pos_weight, eval_metric='aucpr', random_state=42, n_jobs=-1)
    inner_cv = TimeSeriesSplit(n_splits=args.tune_splits)
    search = RandomizedSearchCV(base_estimator, param_dist, n_iter=args.tune_iter, scoring='average_precision',
                                  cv=inner_cv, random_state=42, n_jobs=-1, verbose=1, refit=True)
    print(f"Nested CV: {args.tune_iter} candidate configs x {args.tune_splits} time-ordered inner folds on the {len(X_train_sorted):,}-row training period only (test set untouched)...")
    t_tune0 = time.time()
    search.fit(X_train_sorted, y_train_sorted)
    print(f"Search done in {time.time()-t_tune0:.0f}s. Best inner-CV AUC-PR: {search.best_score_:.4f}")
    print(f"Best params: {search.best_params_}")
    xgb_model = search.best_estimator_
    final_params = search.best_params_
else:
    xgb_model = xgb.XGBClassifier(**DEFAULT_XGB_PARAMS, scale_pos_weight=pos_weight, eval_metric='aucpr', random_state=42)
    xgb_model.fit(X_train, y_train)
    final_params = DEFAULT_XGB_PARAMS

evaluate('xgboost_tuned' if args.tune else 'xgboost', xgb_model.predict_proba(X_test)[:, 1],
          cv_estimator=xgb.XGBClassifier(**final_params, scale_pos_weight=pos_weight, eval_metric='aucpr', random_state=42),
          cv_X=X_train)

print("\n=== Feature importance (XGBoost, top 15) ===")
imp = sorted(zip(feature_cols, xgb_model.feature_importances_), key=lambda x: -x[1])[:15]
for name, val in imp:
    print(f"  {name:32s} {val:.4f}")

print("\n=== Summary (test period, from {}) ===".format(args.split_date))
base = results['ruleBasedScoreNoCurrents']['aucPr']
for name, r in results.items():
    diff = r['aucPr'] - base
    print(f"  {name:32s} AUC-PR={r['aucPr']:.4f}  ({'+' if diff>=0 else ''}{diff:.4f} vs. shrinkage-only rule baseline)")

out_name = 'output/alt-model-results-tuned.json' if args.tune else 'output/alt-model-results.json'
with open(out_name, 'w') as f:
    json.dump({'splitDate': args.split_date, 'label': args.label, 'featureCols': feature_cols,
               'nTrain': int(train_mask.sum()), 'nTest': int(test_mask.sum()), 'results': results,
               'tuned': args.tune, 'xgbParams': final_params,
               'tuneInnerCvAucPr': float(search.best_score_) if args.tune else None}, f, indent=2)
print(f"\nWrote {out_name}")
