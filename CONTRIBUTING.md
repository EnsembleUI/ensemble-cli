# Contributing to Ensemble CLI

This document is for people working on the CLI itself. If you only use `ensemble` in your projects, see the [README](README.md).

## Local development

```bash
git clone https://github.com/EnsembleUI/ensemble-cli
cd ensemble-cli
npm install
npm run build
npm link   # optional: use the CLI globally from this checkout
```

### Scripts

| Command                | Description                   |
| ---------------------- | ----------------------------- |
| `npm run dev`          | Run the CLI with `ts-node`    |
| `npm run build`        | Compile TypeScript to `dist/` |
| `npm test`             | Run the test suite (Vitest)   |
| `npm run test:watch`   | Tests in watch mode           |
| `npm run lint`         | ESLint                        |
| `npm run format`       | Prettier (write)              |
| `npm run format:check` | Prettier (check only)         |

## Project layout

```text
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

## Advanced: Firebase and backend configuration

Normal installs use Ensemble’s cloud endpoints and a Firebase API key that is **injected at build time** (`npm run build` reads `ENSEMBLE_FIREBASE_API_KEY` via `scripts/inject-env.mjs`). You typically set that only when building or testing the CLI from source.

You can override the defaults at **runtime** (forks, custom backends, local integration tests):

| Variable                    | Default                                 | Purpose                                       |
| --------------------------- | --------------------------------------- | --------------------------------------------- |
| `ENSEMBLE_FIREBASE_PROJECT` | `ensemble-web-studio`                   | Firestore / Firebase project ID               |
| `ENSEMBLE_AUTH_BASE_URL`    | `https://studio.ensembleui.com/sign-in` | Browser sign-in page used by `ensemble login` |
| `ENSEMBLE_FIREBASE_API_KEY` | Injected placeholder in `dist/`         | Firebase Web API key (token refresh, etc.)    |

If the built-in key is missing or wrong, token refresh may fail with a message to set `ENSEMBLE_FIREBASE_API_KEY`.

## Releases

GitHub Actions bumps the version, tags, creates a GitHub Release, and publishes `@ensembleui/cli` to **GitHub Packages** and \*\*npm`.

**npm: trusted publishing (OIDC)** — Pushes to [registry.npmjs.org](https://www.npmjs.com/) use [trusted publishing](https://docs.npmjs.com/trusted-publishers): short-lived tokens via GitHub OIDC, no `NPM_TOKEN` secret. On npm → **Package** → **Settings** → **Trusted publishing**, add **GitHub Actions** with repository `EnsembleUI/ensemble-cli` and workflow filename **`release.yml`** (must match exactly, including `.yml`). `package.json` must keep a correct [`repository`](https://docs.npmjs.com/trusted-publishers) URL for this repo.

**Repository secrets**

| Secret                      | Purpose                                   |
| --------------------------- | ----------------------------------------- |
| `GH_PACKAGES_TOKEN`         | Publish to GitHub Packages                |
| `ENSEMBLE_FIREBASE_API_KEY` | Used at build time when compiling the CLI |

To cut a release: GitHub → **Actions** → **Release (bump version, tag, publish)** → choose `patch`, `minor`, or `major`.

## Security notes (maintainers)

- GitHub tokens used in `.npmrc` for GitHub Packages must not be committed; use least-privilege scopes (`read:packages` for consumers) and rotate if exposed.
- Shell and subprocess usage in the CLI (`npm view`, `npm install -g`, `open`/`start`/`xdg-open`) should stay **static string literals** so user input cannot be injected into shells.
