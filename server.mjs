import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 4311);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
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

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const body = await readJsonBody(req);
    const title = String(body.title || '').trim();
    if (!title) {
      sendJson(res, 400, { error: 'validation', message: 'Task title is required.' });
      return;
    }

    const task = {
      id: nextId('task'),
      title,
      notes: String(body.notes || '').trim(),
      priority: sanitizePriority(body.priority),
      skill: sanitizeSkill(body.skill),
      owner: String(body.owner || '').trim() || 'Unassigned stream',
      lane: 'definition',
      assignedAgentId: null,
      runStatus: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastRun: null,
    };

    state.tasks.unshift(task);
    pushActivity(`New task created in Definition: ${task.title}.`, 'info');
    await persistState();
    sendJson(res, 201, { ok: true, task });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    state = createSeedState();
    pushActivity('Board state reset to the live prototype seed.', 'info');
    await persistState();
    sendJson(res, 200, { ok: true });
    return;
  }

  const taskRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(approve|move|assign)$/);
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
  const args = [
    'agent',
    '--agent',
    agent.id,
    '--message',
    buildTaskPrompt(task, agent),
    '--thinking',
    'off',
    '--json',
  ];

  const child = spawn('openclaw', args, {
    cwd: ROOT_WORKSPACE,
    env: process.env,
  });

  const run = {
    taskId: task.id,
    agentId: agent.id,
    pid: child.pid,
    startedAt: Date.now(),
    stdout: '',
    stderr: '',
  };

  activeRuns.set(task.id, run);
  task.assignedAgentId = agent.id;
  task.lane = 'inprogress';
  task.runStatus = 'running';
  task.updatedAt = Date.now();
  task.lastRun = {
    status: 'running',
    startedAt: run.startedAt,
    output: '',
    usage: null,
    error: null,
  };
  pushActivity(`${agent.name} started ${task.title}.`, 'busy');
  await persistState();

  child.stdout.on('data', (chunk) => {
    run.stdout += String(chunk);
  });

  child.stderr.on('data', (chunk) => {
    run.stderr += String(chunk);
  });

  child.on('close', async (code) => {
    const finishedAt = Date.now();
    const parsed = tryParseJson(run.stdout.trim()) || extractJsonFromMixedText(run.stderr);
    const usage = parsed?.meta?.agentMeta?.usage || parsed?.meta?.agentMeta?.lastCallUsage || null;
    const output = (parsed?.payloads || []).map((item) => item.text).filter(Boolean).join('\n\n').trim();
    const hasPayload = Array.isArray(parsed?.payloads) && parsed.payloads.some((item) => item.text || item.mediaUrl);

    task.updatedAt = finishedAt;

    if (hasPayload) {
      task.lane = 'review';
      task.runStatus = 'succeeded';
      task.lastRun = {
        status: 'succeeded',
        startedAt: run.startedAt,
        finishedAt,
        output,
        usage,
        sessionId: parsed?.meta?.agentMeta?.sessionId || null,
        model: parsed?.meta?.agentMeta?.model || null,
        error: run.stderr.trim() || null,
      };
      pushActivity(`${agent.name} finished ${task.title}. Review is ready.`, 'info');
    } else {
      task.lane = 'ready';
      task.runStatus = 'failed';
      task.assignedAgentId = null;
      task.lastRun = {
        status: 'failed',
        startedAt: run.startedAt,
        finishedAt,
        output: output || '',
        usage,
        error: run.stderr.trim() || run.stdout.trim() || `Exit code ${code}`,
      };
      pushActivity(`${agent.name} failed ${task.title}. The task moved back to Ready.`, 'warning');
    }

    activeRuns.delete(task.id);
    await persistState();
    refreshTelemetry().catch(() => {});
  });
}

function buildTaskPrompt(task, agent) {
  return [
    `You are ${agent.name}, a specialized ${agent.specialty} agent working for Bjorn through Jarvis.`,
    `Handle this task carefully and be accurate.`,
    '',
    `Task title: ${task.title}`,
    `Priority: ${task.priority}`,
    `Required skill: ${task.skill}`,
    `Owner or stream: ${task.owner}`,
    `Task notes: ${task.notes || 'No additional notes provided.'}`,
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
  const agents = agentCatalog
    .filter((agent) => !busyAgentIds.has(agent.id))
    .filter((agent) => (requestedAgentId ? agent.id === requestedAgentId : agent.specialty === task.skill));

  if (requestedAgentId) {
    return agents[0] || null;
  }

  return agents.sort((a, b) => a.name.localeCompare(b.name))[0] || null;
}

async function buildDashboardPayload() {
  if (!telemetryCache.updatedAt) {
    await refreshTelemetry();
  }

  const configuredAgents = telemetryCache.configuredAgents;
  const sessions = telemetryCache.sessions;
  const backgroundTasks = telemetryCache.backgroundTasks;

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
    lanes,
    tasks: [...state.tasks].sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority] || (b.createdAt || 0) - (a.createdAt || 0)),
    activity: state.activity.slice(0, 20),
    agents: mergedAgents,
    approvals: state.tasks.filter((task) => task.lane === 'approval'),
    activeRuns: Array.from(activeRuns.values()).map((run) => ({
      taskId: run.taskId,
      agentId: run.agentId,
      pid: run.pid,
      startedAt: run.startedAt,
    })),
    metrics: {
      taskCount: state.tasks.length,
      readyCount: state.tasks.filter((task) => task.lane === 'ready').length,
      approvalCount: state.tasks.filter((task) => task.lane === 'approval').length,
      busyAgentCount: mergedAgents.filter((agent) => agent.status === 'busy').length,
      doneCount: state.tasks.filter((task) => task.lane === 'done').length,
      totalSessionTokens,
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
    return JSON.parse(raw);
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

async function execOpenClawJson(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn('openclaw', [...args], {
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
        reject(new Error(stderr.trim() || stdout.trim() || `openclaw ${args.join(' ')} exited with code ${code}`));
        return;
      }
      const parsed = tryParseJson(stdout.trim());
      resolve(parsed ?? stdout.trim());
    });
  });
}
