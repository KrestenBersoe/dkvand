#!/usr/bin/env bash
# One-command deploy: always builds and ships whatever is on origin/main,
# never whatever branch/commit your local checkout happened to be on.
#
# Why this exists (2026-09-06 incident): a manual `git checkout <branch> &&
# git pull && fly deploy` sequence gives no error when a step is silently
# skipped or the checkout is on the wrong branch — it just ships stale code
# with no warning. This repo's own stabilization fixes (the CPU steal-time
# fix, push-notification concurrency cap, disk-persistence fixes) sat
# unmerged on a feature branch for hours while deploys kept shipping `main`
# without them — same failure mode islandswim.co.uk and vigiebaignade.fr
# hit the same day. This script removes every manual step that can go wrong:
# it always resolves to origin/main's actual tip, with no branch to forget.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="dkvand"
BRANCH="main"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Uncommitted changes to tracked files — commit, stash, or discard them first:"
  git status --short --untracked-files=no
  exit 1
fi

echo "==> Switching to $BRANCH..."
git checkout "$BRANCH"

echo "==> Pulling latest from origin/$BRANCH..."
git pull origin "$BRANCH"

echo "==> Deploying this commit:"
git log -1 --oneline

echo "==> Deploying $APP_NAME..."
fly deploy -a "$APP_NAME"
