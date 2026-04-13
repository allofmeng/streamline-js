# Release Process

This repo uses a GitHub Action (`.github/workflows/release.yml`) that builds a
sanitised snapshot of the skin from a whitelist of paths. Two triggers:

## `dist` branch — tracks `main`

Every push to `main` force-pushes a clean copy of the whitelist to the `dist`
branch. This is the bleeding-edge dev channel. Downstream tools that want to
follow main without waiting for a release can point at:

```
github_branch: <owner>/streamline_project@dist
```

The `dist` branch is orphan and force-pushed on every main update, so it
never accumulates history.

## Tagged releases

Push a tag matching `v*` to cut a release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The action:

1. Stages the whitelist into `./dist/`
2. **Rewrites** `dist/skin-manifest.json` to set `version` to the tag name
   (with the leading `v` stripped — tag `v0.1.0` → version `0.1.0`). This
   means the git tag is the single source of truth for version and you do
   not have to bump `skin-manifest.json` manually before tagging.
3. Zips the staged whitelist as `streamline.js-v0.1.0.zip`
4. Publishes a GitHub Release with auto-generated notes

Downstream tools consume the release via:

```
github_release: <owner>/streamline_project
```

Note: the committed `skin-manifest.json` version is only rewritten inside
the release artifact — the file on disk in `main` is untouched. The `dist`
branch snapshot (for bleeding-edge dev) keeps the version as committed,
because tag-based auto-sync only runs on tag builds.

## Whitelist

Only these paths ship in the skin:

- `index.html`
- `skin-manifest.json`
- `src/` (contains `css/`, `modules/`, `profiles/`, `settings/`, `ui/`)

Anything else in the repo is **excluded by construction**, not by ignore
rules. This means future repo pollution (loose notes, AI agent configs,
experimental folders, etc.) cannot slip into releases without an explicit
change to the workflow.

To add a new top-level path, edit the `Stage whitelist into ./dist` step in
`.github/workflows/release.yml`.

## Validation

The workflow enforces two invariants before publishing:

1. `dist/skin-manifest.json` exists and declares `id == "streamline.js"` and
   a non-empty `version` field.
2. No file in `dist/` has a Win32-reserved character (`< > : " | ? *`) in its
   name. Windows `CreateFile` rejects these with `ERROR_INVALID_NAME`, and
   any such file would crash skin installation on Windows.

A failure on either check stops the release cleanly.
