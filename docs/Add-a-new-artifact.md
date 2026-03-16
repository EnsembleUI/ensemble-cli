# How to Add a New Artifact Type to the Ensemble CLI

This doc explains what you need to change to add a new artifact type (e.g. jobs, flows) to the CLI so that it participates in **add, push, pull, manifests, and Firestore**.

The pipeline is now **registry-driven**, so most work is wiring a **DTO** and a **single config object**.

---

## 1. Define the DTO and Enum Entry (`core/dto.ts`)

**File:** `src/core/dto.ts`

Add an enum value to `EnsembleDocumentType`:

```ts
export enum EnsembleDocumentType {
  // ...
  Job = 'internal_job', // example
}
```

Add a DTO type for the artifact:

```ts
export type JobDTO = EnsembleLabeledDocument & {
  readonly type: EnsembleDocumentType.Job;
};
```

Expose it on `ApplicationDTO`:

```ts
export interface ApplicationDTO extends Omit<EnsembleDocument, 'type' | 'content'>, HasManifest {
  // ...
  readonly jobs?: JobDTO[]; // new
}
```

This is the **only DTO file you need to touch**.

---

## 2. Register the Artifact in the Central Registry (`core/artifacts.ts`)

**File:** `src/core/artifacts.ts`

This is the **single source of truth for artifact kinds**. Adding a new entry here wires most of the CLI automatically.

Confirm the new prop is in `ArtifactProps`:

```ts
export const ArtifactProps = [
  'screens',
  'widgets',
  'scripts',
  'actions',
  'translations',
  'theme',
  // 'jobs',          // add if you want it to be controlled via options
] as const;
```

Add a new `ArtifactConfig` entry to `ARTIFACT_CONFIGS_ARRAY`:

```ts
const ARTIFACT_CONFIGS_ARRAY: readonly ArtifactConfig[] = [
  // existing configs...
  {
    prop: 'jobs', // property on ApplicationDTO / CloudApp
    label: 'job', // singular label for logs/UI
    fsDir: 'jobs', // top-level directory name under project root
    fileExtension: '.yaml', // or '.js' / '.json' etc.
    firestoreCollection: 'internal_artifacts', // 'artifacts' or 'internal_artifacts'
    firestoreType: EnsembleDocumentType.Job, // Firestore type field value
  },
];
```

Once this is in place:

- `ArtifactProps` includes `'jobs'`
- `ARTIFACT_FS_CONFIG` has an entry for `'jobs'`
- `getArtifactConfig('jobs')` returns collection/type/FS info

### What this automatically wires

- Per-app options (`enabledByProp`) for **push/pull**
- Push diff gating in `computePushPlan`
- Pull diff + FS comparison in `computePullPlan`
- Firestore collection/type mapping when pushing YAML artifacts
- Collector behavior via `fsDir` and `fileExtension`

---

## 3. Make the Collector Understand the New Directory (`core/appCollector.ts`)

**File:** `src/core/appCollector.ts`

`collectAppFiles` already uses the registry for directory inclusion, but you still need:

## Extend `ParsedAppFiles`

```ts
export interface ParsedAppFiles {
  screens: Record<string, string>;
  scripts: Record<string, string>;
  widgets: Record<string, string>;
  actions: Record<string, string>;
  translations: Record<string, string>;
  jobs: Record<string, string>; // new
  theme?: string;
}
```

## Initialize It in `result`

```ts
const result: ParsedAppFiles = {
  screens: {},
  scripts: {},
  widgets: {},
  actions: {},
  translations: {},
  jobs: {}, // new
  theme: undefined,
};
```

## Teach the Walker About the `jobs` Directory

Top-level directory routing:

```ts
const [top, ...restParts] = relPath.split(path.sep);
// ...
if (top === 'jobs') {
  tasks.push({ kind: 'jobs', key: relativeWithinTop, fullPath });
  continue;
}
```

Update `FileTask` union:

```ts
type FileTask =
  | {
      kind: 'screens' | 'scripts' | 'widgets' | 'actions' | 'translations' | 'jobs';
      key: string;
      fullPath: string;
    }
  | { kind: 'theme'; fullPath: string };
```

Switch case:

```ts
switch (task.kind) {
  // ...
  case 'jobs':
    result.jobs[task.key] = content;
    break;
}
```

The **inclusion/exclusion of the `jobs` directory** is already driven via:

- `ARTIFACT_CONFIGS`
- `fsDirToProp`

---

## 4. Build Documents for the New Kind (`core/buildDocuments.ts`)

**File:** `src/core/buildDocuments.ts`

## Count Files in the Status Report

```ts
reportStatus('building', {
  // ...
  jobFileCount: Object.keys(parsed.jobs ?? {}).length,
});
```

## Map Parsed Files Into DTOs

```ts
const jobs: JobDTO[] = Object.entries(parsed.jobs ?? {}).map(([relativePath, content]) => ({
  id: pathToId(`jobs/${relativePath}`),
  name: pathToName(relativePath),
  content,
  type: EnsembleDocumentType.Job,
  createdAt: now,
  updatedAt: now,
}));
```

