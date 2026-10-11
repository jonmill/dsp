# DSP Factory Planner

A personal, local-only web app for Dyson Sphere Program: no backend and no network calls at runtime.
Pick a target product, your unlocked techs, the items supplied from outside and a rate or building count.
It produces a production plan, a validated densely packed factory layout as a blueprint string, and the power it needs.
Game data is extracted statically from the installed game by a Python tool (`tools/extract/`) and committed as JSON in `data/`; there are no game mods.
The app lives in `app/` (Vite + Svelte 5 + TypeScript); game binaries, decompiled source and icons are never committed.

## Dev commands

Node 22 (see `.nvmrc`) and Python 3.11+. Run from the repository root.

App (`app/`):

```sh
cd app && npm install && npm test && npm run lint && npm run build
npm run dev     # dev server
npm run check   # svelte-check
```

Extractor (`tools/extract/`, package `dsp_extract`):

```sh
python3 -m venv tools/extract/.venv && tools/extract/.venv/bin/pip install -e 'tools/extract[dev]' && tools/extract/.venv/bin/pytest tools/extract
```

The `game` extra (`pip install -e 'tools/extract[game]'`) adds UnityPy and TypeTreeGeneratorAPI, which are only needed to run the extraction against a real game install.
