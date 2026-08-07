# Environment config + secrets files (`.env.config` / `.env.secrets` + per-alias overrides)

This document describes the environment-variable architecture used by the Ensemble CLI for **multiple app environments** (or “targets”).

The chosen approach is:

- **Config base file**: `.env.config` (shared defaults)
- **Config scoped override file**: `.env.config.<alias>` (per app/environment alias)
- **Secrets base file**: `.env.secrets` (shared defaults)
- **Secrets scoped override file**: `.env.secrets.<alias>` (per app/environment alias)

Where `<alias>` matches the `--app <alias>` value (an app key in `ensemble.config.json`). The README already describes `--app <alias>` as the “App alias / environment key”.

---

## Goals

- **Prevent accidental cross-environment breakage** (e.g. pushing dev values to prod).
- **Support per-environment differences** (e.g. `api_url` differs between dev and prod).
- **Keep local configuration readable** and easy to reason about.
- **Play nicely with existing CLI behavior** that already maintains `.env.config` for assets.
- **Keep secrets out of source control by default** with a predictable local structure.

## Non-goals

- Replacing runtime secrets management (e.g. Vault/KMS). This design is about **how the CLI stores and syncs config**, not the ultimate secret storage strategy.
- Introducing a complex file format. Files remain simple `KEY=value` pairs.

---

## Terminology

- **Alias**: The value passed to `--app <alias>` (e.g. `default`, `dev`, `prod`), corresponding to an app entry in `ensemble.config.json`.
- **Base config**: `.env.config`
- **Alias config**: `.env.config.<alias>` (example: `.env.config.prod`)
- **Effective config**: The merged view used by commands (base + alias overrides).
- **Base secrets**: `.env.secrets`
- **Alias secrets**: `.env.secrets.<alias>` (example: `.env.secrets.prod`)
- **Effective secrets**: The merged view used by commands (base + alias overrides).

---

## File format

Both files use the same syntax:

- One entry per line: `KEY=value`
- Empty lines allowed
- Lines starting with `#` are comments
- The first `=` separates key from value
- Whitespace around keys is trimmed

Example:

```ini
# shared defaults
api_timeout_ms=30000
api_url=https://dev.ensemble.com
```

And an alias override:

```ini
# prod overrides
api_url=https://prod.ensemble.com
```

---

## Resolution rules

For the active alias (`--app` or `ensemble.config.json` → `default`):

| Situation                                      | Files used                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| Alias is **default** and only base files exist | `.env.config` + `.env.secrets`                                              |
| Alias is **not default**                       | `.env.config.<alias>` + `.env.secrets.<alias>` (created on pull if missing) |
| Alias has **both** scoped files (any alias)    | scoped pair wins over base                                                  |

No mixing across tiers. Config and secrets always come from the same tier.

Pulling a non-default alias (e.g. `ensemble pull --app uat`) writes cloud env into `.env.config.uat` / `.env.secrets.uat` and leaves base files untouched.

---

## CLI behavior

### Reading env files

Commands use the resolved pair for the selected `--app` alias (see resolution rules above).

`--app` is optional and defaults to `ensemble.config.json` → `default`.

### Missing vs empty (push)

| Local state             | Push behavior                                                     |
| ----------------------- | ----------------------------------------------------------------- |
| File **missing**        | Ignored — no env push for that side, no cloud wipe                |
| File **present, empty** | Wipe — warn + `[y/N]` before deleting all cloud keys on that side |

### Pushing env variables

- `ensemble push --app <alias>` pushes the **effective** env for that alias.
- Config and secrets are pushed independently (missing file → that side skipped).

### Pulling env variables

- `ensemble pull --app <alias>` writes cloud env into the scoped target file when in scoped mode (`.env.config.<alias>` / `.env.secrets.<alias>`), leaving the base file untouched.
- In legacy mode, pull continues to write `.env.config` / `.env.secrets`.

### Release use

- `ensemble release use` restores snapshot config and secrets into the same write targets as pull (scoped or base).
- `release create` and `release use` require `ENSEMBLE_ENCRYPTION_KEY` in the alias secrets file (`.env.secrets` or `.env.secrets.<alias>`). Generate with `openssl rand -hex 32`.
- Snapshots are stored encrypted as `.enc.json` in Firebase Storage. Download uses normal Firebase Storage auth; access is enforced by Storage rules (app collaborators).

### Release encryption (CDN vs CLI)

| Key                       | CDN publish                              | CLI releases                                     |
| ------------------------- | ---------------------------------------- | ------------------------------------------------ |
| `ENSEMBLE_ENCRYPTION_KEY` | Encrypts `encrypted-manifest.json` on R2 | Encrypts release `.enc.json` on Firebase Storage |

CDN may also use `ENSEMBLE_MANIFEST_KEY` for Cloudflare WAF. CLI releases do not use a manifest key.

---

## Asset-generated keys and `.env.config`

The CLI upserts `.env.config` for asset-related keys after:

- `ensemble add asset`
- `ensemble push` (asset upload)

Pull writes asset env keys (`assets=`, per-asset keys) into the resolved config file for the active alias (base or scoped). `ensemble add asset` still upserts the base `.env.config`.

---

## Safety

- **Never default to destructive deletes** except when a local env file exists but is empty (explicit wipe semantics above).
- **`--delete-missing`** is not implemented; local-only keys are not auto-deleted from cloud on push.

---

## Git and secrets guidance

Different teams will choose different policies. Recommended defaults:

- Commit `.env.config` only if it contains **non-secret** shared defaults.
- Do **not** commit `.env.secrets` or `.env.secrets.<alias>` (treat as sensitive).
- Prefer `.env.config.example` / `.env.secrets.example` for documentation when needed.

At minimum, consider adding these to `.gitignore`:

```gitignore
.env.config.*
!.env.config.example
.env.secrets
.env.secrets.*
!.env.secrets.example
```

If you _do_ want to commit alias files for non-secret config, use a more selective ignore pattern or separate “public” vs “secret” configs.

---

## Examples

### Dev + prod API URL

`.env.config`:

```ini
api_timeout_ms=30000
api_url=https://dev.ensemble.com
```

`.env.config.prod`:

```ini
api_url=https://prod.ensemble.com
```

- `ensemble push --app default` uses dev URL
- `ensemble push --app prod` uses prod URL

### Shared defaults + per-alias assets

`.env.config`:

```ini
cdn_region=us-east-1
```

`.env.config.dev`:

```ini
assets=https://assets.dev.ensemble.com/
```

`.env.config.prod`:

```ini
assets=https://assets.prod.ensemble.com/
```

---

## Migration plan

1. Single-app projects: no change — keep using `.env.config` / `.env.secrets`.
2. Multi-app projects: add `.env.config.<alias>` / `.env.secrets.<alias>` for per-target overrides; shared defaults stay in the base files.
3. Existing single-app repos can opt in early by creating a scoped file (e.g. `.env.config.dev`).

---

## Open questions (for follow-up)

- Should `.env.config` be treated as **shared defaults** only, or also as the “default alias” file?
  - This doc treats it as shared defaults that apply to all aliases unless overridden.
- Should asset keys always be alias-scoped, or can some be global?
  - Recommended: alias-scoped, since assets are tied to a specific app target.

- Do we want separate commands for secrets vs config (recommended), or a unified env push/pull that handles both?
  - Recommendation: separate surfaces (e.g. `env` vs `secrets`) to make “high risk” operations explicit.
