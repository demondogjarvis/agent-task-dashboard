# Agent Task Dashboard

A local-first browser prototype for managing agent work with staged approvals.

## What it includes

- Kanban lanes from intake through done
- Approval gate before agents can claim work
- Live agent cards with status and current task
- Token usage panel per agent
- Activity log for orchestration events
- Auto-claim simulation for approved tasks
- Local persistence via browser localStorage

## Open it

Option 1, simple:
- Open `index.html` directly in your browser

Option 2, recommended:
- Serve the folder locally and open `http://127.0.0.1:4311`

Example:

```bash
cd agent-task-dashboard
python3 -m http.server 4311
```

## Notes

This is a prototype control surface, not yet wired into live OpenClaw sessions or task assignment APIs.
The next step would be connecting it to real task state, agent sessions, token telemetry, and approval actions.
