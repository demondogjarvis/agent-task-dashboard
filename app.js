const STORAGE_KEY = "jarvis-agent-dashboard-v1";

const lanes = [
  { id: "intake", title: "Intake" },
  { id: "definition", title: "Definition" },
  { id: "approval", title: "Awaiting Approval" },
  { id: "ready", title: "Ready for Agents" },
  { id: "inprogress", title: "In Progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
];

const priorityRank = { critical: 4, high: 3, medium: 2, low: 1 };

const skillLabels = {
  frontend: "Frontend",
  backend: "Backend",
  ops: "Ops",
  qa: "QA",
  automation: "Automation",
  product: "Product",
};

const seedState = {
  autoClaimEnabled: false,
  tasks: [
    {
      id: "task-101",
      title: "Stabilize client invoice ingestion",
      notes: "Audit retry policy, idempotency keys, and dead-letter handling for the overnight importer.",
      priority: "critical",
      skill: "backend",
      owner: "Northstar Finance",
      lane: "approval",
      assignedAgentId: null,
      createdAt: Date.now() - 1000 * 60 * 90,
    },
    {
      id: "task-102",
      title: "Refine migration runbook UI",
      notes: "Tighten the operator dashboard so migration checkpoints are obvious at a glance.",
      priority: "high",
      skill: "frontend",
      owner: "Atlas Rollout",
      lane: "ready",
      assignedAgentId: null,
      createdAt: Date.now() - 1000 * 60 * 50,
    },
    {
      id: "task-103",
      title: "Create regression checklist for approval workflows",
      notes: "Convert edge cases from support incidents into a reusable QA gate before release.",
      priority: "medium",
      skill: "qa",
      owner: "Core Platform",
      lane: "inprogress",
      assignedAgentId: "agent-qa-1",
      createdAt: Date.now() - 1000 * 60 * 180,
    },
    {
      id: "task-104",
      title: "Map automation opportunities in onboarding flow",
      notes: "Find repetitive human approvals that can become policy-driven checks later.",
      priority: "medium",
      skill: "automation",
      owner: "Launch Ops",
      lane: "definition",
      assignedAgentId: null,
      createdAt: Date.now() - 1000 * 60 * 30,
    },
    {
      id: "task-105",
      title: "Document token budget policy",
      notes: "Set thresholds per agent class so expensive runs trigger review before launch.",
      priority: "low",
      skill: "product",
      owner: "Internal",
      lane: "done",
      assignedAgentId: "agent-prod-1",
      createdAt: Date.now() - 1000 * 60 * 400,
    },
  ],
  agents: [
    {
      id: "agent-fe-1",
      name: "Atlas",
      specialty: "frontend",
      status: "idle",
      currentTaskId: null,
      tokensToday: 18640,
      maxTokens: 60000,
      capability: "UI systems and dashboards",
    },
    {
      id: "agent-be-1",
      name: "Meridian",
      specialty: "backend",
      status: "idle",
      currentTaskId: null,
      tokensToday: 24110,
      maxTokens: 70000,
      capability: "Services, APIs, and data flows",
    },
    {
      id: "agent-qa-1",
      name: "Sentinel",
      specialty: "qa",
      status: "busy",
      currentTaskId: "task-103",
      tokensToday: 12220,
      maxTokens: 40000,
      capability: "Regression, validation, and test coverage",
    },
    {
      id: "agent-ops-1",
      name: "Pulse",
      specialty: "ops",
      status: "offline",
      currentTaskId: null,
      tokensToday: 8140,
      maxTokens: 50000,
      capability: "Infra, runtime health, and deployment safety",
    },
    {
      id: "agent-auto-1",
      name: "Vector",
      specialty: "automation",
      status: "idle",
      currentTaskId: null,
      tokensToday: 9640,
      maxTokens: 55000,
      capability: "Workflow automation and agent routing",
    },
    {
      id: "agent-prod-1",
      name: "North",
      specialty: "product",
      status: "idle",
      currentTaskId: null,
      tokensToday: 4920,
      maxTokens: 28000,
      capability: "Scope, definition, and approval quality",
    },
  ],
  activity: [
    {
      id: "activity-1",
      message: "Sentinel is validating approval edge cases in the regression checklist.",
      time: Date.now() - 1000 * 60 * 12,
      tone: "busy",
    },
    {
      id: "activity-2",
      message: "Migration runbook UI is approved and waiting for the best frontend agent to claim it.",
      time: Date.now() - 1000 * 60 * 26,
      tone: "info",
    },
    {
      id: "activity-3",
      message: "Invoice ingestion hardening is blocked on human approval, so no agent can touch it yet.",
      time: Date.now() - 1000 * 60 * 35,
      tone: "warning",
    },
  ],
};

let state = loadState();
let autoClaimInterval = null;

const statsGrid = document.getElementById("stats-grid");
const kanbanBoard = document.getElementById("kanban-board");
const approvalList = document.getElementById("approval-list");
const agentList = document.getElementById("agent-list");
const usageList = document.getElementById("usage-list");
const activityList = document.getElementById("activity-list");
const taskForm = document.getElementById("task-form");
const approvalCountPill = document.getElementById("approval-count-pill");
const runningAgentsPill = document.getElementById("running-agents-pill");
const tokenTotalPill = document.getElementById("token-total-pill");
const autoClaimButton = document.getElementById("auto-claim-button");
const resetButton = document.getElementById("reset-button");
const seedReadyButton = document.getElementById("seed-ready-button");
const newTaskButton = document.getElementById("new-task-button");
const cardTemplate = document.getElementById("task-card-template");

function loadState() {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return structuredClone(seedState);
  }

  try {
    return JSON.parse(stored);
  } catch {
    return structuredClone(seedState);
  }
}

