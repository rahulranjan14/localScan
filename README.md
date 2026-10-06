# agentic-ocr

A local-first document intelligence application. PDF in, validated typed JSON out.

Runs on your own machine. No cloud account required, no data leaves the network
in the default configuration.

> **Status: under construction.** This README describes only what is actually
> built. Planned work lives in [`docs/PRD.md`](docs/PRD.md) and
> [`docs/FRD.md`](docs/FRD.md); decisions are logged in
> [`docs/DECISIONS.md`](docs/DECISIONS.md) as they are made.

---

## What it does

Nothing yet — the repository is being built in phases. See the PRD for the
intended product and the FRD for the functional specification.

## Documentation

| Document | Purpose |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | Product requirements — what is being built, and why |
| [`docs/FRD.md`](docs/FRD.md) | Functional requirements — how each feature behaves |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Append-only log of technical decisions and their reasoning |
| [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) | Measured extraction accuracy, including negative results |

## Development process

Work proceeds in phases. Every feature is developed on its own branch and merged
into `main` with `--no-ff`, so the branch structure stays visible in the history.
Documentation is updated in the same branch as the feature it describes.

## Licence

Not yet determined.
