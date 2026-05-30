import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.mjs');
const PORT = Number(process.env.PORT || 4312);
const HOST = process.env.HOST || '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;
const DB_PATH = path.join(ROOT, 'data', 'run-history.sqlite');

const child = spawn(process.execPath, [SERVER_PATH], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
let settled = false;

child.stdout.on('data', (chunk) => {
  stdout += String(chunk);
});

child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

try {
  await waitForServer();
  const dashboard = await getJson('/api/dashboard');
  const runsPayload = await getJson('/api/runs');
  await access(DB_PATH);

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const tableNames = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'run_%' OR name = 'runs') ORDER BY name")
    .all()
    .map((row) => row.name);
  db.close();

  const result = {
    ok: true,
    baseUrl: BASE_URL,
    dashboard: {
      tasks: dashboard.tasks.length,
      approvals: dashboard.approvals.length,
      agents: dashboard.agents.length,
      runs: dashboard.runs.length,
      backgroundTasks: dashboard.openclaw?.backgroundTasks?.length || 0,
      dbPath: dashboard.storage?.runHistoryDbPath || null,
    },
    apiRuns: {
      count: runsPayload.runs.length,
      firstRunId: runsPayload.runs[0]?.id || null,
    },
    sqlite: {
      path: DB_PATH,
      tables: tableNames,
    },
  };

  console.log(JSON.stringify(result, null, 2));
  await shutdown(0);
} catch (error) {
  const failure = {
    ok: false,
    baseUrl: BASE_URL,
    error: error instanceof Error ? error.message : String(error),
    stdout: stdout.trim() || null,
    stderr: stderr.trim() || null,
  };
  console.error(JSON.stringify(failure, null, 2));
  await shutdown(1);
}

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode != null) {
      throw new Error(`Server exited early with code ${child.exitCode}.`);
    }

    try {
      const response = await fetch(`${BASE_URL}/api/dashboard`);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }

    await sleep(200);
  }

  throw new Error(`Timed out waiting for ${BASE_URL}.`);
}

async function getJson(pathname) {
  const response = await fetch(`${BASE_URL}${pathname}`);
  if (!response.ok) {
    throw new Error(`${pathname} returned ${response.status}.`);
  }
  return await response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(code) {
  if (settled) {
    process.exit(code);
    return;
  }
  settled = true;

  if (child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(2000),
    ]);
  }

  if (child.exitCode == null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(1000),
    ]);
  }

  process.exit(code);
}
