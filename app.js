const priorityRank = { critical: 4, high: 3, medium: 2, low: 1 };
const skillLabels = {
  frontend: 'Frontend',
  backend: 'Backend',
  ops: 'Ops',
  qa: 'QA',
  automation: 'Automation',
  product: 'Product',
};

let dashboard = null;
let pollHandle = null;
let isMutating = false;

const statsGrid = document.getElementById('stats-grid');
const kanbanBoard = document.getElementById('kanban-board');
const approvalList = document.getElementById('approval-list');
const agentList = document.getElementById('agent-list');
const usageList = document.getElementById('usage-list');
const activityList = document.getElementById('activity-list');
const taskForm = document.getElementById('task-form');
const approvalCountPill = document.getElementById('approval-count-pill');
const runningAgentsPill = document.getElementById('running-agents-pill');
const tokenTotalPill = document.getElementById('token-total-pill');
const resetButton = document.getElementById('reset-button');
const seedReadyButton = document.getElementById('seed-ready-button');
const newTaskButton = document.getElementById('new-task-button');
const refreshButton = document.getElementById('refresh-button');
const cardTemplate = document.getElementById('task-card-template');
const sessionList = document.getElementById('session-list');
const backgroundTaskList = document.getElementById('background-task-list');
const sessionCountPill = document.getElementById('session-count-pill');
const backgroundTaskPill = document.getElementById('background-task-pill');

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

function laneLabel(laneId) {
  return dashboard?.lanes.find((lane) => lane.id === laneId)?.title || laneId;
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
  runningAgentsPill.textContent = `${metrics.busyAgentCount} running`;
  tokenTotalPill.textContent = `${metrics.totalSessionTokens.toLocaleString()} tokens`;
  sessionCountPill.textContent = `${openclaw.sessions.length} sessions`;
  backgroundTaskPill.textContent = `${dashboard.activeRuns.length + openclaw.backgroundTasks.length} tracked`;
}

function buildTaskActions(task) {
  const actions = [];
  const laneIndex = dashboard.lanes.findIndex((lane) => lane.id === task.lane);
  const isRunning = task.runStatus === 'running';

  if (!isRunning && laneIndex > 0) {
    actions.push(`<button class="button ghost" data-action="move-left" data-task-id="${task.id}">← Back</button>`);
  }

  if (task.lane === 'approval') {
    actions.push(`<button class="button primary" data-action="approve" data-task-id="${task.id}">Approve</button>`);
  } else if (task.lane === 'ready') {
    actions.push(`<button class="button primary" data-action="assign" data-task-id="${task.id}">Assign real agent</button>`);
  } else if (task.lane === 'review') {
    actions.push(`<button class="button primary" data-action="move-right" data-task-id="${task.id}">Complete</button>`);
  } else if (!isRunning && laneIndex < dashboard.lanes.length - 1 && !['ready', 'approval', 'done'].includes(task.lane)) {
    actions.push(`<button class="button ghost" data-action="move-right" data-task-id="${task.id}">Advance</button>`);
  }

  return actions.join('');
}

