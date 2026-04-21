# Agent Task Dashboard

A local browser app for managing staged agent work with real OpenClaw-backed runs.

## What it does now

- Persists board state in `data/state.json`
- Enforces definition and approval before assignment
- Seeds and manages isolated OpenClaw agents for frontend, backend, QA, ops, automation, and product work
- Launches real `openclaw agent --agent <id>` runs when a ready task is assigned
- Tracks active process runs in the dashboard
- Surfaces live OpenClaw session telemetry and token usage
- Moves completed agent runs into review for human signoff

## Run it

```bash
cd agent-task-dashboard
node server.mjs
```

Then open:

- `http://127.0.0.1:4311`

## Notes

- This uses the local OpenClaw CLI and your configured model provider.
- Assigning a task to an agent triggers a real model-backed run and will consume tokens.
- The current implementation tracks launched runs through the local dashboard server process.
