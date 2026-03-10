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
npm config set @ensembleui:registry https://npm.pkg.github.com >/dev/null
npm config set //npm.pkg.github.com/:_authToken "$GH_TOKEN" >/dev/null

echo "Validating token against GitHub Packages..."
if ! npm view @ensembleui/cli --registry=https://npm.pkg.github.com >/dev/null 2>&1; then
  echo
  echo "Error: Unable to authenticate with GitHub Packages using the provided token."
  echo "Make sure your token:"
  echo "  - Is a classic PAT (not fine-grained), and"
  echo "  - Has at least the 'read:packages' scope for the EnsembleUI organization."
  echo
  echo "You can generate one at: https://github.com/settings/tokens"
  exit 1
fi

echo "Installing @ensembleui/cli globally..."
if ! npm install -g @ensembleui/cli; then
  echo
  echo "Error: npm install failed even though authentication succeeded."
  echo "Check the npm log output above for details."
  exit 1
fi

echo
echo "Done. You can now run 'ensemble login', 'ensemble push', etc."

