import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export function createRunLogger({ dbPath }) {
  const database = new DatabaseSync(dbPath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_title TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      owner TEXT,
      priority TEXT,
      skill TEXT,
      lane_at_start TEXT,
      pid INTEGER,
      status TEXT NOT NULL,
      exit_code INTEGER,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      duration_ms INTEGER,
      updated_at INTEGER NOT NULL,
      session_id TEXT,
      session_key TEXT,
      model TEXT,
      usage_input_tokens INTEGER,
      usage_output_tokens INTEGER,
      usage_total_tokens INTEGER,
      failure_details TEXT,
      summary_text TEXT,
      output_text TEXT,
      error_text TEXT,
      prompt_text TEXT
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT,
      message TEXT,
      details_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      stream TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
      UNIQUE (run_id, seq)
    );

    CREATE TABLE IF NOT EXISTS run_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      label TEXT,
      content_text TEXT,
      content_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_runs_task_started_at ON runs(task_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_status_started_at ON runs(status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_run_events_run_created_at ON run_events(run_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_run_logs_run_seq ON run_logs(run_id, seq ASC);
    CREATE INDEX IF NOT EXISTS idx_run_artifacts_run_type ON run_artifacts(run_id, artifact_type, created_at ASC);
  `);

  const insertRun = database.prepare(`
    INSERT INTO runs (
      id, task_id, task_title, agent_id, agent_name, owner, priority, skill, lane_at_start,
      pid, status, started_at, updated_at, prompt_text
    ) VALUES (
      $id, $taskId, $taskTitle, $agentId, $agentName, $owner, $priority, $skill, $laneAtStart,
      $pid, $status, $startedAt, $updatedAt, $promptText
    )
  `);

  const updateRunStatement = database.prepare(`
    UPDATE runs
    SET pid = COALESCE($pid, pid),
        status = COALESCE($status, status),
        exit_code = COALESCE($exitCode, exit_code),
        finished_at = COALESCE($finishedAt, finished_at),
        duration_ms = COALESCE($durationMs, duration_ms),
        updated_at = $updatedAt,
        session_id = COALESCE($sessionId, session_id),
        session_key = COALESCE($sessionKey, session_key),
        model = COALESCE($model, model),
        usage_input_tokens = COALESCE($usageInputTokens, usage_input_tokens),
        usage_output_tokens = COALESCE($usageOutputTokens, usage_output_tokens),
        usage_total_tokens = COALESCE($usageTotalTokens, usage_total_tokens),
        failure_details = COALESCE($failureDetails, failure_details),
        summary_text = COALESCE($summaryText, summary_text),
        output_text = COALESCE($outputText, output_text),
        error_text = COALESCE($errorText, error_text)
    WHERE id = $id
  `);

  const insertEvent = database.prepare(`
    INSERT INTO run_events (run_id, event_type, status, message, details_json, created_at)
    VALUES ($runId, $eventType, $status, $message, $detailsJson, $createdAt)
  `);

  const insertLog = database.prepare(`
    INSERT INTO run_logs (run_id, seq, stream, chunk_text, created_at)
    VALUES ($runId, $seq, $stream, $chunkText, $createdAt)
  `);

  const insertArtifact = database.prepare(`
    INSERT INTO run_artifacts (run_id, artifact_type, label, content_text, content_json, created_at)
    VALUES ($runId, $artifactType, $label, $contentText, $contentJson, $createdAt)
  `);

  const selectRecentRuns = database.prepare(`
    SELECT *
    FROM runs
    ORDER BY started_at DESC
    LIMIT ?
  `);

  const selectRunsByTask = database.prepare(`
    SELECT *
    FROM runs
    WHERE task_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `);

  const selectEventsByRun = database.prepare(`
    SELECT id, event_type, status, message, details_json, created_at
    FROM run_events
    WHERE run_id = ?
    ORDER BY created_at ASC, id ASC
  `);

  const selectLogsByRun = database.prepare(`
    SELECT id, seq, stream, chunk_text, created_at
    FROM run_logs
    WHERE run_id = ?
    ORDER BY seq ASC
    LIMIT ?
  `);

  const selectArtifactsByRun = database.prepare(`
    SELECT id, artifact_type, label, content_text, content_json, created_at
    FROM run_artifacts
    WHERE run_id = ?
    ORDER BY created_at ASC, id ASC
  `);

  const selectRunById = database.prepare(`
    SELECT * FROM runs WHERE id = ? LIMIT 1
  `);

  function serializeJson(value) {
    return value == null ? null : JSON.stringify(value);
  }

  function normalizeRun(row) {
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      taskTitle: row.task_title,
      agentId: row.agent_id,
      agentName: row.agent_name,
      owner: row.owner,
      priority: row.priority,
      skill: row.skill,
      laneAtStart: row.lane_at_start,
      pid: row.pid,
      status: row.status,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      updatedAt: row.updated_at,
      sessionId: row.session_id,
      sessionKey: row.session_key,
      model: row.model,
      usage: {
        input: row.usage_input_tokens || 0,
        output: row.usage_output_tokens || 0,
        total: row.usage_total_tokens || 0,
      },
      failureDetails: row.failure_details,
      summaryText: row.summary_text,
      outputText: row.output_text,
      errorText: row.error_text,
      promptText: row.prompt_text,
    };
  }

  function parseJsonSafe(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return {
    database,
    path: path.resolve(dbPath),
    createRun(run) {
      insertRun.run({
        id: run.id,
        taskId: run.taskId,
        taskTitle: run.taskTitle,
        agentId: run.agentId,
        agentName: run.agentName || null,
        owner: run.owner || null,
        priority: run.priority || null,
        skill: run.skill || null,
        laneAtStart: run.laneAtStart || null,
        pid: run.pid || null,
        status: run.status,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt || run.startedAt,
        promptText: run.promptText || null,
      });
    },
    updateRun(run) {
      updateRunStatement.run({
        id: run.id,
        pid: run.pid ?? null,
        status: run.status ?? null,
        exitCode: Number.isInteger(run.exitCode) ? run.exitCode : null,
        finishedAt: run.finishedAt ?? null,
        durationMs: run.durationMs ?? null,
        updatedAt: run.updatedAt || Date.now(),
        sessionId: run.sessionId ?? null,
        sessionKey: run.sessionKey ?? null,
        model: run.model ?? null,
        usageInputTokens: run.usage?.input ?? null,
        usageOutputTokens: run.usage?.output ?? null,
        usageTotalTokens: run.usage?.total ?? null,
        failureDetails: run.failureDetails ?? null,
        summaryText: run.summaryText ?? null,
        outputText: run.outputText ?? null,
        errorText: run.errorText ?? null,
      });
    },
    appendEvent(event) {
      insertEvent.run({
        runId: event.runId,
        eventType: event.eventType,
        status: event.status ?? null,
        message: event.message ?? null,
        detailsJson: serializeJson(event.details) ?? null,
        createdAt: event.createdAt || Date.now(),
      });
    },
    appendLog(log) {
      insertLog.run({
        runId: log.runId,
        seq: log.seq,
        stream: log.stream,
        chunkText: log.chunkText,
        createdAt: log.createdAt || Date.now(),
      });
    },
    addArtifact(artifact) {
      insertArtifact.run({
        runId: artifact.runId,
        artifactType: artifact.artifactType,
        label: artifact.label ?? null,
        contentText: artifact.contentText ?? null,
        contentJson: serializeJson(artifact.contentJson) ?? null,
        createdAt: artifact.createdAt || Date.now(),
      });
    },
    getRecentRuns(limit = 50) {
      return selectRecentRuns.all(limit).map(normalizeRun);
    },
    getTaskRuns(taskId, limit = 20) {
      return selectRunsByTask.all(taskId, limit).map(normalizeRun);
    },
    getRun(runId, { logLimit = 400 } = {}) {
      const run = normalizeRun(selectRunById.get(runId));
      if (!run) return null;
      return {
        ...run,
        events: selectEventsByRun.all(runId).map((row) => ({
          id: row.id,
          eventType: row.event_type,
          status: row.status,
          message: row.message,
          details: parseJsonSafe(row.details_json),
          createdAt: row.created_at,
        })),
        logs: selectLogsByRun.all(runId, logLimit).map((row) => ({
          id: row.id,
          seq: row.seq,
          stream: row.stream,
          chunkText: row.chunk_text,
          createdAt: row.created_at,
        })),
        artifacts: selectArtifactsByRun.all(runId).map((row) => ({
          id: row.id,
          artifactType: row.artifact_type,
          label: row.label,
          contentText: row.content_text,
          contentJson: parseJsonSafe(row.content_json),
          createdAt: row.created_at,
        })),
      };
    },
  };
}
