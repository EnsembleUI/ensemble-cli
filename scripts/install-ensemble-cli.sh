#!/usr/bin/env bash
set -euo pipefail

echo "This script will configure npm to use GitHub Packages for @ensembleui and install @ensembleui/cli globally."
echo

# Use existing GH_TOKEN if set; otherwise prompt on the TTY so this works with curl | bash
if [[ -z "${GH_TOKEN-}" ]]; then
  if [[ -t 0 ]]; then
    # stdin is a TTY
    read -rsp "GitHub Personal Access Token (with read:packages): " GH_TOKEN
    echo
  else
    # read from /dev/tty when running via curl | bash
    read -rsp "GitHub Personal Access Token (with read:packages): " GH_TOKEN </dev/tty
    echo
  fi
fi

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "Error: GH_TOKEN is empty. Set GH_TOKEN in your environment or rerun and enter a token."
  exit 1
fi

echo "Configuring npm registry for @ensembleui scope..."
npm config set @ensembleui:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$GH_TOKEN"

echo "Installing @ensembleui/cli globally..."
npm install -g @ensembleui/cli

echo
echo "Done. You can now run 'ensemble login', 'ensemble push', etc."

