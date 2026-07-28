#!/usr/bin/env bash
# install-service.sh — Install the Hermes Dashboard as a systemd user service
# Run with: bash docs/install-service.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SERVICE_SRC="$SCRIPT_DIR/hermes-dashboard.service"
SERVICE_NAME="hermes-dashboard"

echo "=== Hermes Dashboard — systemd Install ==="
echo "Repo root: $REPO_ROOT"

# Copy to system service directory
echo "Copying service file to /etc/systemd/system/..."
sudo cp "$SERVICE_SRC" "/etc/systemd/system/${SERVICE_NAME}.service"

# Reload systemd, enable and start
echo "Enabling and starting service..."
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl start "$SERVICE_NAME"

echo ""
echo "✅ Done. Dashboard will auto-start on every boot."
echo ""
echo "Useful commands:"
echo "  sudo systemctl status $SERVICE_NAME    — check service health"
echo "  sudo systemctl restart $SERVICE_NAME   — restart the dashboard"
echo "  sudo journalctl -u $SERVICE_NAME -f    — follow live logs"
echo "  sudo systemctl stop $SERVICE_NAME      — stop the dashboard"
echo "  sudo systemctl disable $SERVICE_NAME   — disable auto-start"
