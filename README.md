# Ensemble CLI

CLI for logging in, initializing, and pushing app definitions to the Ensemble cloud.

## Installation

```bash
npm install -g @ensembleui/cli
```

### Use the CLI

```bash
ensemble login
ensemble logout
ensemble token
ensemble init
ensemble push
ensemble pull
ensemble release
ensemble add
ensemble update
```

## Commands

| Command            | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| `ensemble login`   | Log in to Ensemble (opens browser)                                        |
| `ensemble logout`  | Log out and clear local auth session                                      |
| `ensemble token`   | Print token for CI (set as `ENSEMBLE_TOKEN`); run `ensemble login` first  |
| `ensemble init`    | Initialize or update `ensemble.config.json` in the project                |
| `ensemble push`    | Scan the app directory and push changes to the cloud                      |
| `ensemble pull`    | Pull artifacts from the cloud and overwrite local files                   |
| `ensemble release` | Manage releases (snapshots) of your app (interactive menu or subcommands) |
| `ensemble add`     | Add a new screen, widget, script, action, translation, or asset           |
| `ensemble update`  | Update the CLI to the latest version                                      |

### Options

- **global** — `--debug` — Print full debug information and stack traces. Can also be enabled with `DEBUG=1`.
- **login** — `--verbose` — Print auth config path
- **push** — `--app <alias>` — App alias / environment key from `ensemble.config.json` (default: `default`)
- **push** — `--verbose` — Write collected data, diff, bundle, and payload JSON files for debugging
- **push** — `--dry-run` — Show what would be pushed without sending anything to the cloud
- **push** — `-y, --yes` — Skip confirmation prompt (useful for CI)
- **pull** — `--app <alias>` — App alias / environment key from `ensemble.config.json` (default: `default`)
- **pull** — `--verbose` — Write fetched cloud JSON to disk
- **pull** — `--dry-run` — Show what would change without modifying local files
- **pull** — `-y, --yes` — Skip confirmation prompt (overwrite without asking)
- **release create** — `--app <alias>` — App alias (default: `default`)
- **release create** — `-m, --message <msg>` — Release message (skips prompt)
- **release create** — `-y, --yes` — Skip message prompt (use empty message)
- **release create** — `--verbose` — Show full Firestore/Storage error response text (debugging)
- **release list** — `--app <alias>` — App alias (default: `default`)
- **release list** — `--limit <n>` — Maximum number of releases to show (default: 20)
- **release list** — `--json` — Print releases as machine-readable JSON (for scripts)
- **release use** — `--app <alias>` — App alias (default: `default`)
- **release use** — `--hash <hash>` — Non-interactive: use release by hash
- **release use** — `--hash <hash>` — Non-interactive: use release by hash (printed by `release list`)

### `ensemble add`

`ensemble add` scaffolds common app artifacts in your project and updates `.manifest.json` when needed.

- **Supported kinds**
  - `screen`
  - `widget`
  - `script`
  - `action`
  - `translation`
  - `asset`

- **Usage**
  - Interactive (prompts for kind and name):

    ```bash
    ensemble add
    ```

  - Non-interactive:

    ```bash
    ensemble add screen Home
    ensemble add widget MyWidget
    ensemble add script myUtility
    ensemble add action ShowToast
    ensemble add translation en_US
    ensemble add asset ./logo.png
    ```

- **Naming rules**
  - Artifact names are normalized (trimmed, repeated whitespace collapsed).
  - Names **cannot contain spaces** in the final file name. If you pass a name with spaces, the CLI will suggest a version without spaces (for example, `\"My Screen\"` → `MyScreen`) and let you confirm in interactive mode.

- **Files created**
  - Screens: `screens/<Name>.yaml`
  - Widgets: `widgets/<Name>.yaml`
  - Actions: `actions/<Name>.yaml`
  - Scripts: `scripts/<Name>.js`
  - Translations: `translations/<Name>.yaml`
  - Assets: `assets/<FileName>`

- **Asset upload behavior**
  - `asset` expects a file path (not a generated scaffold name).
  - The file is copied to `assets/`, uploaded to Ensemble cloud, and `.env.config` is upserted:
    - `assets=<assetBaseUrl>` is added only if missing.
    - The cloud-provided env variable key/value is added (or updated).
  - The CLI prints the returned usage key so you can paste it directly in app definitions.

- **Manifest behavior**
  - For `widget`, `script`, `action`, and `translation`, `.manifest.json` is updated to include the new artifact.
  - For the **first screen**, the CLI will offer to set it as `homeScreenName` in `.manifest.json`.

## Usage

