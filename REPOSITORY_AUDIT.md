# Repository audit

Audit date: 17 July 2026  
Repository: `yas90ahm/intelligent-db`  
Audited branch: `repo-cleanup`  
Default branch: `main`  
Audit scope: documentation and recommendations only. No files were deleted, moved or rewritten.

## 1. Repository summary

intelligent-db is a TypeScript memory system for AI agents. It stores the source of each fact, recalls related facts through a graph, handles contradictions, persists to SQLite and exposes both an MCP server and an optional shared daemon. The project also contains a large benchmark and red-team record.

The repository is active but still an unpublished `0.0.0` package. It has substantial code and validation for an early prototype. Its main maintenance risks are a few very large source files, a large volume of committed experiment output, stale “canonical” documentation and a failing default-branch test caused by a shutdown race.

## 2. Current structure

The repository contains 463 tracked files.

| Path | Purpose | Assessment |
| --- | --- | --- |
| `src/` | Runtime, examples, tests, E2E, torture tests and benchmark harnesses | Core, but runtime and validation are crowded together |
| `.arbor/sessions/` | Committed benchmark runs, transcripts, reports and checkpoints | Useful evidence, but too much generated state is in the source tree |
| `docs/` | Architecture, benchmarks, launch records, product, process, specs and history | Thorough but overlapping and partly stale |
| `figures/` | Benchmark figures and generator | Retain if figures remain cited |
| `scripts/` | Demo, changelog and benchmark helpers | Retain |
| `.github/` | CI, release workflow and contribution templates | Retain; CI currently fails one test |
| Root docs | README, operations, security, changelog, agent instructions and large status reports | Mixed current reference and historical narrative |

The largest maintenance hotspots are `src/api.ts` (about 3,778 lines), `src/ratification/pendingLedger.ts` (about 1,806 lines) and `src/daemon/server.ts` (about 1,536 lines). `CLAUDE.md` and `BENCH_RERUN_2026-07-06.md` are each larger than 100 KB.

## 3. Identified projects

This repository contains one package with four major surfaces:

1. The in-process memory library and SQLite persistence.
2. An MCP server for agent-tool integration.
3. An optional socket/pipe daemon and remote client.
4. A large benchmark, adversarial-test and research-evidence program.

The cross-database adapters and external model/database packages are development dependencies used for comparison. The shipped runtime declares no external runtime dependencies.

## 4. Build and test status

| Check | Status | Evidence |
| --- | --- | --- |
| TypeScript | Pass in latest CI | `npm run typecheck` completed before the test failure |
| Tests | Fail | 894 passed, 44 skipped and 1 failed in run `28993238344` |
| Failure | Shutdown race | `src/daemon/__e2e__/adversarial.e2e.test.ts:277` observed a successful authentication after shutdown had begun |
| Build | Not reached in the failed job | The workflow stopped after tests |
| Dependency audit | Needs review | CI installation reported three moderate, one high and one critical vulnerability |
| Local rerun | Not performed | Dependencies were not installed in the audit clone; the clean GitHub runner gives the current failure evidence |

The failure may be timing-sensitive, but it tests a security-relevant boundary: whether a new connection can finish authentication while the daemon is draining. It should not be dismissed as flaky without reproducing and understanding the race.

## 5. Documentation problems

### The canonical status contradicts itself and current code

`CLAUDE.md` says the `RECONCILE_DRIFT` finding remains documented and unfixed, later marks it closed, and later refers to it again as present. The torture-test allowlist is empty in code, while a CI comment still describes the issue as allowlisted. The same document points to a compile-time assertion in `src/daemon/client.ts` that the code says was removed and replaced by a real binding check elsewhere.

Recommended action: replace the opening status wall with a short dated status summary linked to specific current tests and known limits. Keep older findings in dated reports.

### Release documentation is obsolete

`docs/project-management/RELEASE_PROCESS.md` treats schema migration as missing even though a migration ladder now ships. It prescribes `master` as trunk, then later acknowledges the rename to `main`. `docs/project-management/GOVERNANCE.md` also tells contributors to target `master`.

Recommended action: rewrite both around the current `main` branch, unpublished package state and actual migration behavior.

### Launch documents still read as live instructions

