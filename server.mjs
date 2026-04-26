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
const GIT_BIN = process.env.GIT_BIN || 'git';
const DATA_DIR = path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const RUNS_DB_PATH = path.join(DATA_DIR, 'run-history.sqlite');
const ROOT_WORKSPACE = path.resolve(__dirname, '..');
const GITHUB_REPOS_DIR = path.join(ROOT_WORKSPACE, 'github-repos');
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
const reviewSessions = new Map();
let state = await loadOrCreateState();
const runLogger = createRunLogger({ dbPath: RUNS_DB_PATH });
let restartPending = false;
let telemetryCache = {
  configuredAgents: [],
  sessions: [],
  backgroundTasks: [],
  updatedAt: 0,
};
let refreshTelemetryPromise = null;

await ensureDirectory(DATA_DIR);
await ensureDirectory(GITHUB_REPOS_DIR);
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

  if (req.method === 'POST' && url.pathname === '/api/server/restart') {
    if (restartPending) {
      sendJson(res, 409, { error: 'restart_pending', message: 'A dashboard restart is already in progress.' });
      return;
    }

    const activeReviewCount = countActiveReviewSessions();
    if (activeRuns.size > 0 || activeReviewCount > 0) {
      const parts = [];
      if (activeRuns.size > 0) {
        parts.push(`${activeRuns.size} task run${activeRuns.size === 1 ? '' : 's'}`);
      }
      if (activeReviewCount > 0) {
        parts.push(`${activeReviewCount} review environment${activeReviewCount === 1 ? '' : 's'}`);
      }
      sendJson(res, 409, {
        error: 'restart_blocked',
        message: `Cannot restart while ${parts.join(' and ')} ${parts.length === 1 ? 'is' : 'are'} active.`,
      });
      return;
    }

    restartPending = true;
    pushActivity('Dashboard server restart requested by operator.', 'warning');
    sendJson(res, 202, { ok: true, restarting: true });
    setTimeout(() => {
      scheduleServerRestart();
    }, 150);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/runs') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 80)));
    sendJson(res, 200, { runs: runLogger.getRecentRuns(limit) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    sendJson(res, 200, { projects: [...state.projects].sort((a, b) => a.name.localeCompare(b.name)) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/projects') {
    const body = await readJsonBody(req);
    const name = String(body.name || '').trim();
    const repos = normalizeProjectRepos(body.repos, body.repoUrl);
    const repoUrl = getProjectRepoUrl({ repos, repoUrl: body.repoUrl });
    const gitWorkflow = normalizeProjectWorkflow(body.gitWorkflow);
    const reviewServices = normalizeProjectReviewServices(body.reviewServices);
    const notes = String(body.notes || '').trim();

    if (!name) {
      sendJson(res, 400, { error: 'validation', message: 'Project name is required.' });
      return;
    }

    if (!repoUrl) {
      sendJson(res, 400, { error: 'validation', message: 'Repository URL is required.' });
      return;
    }

    if (state.projects.some((project) => project.name.toLowerCase() === name.toLowerCase())) {
      sendJson(res, 400, { error: 'validation', message: 'A project with that name already exists.' });
      return;
    }

    const project = {
      id: nextId('project'),
      name,
      repoUrl,
      repos,
      gitWorkflow,
      reviewServices,
      notes,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    state.projects.unshift(project);
    pushActivity(`Project created: ${project.name}.`, 'info');
    await persistState();
    sendJson(res, 201, { ok: true, project });
    return;
  }

  const projectRoute = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectRoute && req.method === 'PATCH') {
    const [, projectId] = projectRoute;
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) {
      sendJson(res, 404, { error: 'not_found', message: 'Project not found.' });
      return;
    }

    const body = await readJsonBody(req);
    const nextName = String(body.name || '').trim();
    const nextRepos = normalizeProjectRepos(body.repos, body.repoUrl);
    const nextRepoUrl = getProjectRepoUrl({ repos: nextRepos, repoUrl: body.repoUrl });
    const nextGitWorkflow = normalizeProjectWorkflow(body.gitWorkflow);
    const nextReviewServices = normalizeProjectReviewServices(body.reviewServices);
    const nextNotes = String(body.notes || '').trim();

    if (!nextName) {
      sendJson(res, 400, { error: 'validation', message: 'Project name is required.' });
      return;
    }

    if (!nextRepoUrl) {
      sendJson(res, 400, { error: 'validation', message: 'Repository URL is required.' });
      return;
    }

    const duplicate = state.projects.some(
      (item) => item.id !== project.id && item.name.toLowerCase() === nextName.toLowerCase()
    );
    if (duplicate) {
      sendJson(res, 400, { error: 'validation', message: 'A project with that name already exists.' });
      return;
    }

    const previousName = project.name;
    project.name = nextName;
    project.repoUrl = nextRepoUrl;
    project.repos = nextRepos;
    project.gitWorkflow = nextGitWorkflow;
    project.reviewServices = nextReviewServices;
    project.notes = nextNotes;
    project.updatedAt = Date.now();

    if (previousName !== nextName) {
      state.tasks.forEach((task) => {
        if (task.owner === previousName) {
          task.owner = nextName;
          task.updatedAt = Date.now();
        }
      });
    }

    pushActivity(`Project updated: ${project.name}.`, 'info');
    await persistState();
    sendJson(res, 200, { ok: true, project });
    return;
  }

  if (projectRoute && req.method === 'DELETE') {
    const [, projectId] = projectRoute;
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) {
      sendJson(res, 404, { error: 'not_found', message: 'Project not found.' });
      return;
    }

    state.projects = state.projects.filter((item) => item.id !== project.id);
    pushActivity(`Project removed: ${project.name}.`, 'warning');
    await persistState();
    sendJson(res, 200, { ok: true, projectId: project.id });
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

  const reviewRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/review\/(start|stop)$/);
  if (reviewRoute && req.method === 'POST') {
    const [, taskId, reviewAction] = reviewRoute;
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) {
      sendJson(res, 404, { error: 'not_found', message: 'Task not found.' });
      return;
    }

    if (reviewAction === 'start') {
      try {
        const reviewEnvironment = await startTaskReviewEnvironment(task);
        sendJson(res, 202, { ok: true, reviewEnvironment });
      } catch (error) {
        sendJson(res, 400, { error: 'review_start_failed', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    await stopTaskReviewEnvironment(task.id, { quiet: false });
    sendJson(res, 200, { ok: true });
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
    const moved = await moveTask(task, direction);
    if (!moved.ok) {
      sendJson(res, 400, { error: 'invalid_state', message: moved.message });
      return;
    }
    await persistState();
    sendJson(res, 200, { ok: true, task, publish: moved.publish || null });
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
      await stopTaskReviewEnvironment(task.id, { quiet: true });
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

    await stopTaskReviewEnvironment(task.id, { quiet: true });
    state.tasks = state.tasks.filter((item) => item.id !== task.id);
    pushActivity(`${task.title} was deleted from the board.`, 'warning');
    await persistState();
    sendJson(res, 200, { ok: true, taskId: task.id });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

async function moveTask(task, direction) {
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
    await stopTaskReviewEnvironment(task.id, { quiet: true });
    const publish = await publishTaskProjectChanges(task);
    if (!publish.ok) {
      return publish;
    }
    task.lane = 'done';
    task.assignedAgentId = null;
    task.updatedAt = Date.now();
    pushActivity(`${task.title} marked Done after review.${publish.message ? ` ${publish.message}` : ''}`, 'info');
    return { ok: true, publish };
  }

  if (task.lane === 'review' && nextLane !== 'review') {
    await stopTaskReviewEnvironment(task.id, { quiet: true });
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
  let executionContext;

  try {
    executionContext = await prepareTaskExecutionContext(task);
  } catch (error) {
    const finishedAt = Date.now();
    const failureDetails = error instanceof Error ? error.message : String(error);
    task.updatedAt = finishedAt;
    task.lane = 'ready';
    task.runStatus = 'failed';
    task.assignedAgentId = null;
    task.lastRun = {
      id: null,
      status: 'failed',
      startedAt: finishedAt,
      finishedAt,
      output: '',
      usage: null,
      error: failureDetails,
    };
    pushActivity(`Failed to prepare a repo workspace for ${task.title}.`, 'warning');
    await persistState();
    throw error;
  }

  const prompt = buildTaskPrompt(task, agent, executionContext);
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
    cwd: executionContext.cwd,
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
    details: {
      args,
      pid: child.pid,
      cwd: executionContext.cwd,
      projectName: executionContext.project?.name || null,
      repoUrl: executionContext.primaryRepo?.url || executionContext.project?.repoUrl || null,
      repoDir: executionContext.repoDir || null,
      branchName: executionContext.branchName || null,
    },
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

function buildTaskPrompt(task, agent, executionContext = null) {
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

  const linkedRepos = executionContext?.project ? getProjectRepos(executionContext.project) : [];
  const repoSummary = linkedRepos.length
    ? linkedRepos.map((repo) => `- ${repo.label || repo.role || 'repo'}${repo.primary ? ' (primary)' : ''}: ${repo.url}`).join('\n')
    : null;
  const repoSection = executionContext?.project
    ? [
        'Project repo context:',
        `Project: ${executionContext.project.name}`,
        `Primary repository URL: ${executionContext.primaryRepo?.url || executionContext.project.repoUrl}`,
        repoSummary ? `Linked repositories:\n${repoSummary}` : null,
        `Local task workspace: ${executionContext.cwd}`,
        'Work only inside the primary code repository unless the task explicitly requires shared workspace changes.',
      ].filter(Boolean).join('\n')
    : [
        'Project repo context:',
        'No linked project repo was resolved for this task.',
        `Fallback workspace: ${executionContext?.cwd || ROOT_WORKSPACE}`,
      ].join('\n');

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
    repoSection,
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

function sanitizePathSegment(value) {
  const sanitized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'repo';
}

function normalizeRepoUrl(repoUrl) {
  const raw = String(repoUrl || '').trim();
  if (!raw) return '';

  const sshMatch = raw.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const [, host, repoPath] = sshMatch;
    return `${host}/${repoPath.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase()}`;
  }

  try {
    const parsed = new URL(raw);
    return `${parsed.host}${parsed.pathname}`.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase();
  } catch {
    return raw.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase();
  }
}

function parseRepoIdentity(repoUrl) {
  const normalized = normalizeRepoUrl(repoUrl);
  if (!normalized) return null;

  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return null;

  const name = parts.at(-1) || null;
  const owner = parts.length >= 2 ? parts.at(-2) : null;
  return {
    owner,
    name,
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeoutMs || 45000);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GH_PROMPT_DISABLED: '1',
        ...(options.env || {}),
      },
    });
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      child.kill('SIGTERM');
      const error = new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`${command} ${args.join(' ')} failed with code ${code}: ${(stderr || stdout).trim()}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function getGitOriginUrl(repoDir) {
  try {
    const result = await runCommand(GIT_BIN, ['remote', 'get-url', 'origin'], { cwd: repoDir });
    return result.stdout.trim();
  } catch {
    return '';
  }
}

async function findExistingRepoClone(repoUrl) {
  const normalized = normalizeRepoUrl(repoUrl);
  if (!normalized) return null;

  const entries = await fs.readdir(GITHUB_REPOS_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoDir = path.join(GITHUB_REPOS_DIR, entry.name);
    if (!(await pathExists(path.join(repoDir, '.git')))) continue;
    const originUrl = await getGitOriginUrl(repoDir);
    if (originUrl && normalizeRepoUrl(originUrl) === normalized) {
      return repoDir;
    }
  }

  return null;
}

function deriveRepoClonePath(repoUrl) {
  const identity = parseRepoIdentity(repoUrl);
  if (!identity?.name) {
    return path.join(GITHUB_REPOS_DIR, `repo-${Date.now()}`);
  }

  if (identity.owner) {
    return path.join(GITHUB_REPOS_DIR, `${sanitizePathSegment(identity.owner)}__${sanitizePathSegment(identity.name)}`);
  }

  return path.join(GITHUB_REPOS_DIR, sanitizePathSegment(identity.name));
}

async function ensureBaseRepoClone(project) {
  const primaryRepo = getProjectPrimaryRepo(project);
  if (!primaryRepo?.url) {
    throw new Error(`Project ${project?.name || 'unknown'} has no primary repository configured.`);
  }

  let repoDir = await findExistingRepoClone(primaryRepo.url);

  if (!repoDir) {
    repoDir = deriveRepoClonePath(primaryRepo.url);
    await runCommand(GIT_BIN, ['clone', primaryRepo.url, repoDir], { cwd: GITHUB_REPOS_DIR });
    return { repoDir, primaryRepo };
  }

  await runCommand(GIT_BIN, ['fetch', 'origin', '--prune'], { cwd: repoDir }).catch(() => {});
  return { repoDir, primaryRepo };
}

function getProjectRepoByRole(project, role) {
  const repos = getProjectRepos(project);
  if (!repos.length) {
    return null;
  }

  const wanted = String(role || '').trim().toLowerCase();
  if (!wanted) {
    return getProjectPrimaryRepo(project);
  }

  return repos.find((repo) => String(repo.role || '').trim().toLowerCase() === wanted)
    || repos.find((repo) => String(repo.label || '').trim().toLowerCase() === wanted)
    || getProjectPrimaryRepo(project);
}

async function ensureProjectRepoClone(project, repo) {
  const targetRepo = repo || getProjectPrimaryRepo(project);
  if (!targetRepo?.url) {
    throw new Error(`Project ${project?.name || 'unknown'} has no repository configured for this service.`);
  }

  let repoDir = await findExistingRepoClone(targetRepo.url);

  if (!repoDir) {
    repoDir = deriveRepoClonePath(targetRepo.url);
    await runCommand(GIT_BIN, ['clone', targetRepo.url, repoDir], { cwd: GITHUB_REPOS_DIR });
  } else {
    await runCommand(GIT_BIN, ['fetch', 'origin', '--prune'], { cwd: repoDir }).catch(() => {});
  }

  return { repoDir, repo: targetRepo };
}

function countActiveReviewSessions() {
  return Array.from(reviewSessions.values()).filter((session) => ['starting', 'ready', 'stopping'].includes(session?.status)).length;
}

function appendReviewServiceLog(service, chunk, stream = 'stdout') {
  const lines = String(chunk || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (stream === 'stderr' ? `! ${line}` : line));

  if (!lines.length) {
    return;
  }

  service.logLines = Array.isArray(service.logLines) ? service.logLines : [];
  service.logLines.push(...lines);
  if (service.logLines.length > 40) {
    service.logLines = service.logLines.slice(-40);
  }
  service.lastLogAt = Date.now();
}

function buildReviewSessionMessage(session) {
  if (!session) return '';
  const services = Array.isArray(session.services) ? session.services : [];
  const total = services.length;
  const readyCount = services.filter((service) => service.status === 'ready').length;
  const failedService = services.find((service) => service.status === 'failed');
  const openUrl = services.find((service) => service.localUrl && service.status === 'ready')?.localUrl || services.find((service) => service.localUrl)?.localUrl || null;

  if (session.status === 'failed') {
    return failedService?.error
      ? `${failedService.name || 'Service'} failed: ${failedService.error}`
      : 'Review service startup failed.';
  }

  if (session.status === 'stopping') {
    return 'Stopping review services…';
  }

  if (session.status === 'ready') {
    return `${readyCount}/${total} review service${total === 1 ? '' : 's'} ready${openUrl ? ` at ${openUrl}` : ''}.`;
  }

  return `${readyCount}/${total} review service${total === 1 ? '' : 's'} ready, starting the rest…`;
}

function summarizeReviewSession(session) {
  if (!session) {
    return null;
  }

  const services = Array.isArray(session.services) ? session.services : [];
  const openUrl = services.find((service) => service.localUrl && service.status === 'ready')?.localUrl || services.find((service) => service.localUrl)?.localUrl || null;
  return {
    status: session.status,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    message: buildReviewSessionMessage(session),
    openUrl,
    services: services.map((service) => ({
      id: service.id,
      name: service.name,
      status: service.status,
      repoRole: service.repoRole,
      repoUrl: service.repoUrl,
      cwd: service.cwd,
      localUrl: service.localUrl,
      healthcheckUrl: service.healthcheckUrl,
      pid: service.pid,
      error: service.error || null,
      logTail: Array.isArray(service.logLines) ? service.logLines.slice(-6) : [],
    })),
  };
}

async function probeServiceUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveReviewServiceWorkspace(task, project, service) {
  const repo = getProjectRepoByRole(project, service.repoRole);
  if (!repo?.url) {
    throw new Error(`No repository is configured for review service ${service.name || 'unnamed service'}.`);
  }

  const primaryRepo = getProjectPrimaryRepo(project);
  const taskWorktreeDir = path.join(AGENT_WORKSPACES_DIR, sanitizePathSegment(task.id));
  let repoDir = null;

  if (primaryRepo?.url && normalizeRepoUrl(primaryRepo.url) === normalizeRepoUrl(repo.url) && await pathExists(path.join(taskWorktreeDir, '.git'))) {
    repoDir = taskWorktreeDir;
  }

  if (!repoDir) {
    repoDir = (await ensureProjectRepoClone(project, repo)).repoDir;
  }

  const requestedDir = String(service.workingDirectory || '').trim();
  const cwd = requestedDir ? path.resolve(repoDir, requestedDir) : repoDir;
  if (!cwd.startsWith(repoDir)) {
    throw new Error(`Review service ${service.name || 'unnamed service'} has an invalid working directory.`);
  }
  if (!(await pathExists(cwd))) {
    throw new Error(`Working directory not found for ${service.name || 'unnamed service'}: ${cwd}`);
  }

  return { repo, repoDir, cwd };
}

function refreshReviewSessionStatus(task, session) {
  if (!session) {
    return;
  }

  if (session.stopRequested && session.status !== 'failed') {
    session.status = 'stopping';
    session.updatedAt = Date.now();
    return;
  }

  if (session.status === 'failed') {
    session.updatedAt = Date.now();
    return;
  }

  const services = Array.isArray(session.services) ? session.services : [];
  const failed = services.some((service) => service.status === 'failed');
  const allReady = services.length > 0 && services.every((service) => service.status === 'ready');

  if (failed) {
    session.status = 'failed';
  } else if (allReady) {
    session.status = 'ready';
    if (!session.readyAnnouncedAt) {
      session.readyAnnouncedAt = Date.now();
      pushActivity(`Review environment ready for ${task.title}.`, 'info');
    }
  } else {
    session.status = 'starting';
  }

  session.updatedAt = Date.now();
}

async function stopReviewServiceProcess(service) {
  const child = service?.process;
  if (!child) {
    return;
  }

  if (service.exitPromise) {
    await service.exitPromise;
    return;
  }

  if (!['failed', 'stopped'].includes(service.status)) {
    service.status = 'stopping';
  }

  service.exitPromise = new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      clearTimeout(safetyTimer);
      resolve();
    };

    const forceTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, 4000);

    const safetyTimer = setTimeout(finish, 5500);
    child.once('close', finish);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
    }
  });

  await service.exitPromise;
}

async function stopTaskReviewEnvironment(taskId, options = {}) {
  const { quiet = false, preserveFailure = false } = options;
  const session = reviewSessions.get(taskId);
  if (!session) {
    return false;
  }

  session.stopRequested = true;
  if (session.status !== 'failed') {
    session.status = 'stopping';
  }
  session.updatedAt = Date.now();

  await Promise.all(
    (session.services || []).map(async (service) => {
      if (!service?.process || service.status === 'stopped') {
        return;
      }
      await stopReviewServiceProcess(service);
    })
  );

  session.updatedAt = Date.now();

  if (!(preserveFailure && session.status === 'failed')) {
    reviewSessions.delete(taskId);
    if (!quiet) {
      pushActivity(`Review environment stopped for ${session.taskTitle}.`, 'info');
    }
  }

  return true;
}

async function monitorReviewService(task, session, service) {
  const probeUrl = service.healthcheckUrl || service.localUrl || '';
  const deadline = Date.now() + (probeUrl ? 60000 : 1500);

  while (reviewSessions.get(task.id) === session && !session.stopRequested && service.status === 'starting') {
    if (probeUrl) {
      if (await probeServiceUrl(probeUrl)) {
        service.status = 'ready';
        service.readyAt = Date.now();
        refreshReviewSessionStatus(task, session);
        return;
      }
    } else if (Date.now() >= deadline) {
      service.status = 'ready';
      service.readyAt = Date.now();
      refreshReviewSessionStatus(task, session);
      return;
    }

    if (Date.now() >= deadline) {
      service.status = 'failed';
      service.error = probeUrl
        ? `Timed out waiting for ${probeUrl}`
        : 'Service did not become ready.';
      session.status = 'failed';
      session.updatedAt = Date.now();
      pushActivity(`Review environment failed for ${task.title}. ${service.name} did not become ready.`, 'warning');
      await stopTaskReviewEnvironment(task.id, { quiet: true, preserveFailure: true });
      return;
    }

    await wait(1000);
  }
}

async function startTaskReviewEnvironment(task) {
  if (task.lane !== 'review') {
    throw new Error('Only Review tasks can start services.');
  }

  if (activeRuns.has(task.id) || task.runStatus === 'running') {
    throw new Error('Wait for the task run to finish before starting review services.');
  }

  const existing = reviewSessions.get(task.id);
  if (existing && ['starting', 'ready', 'stopping'].includes(existing.status)) {
    throw new Error('Review services are already active for this task.');
  }

  const project = state.projects.find((item) => item.name === task.owner) || null;
  if (!project) {
    throw new Error('This task does not have a linked project.');
  }

  const configuredServices = normalizeProjectReviewServices(project.reviewServices);
  if (!configuredServices.length) {
    throw new Error(`Project ${project.name} has no review services configured yet.`);
  }

  const invalid = configuredServices.find((service) => !service.startCommand);
  if (invalid) {
    throw new Error(`Review service ${invalid.name || 'unnamed service'} is missing a start command.`);
  }

  const session = {
    taskId: task.id,
    taskTitle: task.title,
    projectName: project.name,
    status: 'starting',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    stopRequested: false,
    services: [],
  };
  reviewSessions.set(task.id, session);
  pushActivity(`Starting review environment for ${task.title}.`, 'busy');

  try {
    for (const configuredService of configuredServices) {
      const workspace = await resolveReviewServiceWorkspace(task, project, configuredService);
      const child = spawn('sh', ['-lc', configuredService.startCommand], {
        cwd: workspace.cwd,
        env: {
          ...process.env,
          PATH: process.env.PATH || '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          REVIEW_TASK_ID: task.id,
          REVIEW_PROJECT_NAME: project.name,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const service = {
        id: configuredService.id,
        name: configuredService.name || configuredService.repoRole || 'Review service',
        status: 'starting',
        repoRole: configuredService.repoRole,
        repoUrl: workspace.repo.url,
        cwd: workspace.cwd,
        startCommand: configuredService.startCommand,
        localUrl: configuredService.localUrl,
        healthcheckUrl: configuredService.healthcheckUrl,
        pid: child.pid,
        startedAt: Date.now(),
        logLines: [],
        error: null,
        process: child,
        exitPromise: null,
      };

      child.stdout.on('data', (chunk) => {
        appendReviewServiceLog(service, chunk, 'stdout');
        session.updatedAt = Date.now();
      });

      child.stderr.on('data', (chunk) => {
        appendReviewServiceLog(service, chunk, 'stderr');
        session.updatedAt = Date.now();
      });

      child.on('error', (error) => {
        service.error = error instanceof Error ? error.message : String(error);
        service.status = 'failed';
        session.status = 'failed';
        session.updatedAt = Date.now();
        pushActivity(`Review environment failed for ${task.title}. ${service.name} could not start.`, 'warning');
        stopTaskReviewEnvironment(task.id, { quiet: true, preserveFailure: true }).catch(() => {});
      });

      child.on('close', (code, signal) => {
        service.process = null;
        service.endedAt = Date.now();
        if (service.status === 'stopping') {
          service.status = 'stopped';
        } else if (service.status !== 'failed') {
          const unexpected = !session.stopRequested;
          if (unexpected) {
            service.status = 'failed';
            service.error = `Exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
            session.status = 'failed';
            pushActivity(`Review environment failed for ${task.title}. ${service.name} exited unexpectedly.`, 'warning');
            stopTaskReviewEnvironment(task.id, { quiet: true, preserveFailure: true }).catch(() => {});
          } else {
            service.status = 'stopped';
          }
        }
        refreshReviewSessionStatus(task, session);
      });

      session.services.push(service);
      monitorReviewService(task, session, service).catch(() => {});
    }
  } catch (error) {
    session.status = 'failed';
    session.updatedAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    const failedService = {
      id: nextId('service'),
      name: 'Review setup',
      status: 'failed',
      repoRole: '',
      repoUrl: '',
      cwd: '',
      startCommand: '',
      localUrl: '',
      healthcheckUrl: '',
      pid: null,
      startedAt: Date.now(),
      logLines: [],
      error: message,
      process: null,
      exitPromise: null,
    };
    if (!session.services.some((service) => service.status === 'failed')) {
      session.services.push(failedService);
    }
    await stopTaskReviewEnvironment(task.id, { quiet: true, preserveFailure: true });
    throw error;
  }

  refreshReviewSessionStatus(task, session);
  return summarizeReviewSession(session);
}

