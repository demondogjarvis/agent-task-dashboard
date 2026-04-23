const priorityRank = { critical: 4, high: 3, medium: 2, low: 1 };
const skillLabels = {
  frontend: 'Frontend',
  backend: 'Backend',
  ops: 'Ops',
  qa: 'QA',
  automation: 'Automation',
  product: 'Product',
};

const DONE_HISTORY_WINDOW_MS = 8 * 60 * 60 * 1000;
const DONE_HISTORY_MINIMUM = 4;

const viewMeta = {
  overview: {
    title: 'Overview',
    description: 'See the current approval load, ready queue, active specialists, and the latest movement across the system.',
  },
  tasks: {
    title: 'Tasks',
    description: 'Define work, approve it, and move it through the execution lanes.',
  },
  projects: {
    title: 'Projects',
    description: 'Create and manage the project list that feeds task creation and task editing.',
  },
  agents: {
    title: 'Agents',
    description: 'Browse the specialist agents that exist, what they handle, and their current token footprint.',
  },
  runtime: {
    title: 'Runtime',
    description: 'Inspect OpenClaw session telemetry, tracked background state, and orchestration events.',
  },
  history: {
    title: 'History',
    description: 'Browse every completed task while the Done column stays focused on recent completions.',
  },
  'system-history': {
    title: 'System History',
    description: 'Review broader OpenClaw task history and session activity outside the dashboard-owned run log.',
  },
};

let dashboard = null;
let pollHandle = null;
let isMutating = false;
let pendingReassignTaskId = null;
let selectedTaskId = null;
let taskDetailDraftTaskId = null;
let isTaskEditMode = false;
let selectedProjectId = null;

const statsGrid = document.getElementById('stats-grid');
const approvalList = document.getElementById('approval-list');
const approvalCountPill = document.getElementById('approval-count-pill');
const overviewApprovalList = document.getElementById('overview-approval-list');
const overviewApprovalPill = document.getElementById('overview-approval-pill');
const overviewReadyList = document.getElementById('overview-ready-list');
const overviewReadyPill = document.getElementById('overview-ready-pill');
const overviewAgentPreview = document.getElementById('overview-agent-preview');
const overviewAgentPill = document.getElementById('overview-agent-pill');
const overviewActivityList = document.getElementById('overview-activity-list');
const kanbanBoard = document.getElementById('kanban-board');
const agentList = document.getElementById('agent-list');
const usageList = document.getElementById('usage-list');
const activityList = document.getElementById('activity-list');
const sessionList = document.getElementById('session-list');
const backgroundTaskList = document.getElementById('background-task-list');
const historyList = document.getElementById('history-list');
const historySummary = document.getElementById('history-summary');
const runList = document.getElementById('run-list');
const runSummary = document.getElementById('run-summary');
const systemTaskHistoryList = document.getElementById('system-task-history-list');
const systemTaskHistorySummary = document.getElementById('system-task-history-summary');
const systemTaskHistoryCountPill = document.getElementById('system-task-history-count-pill');
const systemSessionHistoryList = document.getElementById('system-session-history-list');
const systemSessionHistorySummary = document.getElementById('system-session-history-summary');
const systemSessionHistoryCountPill = document.getElementById('system-session-history-count-pill');
const taskForm = document.getElementById('task-form');
const tokenTotalPill = document.getElementById('token-total-pill');
const runningAgentsPill = document.getElementById('running-agents-pill');
const sessionCountPill = document.getElementById('session-count-pill');
const backgroundTaskPill = document.getElementById('background-task-pill');
const historyCountPill = document.getElementById('history-count-pill');
const runCountPill = document.getElementById('run-count-pill');
const agentCountPill = document.getElementById('agent-count-pill');
const seedReadyButton = document.getElementById('seed-ready-button');
const newTaskButton = document.getElementById('new-task-button');
const refreshButton = document.getElementById('refresh-button');
const pageTitle = document.getElementById('page-title');
const pageDescription = document.getElementById('page-description');
const projectList = document.getElementById('project-list');
const projectSummary = document.getElementById('project-summary');
const projectCountPill = document.getElementById('project-count-pill');
const projectFormModePill = document.getElementById('project-form-mode-pill');
const projectForm = document.getElementById('project-form');
const projectNameInput = document.getElementById('project-name');
const projectRepoUrlInput = document.getElementById('project-repo-url');
const projectNotesInput = document.getElementById('project-notes');
const projectGitWorkflowSelect = document.getElementById('project-git-workflow');
const projectSubmitButton = document.getElementById('project-submit-button');
const projectCancelButton = document.getElementById('project-cancel-button');
const taskDetailDrawer = document.getElementById('task-detail-drawer');
const taskDetailBackdrop = document.getElementById('task-detail-backdrop');
const taskDetailCloseButton = document.getElementById('task-detail-close');
const taskDetailEditToggle = document.getElementById('task-detail-edit-toggle');
const taskDetailTitle = document.getElementById('task-detail-title');
const taskDetailSummary = document.getElementById('task-detail-summary');
const taskDetailTags = document.getElementById('task-detail-tags');
const taskDetailNotes = document.getElementById('task-detail-notes');
const taskDetailEditSection = document.getElementById('task-detail-edit-section');
const taskEditForm = document.getElementById('task-edit-form');
const taskEditTitle = document.getElementById('task-edit-title');
const taskEditPriority = document.getElementById('task-edit-priority');
const taskEditAgent = document.getElementById('task-edit-agent');
const taskEditOwner = document.getElementById('task-edit-owner');
const taskEditNotes = document.getElementById('task-edit-notes');
const taskCommentCount = document.getElementById('task-comment-count');
const taskCommentList = document.getElementById('task-comment-list');
const taskCommentForm = document.getElementById('task-comment-form');
const taskEditSubmitButton = taskEditForm.querySelector('button[type="submit"]');
const taskCommentSubmitButton = taskCommentForm.querySelector('button[type="submit"]');
const taskCommentAuthor = document.getElementById('task-comment-author');
const taskCommentBody = document.getElementById('task-comment-body');
const taskDetailRunStatus = document.getElementById('task-detail-run-status');
const taskDetailOutput = document.getElementById('task-detail-output');
const taskDetailError = document.getElementById('task-detail-error');
const taskRunHistoryCount = document.getElementById('task-run-history-count');
const taskRunHistory = document.getElementById('task-run-history');
const taskDetailActions = document.getElementById('task-detail-actions');
const reassignDialog = document.getElementById('reassign-dialog');
const reassignTaskTitle = document.getElementById('reassign-task-title');
const reassignAgentSelect = document.getElementById('reassign-agent-select');
const reassignConfirmButton = document.getElementById('reassign-confirm-button');
const reassignCancelButton = document.getElementById('reassign-cancel-button');
const cardTemplate = document.getElementById('task-card-template');
const THEME_STORAGE_KEY = 'jarvis-theme';
const themeToggleButton = document.getElementById('theme-toggle-button');
const themeToggleLabel = document.getElementById('theme-toggle-label');

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof data === 'string' ? data : data?.message || data?.error || 'Request failed';
    throw new Error(message);
  }

  return data;
}

