#!/usr/bin/env bash
# One-shot installer for a fresh Ubuntu 24.04 VPS.
# Run as root:  curl -fsSL <raw-url-of-this-file> | bash
# Or after `git clone`:  sudo bash setup.sh
#
# What it does:
#   1. Installs Node 22 LTS, git, build tools, Tailscale
#   2. Creates a dedicated `relay` user
#   3. Drops the bot under /srv/relay-bot, installs deps
#   4. Wires up the systemd unit so the bot survives reboots
#   5. Stops short of joining Tailscale or writing .env — those are
#      one-time manual steps you do at the end (so secrets don't end
#      up in this script).

set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root (sudo bash setup.sh)" >&2
  exit 1
fi

REPO_URL="${REPO_URL:-https://github.com/yaegerrrr/relay-bot.git}"
INSTALL_DIR="/srv/relay-bot"
LOG_DIR="/var/log/relay-bot"
USER_NAME="relay"

echo "==> Installing system packages"
apt-get update
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg git build-essential

echo "==> Installing Node.js 22"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "^v22"; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> Installing Tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

echo "==> Creating ${USER_NAME} user"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$USER_NAME"
fi

echo "==> Cloning bot to ${INSTALL_DIR}"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  sudo -u "$USER_NAME" git -C "$INSTALL_DIR" pull --ff-only
else
  rm -rf "$INSTALL_DIR"
  sudo -u "$USER_NAME" git clone "$REPO_URL" "$INSTALL_DIR"
fi

echo "==> Installing npm deps"
cd "$INSTALL_DIR"
sudo -u "$USER_NAME" npm install --omit=dev --no-audit --no-fund

echo "==> Creating log dir"
mkdir -p "$LOG_DIR"
chown -R "$USER_NAME:$USER_NAME" "$LOG_DIR"

echo "==> Installing systemd unit"
install -m 0644 "$INSTALL_DIR/relay-bot.service" /etc/systemd/system/relay-bot.service
systemctl daemon-reload
systemctl enable relay-bot.service

echo
echo "============================================================"
echo "  setup complete — three things left to do manually:"
echo
echo "  1. Create .env from the template and fill in your secrets:"
echo "       sudo -u $USER_NAME cp $INSTALL_DIR/.env.example $INSTALL_DIR/.env"
echo "       sudo -u $USER_NAME nano $INSTALL_DIR/.env"
echo "     Required:"
echo "       TELEGRAM_BOT_TOKEN          (from @BotFather)"
echo "       TELEGRAM_ALLOWED_USER_IDS   (from @userinfobot)"
echo "       ANTHROPIC_API_KEY           (console.anthropic.com)"
echo
echo "  2. Join Tailscale (so you can SSH in without exposing :22):"
echo "       sudo tailscale up"
echo "     Follow the URL it prints, sign in with your Tailscale account."
echo
echo "  3. Clone the repos you want the bot to manage:"
echo "       sudo -u $USER_NAME bash"
echo "       mkdir -p $INSTALL_DIR/repos && cd $INSTALL_DIR/repos"
echo "       git clone <your-repo-url> ..."
echo
echo "  Then start it:"
echo "       sudo systemctl start relay-bot"
echo "       sudo journalctl -u relay-bot -f"
echo "============================================================"