## Include in Validation Status

```ts
reportStatus('validating', {
  // ...
  jobCount: jobs.length,
});
```

## Attach to the `ApplicationDTO`

```ts
const application: ApplicationDTO = {
  id: appId,
  name: appName,
  createdAt: now,
  updatedAt: now,
  // ...
  ...(jobs.length > 0 && { jobs }),
};
```

### If the Artifact Is Stored in Firestore and Merged on Push

Update `buildMergedBundle` to merge the new list just like:

- widgets
- scripts
- actions

Include **ID generation** if they need `randomUUID` on first push.

---

## 5. Firestore Fetch / Push Behavior (`cloud/firestoreClient.ts`)

Most of the **collection + type wiring** is now via `getArtifactConfig`, so typically you only need:

## Update `CloudApp`

```ts
export type CloudApp = Pick<
  ApplicationDTO,
  | 'id'
  | 'name'
  | 'createdAt'
  | 'updatedAt'
  | 'widgets'
  | 'scripts'
  | 'actions'
  | 'screens'
  | 'theme'
  | 'translations'
  | 'jobs' // new
>;
```

When fetching Firestore documents, route `internal_job` into `jobs: JobDTO[]` (similar to `toActionDTO`, `toWidgetDTO`, etc.).

### No Changes Needed To

- `artifactCollectionAndType`
- `encodeYamlDocumentFields`
- `encodeUpdateFields`

These rely on the **registry + ArtifactProp**.

If the new artifact is a **YAML/cloud artifact** like screens/widgets/actions, most of the **push-path logic will “just work.”**

---

## 6. CLI Add Command (Optional but Recommended) (`commands/add.ts`)

**File:** `src/commands/add.ts`

If you want `ensemble add` to support the new type:

## Extend `AddKind`

```ts
export type AddKind = 'screen' | 'widget' | 'script' | 'action' | 'translation' | 'job';
```

## Add a Template Function

```ts
function jobTemplate(): string {
  return `Job:
  # your fields here
`;
}
```

## Add Interactive Choice

```ts
choices: [
  { title: 'Screen', value: 'screen' },
  { title: 'Widget', value: 'widget' },
  { title: 'Script', value: 'script' },
  { title: 'Action', value: 'action' },
  { title: 'Translation', value: 'translation' },
  { title: 'Job', value: 'job' },          // new
],
```

## Switch Case

```ts
case 'job':
  targetDir = path.join(projectRoot, 'jobs');
  fileName = `${name}.yaml`;
  contents = jobTemplate();
  updateManifest = false; // or true if you want it in .manifest
  break;
```

If you want `.manifest.json` entries:

- Extend `upsertManifestEntry` in `core/manifest.ts`
- Pass the right kind from `addCommand` when `updateManifest` is `true`.

---

## 7. Manifest Integration (Optional) (`core/manifest.ts`)

If the new artifact should be listed in `.manifest.json`:

## Extend `RootManifest`

```ts
export type RootManifest = Record<string, unknown> & {
  scripts?: { name: string }[];
  widgets?: { name: string }[];
  actions?: { name: string }[];
  jobs?: { name: string }[]; // optional
};
```

Update `buildManifestObject` to merge names from cloud into the manifest (similar to widgets/scripts/actions).

Update `upsertManifestEntry`:

- Add `'job'` to the kind union
- Update `listKeyByKind` mapping

This allows `addCommand` to register jobs in `.manifest.json`.

---

## 8. Tests to Update / Add

### DTO / Build Pipeline

`tests/core/buildDocuments.test.ts`

Ensure the new artifact is collected into `ApplicationDTO`.

---

### Diff / Sync

- `tests/core/sync.test.ts` – pull/push consistency scenarios
- `tests/core/bundleDiff.test.ts` – content normalization behavior

---

### Registry

`tests/core/artifacts.test.ts`

Verify:

- new prop exists
- config values are correct

---

### Commands

- `tests/commands/pushPull.test.ts` – integration coverage
- `tests/core/appCollector.test.ts` – ensure `collectAppFiles` sees the new directory

---

## Quick Mental Checklist

When adding a new artifact kind, verify:

### Data Model

- `EnsembleDocumentType`
- `XxxDTO`
- `ApplicationDTO` field

### Registry

- `ArtifactProps`
- `ARTIFACT_CONFIGS_ARRAY` entry with:
  - `prop`
  - `label`
  - `fsDir`
  - `fileExtension`
  - `firestoreCollection`
  - `firestoreType`

### Collector

- `ParsedAppFiles` field
- tasks
- switch case

### Builder

- `buildDocumentsFromParsed` creates DTOs
- DTOs attached to `ApplicationDTO`

### Cloud

- `CloudApp` includes the field
- Firestore fetch maps documents → DTOs

### Optional UX

- `addCommand`
- `.manifest.json` integration
- tests

---

✅ Once these are done, **`ensemble pull` / `ensemble push` will treat the new artifact exactly like existing YAML types** with minimal extra code.