function renderKanban() {
  kanbanBoard.innerHTML = '';

  dashboard.lanes.forEach((lane) => {
    const tasks = dashboard.tasks
      .filter((task) => task.lane === lane.id)
      .sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority] || (b.createdAt || 0) - (a.createdAt || 0));

    const column = document.createElement('section');
    column.className = 'kanban-column';
    column.innerHTML = `
      <div class="column-header">
        <div>
          <h3>${lane.title}</h3>
          <span class="column-count">${tasks.length} task${tasks.length === 1 ? '' : 's'}</span>
        </div>
      </div>
      <div class="task-stack"></div>
    `;

    const stack = column.querySelector('.task-stack');
    if (!tasks.length) {
      stack.innerHTML = '<div class="empty-state">No tasks in this lane.</div>';
    }

    tasks.forEach((task) => {
      const node = cardTemplate.content.firstElementChild.cloneNode(true);
      const agent = findAgent(task.assignedAgentId);
      const runStatus = task.lastRun?.status || task.runStatus;
      const usage = task.lastRun?.usage?.total ? `${task.lastRun.usage.total.toLocaleString()} tokens` : null;
      const outputPreview = task.lastRun?.output ? truncate(task.lastRun.output, 220) : '';
      const errorPreview = task.lastRun?.error ? truncate(task.lastRun.error, 180) : '';

      node.querySelector('.priority-dot').classList.add(priorityClass(task.priority));
      node.querySelector('.task-priority-label').textContent = task.priority;
      node.querySelector('.task-owner').textContent = task.owner || 'No stream';
      node.querySelector('.task-title').textContent = task.title;
      node.querySelector('.task-notes').textContent = task.notes || 'No notes yet.';
      node.querySelector('.skill-tag').textContent = skillLabels[task.skill] || task.skill;
      node.querySelector('.assignee-tag').textContent = agent
        ? `${agent.emoji} ${agent.name}${task.runStatus === 'running' ? ' running' : ''}`
        : 'Unassigned';
      node.querySelector('.task-actions').innerHTML = buildTaskActions(task);

      if (runStatus && runStatus !== 'idle') {
        const statusTag = document.createElement('span');
        statusTag.className = 'tag';
        statusTag.textContent = `Run: ${runStatus}`;
        node.querySelector('.task-meta').appendChild(statusTag);
      }

      if (usage) {
        const usageTag = document.createElement('span');
        usageTag.className = 'tag';
        usageTag.textContent = usage;
        node.querySelector('.task-meta').appendChild(usageTag);
      }

      if (task.runStatus === 'running') {
        const runningNote = document.createElement('p');
        runningNote.className = 'task-run-note';
        runningNote.textContent = `Live run started ${relativeTime(task.lastRun?.startedAt || task.updatedAt)}.`;
        node.appendChild(runningNote);
      }

      if (outputPreview) {
        const output = document.createElement('p');
        output.className = 'task-run-note';
        output.textContent = `Latest run: ${outputPreview}`;
        node.appendChild(output);
      }

      if (errorPreview) {
        const error = document.createElement('p');
        error.className = 'task-run-note error-note';
        error.textContent = `Runtime note: ${errorPreview}`;
        node.appendChild(error);
      }

      stack.appendChild(node);
    });

    kanbanBoard.appendChild(column);
  });
}

function renderApprovals() {
  approvalList.innerHTML = '';
  if (!dashboard.approvals.length) {
    approvalList.innerHTML = '<div class="empty-state">Nothing is waiting for approval right now.</div>';
    return;
  }

  dashboard.approvals.forEach((task) => {
    const item = document.createElement('article');
    item.className = 'approval-item';
    item.innerHTML = `
      <h3>${task.title}</h3>
      <p>${task.notes || 'No definition notes provided.'}</p>
      <div class="approval-actions">
        <span class="tag">${task.priority}</span>
        <span class="tag">${skillLabels[task.skill] || task.skill}</span>
        <button class="button primary" data-action="approve" data-task-id="${task.id}">Approve for agents</button>
      </div>
    `;
    approvalList.appendChild(item);
  });
}

