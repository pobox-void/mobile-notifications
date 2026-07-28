#!/bin/bash

# Configuration
BACKUP_DIR="/tmp/actual_backups"
GDRIVE_REMOTE="gdrive"
GDRIVE_FOLDER="ActualBudgetBackups"
RETENTION_COUNT=5
DRY_RUN=false

# Source Data Directories
DATA_DIR_1="$HOME/source/mobile-notifications/user-files"
DATA_DIR_2="$HOME/source/actual/packages/sync-server/user-files"

# Parse arguments
for arg in "$@"; do
    if [ "$arg" == "--dry-run" ]; then
        DRY_RUN=true
        echo "--- DRY RUN MODE ENABLED ---"
    fi
done

# Node.js and dependencies
export PATH="$HOME/.nvm/versions/node/v20.11.0/bin:$PATH"
BASE_DIR="$HOME/source/mobile-notifications"

function fail_exit() {
    echo "$1"
    cd "$BASE_DIR" || exit 1
    npm run build >/dev/null 2>&1
    node dist/scripts/send-backup-email.js "fail" "$1"
    exit 1
}

function success_exit() {
    echo "Backup process complete."
    cd "$BASE_DIR" || exit 1
    npm run build >/dev/null 2>&1
    node dist/scripts/send-backup-email.js "success" "The automated Actual Budget backup to Google Drive completed successfully. File uploaded: $FILENAME"
    exit 0
}

# Create local backup dir if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Timestamp
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
FILENAME="actual_backup_$TIMESTAMP.tar.gz"
FILEPATH="$BACKUP_DIR/$FILENAME"

echo "Creating backup: $FILENAME..."

# Compress directories
# Change into source root to properly preserve directory structures individually
cd "$HOME/source" || fail_exit "Failed to cd into $HOME/source"
tar -czf "$FILEPATH" mobile-notifications/user-files actual/packages/sync-server/user-files

if [ $? -eq 0 ]; then
    echo "Compression successful."
else
    fail_exit "Compression failed!"
fi

# Upload to Google Drive
echo "Uploading to Google Drive ($GDRIVE_REMOTE:$GDRIVE_FOLDER)..."
if [ "$DRY_RUN" == "true" ]; then
    echo "[DRY RUN] Would run: rclone copy $FILEPATH $GDRIVE_REMOTE:$GDRIVE_FOLDER"
else
    # Check if remote exists
    if ! rclone listremotes | grep -q "^$GDRIVE_REMOTE:"; then
        rm -f "$FILEPATH"
        fail_exit "Error: rclone remote '$GDRIVE_REMOTE' not found. Please run 'rclone config' first."
    fi
    
    rclone copy "$FILEPATH" "$GDRIVE_REMOTE:$GDRIVE_FOLDER"
    if [ $? -eq 0 ]; then
        echo "Upload successful."
    else
        rm -f "$FILEPATH"
        fail_exit "Upload failed!"
    fi
fi

# Cleanup local file
rm "$FILEPATH"

# Retention Logic
echo "Checking retention policy (Keeping last $RETENTION_COUNT backups)..."

# List files in GDrive, sorted by name (which includes timestamp)
# lsf --format "p" gets just the path/filename
FILES=$(rclone lsf "$GDRIVE_REMOTE:$GDRIVE_FOLDER" --format "p")
if [ $? -ne 0 ]; then
    fail_exit "Error: Failed to list files from Google Drive. Retention logic skipped."
fi
FILES=$(echo "$FILES" | sort)
COUNT=$(echo "$FILES" | grep -v "^$" | wc -l)

if [ "$COUNT" -gt "$RETENTION_COUNT" ]; then
    DELETE_COUNT=$((COUNT - RETENTION_COUNT))
    FILES_TO_DELETE=$(echo "$FILES" | head -n "$DELETE_COUNT")
    
    echo "Found $COUNT backups. Deleting $DELETE_COUNT oldest files..."
    
    while read -r file; do
        if [ -n "$file" ]; then
            if [ "$DRY_RUN" == "true" ]; then
                echo "[DRY RUN] Would delete: $file"
            else
                echo "Deleting: $file"
                rclone deletefile "$GDRIVE_REMOTE:$GDRIVE_FOLDER/$file"
            fi
        fi
    done <<< "$FILES_TO_DELETE"
else
    echo "Current count ($COUNT) is within limit ($RETENTION_COUNT). No files deleted."
fi

success_exit
