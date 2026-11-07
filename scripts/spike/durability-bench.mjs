#!/usr/bin/env node
/**
 * Spike-B7: SQLite durability benchmark — synchronous=FULL vs NORMAL.
 *
 * Replicates the §7.2 task-stream write pattern: BEGIN IMMEDIATE →
 * read tasks.last_seq → insert event → update tasks.last_seq → optional
 * turn upsert → COMMIT. Measures commits/sec, commit latency
 * p50/p95/p99, and WAL size on this machine.
 *
 * Usage: node scripts/spike/durability-bench.mjs [--iters 2000] [--db-dir /tmp/x]
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const iters = Number(flag("--iters")) || 2000;
const dbDir = flag("--db-dir") || fs.mkdtempSync(path.join(os.tmpdir(), "chromex-b7-"));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  stream TEXT NOT NULL, task_id TEXT NOT NULL, seq INTEGER NOT NULL,
  ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
  PRIMARY KEY (stream, task_id, seq)
);
CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL
);
`;

function openDb(file, sync) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA synchronous = ${sync}`);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function bench(sync, label) {
  const file = path.join(dbDir, `bench-${sync}.db`);
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(file + suffix); } catch { /* ignore */ }
  }
  const db = openDb(file, sync);
  db.exec(SCHEMA);
  db.prepare("INSERT INTO tasks (task_id, last_seq) VALUES ('t1', 0)").run();
  db.prepare(
    "INSERT INTO turns (turn_id, task_id, status) VALUES ('u1','t1','running')",
  ).run();

  const insEvent = db.prepare(
    "INSERT INTO events (stream, task_id, seq, ts, type, payload_json) VALUES ('task','t1',?,?,?,?)",
  );
  const updTask = db.prepare("UPDATE tasks SET last_seq = ? WHERE task_id = 't1'");
  const upTurn = db.prepare(
    "INSERT INTO turns (turn_id, task_id, status) VALUES ('u1','t1','running') ON CONFLICT(turn_id) DO UPDATE SET status=excluded.status",
  );
  const getSeq = db.prepare("SELECT last_seq FROM tasks WHERE task_id = 't1'");

  const latencies = [];
  const t0 = performance.now();
  for (let i = 0; i < iters; i += 1) {
    const c0 = performance.now();
    db.exec("BEGIN IMMEDIATE");
    const { last_seq } = getSeq.get();
    const seq = last_seq + 1;
    insEvent.run(seq, Date.now(), i % 3 === 0 ? "tool.completed" : "assistant.delta", `{"i":${i}}`);
    updTask.run(seq);
    if (i % 4 === 0) upTurn.run();
    db.exec("COMMIT");
    latencies.push(performance.now() - c0);
  }
  const wallMs = performance.now() - t0;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const walBytes = fs.existsSync(file + "-wal") ? fs.statSync(file + "-wal").size : 0;
  db.close();

  latencies.sort((a, b) => a - b);
  return {
    sync,
    iters,
    wallMs: Math.round(wallMs),
    commitsPerSec: Math.round((iters / wallMs) * 1000),
    p50: +percentile(latencies, 50).toFixed(3),
    p95: +percentile(latencies, 95).toFixed(3),
    p99: +percentile(latencies, 99).toFixed(3),
    max: +latencies[latencies.length - 1].toFixed(3),
    walKB: Math.round(walBytes / 1024),
  };
}

console.log(`platform=${process.platform} node=${process.version} iters=${iters} dir=${dbDir}`);
const results = [bench("FULL", "FULL"), bench("NORMAL", "NORMAL")];
for (const r of results) console.log(JSON.stringify(r));
