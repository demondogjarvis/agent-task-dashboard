# Agent Task Dashboard

A local browser app for managing staged agent work with real OpenClaw-backed runs.

## What it does now

- Persists board state in `data/state.json`
- Persists durable run history in `data/run-history.sqlite`
- Enforces definition and approval before assignment
- Seeds and manages isolated OpenClaw agents for frontend, backend, QA, ops, automation, and product work
- Launches real `openclaw agent --agent <id>` runs when a ready task is assigned
- Tracks active process runs in the dashboard
- Captures run records, lifecycle events, stdout and stderr chunks, summaries, usage metadata, timing, and failure details
- Surfaces live OpenClaw session telemetry and token usage
- Moves completed agent runs into review for human signoff
- Exposes a minimal history view for inspecting past runs and failures

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
- The board itself still uses `data/state.json` for task state. Run logging is additive and stored separately in SQLite.
- Run logging is written locally to `data/run-history.sqlite` using plain SQLite via Node's built-in `node:sqlite` module.
- Current API surfaces include `/api/dashboard`, `/api/runs`, `/api/runs/:id`, and `/api/tasks/:id/runs`.
- Existing task state is preserved. Historical runs that happened before the SQLite logger was added are not backfilled automatically.

## Quick validation

```bash
cd agent-task-dashboard
node --check server.mjs
node --check app.js
node --check db.mjs
node --check scripts/smoke-logging.mjs
node scripts/smoke-logging.mjs
node server.mjs
```

The smoke check starts the dashboard on port `4312`, verifies `/api/dashboard` and `/api/runs`, and confirms the SQLite logging tables exist.

Then open `http://127.0.0.1:4311`, assign a Ready task, and verify:

- the task still moves through Ready → In Progress → Review or back to Ready on failure
- the History view shows a durable run record
- task details show the latest run plus run history
- `data/run-history.sqlite` is created and grows with each run
