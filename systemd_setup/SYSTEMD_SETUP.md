# Systemd Services Setup

This directory contains systemd service files to automatically start the webhook server, Actual Budget server, and Cloudflare Tunnel on system boot.

### 1. Actual Budget Server (`MJ_actual-server.service`)
- **Purpose**: Runs the main Actual Budget server.
- **Path**: `$HOME/source/actual`
- **Command**: `yarn start:server` (Port 5006)
- **User**: `$USER`

### 2. Up Bank Webhook Server (`MJ_upbank-webhook.service`)
- **Purpose**: Bridge between Up Bank and Actual Budget.
- **Port**: 8080
- **User**: `$USER`

### 3. Cloudflare Tunnel (`cloudflared.service`)
- **Purpose**: Exposes services to the internet securely (`your-domain.com`).
- **Path**: `/etc/systemd/system/cloudflared.service`
- **Domains**: 
  - `actual.your-domain.com` -> localhost:5006
  - `upbankwebhook.your-domain.com` -> localhost:8080

### 4. Actual Budget Daily Backup (`MJ_actual-backup.timer`)
- **Purpose**: Daily backup of data to Google Drive.
- **Schedule**: 3:00 AM Daily.
- **Script**: `$HOME/source/mobile-notifications/src/scripts/backup-actual.sh`

## Installation

1. **Update and Copy service files:**
   > [!IMPORTANT]
   > Before copying, edit the `.service` files and replace `$HOME` with your actual home path (e.g., `/home/username`) and `$USER` with your username. Systemd requires absolute paths in most directives.

   ```bash
   cd $HOME/source/mobile-notifications/systemd_setup
   sudo cp MJ_upbank-webhook.service /etc/systemd/system/
   sudo cp MJ_actual-server.service /etc/systemd/system/
   sudo cp MJ_actual-backup.service /etc/systemd/system/
   sudo cp MJ_actual-backup.timer /etc/systemd/system/
   ```

2. **Cloudflare Tunnel Setup:**
   The `cloudflared.service` is usually managed by the Cloudflare agent during installation.
   ```bash
   sudo cloudflared service install [TOKEN]
   ```

3. **Reload and Enable Services:**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable MJ_upbank-webhook.service
   sudo systemctl enable MJ_actual-server.service
   sudo systemctl enable MJ_actual-backup.timer
   sudo systemctl enable cloudflared.service
   ```

4. **Start Services:**
   ```bash
   sudo systemctl start MJ_upbank-webhook.service
   sudo systemctl start MJ_actual-server.service
   sudo systemctl start MJ_actual-backup.timer
   sudo systemctl start cloudflared.service
   ```

## Managing Services

### Check service status
```bash
sudo systemctl status MJ_upbank-webhook.service
sudo systemctl status MJ_actual-server.service
sudo systemctl status MJ_actual-backup.timer
sudo systemctl status cloudflared.service
```

### View logs
```bash
# Webhook Server logs
tail -f $HOME/source/mobile-notifications/logs/webhook.log

# Actual Server logs
tail -f $HOME/source/mobile-notifications/logs/actual-server.log

# Backup logs
tail -f $HOME/source/mobile-notifications/logs/backup.log

# Reconciliation logs
tail -f $HOME/source/mobile-notifications/logs/reconcile-cron.log

# Cloudflare Tunnel logs
sudo journalctl -u cloudflared -f
```

### Stop/Restart
```bash
sudo systemctl restart MJ_upbank-webhook.service
sudo systemctl restart MJ_actual-server.service
sudo systemctl restart cloudflared.service
```

## Service Details

### MJ_upbank-webhook.service
- Runs the Node.js webhook server on port 8080.

### cloudflared.service
- Creates a secure outbound tunnel to Cloudflare.
- Provides SSL/TLS termination automatically.
- Managed via the Cloudflare Zero Trust Dashboard.

### MJ_actual-backup.service & MJ_actual-backup.timer
- Performs a daily backup of your user-files.
- Compresses files and uploads to Google Drive using `rclone`.
- Keep the last 5 days of backups.
- Logs results to `logs/backup.log`.

### MJ_actual-server.service
- Runs the Actual Budget Server on port 5006.
- Data stored in `$HOME/source/actual/data`.