function saveState() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function structuredClone(data) {
  return JSON.parse(JSON.stringify(data));
}

function nextId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function addActivity(message, tone = "info") {
  state.activity.unshift({
    id: nextId("activity"),
    message,
    time: Date.now(),
    tone,
  });
  state.activity = state.activity.slice(0, 18);
}

function getAgent(agentId) {
  return state.agents.find((agent) => agent.id === agentId) || null;
}

function getTask(taskId) {
  return state.tasks.find((task) => task.id === taskId) || null;
}

function releaseAgent(task) {
  if (!task.assignedAgentId) {
    return;
  }

  const agent = getAgent(task.assignedAgentId);
  if (!agent) {
    return;
  }

  if (agent.currentTaskId === task.id) {
    agent.currentTaskId = null;
  }

  if (agent.status !== "offline") {
    agent.status = "idle";
  }
}

function markAgentBusy(agent, task) {
  agent.currentTaskId = task.id;
  agent.status = "busy";
  agent.tokensToday = Math.min(agent.maxTokens, agent.tokensToday + randomInt(800, 3400));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function bestAgentForTask(task) {
  const candidates = state.agents
    .filter((agent) => agent.status === "idle" && agent.specialty === task.skill)
    .sort((a, b) => a.tokensToday - b.tokensToday);
  return candidates[0] || null;
}

function syncAgentAssignments() {
  state.agents.forEach((agent) => {
    const currentTask = state.tasks.find((task) => task.assignedAgentId === agent.id && task.lane === "inprogress");
    if (agent.status !== "offline") {
      agent.status = currentTask ? "busy" : "idle";
    }
    agent.currentTaskId = currentTask ? currentTask.id : null;
  });
}

function createTask({ title, notes, priority, skill, owner, lane = "intake" }) {
  state.tasks.unshift({
    id: nextId("task"),
    title,
    notes,
    priority,
    skill,
    owner: owner || "Unassigned stream",
    lane,
    assignedAgentId: null,
    createdAt: Date.now(),
  });
  addActivity(`New task created in ${laneLabel(lane)}: ${title}.`, "info");
}

function laneLabel(laneId) {
  return lanes.find((lane) => lane.id === laneId)?.title || laneId;
}

function moveTask(taskId, direction) {
  const task = getTask(taskId);
  if (!task) {
    return;
  }

  const currentIndex = lanes.findIndex((lane) => lane.id === task.lane);
  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= lanes.length) {
    return;
  }

  const nextLane = lanes[nextIndex].id;

  if (task.lane === "approval" && nextLane === "ready") {
    approveTask(taskId);
    return;
  }

  if (task.lane === "ready" && nextLane === "inprogress") {
    claimTask(taskId);
    return;
  }

  if (task.lane === "inprogress" && nextLane === "review") {
    task.lane = "review";
    addActivity(`${task.title} moved into review.`, "busy");
    saveAndRender();
    return;
  }

  if (task.lane === "review" && nextLane === "done") {
    task.lane = "done";
    releaseAgent(task);
    addActivity(`${task.title} completed and archived to Done.`, "info");
    saveAndRender();
    return;
  }

  if (task.lane === "inprogress" && direction < 0) {
    task.lane = "ready";
    releaseAgent(task);
    task.assignedAgentId = null;
    addActivity(`${task.title} moved back to Ready for Agents.`, "warning");
    saveAndRender();
    return;
  }

  task.lane = nextLane;
  addActivity(`${task.title} moved to ${laneLabel(nextLane)}.`, "info");
  saveAndRender();
}

