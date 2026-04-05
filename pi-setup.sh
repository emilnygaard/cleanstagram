#!/usr/bin/env bash
# Run this on the Raspberry Pi after cloning the repo.
# Usage: bash pi-setup.sh
set -e

echo "==> Installing fnm + Node 20"
curl -fsSL https://fnm.vercel.app/install | bash
export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env)"
fnm install 20
fnm use 20
fnm default 20

# Persist fnm in shell
if ! grep -q 'fnm env' ~/.bashrc; then
  echo 'export PATH="$HOME/.local/share/fnm:$PATH"' >> ~/.bashrc
  echo 'eval "$(fnm env --use-on-cd)"' >> ~/.bashrc
fi

echo "==> Installing worker dependencies"
cd "$(dirname "$0")/worker"
npm install

echo "==> Installing PM2"
npm install -g pm2

echo "==> Starting cleanstagram with PM2"
pm2 start ecosystem.config.cjs
pm2 save

echo ""
echo "==> Done. Next steps:"
echo "    1. Run:  pm2 startup"
echo "       then copy+paste the printed command to enable auto-start on boot"
echo "    2. Run:  sudo tailscale funnel 3000"
echo "       to expose the backend publicly"
echo "    3. Note your Funnel URL with: tailscale status"
