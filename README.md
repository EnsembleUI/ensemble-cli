# Ensemble CLI

CLI for logging in, initializing, and pushing app definitions to the Ensemble cloud.

## Installation

### From GitHub Packages (recommended)

#### Option 1: One-shot install script

Run this command once (it will prompt for a GitHub token with `read:packages`):

```bash
curl -fsSL https://raw.githubusercontent.com/EnsembleUI/ensemble-cli/main/scripts/install-ensemble-cli.sh | bash
```

#### Option 2: Manual setup

1. **Configure npm to use GitHub Packages for `@ensembleui`:**

Add this to your `~/.npmrc` (global) or project `.npmrc`:

```bash
@ensembleui:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

Your GitHub token must have at least the `read:packages` scope.

2. **Install the CLI globally:**

```bash
npm install -g @ensembleui/cli
```

3. **Use the CLI:**

```bash
ensemble login
ensemble logout
ensemble init
ensemble push
ensemble pull
ensemble revert
ensemble add
ensemble update
```

### Development setup

```bash
npm install
npm run build
npm link   # link globally for local development
```

## Releasing (GitHub Packages)

This repo uses GitHub Actions to:

- bump the version in `package.json`
- create a git tag (e.g. `v0.1.0`)
- create a GitHub Release
- publish `@ensembleui/cli` to GitHub Packages

To release a new version, go to GitHub → Actions → run the workflow **Release (bump version, tag, publish)** and choose `patch`, `minor`, or `major`.

## Commands

| Command            | Description                                                                 |
|--------------------|-----------------------------------------------------------------------------|
| `ensemble login`   | Log in to Ensemble (opens browser)                                         |
| `ensemble logout`  | Log out and clear local auth session                                       |
| `ensemble init`    | Initialize or update `ensemble.config.json` in the project                |
| `ensemble push`   | Scan the app directory and push changes to the cloud                       |
| `ensemble pull`   | Pull artifacts from the cloud and overwrite local files                    |
| `ensemble revert` | Revert local files to a previous version (run `ensemble push` to sync cloud)|
| `ensemble add`    | Add a new screen, widget, script, or translation scaffold                  |
| `ensemble update` | Update the CLI to the latest version                                       |

### Options

- **login** — `--verbose` — Print auth config path
- **push** — `--app <alias>` — App alias (default: `default`)
- **push** — `--verbose` — Write collected data and diff/payload JSON files for debugging
- **push** — `-y, --yes` — Skip confirmation prompt (useful for CI)
- **pull** — `--app <alias>` — App alias (default: `default`)
- **pull** — `--verbose` — Write fetched cloud JSON to disk
- **pull** — `-y, --yes` — Skip confirmation prompt (overwrite without asking)
- **revert** — `--app <alias>` — App alias (default: `default`)
- **revert** — `--verbose` — Show full error details (e.g. Firestore index creation link)

## Usage

1. Log in: `ensemble login`
2. From your project root, run `ensemble init` and link an existing app
3. Run `ensemble push` to sync your local app (screens, widgets, scripts, etc.) with the cloud
4. Optionally run `ensemble pull` to refresh local artifacts from the cloud when other collaborators change them

### Versions (snapshots)

After a successful push, in interactive mode the CLI may prompt **"Create a version (snapshot) of this state?"**. If you choose yes and enter an optional message, a full snapshot is saved in Firebase. Versions are retained for **30 days**; after that they are deleted automatically. Use **`ensemble revert`** to list recent versions and restore **local files only** to a selected snapshot. The cloud is not updated by revert; run **`ensemble push`** afterward to apply the reverted state to the cloud.

### Exit codes

- `0` — Command completed successfully (including “Up to date. Nothing to push/pull.”).
- `1` — Error (e.g., not logged in, app not found, or no access).
- `130` — User cancelled an interactive confirmation (push/pull/revert prompt).

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ENSEMBLE_FIREBASE_API_KEY` | Required for automatic token refresh. Without it, you must re-run `ensemble login` when the session expires. |
| `ENSEMBLE_FIREBASE_PROJECT` | Firestore project (default: `ensemble-web-studio`) |
| `ENSEMBLE_AUTH_BASE_URL` | Auth sign-in URL (default: `https://studio.ensembleui.com/sign-in`) |

## Project Structure

```
src/
├── auth/       # Session & token handling
├── cloud/      # Firestore API client
├── commands/   # CLI commands
├── config/     # Global & project config
├── core/       # Domain logic (app collection, DTOs, diff)
└── lib/        # Shared utilities
tests/
├── auth/       # Auth unit tests (token, session)
├── cloud/      # Firestore client tests
├── config/     # Config tests (project, global)
├── core/       # Core unit tests (appCollector, bundleDiff, buildDocuments)
└── lib/        # Utility tests (spinner)
```

## Development

```bash
npm run dev        # Run with ts-node
npm run build      # Compile TypeScript
npm run test       # Run tests
npm run test:watch # Run tests in watch mode
npm run lint       # ESLint
npm run format     # Prettier
```

## License

MIT