function getStoredTheme() {
  try {
    const theme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return theme === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function applyTheme(theme, persist = true) {
  const resolved = theme === 'dark' ? 'dark' : 'light';
  document.body.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;

  if (themeToggleButton) {
    themeToggleButton.checked = resolved === 'dark';
    themeToggleButton.setAttribute('aria-checked', resolved === 'dark' ? 'true' : 'false');
  }

  if (themeToggleLabel) {
    themeToggleLabel.textContent = resolved === 'dark' ? 'Dark mode' : 'Light mode';
  }

  if (persist) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, resolved);
    } catch {
      // ignore storage failures
    }
  }
}

function initTheme() {
  applyTheme(getStoredTheme(), false);
}

function toggleTheme() {
  applyTheme(themeToggleButton?.checked ? 'dark' : 'light');
}

function getCurrentView() {
  const view = window.location.hash.replace('#', '') || 'overview';
  return viewMeta[view] ? view : 'overview';
}

function applyView() {
  const view = getCurrentView();
  const meta = viewMeta[view];

  pageTitle.textContent = meta.title;
  pageDescription.textContent = meta.description;

  document.querySelectorAll('.page-view').forEach((section) => {
    section.classList.toggle('active', section.dataset.view === view);
  });

  document.querySelectorAll('[data-view-link]').forEach((button) => {
    button.classList.toggle('active', button.dataset.viewLink === view);
  });

  if (view !== 'tasks') {
    closeTaskDetail();
  }
}

function populateFormOptions() {
  const agentSelect = document.getElementById('task-agent');
  const projectSelect = document.getElementById('task-owner');

  const currentAgentValue = agentSelect.value;
  const currentProjectValue = projectSelect.value;

  agentSelect.innerHTML = dashboard.agents
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (agent) => `<option value="${agent.id}">${escapeHtml(agent.name)} (${escapeHtml(skillLabels[agent.specialty] || agent.specialty)})</option>`
    )
    .join('');

  const projects = getSortedProjects();
  const projectOptions = projects.length
    ? ['<option value="">Select a project</option>', ...projects.map((project) => `<option value="${escapeHtml(getProjectName(project))}">${escapeHtml(getProjectName(project))}</option>`)]
    : ['<option value="">No projects yet</option>'];
  projectSelect.innerHTML = projectOptions.join('');

  if (currentAgentValue && dashboard.agents.some((agent) => agent.id === currentAgentValue)) {
    agentSelect.value = currentAgentValue;
  }

  if (currentProjectValue && projects.some((project) => getProjectName(project) === currentProjectValue)) {
    projectSelect.value = currentProjectValue;
  } else if (projects.length && !currentProjectValue) {
    projectSelect.value = getProjectName(projects[0]);
  }
}

function populateAgentSelectOptions(selectElement, selectedValue = '') {
  selectElement.innerHTML = dashboard.agents
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (agent) => `<option value="${agent.id}">${escapeHtml(agent.name)} (${escapeHtml(skillLabels[agent.specialty] || agent.specialty)})</option>`
    )
    .join('');

  if (selectedValue && dashboard.agents.some((agent) => agent.id === selectedValue)) {
    selectElement.value = selectedValue;
  }
}

function getProjectName(project) {
  return typeof project === 'string' ? project : project?.name || '';
}

function getProjectRepoUrl(project) {
  return typeof project === 'string' ? '' : project?.repoUrl || '';
}

function getProjectGitWorkflow(project) {
  return typeof project === 'string' ? 'feature-branches' : project?.gitWorkflow || 'feature-branches';
}

function getProjectWorkflowLabel(project) {
  const workflow = getProjectGitWorkflow(project);
  if (workflow === 'direct-main') return 'Update main directly';
  if (workflow === 'agent-branch') return 'Dedicated agent branch';
  return 'Use feature branches';
}

function getSortedProjects() {
  return [...(dashboard.projects || [])].filter(Boolean).sort((a, b) => getProjectName(a).localeCompare(getProjectName(b)));
}

function populateProjectSelectOptions(selectElement, selectedValue = '', { allowFallback = true, includePlaceholder = false } = {}) {
  const projects = getSortedProjects();
  const options = [];

  if (includePlaceholder) {
    options.push('<option value="">Select a project</option>');
  }

  if (projects.length) {
    options.push(...projects.map((project) => `<option value="${escapeHtml(getProjectName(project))}">${escapeHtml(getProjectName(project))}</option>`));
  } else if (!includePlaceholder) {
    options.push('<option value="">No projects yet</option>');
  }

  if (allowFallback && selectedValue && !projects.some((project) => getProjectName(project) === selectedValue)) {
    options.push(`<option value="${escapeHtml(selectedValue)}">${escapeHtml(selectedValue)}</option>`);
  }

  selectElement.innerHTML = options.join('');

  if (selectedValue) {
    selectElement.value = selectedValue;
  }
}

function findAgent(agentId) {
  return dashboard?.agents.find((agent) => agent.id === agentId) || null;
}

function relativeTime(timestamp) {
  if (!timestamp) return 'n/a';
  const diffMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  return minutes ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
}

function priorityClass(priority) {
  return ['critical', 'high', 'medium', 'low'].includes(priority) ? priority : 'medium';
}

