import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunLogger } from './db.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 4311);
const HOST = process.env.HOST || '127.0.0.1';
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const DATA_DIR = path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const RUNS_DB_PATH = path.join(DATA_DIR, 'run-history.sqlite');
const ROOT_WORKSPACE = path.resolve(__dirname, '..');
const AGENT_WORKSPACES_DIR = path.join(__dirname, 'agent-workspaces');

const laneOrder = ['intake', 'definition', 'approval', 'ready', 'inprogress', 'review', 'done'];
const lanes = [
  { id: 'intake', title: 'Intake' },
  { id: 'definition', title: 'Definition' },
  { id: 'approval', title: 'Awaiting Approval' },
  { id: 'ready', title: 'Ready for Agents' },
  { id: 'inprogress', title: 'In Progress' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' },
];

const priorityRank = { critical: 4, high: 3, medium: 2, low: 1 };

const agentCatalog = [
  {
    id: 'atlas',
    name: 'Atlas',
    emoji: '🎨',
    specialty: 'frontend',
    capability: 'UI systems, interaction design, and polished operator dashboards.',
  },
  {
    id: 'meridian',
    name: 'Meridian',
    emoji: '🧠',
    specialty: 'backend',
    capability: 'Services, APIs, data flows, and systems-level problem solving.',
  },
  {
    id: 'sentinel',
    name: 'Sentinel',
    emoji: '🛡️',
    specialty: 'qa',
    capability: 'Regression checks, validation plans, and release safety review.',
  },
  {
    id: 'pulse',
    name: 'Pulse',
    emoji: '⚙️',
    specialty: 'ops',
    capability: 'Runtime health, deployments, observability, and operational hardening.',
  },
  {
    id: 'vector',
    name: 'Vector',
    emoji: '🧭',
    specialty: 'automation',
    capability: 'Workflow automation, routing logic, and agent orchestration.',
  },
  {
    id: 'north',
    name: 'North',
    emoji: '📐',
    specialty: 'product',
    capability: 'Scope clarity, definition quality, and operational planning.',
  },
];

const projectCatalog = [
  'Agent Control',
  'Northstar Finance',
  'Atlas Rollout',
  'Launch Ops',
  'Internal Tools',
  'Internal',
  'Unassigned stream',
];

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const activeRuns = new Map();
let state = await loadOrCreateState();
const runLogger = createRunLogger({ dbPath: RUNS_DB_PATH });
let telemetryCache = {
  configuredAgents: [],
  sessions: [],
  backgroundTasks: [],
  updatedAt: 0,
};
let refreshTelemetryPromise = null;

await ensureDirectory(DATA_DIR);
await ensureDirectory(AGENT_WORKSPACES_DIR);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, {
      error: 'server_error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Jarvis dashboard listening on http://${HOST}:${PORT}`);
  refreshTelemetry().catch((error) => {
    console.error('Telemetry bootstrap failed:', error);
  });
  setInterval(() => {
    refreshTelemetry().catch(() => {});
  }, 5000);
});

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    const dashboard = await buildDashboardPayload();
    sendJson(res, 200, dashboard);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/runs') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 80)));
    sendJson(res, 200, { runs: runLogger.getRecentRuns(limit) });
    return;
  }

  const runRoute = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (req.method === 'GET' && runRoute) {
    const run = runLogger.getRun(runRoute[1], { logLimit: 800 });
    if (!run) {
      sendJson(res, 404, { error: 'not_found', message: 'Run not found.' });
      return;
    }
    sendJson(res, 200, { run });
    return;
  }

  const taskRunsRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/runs$/);
  if (req.method === 'GET' && taskRunsRoute) {
    const task = state.tasks.find((item) => item.id === taskRunsRoute[1]);
    if (!task) {
      sendJson(res, 404, { error: 'not_found', message: 'Task not found.' });
      return;
    }
    sendJson(res, 200, { runs: runLogger.getTaskRuns(task.id, 20) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const body = await readJsonBody(req);
    const title = String(body.title || '').trim();
    if (!title) {
      sendJson(res, 400, { error: 'validation', message: 'Task title is required.' });
      return;
    }

    const preferredAgent = agentCatalog.find((agent) => agent.id === String(body.agentId || '').trim()) || null;

    const task = {
      id: nextId('task'),
      title,
      notes: String(body.notes || '').trim(),
      priority: sanitizePriority(body.priority),
      skill: preferredAgent ? preferredAgent.specialty : sanitizeSkill(body.skill),
      preferredAgentId: preferredAgent?.id || null,
      owner: String(body.owner || '').trim() || 'Unassigned stream',
      lane: 'definition',
      assignedAgentId: null,
      runStatus: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastRun: null,
      comments: [],
    };

    state.tasks.unshift(task);
    pushActivity(`New task created in Definition: ${task.title}.`, 'info');
    await persistState();
    sendJson(res, 201, { ok: true, task });
    return;
  }

  const taskRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(approve|move|assign|reassign|update|comment|delete)$/);
  if (!taskRoute) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  const [, taskId, action] = taskRoute;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    sendJson(res, 404, { error: 'not_found', message: 'Task not found.' });
    return;
  }

  if (action === 'approve') {
    if (task.lane !== 'approval') {
      sendJson(res, 400, { error: 'invalid_state', message: 'Only approval-lane tasks can be approved.' });
      return;
    }
    task.lane = 'ready';
    task.updatedAt = Date.now();
    pushActivity(`${task.title} approved. Agents may now claim it.`, 'info');
    await persistState();
    sendJson(res, 200, { ok: true, task });
    return;
  }

  if (action === 'move') {
    const body = await readJsonBody(req);
    const direction = Number(body.direction || 0);
    if (!Number.isInteger(direction) || ![-1, 1].includes(direction)) {
      sendJson(res, 400, { error: 'validation', message: 'direction must be -1 or 1.' });
      return;
    }
    const moved = moveTask(task, direction);
    if (!moved.ok) {
      sendJson(res, 400, { error: 'invalid_state', message: moved.message });
      return;
    }
    await persistState();
    sendJson(res, 200, { ok: true, task });
    return;
  }

  if (action === 'assign') {
    const body = await readJsonBody(req);
    if (task.lane !== 'ready') {
      sendJson(res, 400, { error: 'invalid_state', message: 'Only Ready for Agents tasks can be assigned.' });
      return;
    }
    const agent = pickAgentForTask(task, body.agentId ? String(body.agentId) : null);
    if (!agent) {
      sendJson(res, 400, { error: 'no_agent', message: 'No suitable idle agent is available.' });
      return;
    }
    if (activeRuns.has(task.id)) {
      sendJson(res, 409, { error: 'already_running', message: 'This task already has an active run.' });
      return;
    }
    await launchTaskRun(task, agent);
    sendJson(res, 202, { ok: true, taskId: task.id, agentId: agent.id });
    return;
  }

  if (action === 'reassign') {
    const body = await readJsonBody(req);
    const requestedAgentId = String(body.agentId || '').trim();
    const agent = agentCatalog.find((item) => item.id === requestedAgentId) || null;

    if (!agent) {
      sendJson(res, 400, { error: 'validation', message: 'A valid agentId is required to reassign a task.' });
      return;
    }

    if (activeRuns.has(task.id) || task.runStatus === 'running') {
      sendJson(res, 400, { error: 'invalid_state', message: 'Running tasks cannot be reassigned yet. Stop or let the run finish first.' });
      return;
    }

    if (task.lane === 'done') {
      sendJson(res, 400, { error: 'invalid_state', message: 'Completed tasks cannot be reassigned.' });
      return;
    }

    const previousAgent = agentCatalog.find(
      (item) => item.id === (task.assignedAgentId || task.preferredAgentId || '')
    ) || null;

    task.preferredAgentId = agent.id;
    task.updatedAt = Date.now();

    if (['ready', 'inprogress', 'review'].includes(task.lane)) {
      task.lane = 'ready';
      task.assignedAgentId = null;
      task.runStatus = 'idle';
    }

    pushActivity(
      `${task.title} reassigned${previousAgent ? ` from ${previousAgent.name}` : ''} to ${agent.name}.`,
      'warning'
    );
    await persistState();
    sendJson(res, 200, { ok: true, task });
    return;
  }

  if (action === 'update') {
    if (activeRuns.has(task.id) || task.runStatus === 'running') {
      sendJson(res, 400, { error: 'invalid_state', message: 'Running tasks cannot be edited while an agent is actively working.' });
      return;
    }

    const body = await readJsonBody(req);
    const title = String(body.title || '').trim();
    if (!title) {
      sendJson(res, 400, { error: 'validation', message: 'Task title is required.' });
      return;
    }

    const requestedAgentId = String(body.agentId || '').trim();
    const preferredAgent = requestedAgentId ? agentCatalog.find((agent) => agent.id === requestedAgentId) || null : null;
    if (requestedAgentId && !preferredAgent) {
      sendJson(res, 400, { error: 'validation', message: 'A valid agentId is required.' });
      return;
    }

    task.title = title;
    task.notes = String(body.notes || '').trim();
    task.priority = sanitizePriority(body.priority);
    task.owner = String(body.owner || '').trim() || 'Unassigned stream';
    task.preferredAgentId = preferredAgent?.id || null;
    task.skill = preferredAgent ? preferredAgent.specialty : task.skill;
    task.updatedAt = Date.now();

    pushActivity(`${task.title} was updated.`, 'info');
    await persistState();
    sendJson(res, 200, { ok: true, task });
    return;
  }

  if (action === 'comment') {
    const body = await readJsonBody(req);
    const author = String(body.author || '').trim() || 'Operator';
    const commentText = String(body.comment || '').trim();

    if (!commentText) {
      sendJson(res, 400, { error: 'validation', message: 'Comment text is required.' });
      return;
    }

    task.comments = Array.isArray(task.comments) ? task.comments : [];
    task.comments.push({
      id: nextId('comment'),
      author,
      text: commentText,
      createdAt: Date.now(),
    });
    task.updatedAt = Date.now();

    pushActivity(`${author} added a comment on ${task.title}.`, 'info');
    await persistState();
    sendJson(res, 200, { ok: true, task });
    return;
  }

  if (action === 'delete') {
    if (activeRuns.has(task.id) || task.runStatus === 'running') {
      sendJson(res, 400, { error: 'invalid_state', message: 'Running tasks cannot be deleted.' });
      return;
    }

    state.tasks = state.tasks.filter((item) => item.id !== task.id);
    pushActivity(`${task.title} was deleted from the board.`, 'warning');
    await persistState();
    sendJson(res, 200, { ok: true, taskId: task.id });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

function moveTask(task, direction) {
  if (task.lane === 'inprogress' && activeRuns.has(task.id)) {
    return { ok: false, message: 'This task is actively running and cannot be moved manually.' };
  }

  const index = laneOrder.indexOf(task.lane);
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= laneOrder.length) {
    return { ok: false, message: 'That move is out of range.' };
  }

  const nextLane = laneOrder[nextIndex];

  if (task.lane === 'approval' && nextLane === 'ready') {
    return { ok: false, message: 'Use the approval action for approval-lane tasks.' };
  }

  if (task.lane === 'ready' && nextLane === 'inprogress') {
    return { ok: false, message: 'Use assignment so a real agent run is tracked.' };
  }

  if (task.lane === 'review' && nextLane === 'done') {
    task.lane = 'done';
    task.updatedAt = Date.now();
    pushActivity(`${task.title} marked Done after review.`, 'info');
    return { ok: true };
  }

  if (task.lane === 'inprogress' && direction < 0) {
    task.lane = 'ready';
    task.assignedAgentId = null;
    task.runStatus = 'idle';
    task.updatedAt = Date.now();
    pushActivity(`${task.title} moved back to Ready for Agents.`, 'warning');
    return { ok: true };
  }

  task.lane = nextLane;
  task.updatedAt = Date.now();
  pushActivity(`${task.title} moved to ${laneTitle(nextLane)}.`, 'info');
  return { ok: true };
}

