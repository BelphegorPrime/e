---
name: e2e-trace
description: Trace real `e` commands end to end in a disposable sandbox (built CLI, containers, scripted or live model, git, TUIs driven by keys) to prove a feature works. Use when asked to test, verify, try out or reproduce an `e` feature or bug for real, beyond unit tests.
---

Reference: `docs/agents/e2e.md` (sandbox layout, stub script format, trace files, gotchas). Read it before step 2.

1. **Pin the claim.** Write down what "works" means as observables in a trace: exit code, containers that must run and be removed, model turns served, files in the run branch's diff, refs on origin, no leaks. Done when every claim maps to a trace file.
2. **Sandbox.** `node scripts/e2e/e2e.mjs new <name>` (stub model; `--model live` only when real model behaviour is the point). Reuse a sandbox across steps that build on each other (spawn, then resume).
3. **Script the model.** One turn per harness action, tagged with a `task` token from the run's prompt whenever several conversations share the stub. Save reusable ones under `scripts/e2e/scenarios/`.
4. **Run traced.** `node scripts/e2e/e2e.mjs run <name> --script <f> -- <e args>`; an interactive command adds `--tui <keys.json>`. Long runs: `run_in_background`, follow `steps/NN-*/combined.log`.
5. **Verify every claim** from step 1 against the trace, reading the files the claim names, not only `summary.md`. A claim is green only with the line that proves it.
6. **Report** per claim: green or red, with the trace path and the proving line. A red caused by `e` itself is a finding; one caused by the script or sandbox gets fixed and rerun.
7. **Clean** with `node scripts/e2e/e2e.mjs clean <name>` unless the user wants to inspect it.