async function resolveDefaultBranch(repoDir) {

  try {
    const result = await runCommand(GIT_BIN, ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: repoDir });
    const branch = result.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
    if (branch) return branch;
  } catch {}

  try {
    const result = await runCommand(GIT_BIN, ['remote', 'show', 'origin'], { cwd: repoDir });
    const match = result.stdout.match(/HEAD branch:\s+(.+)/);
    const branch = match?.[1]?.trim();
    if (branch && branch !== '(unknown)') return branch;
  } catch {}

  try {
    const result = await runCommand(GIT_BIN, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'], { cwd: repoDir });
    const branch = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && line !== 'origin/HEAD')
      .map((line) => line.replace(/^origin\//, ''))[0];
    if (branch) return branch;
  } catch {}

  const localBranch = await runCommand(GIT_BIN, ['branch', '--show-current'], { cwd: repoDir }).catch(() => ({ stdout: '' }));
  return localBranch.stdout.trim() || null;
}

async function repoHasCommits(repoDir) {
  try {
    await runCommand(GIT_BIN, ['rev-parse', '--verify', 'HEAD'], { cwd: repoDir });
    return true;
  } catch {
    return false;
  }
}

async function prepareTaskExecutionContext(task) {
  const project = state.projects.find((item) => item.name === task.owner) || null;
  const primaryRepo = getProjectPrimaryRepo(project);
  if (!primaryRepo?.url) {
    return {
      cwd: ROOT_WORKSPACE,
      project: null,
      primaryRepo: null,
      repoDir: null,
      branchName: null,
    };
  }

  const ensured = await ensureBaseRepoClone(project);
  const repoDir = ensured.repoDir;
  const branchName = `task-${sanitizePathSegment(task.id)}`;

  if (!(await repoHasCommits(repoDir))) {
    await runCommand(GIT_BIN, ['checkout', '--orphan', branchName], { cwd: repoDir }).catch(() => {});
    return {
      cwd: repoDir,
      project,
      primaryRepo,
      repoDir,
      branchName,
    };
  }

  const defaultBranch = await resolveDefaultBranch(repoDir);
  const worktreeDir = path.join(AGENT_WORKSPACES_DIR, sanitizePathSegment(task.id));

  if (!(await pathExists(path.join(worktreeDir, '.git')))) {
    if (await pathExists(worktreeDir)) {
      await fs.rm(worktreeDir, { recursive: true, force: true });
    }
    const baseRef = defaultBranch ? `origin/${defaultBranch}` : 'HEAD';
    await runCommand(GIT_BIN, ['worktree', 'add', '-B', branchName, worktreeDir, baseRef], { cwd: repoDir });
  }

  return {
    cwd: worktreeDir,
    project,
    primaryRepo,
    repoDir,
    branchName,
  };
}

async function getCurrentBranch(repoDir) {
  const result = await runCommand(GIT_BIN, ['branch', '--show-current'], { cwd: repoDir }).catch(() => ({ stdout: '' }));
  return result.stdout.trim() || null;
}

async function publishTaskProjectChanges(task) {
  try {
    const project = state.projects.find((item) => item.name === task.owner) || null;
    if (!getProjectPrimaryRepo(project)?.url) {
      return { ok: true, message: 'No linked repo was configured for this task.' };
    }

    const { repoDir } = await ensureBaseRepoClone(project);
    const worktreeDir = path.join(AGENT_WORKSPACES_DIR, sanitizePathSegment(task.id));
    const cwd = (await pathExists(path.join(worktreeDir, '.git'))) ? worktreeDir : repoDir;
    const branchName = await getCurrentBranch(cwd);

    if (!branchName) {
      return { ok: false, message: 'No git branch is checked out for this task workspace.' };
    }

    const statusBefore = await runCommand(GIT_BIN, ['status', '--porcelain'], { cwd });
    if (statusBefore.stdout.trim()) {
      await runCommand(GIT_BIN, ['add', '-A'], { cwd });
      const staged = await runCommand(GIT_BIN, ['diff', '--cached', '--name-only'], { cwd }).catch(() => ({ stdout: '' }));
      if (staged.stdout.trim()) {
        await runCommand(GIT_BIN, ['commit', '-m', `Task ${task.id}: ${task.title}`], { cwd });
      }
    }

    const hasCommits = await repoHasCommits(cwd);
    if (!hasCommits) {
      return { ok: true, branchName, message: 'No commit was created because the repo still has no committed changes.' };
    }

    await runCommand(GIT_BIN, ['push', '-u', 'origin', branchName], { cwd, timeoutMs: 30000 });
    return { ok: true, branchName, message: `Committed and pushed ${branchName} to origin.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not publish this task's repo changes: ${message}` };
  }
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
  const activeRunByTaskId = new Map(Array.from(activeRuns.values()).map((run) => [run.taskId, run]));

  return {
    generatedAt: Date.now(),
    storage: {
      runHistoryDbPath: runLogger.path,
    },
    projects: [...state.projects].sort((a, b) => a.name.localeCompare(b.name)),
    lanes,
    tasks: [...state.tasks]
      .sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority] || (b.createdAt || 0) - (a.createdAt || 0))
      .map((task) => {
        const activeRun = activeRunByTaskId.get(task.id) || null;
        const reviewEnvironment = summarizeReviewSession(reviewSessions.get(task.id) || null);
        return {
          ...task,
          liveStatus: activeRun
            ? {
                message: buildLiveRunStatus(task, activeRun),
                startedAt: activeRun.startedAt,
              }
            : null,
          reviewEnvironment,
        };
      }),
    activity: state.activity.slice(0, 20),
    agents: mergedAgents,
    approvals: state.tasks.filter((task) => task.lane === 'approval'),
    activeRuns: Array.from(activeRuns.values()).map((run) => ({
      id: run.id,
      taskId: run.taskId,
      agentId: run.agentId,
      pid: run.pid,
      startedAt: run.startedAt,
      summary: buildLiveRunStatus(state.tasks.find((task) => task.id === run.taskId) || null, run),
    })),
    reviewEnvironments: Array.from(reviewSessions.values()).map((session) => ({
      taskId: session.taskId,
      ...summarizeReviewSession(session),
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
      reviewEnvironmentCount: countActiveReviewSessions(),
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
    projects: [],
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
      projects: Array.isArray(parsed.projects)
        ? parsed.projects
            .filter((project) => project && typeof project === 'object' && typeof project.name === 'string')
            .map((project) => {
              const repos = normalizeProjectRepos(project.repos, project.repoUrl);
              return {
                id: String(project.id || nextId('project')),
                name: String(project.name || '').trim(),
                repoUrl: getProjectRepoUrl({ repos, repoUrl: project.repoUrl }),
                repos,
                gitWorkflow: normalizeProjectWorkflow(project.gitWorkflow),
                reviewServices: normalizeProjectReviewServices(project.reviewServices),
                notes: String(project.notes || '').trim(),
                createdAt: Number(project.createdAt || Date.now()),
                updatedAt: Number(project.updatedAt || Date.now()),
              };
            })
        : [],
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

function scheduleServerRestart() {
  const logPath = '/tmp/agent-task-dashboard.log';
  const script = `sleep 1; exec "${process.execPath}" "${__filename}" >> "${logPath}" 2>&1`;
  const child = spawn('sh', ['-lc', script], {
    cwd: __dirname,
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 400).unref();
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

function normalizeProjectWorkflow(value) {
  const workflow = String(value || '').trim();
  return ['direct-main', 'feature-branches', 'agent-branch'].includes(workflow)
    ? workflow
    : 'feature-branches';
}

function normalizeProjectRepos(repos, fallbackRepoUrl = '') {
  const source = Array.isArray(repos) ? repos : [];
  const normalized = source
    .filter((repo) => repo && typeof repo === 'object')
    .map((repo, index) => ({
      id: String(repo.id || nextId('repo')),
      label: String(repo.label || '').trim(),
      role: String(repo.role || '').trim(),
      url: String(repo.url || '').trim(),
      primary: Boolean(repo.primary),
      order: index,
    }))
    .filter((repo) => repo.url);

  if (!normalized.length && String(fallbackRepoUrl || '').trim()) {
    normalized.push({
      id: nextId('repo'),
      label: 'Primary repo',
      role: 'app',
      url: String(fallbackRepoUrl || '').trim(),
      primary: true,
      order: 0,
    });
  }

  if (!normalized.length) {
    return normalized;
  }

  let primaryIndex = normalized.findIndex((repo) => repo.primary);
  if (primaryIndex === -1) {
    primaryIndex = 0;
  }

  return normalized.map(({ order, ...repo }, index) => ({
    ...repo,
    primary: index === primaryIndex,
  }));
}

function normalizeProjectReviewServices(services) {
  return (Array.isArray(services) ? services : [])
    .filter((service) => service && typeof service === 'object')
    .map((service) => ({
      id: String(service.id || nextId('service')),
      name: String(service.name || '').trim(),
      repoRole: String(service.repoRole || '').trim(),
      workingDirectory: String(service.workingDirectory || '').trim(),
      startCommand: String(service.startCommand || '').trim(),
      localUrl: String(service.localUrl || '').trim(),
      healthcheckUrl: String(service.healthcheckUrl || '').trim(),
    }))
    .filter((service) => service.name || service.repoRole || service.workingDirectory || service.startCommand || service.localUrl || service.healthcheckUrl);
}

function getProjectRepos(project) {
  return normalizeProjectRepos(project?.repos, project?.repoUrl);
}

function getProjectPrimaryRepo(project) {
  const repos = getProjectRepos(project);
  return repos.find((repo) => repo.primary) || repos[0] || null;
}

function getProjectRepoUrl(project) {
  return getProjectPrimaryRepo(project)?.url || '';
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

function extractLatestProgressLine(raw) {
  const cleaned = sanitizeRunNote(raw);
  if (!cleaned) {
    return null;
  }

  const lines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('{') && !line.startsWith('Summary'));

  return lines.at(-1) || null;
}

function buildLiveRunStatus(task, run) {
  if (!run) {
    return null;
  }

  const agentName = agentCatalog.find((agent) => agent.id === run.agentId)?.name || 'Agent';
  const progressLine = extractLatestProgressLine(run.stderr) || extractLatestProgressLine(run.stdout);
  if (progressLine) {
    return progressLine.slice(0, 180);
  }

  const ageMs = Math.max(0, Date.now() - Number(run.startedAt || Date.now()));
  if (ageMs < 15000) {
    return `${agentName} claimed the task and is preparing the workspace.`;
  }
  if (ageMs < 60000) {
    return `${agentName} is reviewing the task and repo context.`;
  }
  if (ageMs < 180000) {
    return `${agentName} is making changes in the background.`;
  }
  return `${agentName} is still working in the background.`;
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