function renderAgents() {
  const busyAgents = dashboard.agents.filter((agent) => agent.status === 'busy');
  const sorted = [...dashboard.agents].sort((a, b) => {
    const order = { busy: 0, idle: 1, unconfigured: 2 };
    return (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.name.localeCompare(b.name);
  });

  agentList.innerHTML = '';
  sorted.forEach((agent) => {
    const card = document.createElement('article');
    card.className = 'agent-card';
    card.innerHTML = `
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
      <p>
        ${agent.currentTaskTitle ? `Working on: ${agent.currentTaskTitle}` : agent.lastTaskTitle ? `Last task: ${agent.lastTaskTitle}` : 'No task attached.'}
      </p>
      <p>${agent.sessionKey ? `Session: ${agent.sessionKey}` : 'No live session recorded yet.'}</p>
    `;
    agentList.appendChild(card);
  });

  if (!busyAgents.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No agents are currently running a task.';
    agentList.appendChild(empty);
  }
}

function renderUsage() {
  const maxTokens = Math.max(...dashboard.agents.map((agent) => agent.latestUsageTokens), 1);
  usageList.innerHTML = '';

  dashboard.agents
    .slice()
    .sort((a, b) => b.latestUsageTokens - a.latestUsageTokens)
    .forEach((agent) => {
      const percent = Math.round((agent.latestUsageTokens / maxTokens) * 100);
      const card = document.createElement('article');
      card.className = 'usage-card';
      card.innerHTML = `
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
      `;
      usageList.appendChild(card);
    });
}

function renderActivity() {
  activityList.innerHTML = '';
  dashboard.activity.forEach((item) => {
    const row = document.createElement('article');
    row.className = 'activity-item';
    row.innerHTML = `
      <div class="activity-header">
        <strong>${item.tone === 'warning' ? 'Attention' : item.tone === 'busy' ? 'Agent run' : 'Update'}</strong>
        <small>${relativeTime(item.time)}</small>
      </div>
      <p>${item.message}</p>
    `;
    activityList.appendChild(row);
  });
}

function renderSessions() {
  sessionList.innerHTML = '';
  if (!dashboard.openclaw.sessions.length) {
    sessionList.innerHTML = '<div class="empty-state">No OpenClaw sessions are visible yet.</div>';
    return;
  }

  dashboard.openclaw.sessions
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .forEach((session) => {
      const row = document.createElement('article');
      row.className = 'activity-item';
      row.innerHTML = `
        <div class="activity-header">
          <strong>${session.agentId}</strong>
          <small>${relativeTime(session.updatedAt)}</small>
        </div>
        <p>${session.key}</p>
        <p>${(session.totalTokens || 0).toLocaleString()} total tokens, model ${session.model || 'unknown'}.</p>
      `;
      sessionList.appendChild(row);
    });
}

function renderBackgroundTasks() {
  backgroundTaskList.innerHTML = '';
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
  if (!rows.length) {
    backgroundTaskList.innerHTML = '<div class="empty-state">No background tasks or active agent processes right now.</div>';
    return;
  }

  rows.forEach((item) => {
    const row = document.createElement('article');
    row.className = 'activity-item';
    row.innerHTML = `
      <div class="activity-header">
        <strong>${item.kind}</strong>
        <small>${relativeTime(item.updatedAt)}</small>
      </div>
      <p>${item.title}</p>
      <p>${item.detail}</p>
    `;
    backgroundTaskList.appendChild(row);
  });
}

function renderAll() {
  renderStats();
  renderKanban();
  renderApprovals();
  renderAgents();
  renderUsage();
  renderActivity();
  renderSessions();
  renderBackgroundTasks();
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
    await refreshDashboard();
  } catch (error) {
    window.alert(error.message);
  } finally {
    isMutating = false;
  }
}

kanbanBoard.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-task-id]');
  if (!button) return;

  const { action, taskId } = button.dataset;
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
});

approvalList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-task-id]');
  if (!button) return;
  mutate(() => api(`/api/tasks/${button.dataset.taskId}/approve`, { method: 'POST' }));
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
        skill: formData.get('skill'),
        owner: formData.get('owner'),
      }),
    });
    taskForm.reset();
    document.getElementById('task-priority').value = 'medium';
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
        skill: 'frontend',
        owner: 'Internal Tools',
      }),
    });
    await api(`/api/tasks/${created.task.id}/move`, { method: 'POST', body: JSON.stringify({ direction: 1 }) });
    await api(`/api/tasks/${created.task.id}/approve`, { method: 'POST' });
  });
});

resetButton.addEventListener('click', () => {
  if (!window.confirm('Reset the board to the current seed state?')) return;
  mutate(() => api('/api/reset', { method: 'POST' }));
});

refreshButton.addEventListener('click', () => {
  mutate(() => refreshDashboard());
});

newTaskButton.addEventListener('click', () => {
  document.getElementById('task-title').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

async function bootstrap() {
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