async function launchTaskRun(task, agent) {
  const prompt = buildTaskPrompt(task, agent);
  const args = [
    'agent',
    '--agent',
    agent.id,
    '--message',
    prompt,
    '--thinking',
    'off',
    '--json',
  ];

  const child = spawn(OPENCLAW_BIN, args, {
    cwd: ROOT_WORKSPACE,
    env: process.env,
  });

  const run = {
    id: nextId('run'),
    taskId: task.id,
    taskTitle: task.title,
    agentId: agent.id,
    agentName: agent.name,
    pid: child.pid,
    startedAt: Date.now(),
    stdout: '',
    stderr: '',
    prompt,
    seq: 0,
    finished: false,
  };

  runLogger.createRun({
    id: run.id,
    taskId: task.id,
    taskTitle: task.title,
    agentId: agent.id,
    agentName: agent.name,
    owner: task.owner,
    priority: task.priority,
    skill: task.skill,
    laneAtStart: task.lane,
    pid: child.pid,
    status: 'running',
    startedAt: run.startedAt,
    updatedAt: run.startedAt,
    promptText: prompt,
  });
  runLogger.appendEvent({
    runId: run.id,
    eventType: 'spawned',
    status: 'running',
    message: `${agent.name} started task execution.`,
    details: { args, pid: child.pid, cwd: ROOT_WORKSPACE },
    createdAt: run.startedAt,
  });

  activeRuns.set(task.id, run);
  task.assignedAgentId = agent.id;
  task.lane = 'inprogress';
  task.runStatus = 'running';
  task.updatedAt = Date.now();
  task.lastRun = {
    id: run.id,
    status: 'running',
    startedAt: run.startedAt,
    output: '',
    usage: null,
    error: null,
  };
  pushActivity(`${agent.name} started ${task.title}.`, 'busy');
  await persistState();

  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    run.stdout += text;
    run.seq += 1;
    runLogger.appendLog({
      runId: run.id,
      seq: run.seq,
      stream: 'stdout',
      chunkText: text,
      createdAt: Date.now(),
    });
  });

  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    run.stderr += text;
    run.seq += 1;
    runLogger.appendLog({
      runId: run.id,
      seq: run.seq,
      stream: 'stderr',
      chunkText: text,
      createdAt: Date.now(),
    });
  });

  child.on('error', async (error) => {
    if (run.finished) {
      return;
    }
    run.finished = true;
    const finishedAt = Date.now();
    const failureDetails = error instanceof Error ? error.message : String(error);
    task.updatedAt = finishedAt;
    task.lane = 'ready';
    task.runStatus = 'failed';
    task.assignedAgentId = null;
    task.lastRun = {
      id: run.id,
      status: 'failed',
      startedAt: run.startedAt,
      finishedAt,
      output: '',
      usage: null,
      error: failureDetails,
    };
    activeRuns.delete(task.id);
    runLogger.appendEvent({
      runId: run.id,
      eventType: 'process_error',
      status: 'failed',
      message: 'OpenClaw process failed before completion.',
      details: { failureDetails },
      createdAt: finishedAt,
    });
    runLogger.updateRun({
      id: run.id,
      status: 'failed',
      finishedAt,
      durationMs: finishedAt - run.startedAt,
      updatedAt: finishedAt,
      failureDetails,
      errorText: failureDetails,
    });
    runLogger.addArtifact({
      runId: run.id,
      artifactType: 'failure',
      label: 'Process error',
      contentText: failureDetails,
      contentJson: { failureDetails },
      createdAt: finishedAt,
    });
    pushActivity(`${agent.name} failed to start ${task.title}. The task moved back to Ready.`, 'warning');
    await persistState();
  });

  child.on('close', async (code) => {
    if (run.finished) {
      return;
    }
    run.finished = true;
    const finishedAt = Date.now();
    const parsed =
      tryParseJson(run.stdout.trim()) ||
      extractJsonFromMixedText(run.stdout) ||
      extractJsonFromMixedText(run.stderr);
    const resultEnvelope = parsed?.result && typeof parsed.result === 'object' ? parsed.result : parsed;
    const payloads = Array.isArray(resultEnvelope?.payloads) ? resultEnvelope.payloads : [];
    const meta = resultEnvelope?.meta || parsed?.meta || null;
    const usage = meta?.agentMeta?.usage || meta?.agentMeta?.lastCallUsage || null;
    const agentMeta = meta?.agentMeta || null;
    const output = payloads.map((item) => item.text).filter(Boolean).join('\n\n').trim();
    const hasPayload = payloads.some((item) => item.text || item.mediaUrl);
    const runNote = sanitizeRunNote(run.stderr);
    const summaryText = extractSummarySection(output);
    const failureText = !hasPayload ? run.stderr.trim() || run.stdout.trim() || `Exit code ${code}` : runNote;

    task.updatedAt = finishedAt;
    runLogger.appendEvent({
      runId: run.id,
      eventType: 'process_closed',
      status: hasPayload ? 'succeeded' : 'failed',
      message: hasPayload ? 'Run completed with payload output.' : 'Run closed without usable payload output.',
      details: {
        exitCode: code,
        hasPayload,
        sessionId: agentMeta?.sessionId || null,
        model: agentMeta?.model || null,
      },
      createdAt: finishedAt,
    });

    if (hasPayload) {
      task.lane = 'review';
      task.runStatus = 'succeeded';
      task.lastRun = {
        id: run.id,
        status: 'succeeded',
        startedAt: run.startedAt,
        finishedAt,
        output,
        usage,
        sessionId: agentMeta?.sessionId || null,
        model: agentMeta?.model || null,
        error: runNote,
      };
      runLogger.updateRun({
        id: run.id,
        status: 'succeeded',
        exitCode: code,
        finishedAt,
        durationMs: finishedAt - run.startedAt,
        updatedAt: finishedAt,
        sessionId: agentMeta?.sessionId || null,
        sessionKey: agentMeta?.sessionKey || null,
        model: agentMeta?.model || null,
        usage,
        summaryText,
        outputText: output || null,
        errorText: runNote || null,
      });
      if (summaryText) {
        runLogger.addArtifact({
          runId: run.id,
          artifactType: 'summary',
          label: 'Agent summary',
          contentText: summaryText,
          createdAt: finishedAt,
        });
      }
      if (output) {
        runLogger.addArtifact({
          runId: run.id,
          artifactType: 'report',
          label: 'Execution report',
          contentText: output,
          contentJson: payloads || null,
          createdAt: finishedAt,
        });
      }
      if (usage) {
        runLogger.addArtifact({
          runId: run.id,
          artifactType: 'usage',
          label: 'Usage metadata',
          contentJson: usage,
          createdAt: finishedAt,
        });
      }
      pushActivity(`${agent.name} finished ${task.title}. Review is ready.`, 'info');
    } else {
      task.lane = 'ready';
      task.runStatus = 'failed';
      task.assignedAgentId = null;
      task.lastRun = {
        id: run.id,
        status: 'failed',
        startedAt: run.startedAt,
        finishedAt,
        output: output || '',
        usage,
        error: failureText,
      };
      runLogger.updateRun({
        id: run.id,
        status: 'failed',
        exitCode: code,
        finishedAt,
        durationMs: finishedAt - run.startedAt,
        updatedAt: finishedAt,
        sessionId: agentMeta?.sessionId || null,
        sessionKey: agentMeta?.sessionKey || null,
        model: agentMeta?.model || null,
        usage,
        failureDetails: failureText,
        summaryText,
        outputText: output || null,
        errorText: failureText,
      });
      runLogger.addArtifact({
        runId: run.id,
        artifactType: 'failure',
        label: `Exit code ${code}`,
        contentText: failureText,
        contentJson: { exitCode: code, stderr: run.stderr, stdout: run.stdout },
        createdAt: finishedAt,
      });
      pushActivity(`${agent.name} failed ${task.title}. The task moved back to Ready.`, 'warning');
    }

    activeRuns.delete(task.id);
    await persistState();
    refreshTelemetry().catch(() => {});
  });
}

