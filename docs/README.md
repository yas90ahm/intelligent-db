# Documentation

The README is the short version. These files hold the detail that is still useful for understanding or changing the project.

## Start here

| File | What it contains |
| --- | --- |
| [`../README.md`](../README.md) | project purpose, setup and current limits |
| [`ARCHITECTURE_ENGINE.md`](./ARCHITECTURE_ENGINE.md) | current engine design and module map |
| [`../CLAUDE.md`](../CLAUDE.md) | long technical record with exact known limits |
| [`../OPERATIONS.md`](../OPERATIONS.md) | daemon and MCP runbook |

## Benchmark material

| File | What it contains |
| --- | --- |
| [`ARCHITECTURE_BENCHMARKS.md`](./ARCHITECTURE_BENCHMARKS.md) | harness design, measurements and reproduction commands |
| [`INTEGRITY_AUDIT.md`](./INTEGRITY_AUDIT.md) | review of what the benchmark claims can support |
| [`RAW_SAMPLES.md`](./RAW_SAMPLES.md) | sample queries and model outputs from the poisoning runs |

The raw run directories are no longer committed. New benchmark output belongs in `.arbor/`, which is ignored. The harnesses remain under `src/__bench__/` so the results can be rerun.

## Specifications

- [`specs/`](./specs/) contains the accepted designs for retrieval, durability and daemon work.

Older launch notes and internal project-management files were removed from the working tree. They remain available in Git history.
