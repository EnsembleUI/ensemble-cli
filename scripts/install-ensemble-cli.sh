#!/usr/bin/env bash
set -euo pipefail

echo "This script will configure npm to use GitHub Packages for @ensembleui and install @ensembleui/cli globally."
echo

read -rsp "GitHub Personal Access Token (with read:packages): " GH_TOKEN
echo

if [[ -z "$GH_TOKEN" ]]; then
  echo "Error: token cannot be empty."
  exit 1
fi

echo "Configuring npm registry for @ensembleui scope..."
npm config set @ensembleui:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$GH_TOKEN"

echo "Installing @ensembleui/cli globally..."
npm install -g @ensembleui/cli

echo
echo "Done. You can now run 'ensemble login', 'ensemble push', etc."

