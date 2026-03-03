# Ensemble CLI

CLI for logging in, initializing, and pushing app definitions to the Ensemble cloud.

## Installation

```bash
npm install
npm run build
```

Link globally for development:

```bash
npm link
```

## Commands

| Command | Description |
|---------|-------------|
| `ensemble login` | Log in to Ensemble (opens browser) |
| `ensemble logout` | Log out |
| `ensemble init` | Initialize or update `ensemble.config.json` in the current project |
| `ensemble push` | Scan the app directory and prepare data for upload |

### Options

- **login** — `--verbose` — Print auth config path
- **push** — `--app <alias>` — App alias (default: `default`)
- **push** — `--verbose` — Write collected data as JSON files for debugging

## Usage

1. Log in: `ensemble login`
2. From your project root, run `ensemble init` and link an existing app
3. Run `ensemble push` to sync your local app (screens, widgets, scripts, etc.) with the cloud

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
