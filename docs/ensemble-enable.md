# `ensemble enable`

Enable optional capabilities (camera, maps, notifications, etc.) in an Ensemble Flutter starter project.

The CLI does **not** vendor module scripts. It downloads tooling from [EnsembleUI/ensemble](https://github.com/EnsembleUI/ensemble) at runtime, caches it locally, and runs Dart scripts against the user’s project.

---

## Command surface

```bash
ensemble enable [modules...] [key=value...]
  --project <path>    # starter root (default: auto-detect from cwd)
  --verbose           # print dart command lines
```

- **Interactive** (TTY): cached runtime `selectModules` + `checkAndAskForMissingArgs`.
- **Direct**: `ensemble enable camera platform=ios cameraDescription=... ensemble_version=1.2.44`
- Does **not** require `ensemble login`.

---

## Architecture

```
enable.ts
  ├── starterProject.ts     cwd or --project must be starter root (no walk-up)
  ├── modulesCache.ts       fetch/cache tooling from GitHub releases
  ├── enableRuntime.ts      jiti-load registry data; prompts use cached param definitions
  └── moduleRunner.ts       fvm dart run <cached-script> cwd=user project
        └── gitProjectChanges.ts   list Modified files (git snapshot diff)
```

| Module             | Role                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `modulesCache.ts`  | Resolve latest **stable** GitHub release; cache under `~/.ensemble/cache/modules_dir/<tag>/`             |
| `enableRuntime.ts` | jiti-load `modules_scripts.ts` + `utility_scripts.ts`; prompts via CLI `prompts` using cached param defs |
| `moduleRunner.ts`  | Runs scripts sequentially; partial success on batch failure                                              |
| `dartToolchain.ts` | `fvm dart` when `.fvmrc` / `.fvm/fvm_config.json` exists, else `dart`                                    |

**Not duplicated in CLI:** module list, parameter keys, prompt text, `commonParameters` — all from cached Ensemble `src/`.

---

## Module tooling cache

**Path:** `~/.ensemble/cache/modules_dir/`

```
modules_dir/
  .ref                    # last successfully cached release tag
  ensemble-v1.2.44/       # example tag — not hardcoded
    src/*
    scripts/*
```

**On each run:**

1. `GET /repos/EnsembleUI/ensemble/releases/latest` (15s timeout)
2. If cached tag matches latest and registry exists → **no download**
3. If tag differs or cache missing → download tarball, extract `starter/` subset, update `.ref`, delete previous tag dir
4. Offline / fetch failure → use cached release if present (warn user)

**Not cached in CLI repo** — only downloaded at runtime.

---

## Script execution

```bash
fvm dart run <abs-path-to-cached-script> key=value key=value ...
# cwd: user starter project root
```

Args are `key=value` only (no `--flags`). Each script receives only keys declared in its registry entry plus `commonParameters` from cached `utility_scripts.ts`.

---

## Modified files

If the project root has a `.git` directory, the CLI snapshots tracked + untracked files (SHA-256) before/after each script and prints a deduped **Modified** list.

- No `.git` in project root → Modified section omitted (known limitation for monorepo nested starters).
- `pubspec.yaml` in Modified → suggests `flutter pub get`.

---

## Important distinctions

| Term               | Meaning                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `ensemble_version` | Flutter **package** git ref in pubspec (e.g. `1.2.44`) — prompted / passed by user           |
| Cache release tag  | GitHub **release** tag for module tooling (e.g. `ensemble-v1.2.44`) — resolved automatically |
| Starter project    | User’s Flutter app being modified                                                            |
| Module tooling     | Downloaded `starter/src` + `starter/scripts` from ensemble repo                              |

---

## Testing

```bash
npm test
npm run build
node dist/index.js enable camera --project ./my-app platform=ios ...
```

Fixtures: `tests/fixtures/starter-cache/` (minimal cached `src/` tree for `enableRuntime` tests).

---

## Known limitations

- Older starters may lack placeholders in `lib/generated/ensemble_modules.dart` → `Pattern not found` from Dart scripts.
- Re-enabling an already-enabled module often fails (expected).
- Batch enable stops at first failure but reports prior successes.
- Global `checkForUpdates()` runs on every CLI invocation; use `ENSEMBLE_NO_UPDATE_CHECK=1` to skip.

---

## Related

- Issue: [ensemble-cli#3](https://github.com/EnsembleUI/ensemble-cli/issues/3)