Several files under `docs/launch/` say no remote exists, the work is uncommitted or the branch still needs renaming. They are valuable as a build record but are not current operations.

Recommended action: label the whole folder as dated history or move it under `docs/history/launch-2026-07/`.

### The README is hard to enter

The README leads with dense internal language—memory substrate, priced identity, hard theorem, corroboration and attack numbers—before a reader sees the simplest working example. The evidence matters, but the order makes the project sound like a proof of importance before it explains the tool.

Recommended action: lead with a plain description, a 60-second example and current maturity. Put the argument and benchmark detail behind links.

### Voice and claim calibration

Phrases such as “hard theorem,” “moat,” “money artifact” and “production-grade single-process prototype” sound larger than the present release state or are internally contradictory. The benchmark disclosures are a strong part of the project and should stay. The copy will be more credible if it says “design constraint,” “measured result” and “research/engineering prototype with durability work” unless formal proof or production operations support a stronger term.

Proposed repository description, for review only:

> A memory system for AI agents that tracks where information came from and resists coordinated false inputs.

## 6. Organization problems

1. Runtime, unit tests, E2E tests, torture tests and benchmark harnesses all live under `src/`.
2. Committed benchmark evidence mixes final reports, raw transcripts and resumable partial checkpoints.
3. Three runtime files are large enough that small changes carry broad review risk.
4. Current reference, launch history, marketing language and research narrative overlap.
5. The package has a release workflow but remains private and version `0.0.0`, so a release tag would predictably fail.
6. There is no lint or formatting contract.

## 7. Security or secret concerns

No tracked live credential, private key, `.env` file or common provider token was found. `NPM_TOKEN` appears only as a GitHub Actions secret reference. The public maintainer email in package metadata and `SECURITY.md` is an intentional privacy choice.

Security-relevant audit items:

- The current failed test concerns authentication during daemon shutdown. Resolve it before calling the daemon boundary stable.
- CI reported one critical and one high dependency vulnerability. Identify whether they are reachable development-only adapters or affect shipped tooling, then pin or replace deliberately.
- The release workflow references a publishing token. Keep the package private and the publish path gated until a real version and release decision exist.
- The committed benchmark corpus includes data from multiple external systems. Keep licenses and dataset terms documented with the results.

## 8. Safe cleanup candidates

No source file is approved for deletion in this audit.

### Candidate: one of the duplicate confidence-interval reports

- **Exact paths:** `.arbor/sessions/verification/confidence_intervals.md` and `src/__bench__/reports/confidence_intervals.md`.
- **Contents:** Byte-identical generated Wilson confidence-interval tables.
- **Why one copy may be unnecessary:** Both contain the same measured output.
- **Evidence:** SHA-256 comparison found exact equality.
- **References:** `src/__bench__/VERIFICATION.md` points to the `.arbor` copy; `docs/ARCHITECTURE_BENCHMARKS.md` points to both forms in different places.
- **Risk:** Low to medium. Deleting either copy without updating links will break documentation.
- **Recommended action:** Choose one canonical generated-result location, update all links, then delete the other only after approval and a link check.

### Candidate: local `node_modules/` and `dist/`

- **Exact paths:** `node_modules/` and `dist/` when present locally.
- **Contents:** Installed dependencies and compiled JavaScript/declarations.
- **Why they are unnecessary:** They are regenerated by `npm ci` and `npm run build`.
- **Evidence:** Both paths are ignored and no tracked copies were found.
- **References:** Tooling uses them locally; source and package metadata define how to recreate them.
- **Risk:** Very low; reinstall or rebuild is required afterward.
- **Recommended action:** Keep ignored and remove locally only for a clean environment or disk space. Never commit them.

## 9. Uncertain cleanup candidates

No deletion is approved or performed.

### Candidate group: raw and partial `.arbor/sessions/` outputs

