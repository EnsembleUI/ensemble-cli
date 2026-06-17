# Environment config + secrets files (`.env.config` / `.env.secrets` + per-alias overrides)

This document proposes an environment-variable architecture for the Ensemble CLI that supports **multiple app environments** (or “targets”) cleanly and safely.

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

## Resolution / precedence rules

When running a command for a given alias, apply the same rules to **config** and **secrets**:

- Config:
  1. Read `.env.config` if present (base defaults).
  2. Read `.env.config.<alias>` if present (alias overrides).
  3. Merge by key where **alias overrides win**.
- Secrets:
  1. Read `.env.secrets` if present (base defaults).
  2. Read `.env.secrets.<alias>` if present (alias overrides).
  3. Merge by key where **alias overrides win**.

If only `.env.config` exists, behavior matches today (backwards compatible). Secrets files are additive and optional.

### Why this precedence?

- Shared values (common across envs) live in one place.
- Environment-specific values override without duplicating the whole file.

---

## CLI behavior (proposed)

### Reading env config

Commands that need env config should use the **effective env config** for the selected `--app` alias.

- If `--app` is omitted, treat it as `default` (existing behavior).
- If `.env.config.<alias>` is missing, fall back to `.env.config` only.

### Pushing env variables

If the CLI supports pushing env vars to the cloud, it should be **explicitly scoped**:

- `ensemble push --app prod` may only push the **prod effective env config**.
- It must never push dev values to prod unless the user explicitly made them prod values (via `.env.config.prod` or identical base defaults).

Recommended sync semantics:

- Default: **upsert/patch** (add/update keys present in local effective env config).
- Optional: `--delete-missing` (dangerous) to remove remote keys not present locally.
- Optional: `--dry-run` to show changes without applying.

### Pulling env variables

Similarly, pulling should be scoped:

- `ensemble pull --app prod` should update **only** `.env.config.prod` (or optionally print a diff).
- Avoid writing prod keys into `.env.config` unless explicitly requested.

---

## Asset-generated keys and `.env.config`

Today, the CLI “upserts” `.env.config` to ensure asset-related keys exist after:

- `ensemble add asset`
- `ensemble push` (asset upload)
- `ensemble pull` (asset sync)

This design proposes:

- Keep `.env.config` as a base defaults file for users.
- Write **asset-generated keys into the alias file** by default (because assets are associated with a specific app target).

Suggested split:

- `.env.config`: user-managed shared defaults (checked in or not—team choice)
- `.env.config.<alias>`: app-target-specific values, including:
  - `assets=<baseUrl>` for that target
  - any cloud-provided asset usage env keys for that target

Backwards-compatibility note:

- If alias files are not in use yet, continue writing to `.env.config` as today.
- Once alias files exist (or a new setting/flag opts into alias-mode), write to alias files.

---

## Safety and production protections

To reduce “oops pushed dev to prod” failures:

- **Require explicit target** for sensitive operations (recommended UX):
  - For example, pushing env vars could require `--app` when multiple apps exist in `ensemble.config.json`.
- **Stronger confirmations** for production-like aliases (e.g. `prod`, `production`):
  - Show a diff summary
  - Require a typed confirmation or `--yes`
- **Never default to destructive deletes**:
  - `--delete-missing` must be opt-in.

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

### CLI handling expectations for secrets

If/when the CLI reads or syncs secrets:

- Never print secret values in logs (even in `--verbose`).
- Prefer diff output that only shows keys changed (and counts), not values.
- Consider stronger confirmations / restrictions for production aliases.

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

## Migration plan (incremental)

1. **Introduce alias file support** in read-paths:
   - merge base + alias override (alias wins)
2. **Introduce alias-aware write-paths**:
   - write generated keys (assets) into `.env.config.<alias>` when applicable
3. **Add env push/pull commands or flags** (if desired):
   - ensure all operations are scoped to `--app <alias>`
4. **Add guardrails**:
   - diffs, confirmations for prod, optional delete-missing

---

## Open questions (for follow-up)

- Should `.env.config` be treated as **shared defaults** only, or also as the “default alias” file?
  - This doc treats it as shared defaults that apply to all aliases unless overridden.
- Should asset keys always be alias-scoped, or can some be global?
  - Recommended: alias-scoped, since assets are tied to a specific app target.

- Do we want separate commands for secrets vs config (recommended), or a unified env push/pull that handles both?
  - Recommendation: separate surfaces (e.g. `env` vs `secrets`) to make “high risk” operations explicit.
