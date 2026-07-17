# Release process

There has not been a public package release yet. The repository is connected to GitHub,
the default branch is `main`, and `package.json` still has version `0.0.0` with
`"private": true`.

That is deliberate. A tag should not turn an experiment into a public package by
accident.

## Before the first release

1. Decide that the package is ready to be public.
2. Read the current known limitations in `CLAUDE.md` and the latest CI results. Old
   launch-prep reports under `docs/history/launch-2026-07/` are history, not a release
   checklist.
3. Run `npm run typecheck`, `npm test` and `npm run build` on the exact commit being
   released. Both Node 22 and Node 24 are covered in CI.
4. Confirm that `dist/mcp/server.js` and `dist/daemon/cli.js` exist after the build.
5. Add a `CHANGELOG.md`, choose the first public version and update `package.json`.
6. Remove `"private": true` only when publication is intended.
7. Add the `NPM_TOKEN` repository secret, then create and push a matching tag such as
   `v0.1.0`.

The tag workflow checks that the tag and package version agree, reruns verification,
publishes with provenance and creates the GitHub release. It fails closed while the
package remains private or the token is absent.

## Versioning

Use SemVer. Before 1.0, reserve patch releases for fixes and use a minor version when the
public API or behaviour changes. Call breaking changes out in the changelog even though
SemVer permits them in a `0.x` minor release.

The public API includes the exported verbs, daemon and MCP behaviour, and persisted data.
The SQLite store has a forward-only migration ladder in `src/store/migrations.ts`,
currently through schema version 2. Any stored-shape change needs a new migration rung.
Do not edit an old rung after it has shipped, and do not release code that opens a newer
schema without a deliberate migration.

## Branches and tags

`main` is the trunk. Keep it green. Use short feature or fix branches and merge through a
pull request. Release tags are cut from `main`; there is no need for a separate release
branch at the current size of the project.

The CI workflow still listens to `master` as well as `main` for old references. New work
and new documentation should say `main`.
