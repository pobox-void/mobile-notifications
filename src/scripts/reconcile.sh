#!/bin/bash
# Reconcile Up Bank transactions with Actual Budget

# Use $HOME for path referencing
BASE_DIR="$HOME/source/mobile-notifications"
LOG_FILE="$BASE_DIR/logs/reconcile-cron.log"
cd "$BASE_DIR" || exit 1

# Ensure Node 20 is on the PATH (required for optional chaining in dependencies)
# Using $HOME to avoid hardcoding user paths
export PATH="$HOME/.nvm/versions/node/v20.11.0/bin:$PATH"

# Load env vars to get ACTUAL_BUDGET_ID
set -a
source env/.env
set +a

# Use npm and node from PATH (ensure they are available in the shell)
npm run build

mkdir -p user-files
node dist/reconcile-up-transactions.js >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

if [ $EXIT_CODE -eq 42 ]; then
    echo "[$(date)] SyncError detected (exit code 42). Clearing ALL cache and retrying..." >> "$LOG_FILE"
    rm -rf user-files
    mkdir -p user-files
    echo "[$(date)] Cache cleared. Retrying..." >> "$LOG_FILE"
    node dist/reconcile-up-transactions.js >> "$LOG_FILE" 2>&1
fi
