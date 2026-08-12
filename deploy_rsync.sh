#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <user@host> <remote_dir>"
  exit 1
fi

target="$1"
remote_dir="$2"

rsync -az --delete \
  --exclude '.git' \
  --exclude '.env' \
  --exclude 'venv' \
  --exclude '__pycache__' \
  --exclude '.pytest_cache' \
  --exclude 'data' \
  --exclude 'exports' \
  --exclude 'bot_state.sqlite3' \
  --exclude 'bot_state.sqlite3-shm' \
  --exclude 'bot_state.sqlite3-wal' \
  ./ "${target}:${remote_dir}/"