function limitPromptSection(text, maxLength = 4000) {
  if (!text) {
    return '';
  }

  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}\n[truncated]` : text;
}

function buildTaskPrompt(task, agent) {
  const commentLines = Array.isArray(task.comments) && task.comments.length
    ? task.comments.map((comment) => `- ${comment.author}: ${comment.text}`).join('\n')
    : 'None.';

  const previousRunOutput = limitPromptSection(sanitizeRunNote(task.lastRun?.output) || '', 5000);
  const previousRunError = limitPromptSection(sanitizeRunNote(task.lastRun?.error) || '', 2500);
  const previousRunSection = task.lastRun?.status && task.lastRun.status !== 'idle'
    ? [
        `Previous run status: ${task.lastRun.status}`,
        previousRunOutput ? `Previous run output:\n${previousRunOutput}` : null,
        previousRunError ? `Previous run error:\n${previousRunError}` : null,
      ]
        .filter(Boolean)
        .join('\n\n')
    : 'No previous run context.';

  return [
    `You are ${agent.name}, a specialized ${agent.specialty} agent working for Bjorn through Jarvis.`,
    `Handle this task carefully and be accurate.`,
    '',
    `Task title: ${task.title}`,
    `Priority: ${task.priority}`,
    `Required skill: ${task.skill}`,
    `Owner or stream: ${task.owner}`,
    `Task notes: ${task.notes || 'No additional notes provided.'}`,
    'Task comments:',
    commentLines,
    '',
    'Previous run context:',
    previousRunSection,
    '',
    'Return a concise execution report with these headings exactly:',
    'Summary',
    'What I did',
    'Risks or blockers',
    'Recommended next step',
    '',
    'If you cannot complete the task from the current context, say what is missing instead of bluffing.',
  ].join('\n');
}

function pickAgentForTask(task, requestedAgentId) {
  const busyAgentIds = new Set(Array.from(activeRuns.values()).map((run) => run.agentId));
  const preferredAgentId = requestedAgentId || task.preferredAgentId || null;
  const agents = agentCatalog
    .filter((agent) => !busyAgentIds.has(agent.id))
    .filter((agent) => (preferredAgentId ? agent.id === preferredAgentId : agent.specialty === task.skill));

  if (preferredAgentId) {
    return agents[0] || null;
  }

  return agents.sort((a, b) => a.name.localeCompare(b.name))[0] || null;
}

function normalizeSystemTask(task) {
  return {
    id: task.taskId || task.id || null,
    runId: task.runId || null,
    label: task.label || task.task || task.taskId || task.id || 'OpenClaw task',
    runtime: task.runtime || 'unknown',
    status: task.status || 'unknown',
    agentId: task.agentId || null,
    scopeKind: task.scopeKind || null,
    ownerKey: task.ownerKey || null,
    sessionKey: task.childSessionKey || null,
    requesterSessionKey: task.requesterSessionKey || null,
    sourceId: task.sourceId || null,
    deliveryStatus: task.deliveryStatus || null,
    createdAt: task.createdAt || null,
    startedAt: task.startedAt || null,
    endedAt: task.endedAt || null,
    updatedAt: task.lastEventAt || task.endedAt || task.startedAt || task.createdAt || 0,
    summary: task.terminalSummary || null,
  };
}

function normalizeSystemSession(session) {
  return {
    key: session.key,
    sessionId: session.sessionId || null,
    agentId: session.agentId || null,
    kind: session.kind || null,
    model: session.model || null,
    updatedAt: session.updatedAt || 0,
    systemSent: Boolean(session.systemSent),
    abortedLastRun: Boolean(session.abortedLastRun),
    thinkingLevel: session.thinkingLevel || null,
    inputTokens: Number(session.inputTokens || 0),
    outputTokens: Number(session.outputTokens || 0),
    totalTokens: Number(session.totalTokens || 0),
  };
}

async function buildDashboardPayload() {
  if (!telemetryCache.updatedAt) {
    await refreshTelemetry();
  }

  const configuredAgents = telemetryCache.configuredAgents;
  const sessions = telemetryCache.sessions;
  const backgroundTasks = telemetryCache.backgroundTasks;
  const systemHistoryTasks = backgroundTasks
    .map(normalizeSystemTask)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const systemHistorySessions = sessions
    .map(normalizeSystemSession)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const mergedAgents = agentCatalog.map((agent) => {
    const configured = configuredAgents.find((item) => item.id === agent.id) || null;
    const activeRun = Array.from(activeRuns.values()).find((run) => run.agentId === agent.id) || null;
    const session = sessions
      .filter((item) => item.agentId === agent.id)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;

    const currentTask = state.tasks.find((task) => task.id === activeRun?.taskId) || state.tasks.find((task) => task.assignedAgentId === agent.id && task.lane === 'review') || null;
    const sessionTokens = session?.totalTokens || 0;
    const lastRunTokens = currentTask?.lastRun?.usage?.total || 0;

    return {
      ...agent,
      configured: Boolean(configured),
      model: configured?.model || null,
      workspace: configured?.workspace || null,
      status: activeRun ? 'busy' : configured ? 'idle' : 'unconfigured',
      currentTaskId: currentTask?.id || null,
      currentTaskTitle: activeRun ? currentTask?.title || null : null,
      lastTaskTitle: !activeRun ? currentTask?.title || null : null,
      pid: activeRun?.pid || null,
      runStartedAt: activeRun?.startedAt || null,
      sessionKey: session?.key || null,
      sessionUpdatedAt: session?.updatedAt || null,
      sessionTokens,
      latestUsageTokens: Math.max(sessionTokens, lastRunTokens),
    };
  });

  const totalSessionTokens = sessions.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);

  return {
    generatedAt: Date.now(),
    storage: {
      runHistoryDbPath: runLogger.path,
    },
    projects: projectCatalog,
    lanes,
    tasks: [...state.tasks].sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority] || (b.createdAt || 0) - (a.createdAt || 0)),
    activity: state.activity.slice(0, 20),
    agents: mergedAgents,
    approvals: state.tasks.filter((task) => task.lane === 'approval'),
    activeRuns: Array.from(activeRuns.values()).map((run) => ({
      id: run.id,
      taskId: run.taskId,
      agentId: run.agentId,
      pid: run.pid,
      startedAt: run.startedAt,
    })),
    runs: runLogger.getRecentRuns(80),
    systemHistory: {
      tasks: systemHistoryTasks,
      sessions: systemHistorySessions,
    },
    metrics: {
      taskCount: state.tasks.length,
      readyCount: state.tasks.filter((task) => task.lane === 'ready').length,
      approvalCount: state.tasks.filter((task) => task.lane === 'approval').length,
      busyAgentCount: mergedAgents.filter((agent) => agent.status === 'busy').length,
      doneCount: state.tasks.filter((task) => task.lane === 'done').length,
      totalSessionTokens,
      systemTaskCount: systemHistoryTasks.length,
      systemSessionCount: systemHistorySessions.length,
    },
    openclaw: {
      sessions,
      backgroundTasks,
      configuredAgents,
      updatedAt: telemetryCache.updatedAt,
    },
  };
}

async function refreshTelemetry() {
  if (!refreshTelemetryPromise) {
    refreshTelemetryPromise = Promise.all([
      execOpenClawJson(['agents', 'list', '--json']).catch(() => []),
      execOpenClawJson(['sessions', '--all-agents', '--json']).catch(() => ({ sessions: [] })),
      execOpenClawJson(['tasks', 'list', '--json']).catch(() => ({ tasks: [] })),
    ])
      .then(([configuredAgentsRaw, sessionsRaw, backgroundTasksRaw]) => {
        telemetryCache = {
          configuredAgents: Array.isArray(configuredAgentsRaw) ? configuredAgentsRaw : [],
          sessions: Array.isArray(sessionsRaw?.sessions) ? sessionsRaw.sessions : [],
          backgroundTasks: Array.isArray(backgroundTasksRaw?.tasks) ? backgroundTasksRaw.tasks : [],
          updatedAt: Date.now(),
        };
      })
      .finally(() => {
        refreshTelemetryPromise = null;
      });
  }

  return refreshTelemetryPromise;
}

function pushActivity(message, tone = 'info') {
  state.activity.unshift({
    id: nextId('activity'),
    message,
    tone,
    time: Date.now(),
  });
  state.activity = state.activity.slice(0, 30);
}

function createSeedState() {
  const now = Date.now();
  return {
    tasks: [
      {
        id: 'task-seed-101',
        title: 'Stabilize client invoice ingestion',
        notes: 'Audit retry policy, idempotency keys, and dead-letter handling for the overnight importer.',
        priority: 'critical',
        skill: 'backend',
        owner: 'Northstar Finance',
        lane: 'approval',
        assignedAgentId: null,
        runStatus: 'idle',
        createdAt: now - 1000 * 60 * 95,
        updatedAt: now - 1000 * 60 * 95,
        lastRun: null,
      },
      {
        id: 'task-seed-102',
        title: 'Refine migration runbook UI',
        notes: 'Tighten the operator dashboard so migration checkpoints are obvious at a glance.',
        priority: 'high',
        skill: 'frontend',
        owner: 'Atlas Rollout',
        lane: 'ready',
        assignedAgentId: null,
        runStatus: 'idle',
        createdAt: now - 1000 * 60 * 60,
        updatedAt: now - 1000 * 60 * 60,
        lastRun: null,
      },
      {
        id: 'task-seed-103',
        title: 'Map automation opportunities in onboarding flow',
        notes: 'Find repetitive human approvals that can become policy-driven checks later.',
        priority: 'medium',
        skill: 'automation',
        owner: 'Launch Ops',
        lane: 'definition',
        assignedAgentId: null,
        runStatus: 'idle',
        createdAt: now - 1000 * 60 * 30,
        updatedAt: now - 1000 * 60 * 30,
        lastRun: null,
      },
      {
        id: 'task-seed-104',
        title: 'Document token budget policy',
        notes: 'Set thresholds per agent class so expensive runs trigger review before launch.',
        priority: 'low',
        skill: 'product',
        owner: 'Internal',
        lane: 'done',
        assignedAgentId: 'north',
        runStatus: 'succeeded',
        createdAt: now - 1000 * 60 * 180,
        updatedAt: now - 1000 * 60 * 40,
        lastRun: {
          status: 'succeeded',
          startedAt: now - 1000 * 60 * 55,
          finishedAt: now - 1000 * 60 * 40,
          output: 'Summary\nToken thresholds drafted for lightweight, normal, and deep task classes.\n\nWhat I did\nOutlined policy tiers and review triggers.\n\nRisks or blockers\nNeeds a final call on threshold numbers.\n\nRecommended next step\nValidate thresholds against one week of real usage.',
          usage: { input: 4120, output: 314, total: 4434 },
          error: null,
        },
      },
    ],
    activity: [
      {
        id: 'activity-seed-1',
        message: 'Dashboard upgraded from a demo board to a live local app shell.',
        tone: 'info',
        time: now - 1000 * 60 * 8,
      },
      {
        id: 'activity-seed-2',
        message: 'Approved tasks can now launch real isolated OpenClaw agent runs.',
        tone: 'busy',
        time: now - 1000 * 60 * 4,
      },
    ],
  };
}

async function loadOrCreateState() {
  await ensureDirectory(DATA_DIR);
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      tasks: Array.isArray(parsed.tasks)
        ? parsed.tasks.map((task) => ({
            ...task,
            comments: Array.isArray(task.comments) ? task.comments : [],
          }))
        : [],
      activity: Array.isArray(parsed.activity) ? parsed.activity : [],
    };
  } catch {
    const seed = createSeedState();
    await fs.writeFile(STATE_PATH, JSON.stringify(seed, null, 2));
    return seed;
  }
}

async function persistState() {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function serveStatic(res, requestPath) {
  const safePath = requestPath === '/' ? '/index.html' : requestPath;
  const filePath = path.normalize(path.join(__dirname, safePath));
  if (!filePath.startsWith(__dirname)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  const extension = path.extname(filePath);
  const contentType = mimeTypes[extension] || 'application/octet-stream';

  try {
    const file = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: 'not_found' });
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function nextId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizePriority(value) {
  const normalized = String(value || 'medium').toLowerCase();
  return ['critical', 'high', 'medium', 'low'].includes(normalized) ? normalized : 'medium';
}

function sanitizeSkill(value) {
  const normalized = String(value || 'product').toLowerCase();
  return ['frontend', 'backend', 'ops', 'qa', 'automation', 'product'].includes(normalized)
    ? normalized
    : 'product';
}

function laneTitle(laneId) {
  return lanes.find((lane) => lane.id === laneId)?.title || laneId;
}

function tryParseJson(raw) {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractJsonFromMixedText(raw) {
  if (!raw) {
    return null;
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return tryParseJson(raw.slice(firstBrace, lastBrace + 1));
}

function sanitizeRunNote(raw) {
  if (!raw) {
    return null;
  }

  const withoutJson = raw.replace(/\{[\s\S]*$/, '').trim();
  const filtered = withoutJson
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !line.startsWith('gateway connect failed: GatewayClientRequestError: pairing required') &&
        !line.startsWith('Gateway agent failed; falling back to embedded: Error: gateway closed (1008): pairing required') &&
        !line.startsWith('Gateway target:') &&
        !line.startsWith('Source:') &&
        !line.startsWith('Config:') &&
        !line.startsWith('Bind:') &&
        !line.startsWith('[agents/auth-profiles] inherited auth-profiles from main agent')
    )
    .join('\n')
    .trim();

  return filtered || null;
}

function extractSummarySection(output) {
  if (!output) {
    return null;
  }

  const match = output.match(/Summary\s*\n([\s\S]*?)(?:\n\n[A-Z][^\n]*\n|$)/);
  return match?.[1]?.trim() || null;
}

async function execOpenClawJson(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(OPENCLAW_BIN, [...args], {
      cwd: ROOT_WORKSPACE,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${OPENCLAW_BIN} ${args.join(' ')} exited with code ${code}`));
        return;
      }
      const parsed = tryParseJson(stdout.trim()) || extractJsonFromMixedText(stdout) || extractJsonFromMixedText(stderr);
      resolve(parsed ?? stdout.trim());
    });
  });
}