1. Log in: `ensemble login`
2. From your project root, run `ensemble init` and link an existing app
3. Run `ensemble push` to sync your local app (screens, widgets, scripts, etc.) with the cloud
4. Optionally run `ensemble pull` to refresh local artifacts from the cloud when other collaborators change them

### Versions / releases (snapshots)

You can save and use snapshots of your app state in the cloud:

- **Create a release from local state:** After you have local changes you want to “tag”, run **`ensemble release create`** to save a snapshot (release) of the **current local app state** with an optional message.
- **List releases:** Run **`ensemble release list`** to see recent releases.
- **Use a release locally:** Run **`ensemble release use`** to choose a release and update **local files only** to that snapshot. Then run **`ensemble push`** to apply that state to the cloud.

When you run `ensemble release` **without a subcommand** in an interactive terminal, the CLI opens an interactive menu that lets you choose between **create**, **list**, and **use**. In non-interactive environments (e.g. CI), you must call an explicit subcommand such as `ensemble release list` or `ensemble release use --hash <hash>`.

### Exit codes

- `0` — Command completed successfully (including “Up to date. Nothing to push/pull.”).
- `1` — Error (e.g., not logged in, app not found, or no access).
- `130` — User cancelled an interactive confirmation (push/pull prompt).

### CI/CD

**Auth:** Set `ENSEMBLE_TOKEN` in your CI environment. To get the token:

1. On your machine, run `ensemble login` (browser) once.
2. Run `ensemble token` — it prints the token for CI.
3. Add that value as a secret in your CI (e.g. GitHub Actions → Settings → Secrets → `ENSEMBLE_TOKEN`).

If `ENSEMBLE_TOKEN` is not set, the CLI uses the global config from `ensemble login` (e.g. on your laptop).

**Non-interactive:** Use `-y` so push and pull do not prompt:

- `ensemble push -y` — Push without confirmation.
- `ensemble pull -y` — Pull without confirmation.

Without `-y`, both commands refuse to run when not attached to a TTY and exit with code 1. Use `--dry-run` in a validation job to inspect changes without applying them. The project must already have `ensemble.config.json`.

> **Tip:** In CI, prefer `ensemble push --dry-run` / `ensemble pull --dry-run` in a validation job, and use `-y` only when you are ready to apply changes.

## Environment variables

For everyday use you do not need to set anything beyond what is described in [CI/CD](#cicd) (`ENSEMBLE_TOKEN` in automation).

**Optional:**

| Variable                          | Purpose                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ENSEMBLE_VERBOSE` / `VERBOSE`    | Truthy values (`1`, `true`, `yes`, `on`) enable verbose mode where supported.                                |
| `DEBUG`                           | Same idea as global `--debug` (truthy values as above).                                                      |
| `CI` / `ENSEMBLE_NO_UPDATE_CHECK` | Truthy values disable the startup “new version available” check (useful in CI or when you want a quiet run). |

Firebase project, auth URL, and API key are fixed for the published CLI (the API key is injected when the package is built). You only need to think about those when [developing the CLI](CONTRIBUTING.md#advanced-firebase-and-backend-configuration).

## Security considerations

- **Secrets and tokens**
  - `ENSEMBLE_TOKEN` (CI token) is a long-lived Firebase refresh token. Store it only in CI secret stores (e.g. GitHub Actions secrets), never in source control or logs.
  - The local auth file at `~/.ensemble/cli-config.json` contains ID tokens and refresh tokens for your user account. Anyone who can read this file can act as you in the CLI.
  - The CLI now writes `~/.ensemble/cli-config.json` with user-only permissions on POSIX systems (`0700` directory, `0600` file), but you should still treat it as sensitive.
- **Auth and authorization model**
  - Authentication is handled via browser sign-in to Ensemble (backed by Firebase). The CLI stores tokens locally and refreshes them via Firebase’s secure token API.
  - Authorization is enforced server-side using Firestore security rules and app-level roles (`write`/`owner`). The CLI passes your Firebase ID token as a Bearer token and does not make its own trust decisions beyond handling HTTP responses.
- **Local login callback**
  - The `ensemble login` flow uses a loopback HTTP callback on `127.0.0.1` with a short timeout and a random `state` value to bind the browser flow to the CLI.
  - Only complete login flows in a browser you trust on the same machine; untrusted local processes with full user access may still interfere, as with most loopback-based OAuth flows.
- **Shell and network usage**
  - All shell commands used by the CLI (`npm view`, `npm install -g`, `open`/`start`/`xdg-open`) are static string literals and must remain so to avoid shell injection.
  - Firestore/network debug hooks intentionally avoid logging Authorization headers or raw tokens; custom debug handlers must preserve this invariant.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development, tests, project layout, and the release workflow.

## License

MIT
