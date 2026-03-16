#!/usr/bin/env bash
set -euo pipefail

echo "This script will configure npm to use GitHub Packages for @ensembleui and install @ensembleui/cli globally."
echo
echo "IMPORTANT:"
echo "  - The GitHub token (GH_TOKEN) you provide is a sensitive secret."
echo "  - It should have the minimum required scope (typically: read:packages)."
echo "  - Your npm config (~/.npmrc) MUST NOT be committed to source control or shared."
echo

# First, check if npm is already authenticated for GitHub Packages.
if npm view @ensembleui/cli --registry=https://npm.pkg.github.com >/dev/null 2>&1; then
  echo "Existing npm auth for GitHub Packages detected; skipping token setup."
else
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
fi

echo "Cleaning up any existing global 'ensemble' installs..."
# Best-effort uninstall via npm; ignore errors
npm uninstall -g @ensembleui/cli >/dev/null 2>&1 || true
npm uninstall -g ensemble >/dev/null 2>&1 || true

# Also remove whichever 'ensemble' binary is currently on PATH, since npm may not
# know about how it was created.
EXISTING_ENSEMBLE="$(command -v ensemble 2>/dev/null || true)"
if [[ -n "$EXISTING_ENSEMBLE" && -e "$EXISTING_ENSEMBLE" ]]; then
  echo "Found existing executable at '$EXISTING_ENSEMBLE'. Removing it so we can install the new CLI..."
  rm -f "$EXISTING_ENSEMBLE"
fi

echo "Installing @ensembleui/cli globally (may overwrite any existing 'ensemble' binary)..."
if ! npm install -g @ensembleui/cli --force; then
  echo
  echo "Error: npm install failed even though authentication succeeded."
  echo "Check the npm log output above for details."
  exit 1
fi

echo "Ensuring 'ensemble' is available on PATH..."
PREFIX="$(npm prefix -g 2>/dev/null || true)"
ROOT="$(npm root -g 2>/dev/null || true)"
if [[ -z "$PREFIX" || -z "$ROOT" ]]; then
  echo "Warning: Could not determine npm global prefix/root. If 'ensemble' is not found, open a new terminal."
else
  BIN_DIR="$PREFIX/bin"
  TARGET="$BIN_DIR/ensemble"
  SOURCE="$ROOT/@ensembleui/cli/dist/index.js"

  if [[ ! -d "$BIN_DIR" ]]; then
    mkdir -p "$BIN_DIR"
  fi

  if [[ ! -e "$TARGET" ]]; then
    if [[ -e "$SOURCE" ]]; then
      ln -sf "$SOURCE" "$TARGET"
      chmod +x "$SOURCE" "$TARGET" 2>/dev/null || true
    else
      echo "Warning: Expected CLI entrypoint not found at '$SOURCE'."
      echo "The package may have been published without 'dist/'."
    fi
  fi
fi

echo
echo "Done. You can now run 'ensemble login', 'ensemble push', etc."