function approveTask(taskId) {
  const task = getTask(taskId);
  if (!task || task.lane !== "approval") {
    return;
  }

  task.lane = "ready";
  addActivity(`${task.title} approved. Agents may now claim it.`, "info");
  saveAndRender();

  if (state.autoClaimEnabled) {
    autoClaimOnce();
  }
}

function claimTask(taskId) {
  const task = getTask(taskId);
  if (!task || task.lane !== "ready") {
    return;
  }

  const agent = bestAgentForTask(task);
  if (!agent) {
    addActivity(`No idle ${skillLabels[task.skill]} agent available for ${task.title}.`, "warning");
    saveAndRender();
    return;
  }

  task.lane = "inprogress";
  task.assignedAgentId = agent.id;
  markAgentBusy(agent, task);
  addActivity(`${agent.name} claimed ${task.title}.`, "busy");
  saveAndRender();
}

function autoClaimOnce() {
  const readyTasks = state.tasks
    .filter((task) => task.lane === "ready")
    .sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority] || a.createdAt - b.createdAt);

  let claimedAny = false;
  readyTasks.forEach((task) => {
    const agent = bestAgentForTask(task);
    if (!agent) {
      return;
    }
    task.lane = "inprogress";
    task.assignedAgentId = agent.id;
    markAgentBusy(agent, task);
    addActivity(`${agent.name} auto-claimed ${task.title}.`, "busy");
    claimedAny = true;
  });

  if (claimedAny) {
    saveAndRender();
  }
}

function toggleAutoClaim() {
  state.autoClaimEnabled = !state.autoClaimEnabled;
  if (state.autoClaimEnabled) {
    autoClaimOnce();
    startAutoClaimLoop();
    addActivity("Auto-claim enabled. Idle agents can pull approved tasks.", "info");
  } else {
    stopAutoClaimLoop();
    addActivity("Auto-claim disabled. Assignments are now manual.", "warning");
  }
  saveAndRender();
}

function startAutoClaimLoop() {
  stopAutoClaimLoop();
  autoClaimInterval = window.setInterval(() => {
    autoClaimOnce();
  }, 6000);
}

function stopAutoClaimLoop() {
  if (autoClaimInterval) {
    window.clearInterval(autoClaimInterval);
    autoClaimInterval = null;
  }
}

function resetDemo() {
  stopAutoClaimLoop();
  state = structuredClone(seedState);
  addActivity("Demo state reset.", "info");
  saveAndRender();
}

