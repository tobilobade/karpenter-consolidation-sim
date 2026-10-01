# Karpenter Consolidation Simulator

See how Karpenter v1 consolidation settings behave over time. Pick a scenario, tweak two NodePool configs (A vs B), and compare cost, node count, evictions and the decision log side by side.

**Run it:** open `index.html` in a browser. No build step or dependencies; it can be hosted as static files (e.g. GitHub Pages). The "Copy share link" button encodes the full setup in the URL.

## What you can change

- **Workloads:** requests, replica pattern (steady, daily cycle, spikes, step change), PDB, `karpenter.sh/do-not-disrupt`, and whether a workload runs in A, B or both (for "what if I add this PDB?" comparisons).
- **NodePool:** `consolidationPolicy`, `consolidateAfter`, disruption budgets (percent/count, reasons, daily schedule windows), instance families and sizes.
- **kube-scheduler scoring:** LeastAllocated (default) vs MostAllocated.

New to the terms? Click **Glossary** (or any **?** next to a setting) for plain-language explanations.

## Presets

| Scenario | Lesson |
|---|---|
| Daily traffic cycle | `WhenEmpty` rarely frees nodes once pods are spread out |
| Spiky load | `consolidateAfter: 0s` churns between bursts |
| Business-hours budget freeze | Scheduled `nodes: "0"` budgets delay savings |
| Big scale-down | Budget % controls how fast stranded capacity is removed |
| Blockers | do-not-disrupt pods and strict PDBs pin nodes, so cost stays high |

## Model

`engine.js` is a pure-JS discrete-time model with 10s ticks. It covers Emptiness, then multi-node consolidation, then single-node consolidation, with 15s validation, budgets, PDB/do-not-disrupt blockers, replace-before-drain, Karpenter-style bin-packing, and EKS allocatable math. The UI's "How the model works" section lists all assumptions and what isn't modelled (spot, drift, affinity/topology, limits, priority).

It's for building intuition, not predicting exact numbers. Validate important scenarios against real Karpenter on the [KWOK provider](https://github.com/kubernetes-sigs/karpenter/tree/main/kwok).

## Tests

```sh
./test.sh   # uses Node if installed, otherwise macOS's built-in JavaScriptCore
```

## Files

- `engine.js`: simulation (no DOM)
- `presets.js`: scenarios
- `glossary.js`: plain-language term explanations
- `charts.js`: SVG line charts + node timeline
- `app.js`: UI and state
- `index.html`, `styles.css`
