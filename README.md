# Agent Task Dashboard

A local browser app for managing staged agent work with real OpenClaw-backed runs.

## What it does now

- Enforces definition and approval before assignment
- Seeds and manages isolated OpenClaw agents for frontend, backend, QA, ops, automation, and product work
- Launches real OpenClaw-backed runs when a ready task is assigned
- Tracks active process runs in the dashboard
- Surfaces live session telemetry and token usage
- Moves completed agent runs into review for human signoff

## Run it

```bash
cd agent-task-dashboard
node server.mjs
```

Then open:

- `http://127.0.0.1:4311`

## State and local data

- `data/state.json` is intentionally gitignored
- On first run, the app creates a local seed state automatically
- `agent-workspaces/` is also ignored so runtime-created workspaces stay local

## Notes

- This uses the local OpenClaw CLI and your configured model provider.
- Assigning a task to an agent triggers a real model-backed run and will consume tokens.
- This public repo is a cleaned standalone version, without my live workspace task data.