function truncate(text, max = 170) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cleanRuntimeNote(text) {
  if (!text) return '';

  const withoutJson = text.replace(/\{[\s\S]*$/, '').trim();
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

  return filtered;
}

function getTaskCompletionTime(task) {
  return task.completedAt || task.updatedAt || task.lastRun?.finishedAt || task.createdAt || 0;
}

function getDoneTasks() {
  return dashboard.tasks
    .filter((task) => task.lane === 'done')
    .sort((a, b) => getTaskCompletionTime(b) - getTaskCompletionTime(a) || priorityRank[b.priority] - priorityRank[a.priority]);
}

function getVisibleDoneTasks(doneTasks = getDoneTasks()) {
  const cutoff = Date.now() - DONE_HISTORY_WINDOW_MS;
  const recentDoneTasks = doneTasks.filter((task) => getTaskCompletionTime(task) >= cutoff);
  return recentDoneTasks.length >= DONE_HISTORY_MINIMUM
    ? recentDoneTasks
    : doneTasks.slice(0, Math.min(DONE_HISTORY_MINIMUM, doneTasks.length));
}

function getDoneColumnMessage(doneTasks, visibleDoneTasks) {
  const cutoff = Date.now() - DONE_HISTORY_WINDOW_MS;
  const recentDoneCount = doneTasks.filter((task) => getTaskCompletionTime(task) >= cutoff).length;

  if (!doneTasks.length) {
    return 'Completed tasks will land here, with full history available once the board has some wins.';
  }

  if (recentDoneCount >= DONE_HISTORY_MINIMUM) {
    return 'Showing every task completed in the last 8 hours.';
  }

  if (doneTasks.length <= DONE_HISTORY_MINIMUM) {
    return 'Showing every completed task currently on the board.';
  }

  return `Showing the latest ${visibleDoneTasks.length} completed tasks.`;
}

function formatDateTime(timestamp) {
  if (!timestamp) return 'n/a';
  return new Date(timestamp).toLocaleString();
}

function formatDuration(durationMs) {
  if (!durationMs) return 'n/a';
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function getStatusClass(status) {
  return ['succeeded', 'success', 'done', 'completed'].includes(status)
    ? 'success'
    : ['failed', 'timed_out', 'cancelled', 'lost'].includes(status)
      ? 'warning'
      : 'neutral';
}

function buildRunCard(run, { compact = false } = {}) {
  const summary = truncate(run.summaryText || run.outputText || run.errorText || '', compact ? 140 : 260);
  const details = [
    run.agentName || run.agentId,
    run.model || 'model pending',
    run.usage?.total ? `${run.usage.total.toLocaleString()} tokens` : 'usage pending',
    run.durationMs ? formatDuration(run.durationMs) : run.status === 'running' ? 'in progress' : 'duration n/a',
  ];

  return `
    <article class="history-card">
      <div class="history-card-header">
        <div>
          <p class="eyebrow">${escapeHtml(formatDateTime(run.startedAt))}</p>
          <h3>${escapeHtml(run.taskTitle)}</h3>
        </div>
        <span class="pill ${getStatusClass(run.status)}">${escapeHtml(run.status)}</span>
      </div>
      <div class="task-meta">
        <span class="tag">${escapeHtml(run.owner || 'No stream')}</span>
        <span class="tag">${escapeHtml(skillLabels[run.skill] || run.skill || 'Unknown skill')}</span>
        ${details.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join('')}
      </div>
      ${summary ? `<p class="task-run-note">${escapeHtml(summary)}</p>` : ''}
      ${run.failureDetails || run.errorText ? `<p class="task-run-note error-note">${escapeHtml(truncate(run.failureDetails || run.errorText, compact ? 180 : 320))}</p>` : ''}
    </article>
  `;
}

function buildSystemTaskCard(task) {
  const summary = truncate(task.summary || '', 320);
  const details = [
    task.runtime || 'unknown runtime',
    task.agentId || 'agent n/a',
    task.sessionKey || 'session n/a',
    task.runId || 'run id n/a',
  ];

  return `
    <article class="history-card">
      <div class="history-card-header">
        <div>
          <p class="eyebrow">${escapeHtml(formatDateTime(task.updatedAt || task.startedAt || task.createdAt))}</p>
          <h3>${escapeHtml(task.label)}</h3>
        </div>
        <span class="pill ${getStatusClass(task.status)}">${escapeHtml(task.status)}</span>
      </div>
      <div class="task-meta">
        ${details.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join('')}
      </div>
      ${summary ? `<p class="task-run-note">${escapeHtml(summary)}</p>` : ''}
    </article>
  `;
}

function buildSystemSessionCard(session) {
  const detailTags = [
    session.agentId || 'agent n/a',
    session.kind || 'kind n/a',
    session.model || 'model unknown',
    `${(session.totalTokens || 0).toLocaleString()} tokens`,
    session.thinkingLevel ? `thinking ${session.thinkingLevel}` : null,
    session.systemSent ? 'system-sent' : null,
    session.abortedLastRun ? 'last run aborted' : null,
  ].filter(Boolean);

  return `
    <article class="history-card">
      <div class="history-card-header">
        <div>
          <p class="eyebrow">${escapeHtml(formatDateTime(session.updatedAt))}</p>
          <h3>${escapeHtml(session.key || session.sessionId || 'Session')}</h3>
        </div>
        <span class="pill neutral">session</span>
      </div>
      <div class="task-meta">
        ${detailTags.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join('')}
      </div>
    </article>
  `;
}

function renderStats() {
  const { metrics, openclaw } = dashboard;
  const statCards = [
    {
      label: 'Tasks in flow',
      value: metrics.taskCount,
      detail: `${metrics.readyCount} ready, ${metrics.approvalCount} waiting for approval`,
    },
    {
      label: 'Live agents running',
      value: metrics.busyAgentCount,
      detail: `${dashboard.agents.filter((agent) => agent.status === 'idle').length} idle and ready`,
    },
    {
      label: 'Session tokens',
      value: metrics.totalSessionTokens.toLocaleString(),
      detail: `${openclaw.sessions.length} OpenClaw session${openclaw.sessions.length === 1 ? '' : 's'} tracked`,
    },
    {
      label: 'Completed after review',
      value: metrics.doneCount,
      detail: `${dashboard.activeRuns.length} active process${dashboard.activeRuns.length === 1 ? '' : 'es'}`,
    },
  ];

  statsGrid.innerHTML = statCards
    .map(
      (card) => `
        <article class="stat-card">
          <p class="stat-label">${card.label}</p>
          <div class="stat-value">${card.value}</div>
          <p class="stat-detail">${card.detail}</p>
        </article>
      `
    )
    .join('');

  approvalCountPill.textContent = `${metrics.approvalCount} waiting`;
  overviewApprovalPill.textContent = `${metrics.approvalCount} waiting`;
  overviewReadyPill.textContent = `${metrics.readyCount} ready`;
  overviewAgentPill.textContent = `${dashboard.agents.length} agents`;
  runningAgentsPill.textContent = `${metrics.busyAgentCount} running`;
  tokenTotalPill.textContent = `${metrics.totalSessionTokens.toLocaleString()} tokens`;
  sessionCountPill.textContent = `${openclaw.sessions.length} sessions`;
  backgroundTaskPill.textContent = `${dashboard.activeRuns.length + openclaw.backgroundTasks.length} tracked`;
  historyCountPill.textContent = `${metrics.doneCount} completed`;
  runCountPill.textContent = `${dashboard.runs.length} runs`;
  agentCountPill.textContent = `${dashboard.agents.length} agents`;
}

function buildTaskActions(task, options = {}) {
  const { compact = false, includeSecondary = !compact } = options;
  const actions = [];
  const laneIndex = dashboard.lanes.findIndex((lane) => lane.id === task.lane);
  const isRunning = task.runStatus === 'running';

  if (!isRunning && laneIndex > 0) {
    actions.push(`<button class="button ghost ${compact ? 'compact-action' : ''}" data-action="move-left" data-task-id="${task.id}">Back</button>`);
  }

  if (task.lane === 'approval') {
    actions.push(`<button class="button primary ${compact ? 'compact-action' : ''}" data-action="approve" data-task-id="${task.id}">Approve</button>`);
  } else if (task.lane === 'ready') {
    actions.push(`<button class="button primary ${compact ? 'compact-action' : ''}" data-action="assign" data-task-id="${task.id}">Assign</button>`);
  } else if (task.lane === 'review') {
    actions.push(`<button class="button primary ${compact ? 'compact-action' : ''}" data-action="move-right" data-task-id="${task.id}">Complete</button>`);
  } else if (!isRunning && laneIndex < dashboard.lanes.length - 1 && !['ready', 'approval', 'done'].includes(task.lane)) {
    actions.push(`<button class="button ghost ${compact ? 'compact-action' : ''}" data-action="move-right" data-task-id="${task.id}">Next</button>`);
  }

  if (includeSecondary && !isRunning && task.lane !== 'done') {
    actions.push(`<button class="button ghost" data-action="reassign" data-task-id="${task.id}">Reassign</button>`);
  }

  if (includeSecondary && !isRunning) {
    actions.push(`<button class="button ghost danger" data-action="delete" data-task-id="${task.id}">Delete</button>`);
  }

  return actions.join('');
}

function buildSummaryTaskCard(task, mode) {
  const actionLabel = mode === 'approval' ? 'Approve' : mode === 'ready' ? 'Assign' : null;
  const action = actionLabel
    ? `<button class="button ${mode === 'approval' ? 'ghost' : 'primary'}" data-action="${mode === 'approval' ? 'approve' : 'assign'}" data-task-id="${task.id}">${actionLabel}</button>`
    : '';

  return `
    <article class="approval-item">
      <h3>${task.title}</h3>
      <p>${task.notes || 'No definition notes provided.'}</p>
      <div class="approval-actions">
        <span class="tag">${task.priority}</span>
        <span class="tag">${skillLabels[task.skill] || task.skill}</span>
        ${action}
      </div>
    </article>
  `;
}

function renderOverview() {
  const approvals = dashboard.approvals.slice(0, 4);
  const readyTasks = dashboard.tasks.filter((task) => task.lane === 'ready').slice(0, 4);
  const agents = dashboard.agents.slice().sort((a, b) => a.name.localeCompare(b.name));
  const activity = dashboard.activity.slice(0, 6);

  overviewApprovalList.innerHTML = approvals.length
    ? approvals.map((task) => buildSummaryTaskCard(task, 'approval')).join('')
    : '<div class="empty-state">Nothing is waiting for approval right now.</div>';

  overviewReadyList.innerHTML = readyTasks.length
    ? readyTasks.map((task) => buildSummaryTaskCard(task, 'ready')).join('')
    : '<div class="empty-state">No approved tasks are waiting for assignment.</div>';

  overviewAgentPreview.innerHTML = agents.length
    ? agents
        .map(
          (agent) => `
            <article class="agent-card">
              <div class="agent-status-row">
                <h3>${agent.emoji} ${agent.name}</h3>
                <span class="status-pill status-${agent.status === 'busy' ? 'busy' : agent.status === 'idle' ? 'idle' : 'offline'}">${agent.status}</span>
              </div>
              <p>${skillLabels[agent.specialty] || agent.specialty}</p>
            </article>
          `
        )
        .join('')
    : '<div class="empty-state">No agents found.</div>';

  overviewActivityList.innerHTML = activity.length
    ? activity
        .map(
          (item) => `
            <article class="activity-item">
              <div class="activity-header">
                <strong>${item.tone === 'warning' ? 'Attention' : item.tone === 'busy' ? 'Agent run' : 'Update'}</strong>
                <small>${relativeTime(item.time)}</small>
              </div>
              <p>${item.message}</p>
            </article>
          `
        )
        .join('')
    : '<div class="empty-state">No recent activity.</div>';
}

function renderApprovals() {
  approvalList.innerHTML = '';
  if (!dashboard.approvals.length) {
    approvalList.innerHTML = '<div class="empty-state">Nothing is waiting for approval right now.</div>';
    return;
  }

  approvalList.innerHTML = dashboard.approvals.map((task) => buildSummaryTaskCard(task, 'approval')).join('');
}

function renderKanban() {
  kanbanBoard.innerHTML = '';
  const doneTasks = getDoneTasks();
  const visibleDoneTasks = getVisibleDoneTasks(doneTasks);

  dashboard.lanes.forEach((lane) => {
    const tasks = (lane.id === 'done' ? visibleDoneTasks : dashboard.tasks.filter((task) => task.lane === lane.id))
      .sort((a, b) => {
        if (lane.id === 'done') {
          return getTaskCompletionTime(b) - getTaskCompletionTime(a) || priorityRank[b.priority] - priorityRank[a.priority];
        }
        return priorityRank[b.priority] - priorityRank[a.priority] || (b.createdAt || 0) - (a.createdAt || 0);
      });

    const countLabel =
      lane.id === 'done'
        ? `${tasks.length} shown${doneTasks.length > tasks.length ? ` of ${doneTasks.length}` : ''}`
        : `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;

    const column = document.createElement('section');
    column.className = 'kanban-column';
    column.innerHTML = `
      <div class="column-header">
        <div>
          <h3>${lane.title}</h3>
          <span class="column-count">${countLabel}</span>
        </div>
      </div>
      <div class="task-stack"></div>
    `;

    const stack = column.querySelector('.task-stack');
    if (!tasks.length) {
      stack.innerHTML = `<div class="empty-state">${lane.id === 'done' ? 'No completed tasks yet.' : 'No tasks in this lane.'}</div>`;
    }

    tasks.forEach((task) => {
      const node = cardTemplate.content.firstElementChild.cloneNode(true);
      const agent = findAgent(task.assignedAgentId);
      const notesNode = node.querySelector('.task-notes');

      node.dataset.taskId = task.id;
      node.setAttribute('tabindex', '0');
      node.setAttribute('role', 'button');
      node.setAttribute('aria-label', `Open details for ${task.title}`);
      node.classList.add('compact-task-card');

      node.querySelector('.priority-dot').classList.add(priorityClass(task.priority));
      node.querySelector('.task-priority-label').textContent = task.priority;
      node.querySelector('.task-owner').textContent = task.owner || 'No stream';
      node.querySelector('.task-title').textContent = task.title;
      node.querySelector('.skill-tag').textContent = skillLabels[task.skill] || task.skill;
      node.querySelector('.assignee-tag').textContent = agent
        ? `${agent.emoji} ${agent.name}${task.runStatus === 'running' ? ' running' : ''}`
        : 'Unassigned';
      node.querySelector('.task-actions').innerHTML = buildTaskActions(task, { compact: true });
      notesNode.remove();

      if (task.preferredAgentId) {
        const preferredAgent = findAgent(task.preferredAgentId);
        if (preferredAgent) {
          const preferredTag = document.createElement('span');
          preferredTag.className = 'tag';
          preferredTag.textContent = `Preferred: ${preferredAgent.name}`;
          node.querySelector('.task-meta').appendChild(preferredTag);
        }
      }

      if (lane.id === 'done') {
        const completedTag = document.createElement('span');
        completedTag.className = 'tag';
        completedTag.textContent = `Completed ${relativeTime(getTaskCompletionTime(task))}`;
        node.querySelector('.task-meta').appendChild(completedTag);
      } else if (task.runStatus === 'running') {
        const statusTag = document.createElement('span');
        statusTag.className = 'tag';
        statusTag.textContent = 'Live run';
        node.querySelector('.task-meta').appendChild(statusTag);
      } else if (task.lastRun?.status && task.lastRun.status !== 'idle') {
        const statusTag = document.createElement('span');
        statusTag.className = 'tag';
        statusTag.textContent = `Run: ${task.lastRun.status}`;
        node.querySelector('.task-meta').appendChild(statusTag);
      }

      node.addEventListener('click', (event) => {
        if (event.target.closest('button, a')) {
          return;
        }
        openTaskDetail(task.id);
      });

      node.addEventListener('keydown', (event) => {
        if (event.target.closest('button, a')) {
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openTaskDetail(task.id);
        }
      });

      stack.appendChild(node);
    });

    if (lane.id === 'done') {
      const footer = document.createElement('div');
      footer.className = 'column-footer';
      footer.innerHTML = `
        <p class="column-footnote">${getDoneColumnMessage(doneTasks, visibleDoneTasks)}</p>
        <a class="column-link" href="#history">See history</a>
      `;
      column.appendChild(footer);
    }

    kanbanBoard.appendChild(column);
  });
}

function renderAgents() {
  const sorted = [...dashboard.agents].sort((a, b) => a.name.localeCompare(b.name));

  agentList.innerHTML = sorted.length
    ? sorted
        .map(
          (agent) => `
            <article class="agent-card">
              <div class="agent-status-row">
                <h3>${agent.emoji} ${agent.name}</h3>
                <span class="status-pill status-${agent.status === 'busy' ? 'busy' : agent.status === 'idle' ? 'idle' : 'offline'}">${agent.status}</span>
              </div>
              <p>${agent.capability}</p>
              <div class="agent-meta">
                <span class="tag">${skillLabels[agent.specialty] || agent.specialty}</span>
                <span class="tag">${agent.model || 'model pending'}</span>
                <span class="tag">${agent.latestUsageTokens.toLocaleString()} tokens</span>
              </div>
              <p>${agent.currentTaskTitle ? `Working on: ${agent.currentTaskTitle}` : agent.lastTaskTitle ? `Last task: ${agent.lastTaskTitle}` : 'No task attached.'}</p>
              <p>${agent.sessionKey ? `Session: ${agent.sessionKey}` : 'No live session recorded yet.'}</p>
            </article>
          `
        )
        .join('')
    : '<div class="empty-state">No agents found.</div>';
}

function renderUsage() {
  const maxTokens = Math.max(...dashboard.agents.map((agent) => agent.latestUsageTokens), 1);
  usageList.innerHTML = dashboard.agents.length
    ? dashboard.agents
        .slice()
        .sort((a, b) => b.latestUsageTokens - a.latestUsageTokens)
        .map((agent) => {
          const percent = Math.round((agent.latestUsageTokens / maxTokens) * 100);
          return `
            <article class="usage-card">
              <div class="usage-bar-row">
                <h3>${agent.emoji} ${agent.name}</h3>
                <span>${agent.latestUsageTokens.toLocaleString()} tokens</span>
              </div>
              <p>${agent.sessionKey ? `Latest session updated ${relativeTime(agent.sessionUpdatedAt)}.` : 'No session usage yet.'}</p>
              <div class="progress-track">
                <div class="progress-fill" style="width: ${percent}%"></div>
              </div>
              <div class="usage-meta">
                <span class="tag">${skillLabels[agent.specialty] || agent.specialty}</span>
                <span class="tag">${percent}% of current max observed</span>
              </div>
            </article>
          `;
        })
        .join('')
    : '<div class="empty-state">No usage data yet.</div>';
}

function renderActivity() {
  activityList.innerHTML = dashboard.activity.length
    ? dashboard.activity
        .map(
          (item) => `
            <article class="activity-item">
              <div class="activity-header">
                <strong>${item.tone === 'warning' ? 'Attention' : item.tone === 'busy' ? 'Agent run' : 'Update'}</strong>
                <small>${relativeTime(item.time)}</small>
              </div>
              <p>${item.message}</p>
            </article>
          `
        )
        .join('')
    : '<div class="empty-state">No activity captured yet.</div>';
}

function renderSessions() {
  sessionList.innerHTML = dashboard.openclaw.sessions.length
    ? dashboard.openclaw.sessions
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map(
          (session) => `
            <article class="activity-item">
              <div class="activity-header">
                <strong>${session.agentId}</strong>
                <small>${relativeTime(session.updatedAt)}</small>
              </div>
              <p>${session.key}</p>
              <p>${(session.totalTokens || 0).toLocaleString()} total tokens, model ${session.model || 'unknown'}.</p>
            </article>
          `
        )
        .join('')
    : '<div class="empty-state">No OpenClaw sessions are visible yet.</div>';
}

function renderBackgroundTasks() {
  const activeProcessRows = dashboard.activeRuns.map((run) => {
    const task = dashboard.tasks.find((item) => item.id === run.taskId);
    const agent = findAgent(run.agentId);
    return {
      title: task?.title || run.taskId,
      detail: `${agent ? `${agent.emoji} ${agent.name}` : run.agentId} is running it, pid ${run.pid}.`,
      updatedAt: run.startedAt,
      kind: 'Active process',
    };
  });

  const taskRows = dashboard.openclaw.backgroundTasks.map((task) => ({
    title: task.id || task.taskId || 'OpenClaw task',
    detail: `${task.runtime || 'runtime'} · ${task.status || 'status unknown'}`,
    updatedAt: task.updatedAt || task.startedAt || dashboard.generatedAt,
    kind: 'Gateway task',
  }));

  const rows = [...activeProcessRows, ...taskRows];
  backgroundTaskList.innerHTML = rows.length
    ? rows
        .map(
          (item) => `
            <article class="activity-item">
              <div class="activity-header">
                <strong>${item.kind}</strong>
                <small>${relativeTime(item.updatedAt)}</small>
              </div>
              <p>${item.title}</p>
              <p>${item.detail}</p>
            </article>
          `
        )
        .join('')
    : '<div class="empty-state">No background tasks or active agent processes right now.</div>';
}

function renderHistory() {
  const doneTasks = getDoneTasks();

  historySummary.textContent = doneTasks.length
    ? `${doneTasks.length} completed task${doneTasks.length === 1 ? '' : 's'}, newest first.`
    : 'Completed tasks will appear here once work starts closing out.';

  historyList.innerHTML = doneTasks.length
    ? doneTasks
        .map((task) => {
          const agent = findAgent(task.assignedAgentId);
          const outputPreview = task.lastRun?.output ? truncate(task.lastRun.output, 260) : '';
          return `
            <article class="history-card">
              <div class="history-card-header">
                <div>
                  <p class="eyebrow">Completed ${relativeTime(getTaskCompletionTime(task))}</p>
                  <h3>${task.title}</h3>
                </div>
                <span class="pill success">Done</span>
              </div>
              <p>${task.notes || 'No notes captured.'}</p>
              <div class="task-meta">
                <span class="tag">${task.owner || 'No stream'}</span>
                <span class="tag">${skillLabels[task.skill] || task.skill}</span>
                <span class="tag">${task.priority}</span>
                <span class="tag">${agent ? `${agent.emoji} ${agent.name}` : 'No agent recorded'}</span>
              </div>
              ${outputPreview ? `<p class="task-run-note">Latest run: ${outputPreview}</p>` : ''}
            </article>
          `;
        })
        .join('')
    : '<div class="empty-state">No completed task history yet.</div>';
}

function renderRuns() {
  const runs = dashboard.runs || [];
  const failedCount = runs.filter((run) => run.status === 'failed').length;

  runSummary.textContent = runs.length
    ? `${runs.length} durable run record${runs.length === 1 ? '' : 's'} loaded from SQLite, with ${failedCount} failure${failedCount === 1 ? '' : 's'} visible.`
    : 'Run records will appear here once agents start executing tasks.';

  runList.innerHTML = runs.length
    ? runs.map((run) => buildRunCard(run)).join('')
    : '<div class="empty-state">No durable run history yet.</div>';
}

function renderSystemHistory() {
  const systemTasks = dashboard.systemHistory?.tasks || [];
  const systemSessions = dashboard.systemHistory?.sessions || [];
  const terminalTasks = systemTasks.filter((task) => ['succeeded', 'failed', 'timed_out', 'cancelled', 'lost'].includes(task.status));

  systemTaskHistoryCountPill.textContent = `${systemTasks.length} task${systemTasks.length === 1 ? '' : 's'}`;
  systemSessionHistoryCountPill.textContent = `${systemSessions.length} session${systemSessions.length === 1 ? '' : 's'}`;

  systemTaskHistorySummary.textContent = systemTasks.length
    ? `${systemTasks.length} tracked OpenClaw task${systemTasks.length === 1 ? '' : 's'}, with ${terminalTasks.length} finished and visible here newest first.`
    : 'OpenClaw background task history will appear here when the system has durable task runs to show.';

  systemSessionHistorySummary.textContent = systemSessions.length
    ? `${systemSessions.length} known session${systemSessions.length === 1 ? '' : 's'} across agents, sorted by most recent activity.`
    : 'Session activity will appear here once OpenClaw has visible session state.';

  systemTaskHistoryList.innerHTML = systemTasks.length
    ? systemTasks.map((task) => buildSystemTaskCard(task)).join('')
    : '<div class="empty-state">No system-wide OpenClaw task history yet.</div>';

  systemSessionHistoryList.innerHTML = systemSessions.length
    ? systemSessions.map((session) => buildSystemSessionCard(session)).join('')
    : '<div class="empty-state">No system-wide session activity yet.</div>';
}

function getProjectTaskCount(projectName) {
  return dashboard.tasks.filter((task) => task.owner === projectName).length;
}

function syncProjectFormMode() {
  const editing = Boolean(selectedProjectId);
  projectFormModePill.textContent = editing ? 'Edit' : 'Create';
  projectSubmitButton.textContent = editing ? 'Save project' : 'Create project';
  projectCancelButton.hidden = !editing;
}

function clearProjectForm() {
  selectedProjectId = null;
  projectForm.reset();
  syncProjectFormMode();
}

function openProjectEdit(projectId) {
  const project = dashboard.projects.find((item) => item.id === projectId);
  if (!project) return;

  selectedProjectId = project.id;
  projectNameInput.value = project.name || '';
  projectRepoUrlInput.value = project.repoUrl || '';
  projectGitWorkflowSelect.value = getProjectGitWorkflow(project);
  projectNotesInput.value = project.notes || '';
  syncProjectFormMode();
  renderProjects();
  projectForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  projectNameInput.focus();
}

function renderProjects() {
  const projects = getSortedProjects();

  projectCountPill.textContent = `${projects.length} project${projects.length === 1 ? '' : 's'}`;
  projectSummary.textContent = projects.length
    ? `${projects.length} linked project${projects.length === 1 ? '' : 's'} available for task creation and task editing.`
    : 'No projects yet. Add the first GitHub repo to populate the task dropdown.';

  projectList.innerHTML = projects.length
    ? projects
        .map((project) => {
          const taskCount = getProjectTaskCount(getProjectName(project));
          return `
            <article class="project-card">
              <div class="project-card-header">
                <div>
                  <h3>${escapeHtml(getProjectName(project))}</h3>
                  <p><a href="${escapeHtml(getProjectRepoUrl(project))}" target="_blank" rel="noreferrer">${escapeHtml(getProjectRepoUrl(project))}</a></p>
                </div>
                <span class="pill neutral">${taskCount} task${taskCount === 1 ? '' : 's'}</span>
              </div>
              <p>${escapeHtml(project.notes || 'No notes added yet.')}</p>
              <div class="task-meta">
                <span class="tag">${escapeHtml(getProjectWorkflowLabel(project))}</span>
              </div>
              <div class="task-actions">
                <button type="button" class="button ghost" data-project-action="edit" data-project-id="${project.id}">Edit</button>
                <button type="button" class="button ghost danger" data-project-action="delete" data-project-id="${project.id}">Delete</button>
              </div>
            </article>
          `;
        })
        .join('')
    : '<div class="empty-state">No projects yet. Add your first linked GitHub repo here.</div>';

  if (selectedProjectId && !projects.some((project) => project.id === selectedProjectId)) {
    clearProjectForm();
  } else {
    syncProjectFormMode();
  }
}

function renderTaskRunHistory(task) {
  const runs = (dashboard.runs || []).filter((run) => run.taskId === task.id);
  taskRunHistoryCount.textContent = `${runs.length} run${runs.length === 1 ? '' : 's'}`;
  taskRunHistory.innerHTML = runs.length
    ? runs.slice(0, 6).map((run) => buildRunCard(run, { compact: true })).join('')
    : '<div class="empty-state">No durable run history recorded for this task yet.</div>';
}

function syncTaskDetailForms(task) {
  if (taskDetailDraftTaskId === task.id) {
    return;
  }

  populateAgentSelectOptions(taskEditAgent, task.preferredAgentId || '');
  populateProjectSelectOptions(taskEditOwner, task.owner || '', { allowFallback: true, includePlaceholder: true });
  taskEditTitle.value = task.title || '';
  taskEditPriority.value = task.priority || 'medium';
  taskEditNotes.value = task.notes || '';

  if (!taskCommentAuthor.value.trim()) {
    taskCommentAuthor.value = 'Operator';
  }
  taskCommentBody.value = '';
  taskDetailDraftTaskId = task.id;
}

function renderTaskComments(task) {
  const comments = Array.isArray(task.comments) ? [...task.comments] : [];
  taskCommentCount.textContent = `${comments.length} comment${comments.length === 1 ? '' : 's'}`;

  taskCommentList.innerHTML = comments.length
    ? comments
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .map(
          (comment) => `
            <article class="activity-item comment-item">
              <div class="activity-header">
                <strong>${escapeHtml(comment.author || 'Operator')}</strong>
                <small>${relativeTime(comment.createdAt)}</small>
              </div>
              <p>${escapeHtml(comment.text)}</p>
            </article>
          `
        )
        .join('')
    : '<div class="empty-state">No comments yet. Use this thread for clarifications and implementation notes.</div>';
}

function renderTaskDetail() {
  if (!selectedTaskId) {
    taskDetailDrawer.classList.remove('open');
    taskDetailDrawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drawer-open');
    return;
  }

  const task = dashboard.tasks.find((item) => item.id === selectedTaskId);
  if (!task) {
    closeTaskDetail();
    return;
  }

  const comments = Array.isArray(task.comments) ? task.comments : [];
  const agent = findAgent(task.assignedAgentId);
  const preferredAgent = findAgent(task.preferredAgentId);
  const cleanError = cleanRuntimeNote(task.lastRun?.error);
  const outputPreview = task.lastRun?.output ? truncate(task.lastRun.output, 600) : '';
  const detailTags = [
    task.priority,
    skillLabels[task.skill] || task.skill,
    task.owner || 'No stream',
    agent ? `${agent.emoji} ${agent.name}` : 'Unassigned',
    preferredAgent ? `Preferred: ${preferredAgent.name}` : null,
    `${comments.length} comment${comments.length === 1 ? '' : 's'}`,
    task.lane === 'done' ? `Completed ${relativeTime(getTaskCompletionTime(task))}` : `Updated ${relativeTime(task.updatedAt)}`,
  ].filter(Boolean);
  const editLocked = task.runStatus === 'running';

  if (editLocked) {
    isTaskEditMode = false;
  }

  taskDetailTitle.textContent = task.title;
  taskDetailTags.innerHTML = detailTags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
  taskDetailNotes.textContent = task.notes || 'No definition notes provided for this task.';
  taskDetailSummary.hidden = isTaskEditMode;
  taskDetailEditSection.hidden = !isTaskEditMode;
  taskDetailEditToggle.textContent = isTaskEditMode ? 'Cancel edit' : 'Edit';
  taskDetailEditToggle.disabled = editLocked;
  taskDetailRunStatus.textContent = task.lastRun?.status
    ? `Run status: ${task.lastRun.status}${task.lastRun?.usage?.total ? ` · ${task.lastRun.usage.total.toLocaleString()} tokens` : ''}`
    : task.runStatus === 'running'
      ? 'Run status: running'
      : 'No run details recorded yet.';
  taskDetailOutput.textContent = outputPreview ? `Latest run: ${outputPreview}` : '';
  taskDetailError.textContent = cleanError ? `Runtime note: ${cleanError}` : '';
  taskDetailActions.innerHTML = buildTaskActions(task, { includeSecondary: true });
  taskEditSubmitButton.textContent = editLocked ? 'Locked while running' : 'Save changes';
  [taskEditTitle, taskEditPriority, taskEditAgent, taskEditOwner, taskEditNotes, taskEditSubmitButton].forEach((element) => {
    element.disabled = editLocked;
  });

  syncTaskDetailForms(task);
  renderTaskComments(task);
  renderTaskRunHistory(task);

  taskDetailDrawer.classList.add('open');
  taskDetailDrawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');
}

function renderAll() {
  renderStats();
  populateFormOptions();
  renderOverview();
  renderApprovals();
  renderKanban();
  renderAgents();
  renderUsage();
  renderActivity();
  renderSessions();
  renderBackgroundTasks();
  renderProjects();
  renderRuns();
  renderHistory();
  renderSystemHistory();
  renderTaskDetail();
  applyView();
}

function openTaskDetail(taskId) {
  selectedTaskId = taskId;
  taskDetailDraftTaskId = null;
  isTaskEditMode = false;
  renderTaskDetail();
}

function closeTaskDetail() {
  selectedTaskId = null;
  taskDetailDraftTaskId = null;
  isTaskEditMode = false;
  taskDetailDrawer.classList.remove('open');
  taskDetailDrawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('drawer-open');
}

function openReassignDialog(task) {
  pendingReassignTaskId = task.id;
  reassignTaskTitle.textContent = `Reassign “${task.title}”`;
  populateAgentSelectOptions(reassignAgentSelect, task.preferredAgentId || task.assignedAgentId || '');
  reassignDialog.showModal();
}

async function refreshDashboard() {
  dashboard = await api('/api/dashboard');
  renderAll();
}

async function mutate(action) {
  if (isMutating) return;
  isMutating = true;
  try {
    await action();
    taskDetailDraftTaskId = null;
    await refreshDashboard();
  } catch (error) {
    window.alert(error.message);
  } finally {
    isMutating = false;
  }
}

document.addEventListener('click', (event) => {
  const navButton = event.target.closest('[data-view-link]');
  if (navButton) {
    window.location.hash = navButton.dataset.viewLink;
    return;
  }

  const projectButton = event.target.closest('button[data-project-id]');
  if (projectButton) {
    const { projectAction, projectId } = projectButton.dataset;
    if (projectAction === 'edit') {
      openProjectEdit(projectId);
      return;
    }
    if (projectAction === 'delete') {
      const project = dashboard.projects.find((item) => item.id === projectId);
      if (!project) return;
      if (!window.confirm(`Delete project "${project.name}"? Tasks will keep their existing project name.`)) return;
      mutate(() => api(`/api/projects/${projectId}`, { method: 'DELETE' }));
      return;
    }
  }

  const taskButton = event.target.closest('button[data-task-id]');
  if (!taskButton) return;

  const { action, taskId } = taskButton.dataset;
  if (action === 'move-left') {
    mutate(() => api(`/api/tasks/${taskId}/move`, { method: 'POST', body: JSON.stringify({ direction: -1 }) }));
  }
  if (action === 'move-right') {
    mutate(() => api(`/api/tasks/${taskId}/move`, { method: 'POST', body: JSON.stringify({ direction: 1 }) }));
  }
  if (action === 'approve') {
    mutate(() => api(`/api/tasks/${taskId}/approve`, { method: 'POST' }));
  }
  if (action === 'assign') {
    mutate(() => api(`/api/tasks/${taskId}/assign`, { method: 'POST', body: JSON.stringify({}) }));
  }
  if (action === 'reassign') {
    const task = dashboard.tasks.find((item) => item.id === taskId);
    if (!task) return;
    openReassignDialog(task);
  }
  if (action === 'delete') {
    if (!window.confirm('Delete this task from the board?')) return;
    mutate(() => api(`/api/tasks/${taskId}/delete`, { method: 'POST' }));
  }
});

taskForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(taskForm);
  mutate(async () => {
    await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: formData.get('title'),
        notes: formData.get('notes'),
        priority: formData.get('priority'),
        agentId: formData.get('agentId'),
        owner: formData.get('owner'),
      }),
    });
    taskForm.reset();
    document.getElementById('task-priority').value = 'medium';
  });
});

projectForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(projectForm);
  const payload = {
    name: formData.get('name'),
    repoUrl: formData.get('repoUrl'),
    gitWorkflow: formData.get('gitWorkflow'),
    notes: formData.get('notes'),
  };

  mutate(async () => {
    const hasEditableProject = Boolean(selectedProjectId) && dashboard.projects.some((project) => project.id === selectedProjectId);

    if (hasEditableProject) {
      try {
        await api(`/api/projects/${selectedProjectId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } catch (error) {
        if (String(error.message || '').includes('not_found')) {
          selectedProjectId = null;
          await api('/api/projects', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
        } else {
          throw error;
        }
      }
    } else {
      selectedProjectId = null;
      await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    clearProjectForm();
  });
});

projectCancelButton.addEventListener('click', () => {
  clearProjectForm();
});

taskEditForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!selectedTaskId) return;

  const formData = new FormData(taskEditForm);
  mutate(async () => {
    await api(`/api/tasks/${selectedTaskId}/update`, {
      method: 'POST',
      body: JSON.stringify({
        title: formData.get('title'),
        notes: formData.get('notes'),
        priority: formData.get('priority'),
        agentId: formData.get('agentId'),
        owner: formData.get('owner'),
      }),
    });
    isTaskEditMode = false;
  });
});

taskCommentForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!selectedTaskId) return;

  const formData = new FormData(taskCommentForm);
  mutate(async () => {
    await api(`/api/tasks/${selectedTaskId}/comment`, {
      method: 'POST',
      body: JSON.stringify({
        author: formData.get('author'),
        comment: formData.get('comment'),
      }),
    });
    taskCommentBody.value = '';
  });
});

seedReadyButton.addEventListener('click', () => {
  mutate(async () => {
    const created = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Spin up reusable agent-run summary panel',
        notes: 'Create a compact summary card for live tasks, token burn, and idle capacity.',
        priority: 'high',
        agentId: 'atlas',
        owner: 'Internal Tools',
      }),
    });
    await api(`/api/tasks/${created.task.id}/move`, { method: 'POST', body: JSON.stringify({ direction: 1 }) });
    await api(`/api/tasks/${created.task.id}/approve`, { method: 'POST' });
  });
});

refreshButton.addEventListener('click', () => {
  refreshDashboard().catch((error) => window.alert(error.message));
});

taskDetailCloseButton.addEventListener('click', closeTaskDetail);
taskDetailBackdrop.addEventListener('click', closeTaskDetail);
taskDetailEditToggle.addEventListener('click', () => {
  if (taskDetailEditToggle.disabled) return;
  isTaskEditMode = !isTaskEditMode;
  renderTaskDetail();
});

themeToggleButton?.addEventListener('change', toggleTheme);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && selectedTaskId) {
    closeTaskDetail();
  }
});

reassignCancelButton.addEventListener('click', () => {
  pendingReassignTaskId = null;
  reassignDialog.close();
});

reassignConfirmButton.addEventListener('click', () => {
  if (!pendingReassignTaskId) {
    reassignDialog.close();
    return;
  }

  const agentId = reassignAgentSelect.value;
  const taskId = pendingReassignTaskId;
  pendingReassignTaskId = null;
  reassignDialog.close();
  mutate(() => api(`/api/tasks/${taskId}/reassign`, { method: 'POST', body: JSON.stringify({ agentId }) }));
});

newTaskButton.addEventListener('click', () => {
  window.location.hash = 'tasks';
  applyView();
  document.getElementById('task-title').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

window.addEventListener('hashchange', applyView);

initTheme();

async function bootstrap() {
  applyView();
  try {
    await refreshDashboard();
    pollHandle = window.setInterval(() => {
      refreshDashboard().catch((error) => {
        console.error(error);
      });
    }, 4000);
  } catch (error) {
    window.alert(`Dashboard failed to load: ${error.message}`);
  }
}

bootstrap();