- **Exact paths:** Files ending in `*.partial.json`, raw transcript JSON/JSONL files and per-experiment working results below `.arbor/sessions/`.
- **Contents:** Generated benchmark transcripts, checkpoints, metrics and experiment notes; 111 tracked files total in the published session set.
- **Why they may be unnecessary in source history:** Large generated runs obscure code changes and can live as release artifacts.
- **Evidence:** The directory is mostly ignored except for explicitly published benchmark sessions; some transcripts exceed 1 MB in total.
- **References:** Several reports cite exact checkpoint/result paths, so the set cannot be removed wholesale.
- **Risk:** High. Deletion could make published numbers irreproducible or break documentation.
- **Recommended action:** Build a manifest for each run, identify every cited input and final result, then retain final evidence in `benchmarks/results/` and move uncited raw/resumable output to an artifact store. Review each deletion path individually.

### Candidate group: `docs/launch/`

- **Exact paths:** All eight Markdown files under `docs/launch/`.
- **Contents:** Design, review, remediation and write-up records from the crypto-free rebuild and launch preparation.
- **Why they may be unnecessary as current docs:** They contain outdated branch, remote and completion statements.
- **Evidence:** Some say the work is uncommitted, no remote exists or `master` still needs renaming.
- **References:** The documentation index links to them; they contain useful design and review history.
- **Risk:** Medium to high.
- **Recommended action:** Retain and move under dated history with clear banners. Do not delete.

### Candidate group: monolithic source files

- **Exact paths:** `src/api.ts`, `src/ratification/pendingLedger.ts`, `src/daemon/server.ts`.
- **Contents:** Core public API, ratification ledger and daemon behavior.
- **Why cleanup is considered:** Their size mixes many responsibilities and makes review difficult.
- **Evidence:** Approximately 3,778, 1,806 and 1,536 lines respectively.
- **References:** Widely imported core runtime code.
- **Risk:** High.
- **Recommended action:** Never delete. Extract responsibilities mechanically behind unchanged exports, one area at a time, with the full test suite green.

## 10. Files that should be retained

- All current runtime source and public exports.
- Unit, E2E and torture suites, including the legacy SQLite migration fixture.
- Benchmark harnesses and the minimum complete evidence needed to reproduce published claims.
- `package-lock.json`, Node-version files and TypeScript/Vitest configurations.
- `OPERATIONS.md`, `SECURITY.md`, contribution and community files.
- Architecture and specification documents that match current code.
- Dated benchmark reports, even when they record poor results; honest negative results are part of the evidence.

## 11. Recommended target structure

```text
intelligent-db/
├── src/                     # shipped runtime
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── torture/
├── benchmarks/
│   ├── harness/
│   └── results/<run-id>/
│       ├── manifest.json
│       ├── metrics.json
│       └── report.md
├── docs/
│   ├── architecture/
│   ├── operations/
│   ├── product/
│   ├── security/
│   ├── decisions/
│   └── history/
├── figures/
├── scripts/
├── .github/workflows/
├── README.md
├── OPERATIONS.md
├── SECURITY.md
└── package.json
```

## 12. Proposed implementation stages

### Stage 1: correctness and current status — high priority

1. Reproduce and resolve the daemon shutdown/authentication race.
2. Triage the reported dependency vulnerabilities.
3. Correct the contradictory `RECONCILE_DRIFT`, compile-time assertion, branch and migration statements.
4. Keep the default branch red until the test is understood; do not mask it.

### Stage 2: public explanation — low risk

1. Rewrite the README opening in plain language.
2. Put maturity and known limits near the top.
3. Move benchmark depth behind clear links while keeping the evidence intact.
4. Remove “hard theorem,” “moat,” “money artifact” and conflicting “production-grade prototype” language from current operational docs.

### Stage 3: evidence organization — medium to high risk

1. Define a manifest for every published benchmark run.
2. Canonicalize duplicate outputs and update links.
3. Separate final/cited evidence from raw transcripts and resumable checkpoints.
4. Move only approved uncited artifacts outside source history.

### Stage 4: source maintenance — high risk

1. Extract the three largest runtime files in small, test-preserving changes.
2. Separate runtime, tests and benchmarks without changing public exports.
3. Add lint and formatting in an isolated change after agreeing on a baseline.

### Stage 5: release decision

1. Decide whether this is ready for an initial `0.1.0` package.
2. Gate the release job until `private`, version, package contents and token handling are deliberately approved.
3. Run typecheck, all tests, build and package-content inspection before a tag.

Human review is required before any deletion, file move, benchmark relocation, source split or public metadata change.