function relativeTime(timestamp) {
  const diffMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (diffMinutes < 1) {
    return "just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  return minutes ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
}

function renderStats() {
  const approvals = state.tasks.filter((task) => task.lane === "approval").length;
  const ready = state.tasks.filter((task) => task.lane === "ready").length;
  const busyAgents = state.agents.filter((agent) => agent.status === "busy").length;
  const totalTokens = state.agents.reduce((sum, agent) => sum + agent.tokensToday, 0);
  const doneToday = state.tasks.filter((task) => task.lane === "done").length;
  const statCards = [
    {
      label: "Tasks in flow",
      value: state.tasks.length,
      detail: `${ready} approved and ready, ${approvals} waiting for approval`,
    },
    {
      label: "Active agents",
      value: busyAgents,
      detail: `${state.agents.filter((agent) => agent.status === "idle").length} idle, ${state.agents.filter((agent) => agent.status === "offline").length} offline`,
    },
    {
      label: "Token usage today",
      value: totalTokens.toLocaleString(),
      detail: `Across ${state.agents.length} agent profiles`,
    },
    {
      label: "Completed",
      value: doneToday,
      detail: state.autoClaimEnabled ? "Auto-claim is active" : "Manual assignment mode",
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
    .join("");

  approvalCountPill.textContent = `${approvals} waiting`;
  runningAgentsPill.textContent = `${busyAgents} running`;
  tokenTotalPill.textContent = `${totalTokens.toLocaleString()} tokens`;
  autoClaimButton.textContent = `Auto-claim: ${state.autoClaimEnabled ? "On" : "Off"}`;
  autoClaimButton.classList.toggle("primary", state.autoClaimEnabled);
}

function buildTaskActions(task) {
  const actions = [];
  const laneIndex = lanes.findIndex((lane) => lane.id === task.lane);

  if (laneIndex > 0) {
    actions.push(`<button class="button ghost" data-action="move-left" data-task-id="${task.id}">← Back</button>`);
  }

  if (task.lane === "approval") {
    actions.push(`<button class="button primary" data-action="approve" data-task-id="${task.id}">Approve</button>`);
  } else if (task.lane === "ready") {
    actions.push(`<button class="button primary" data-action="claim" data-task-id="${task.id}">Claim best-fit agent</button>`);
    if (laneIndex < lanes.length - 1) {
      actions.push(`<button class="button ghost" data-action="move-right" data-task-id="${task.id}">Advance</button>`);
    }
  } else if (task.lane === "inprogress") {
    actions.push(`<button class="button primary" data-action="move-right" data-task-id="${task.id}">Send to review</button>`);
  } else if (task.lane === "review") {
    actions.push(`<button class="button primary" data-action="move-right" data-task-id="${task.id}">Complete</button>`);
  } else if (laneIndex < lanes.length - 1) {
    actions.push(`<button class="button ghost" data-action="move-right" data-task-id="${task.id}">Advance</button>`);
  }

  return actions.join("");
}

function renderKanban() {
  kanbanBoard.innerHTML = "";

  lanes.forEach((lane) => {
    const tasks = state.tasks
      .filter((task) => task.lane === lane.id)
      .sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority] || b.createdAt - a.createdAt);

    const column = document.createElement("section");
    column.className = "kanban-column";
    column.innerHTML = `
      <div class="column-header">
        <div>
          <h3>${lane.title}</h3>
          <span class="column-count">${tasks.length} task${tasks.length === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div class="task-stack"></div>
    `;

    const stack = column.querySelector(".task-stack");

    if (!tasks.length) {
      stack.innerHTML = `<div class="empty-state">No tasks in this lane.</div>`;
    }

    tasks.forEach((task) => {
      const taskNode = cardTemplate.content.firstElementChild.cloneNode(true);
      taskNode.querySelector(".priority-dot").classList.add(task.priority);
      taskNode.querySelector(".task-priority-label").textContent = task.priority;
      taskNode.querySelector(".task-owner").textContent = task.owner || "No stream";
      taskNode.querySelector(".task-title").textContent = task.title;
      taskNode.querySelector(".task-notes").textContent = task.notes || "No notes yet.";
      taskNode.querySelector(".skill-tag").textContent = skillLabels[task.skill] || task.skill;

      const agent = getAgent(task.assignedAgentId);
      taskNode.querySelector(".assignee-tag").textContent = agent ? `Agent: ${agent.name}` : "Unassigned";
      taskNode.querySelector(".task-actions").innerHTML = buildTaskActions(task);
      stack.appendChild(taskNode);
    });

    kanbanBoard.appendChild(column);
  });
}

function renderApprovals() {
  const approvals = state.tasks
    .filter((task) => task.lane === "approval")
    .sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority] || a.createdAt - b.createdAt);

  approvalList.innerHTML = "";

  if (!approvals.length) {
    approvalList.innerHTML = `<div class="empty-state">Nothing is waiting for approval right now.</div>`;
    return;
  }

  approvals.forEach((task) => {
    const item = document.createElement("article");
    item.className = "approval-item";
    item.innerHTML = `
      <h3>${task.title}</h3>
      <p>${task.notes || "No definition notes provided."}</p>
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
  const busyAgents = state.agents.filter((agent) => agent.status === "busy");
  const sortedAgents = [...state.agents].sort((a, b) => {
    const statusOrder = { busy: 0, idle: 1, offline: 2 };
    return statusOrder[a.status] - statusOrder[b.status] || a.name.localeCompare(b.name);
  });

  agentList.innerHTML = "";
  sortedAgents.forEach((agent) => {
    const currentTask = getTask(agent.currentTaskId);
    const card = document.createElement("article");
    card.className = "agent-card";
    card.innerHTML = `
      <div class="agent-status-row">
        <h3>${agent.name}</h3>
        <span class="status-pill status-${agent.status}">${agent.status}</span>
      </div>
      <p>${agent.capability}</p>
      <div class="agent-meta">
        <span class="tag">${skillLabels[agent.specialty] || agent.specialty}</span>
        <span class="tag">${agent.tokensToday.toLocaleString()} tokens</span>
      </div>
      <p>${currentTask ? `Working on: ${currentTask.title}` : "No current task."}</p>
    `;
    agentList.appendChild(card);
  });

  if (!busyAgents.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No agents are currently running a task.";
    agentList.appendChild(empty);
  }
}

function renderUsage() {
  const sortedAgents = [...state.agents].sort((a, b) => b.tokensToday - a.tokensToday);
  usageList.innerHTML = "";

  sortedAgents.forEach((agent) => {
    const percentage = Math.round((agent.tokensToday / agent.maxTokens) * 100);
    const card = document.createElement("article");
    card.className = "usage-card";
    card.innerHTML = `
      <div class="usage-bar-row">
        <h3>${agent.name}</h3>
        <span>${agent.tokensToday.toLocaleString()} / ${agent.maxTokens.toLocaleString()}</span>
      </div>
      <p>${agent.capability}</p>
      <div class="progress-track">
        <div class="progress-fill" style="width: ${Math.min(percentage, 100)}%"></div>
      </div>
      <div class="usage-meta">
        <span class="tag">${percentage}% budget used</span>
        <span class="tag">${skillLabels[agent.specialty] || agent.specialty}</span>
      </div>
    `;
    usageList.appendChild(card);
  });
}

function renderActivity() {
  activityList.innerHTML = "";
  state.activity.forEach((item) => {
    const row = document.createElement("article");
    row.className = "activity-item";
    row.innerHTML = `
      <div class="activity-header">
        <strong>${item.tone === "warning" ? "Attention" : item.tone === "busy" ? "Agent run" : "Update"}</strong>
        <small>${relativeTime(item.time)}</small>
      </div>
      <p>${item.message}</p>
    `;
    activityList.appendChild(row);
  });
}

function saveAndRender() {
  syncAgentAssignments();
  saveState();
  renderStats();
  renderKanban();
  renderApprovals();
  renderAgents();
  renderUsage();
  renderActivity();
}

kanbanBoard.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-task-id]");
  if (!button) {
    return;
  }

  const { action, taskId } = button.dataset;
  if (action === "move-left") {
    moveTask(taskId, -1);
  }
  if (action === "move-right") {
    moveTask(taskId, 1);
  }
  if (action === "approve") {
    approveTask(taskId);
  }
  if (action === "claim") {
    claimTask(taskId);
  }
});

approvalList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-task-id]");
  if (!button) {
    return;
  }
  approveTask(button.dataset.taskId);
});

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(taskForm);
  createTask({
    title: formData.get("title").trim(),
    notes: formData.get("notes").trim(),
    priority: formData.get("priority"),
    skill: formData.get("skill"),
    owner: formData.get("owner").trim(),
    lane: "definition",
  });
  taskForm.reset();
  document.getElementById("task-priority").value = "medium";
  saveAndRender();
});

autoClaimButton.addEventListener("click", toggleAutoClaim);
resetButton.addEventListener("click", resetDemo);
seedReadyButton.addEventListener("click", () => {
  createTask({
    title: "Spin up reusable agent-run summary panel",
    notes: "Create a compact summary card for live tasks, token burn, and idle capacity.",
    priority: "high",
    skill: "frontend",
    owner: "Internal Tools",
    lane: "ready",
  });
  saveAndRender();
  if (state.autoClaimEnabled) {
    autoClaimOnce();
  }
});
newTaskButton.addEventListener("click", () => {
  document.getElementById("task-title").focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

if (state.autoClaimEnabled) {
  startAutoClaimLoop();
}

saveAndRender();
