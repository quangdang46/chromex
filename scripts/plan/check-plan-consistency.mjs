#!/usr/bin/env node
// Consistency gate for "COMPREHENSIVE PLAN FOR CHROMEX.md" (spec §4.11).
//
// Usage:
//   node scripts/plan/check-plan-consistency.mjs [planPath]
//   node scripts/plan/check-plan-consistency.mjs --self-test     # prove it can fail
//
// Exit 0 = all checks pass. Exit 1 = at least one failure.
// Read-only with respect to the plan; writes only to a temp dir for DDL execution.
//
// Scope: text/regex + DDL syntax. This does NOT replace typecheck or runtime
// tests — those need real source files and run in CI/PR-A.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_PLAN = "COMPREHENSIVE PLAN FOR CHROMEX.md";

/** Every check takes plan text and returns null (ok) or a failure reason. */
const CHECKS = [
  {
    id: "identity.tabIntent.singleDeclaration",
    run(md) {
      const hits = [...md.matchAll(/^\s*(?:export\s+)?(?:interface|type)\s+TabIntent\b/gm)];
      return hits.length === 1 ? null : `expected 1 TabIntent declaration, found ${hits.length}`;
    },
  },
  {
    id: "identity.browserInstanceId.nullableEverywhere",
    run(md) {
      // Only TypeScript declaration positions inside fenced code blocks:
      //   browserInstanceId: string | null;
      //   browserInstanceId?: string | null;
      // Prose/backticked identifiers like `profileId:browserInstanceId:tabId` are not
      // declarations and must not be matched. Fences are scanned by state, because the
      // document mixes ```ts, ```text and bare ``` and a pairwise regex desynchronises.
      const blocks = [];
      let current = null;
      for (const line of md.split(/\r?\n/)) {
        if (/^\s*```/.test(line)) {
          if (current === null) current = [];
          else {
            blocks.push(current.join("\n"));
            current = null;
          }
          continue;
        }
        if (current) current.push(line);
      }
      const decls = [];
      for (const block of blocks) {
        for (const m of block.matchAll(/^\s*browserInstanceId\??\s*:\s*([^;]+);/gm)) {
          decls.push({ raw: m[0].trim(), type: m[1].trim() });
        }
      }
      if (!decls.length) return "no browserInstanceId declarations found in code blocks";
      const bad = decls.filter((d) => !/^string\s*\|\s*null$/.test(d.type));
      return bad.length ? `non-nullable: ${bad.map((b) => b.raw).join(" | ")}` : null;
    },
  },
  {
    id: "events.ephemeral.noSeq",
    run(md) {
      const blocks = [...md.matchAll(/reliability:\s*"ephemeral"[\s\S]{0,300}/g)].map((m) => m[0]);
      if (!blocks.length) return "no ephemeral envelope block found";
      return blocks.some((b) => /\bseq:\s*(number|\d)/.test(b))
        ? "ephemeral envelope declares seq"
        : null;
    },
  },
  {
    id: "events.envelope.typePayloadCorrelated",
    run(md) {
      // Durable envelopes must be distributive-mapped over the event union so
      // `type` and `payload.type` cannot drift.
      const task = /export type DurableTaskEventEnvelope = \{\s*\[E in DurableTaskEvent as E\["type"\]\]/.test(md);
      const gateway = /export type DurableGatewayEventEnvelope = \{\s*\[E in DurableGatewayEvent as E\["type"\]\]/.test(md);
      if (!task) return "DurableTaskEventEnvelope is not distributive over DurableTaskEvent";
      if (!gateway) return "DurableGatewayEventEnvelope is not distributive over DurableGatewayEvent";
      // And no legacy "type: XType; payload: X" pairing left in the envelope union.
      if (/type:\s*DurableGatewayEventType;\s*payload:\s*DurableGatewayEvent/.test(md)) {
        return "legacy non-correlated gateway envelope fields still present";
      }
      if (/type:\s*DurableTaskEventType;\s*payload:\s*DurableTaskEvent/.test(md)) {
        return "legacy non-correlated task envelope fields still present";
      }
      return null;
    },
  },
  {
    id: "events.durableGateway.excludesNotice",
    run(md) {
      if (!/export type GatewayNotice = Extract<GatewayEvent, \{ type: "gateway\.notice" \}>/.test(md)) {
        return "GatewayNotice type missing";
      }
      if (!/export type DurableGatewayEvent = Exclude<GatewayEvent, GatewayNotice>/.test(md)) {
        return "DurableGatewayEvent does not exclude GatewayNotice";
      }
      return null;
    },
  },
  {
    id: "events.turnInvariant.coversQueuedTerminal",
    run(md) {
      if (!/Turn đã start.*đúng 1 `turn\.started`/.test(md)) return "missing 'turn đã start' invariant";
      if (!/terminal trước khi start/i.test(md)) return "missing 'terminal before start' invariant";
      if (/approval\.expired/.test(md) && !/không dùng tên `approval\.expired`/.test(md)) {
        return "event invariant still references approval.expired";
      }
      return null;
    },
  },
  {
    id: "events.permissionExpiredExists",
    run(md) {
      return /type: "permission\.expired"/.test(md) ? null : "permission.expired event missing from union";
    },
  },
  {
    id: "errors.registry.complete",
    run(md) {
      const start = md.indexOf("export type ProtocolErrorCode =");
      if (start < 0) return "ProtocolErrorCode union not found";
      const union = md.slice(start, md.indexOf(";", md.indexOf("| \"internal\"")));
      const declared = new Set([...union.matchAll(/"([a-z][a-z_]*\.[a-z_0-9]+)"/g)].map((m) => m[1]));
      // Codes referenced in prose as side-effect / error semantics.
      const referenced = new Set(
        [...md.matchAll(/`((?:proto|gateway|task|turn|provider|browser|approval|artifact|conversation)\.[a-z_]+)`/g)].map((m) => m[1]),
      );
      // Filter out RPC methods, events, file names, config keys — only keep ones
      // that the doc treats as errors (appear near error/retry/sideEffect words).
      const errorish = [...referenced].filter((code) => {
        const idx = md.indexOf(`\`${code}\``);
        const window = md.slice(Math.max(0, idx - 200), idx + 200);
        return /sideEffectState|retryable|requiresUserAction|lỗi|error/i.test(window);
      });
      // Event names share the dotted namespace; they are not error codes.
      const eventTypes = new Set([...md.matchAll(/\{ type: "([a-z]+\.[a-z_.0-9]+)";/g)].map((m) => m[1]));
      const missing = errorish.filter((c) => !declared.has(c) && !eventTypes.has(c));
      return missing.length ? `used but not declared: ${missing.join(", ")}` : null;
    },
  },
  {
    id: "errors.sideEffectClassification",
    run(md) {
      const table = md.slice(md.indexOf("| Code | retryable"), md.indexOf("### 4.3"));
      for (const code of ["browser.no_host", "browser.host_lost_after_dispatch", "browser.result_lost"]) {
        if (!table.includes(code)) return `side-effect table missing ${code}`;
      }
      return null;
    },
  },
  {
    id: "persistence.attention.notAColumn",
    run(md) {
      return /\battention\s+TEXT\b/.test(md) ? "attention persisted as a column" : null;
    },
  },
  {
    id: "persistence.turnInsert.writesQueuedAt",
    run(md) {
      const insert = md.match(/INSERT INTO turns[\s\S]{0,600}?;/);
      if (!insert) return "turn INSERT template not found";
      if (!/queued_at/.test(insert[0])) return "turn INSERT template does not write queued_at";
      return null;
    },
  },
  {
    id: "persistence.noInsertOrReplace",
    run(md) {
      return /^\s*INSERT OR REPLACE INTO/m.test(md) ? "INSERT OR REPLACE used" : null;
    },
  },
  {
    id: "persistence.seqFromCursorNotMax",
    run(md) {
      if (/COALESCE\(MAX\(seq\)/.test(md)) return "seq allocated from MAX(seq)";
      if (!/last_seq \+ 1|last_seq\+1/.test(md) && !/last_seq = next/.test(md)) {
        return "no cursor-based seq allocation documented";
      }
      return null;
    },
  },
  {
    id: "persistence.gatewaySeqSeeded",
    run(md) {
      if (!/gateway\.last_seq/.test(md)) return "gateway.last_seq missing";
      return /ON CONFLICT\(key\) DO NOTHING/.test(md) ? null : "gateway.last_seq not seeded in migration";
    },
  },
  {
    id: "persistence.conversationIntegrityCheck",
    run(md) {
      return /c\.is_current = 1[\s\S]{0,400}?phải = 0/.test(md) ? null : "no startup integrity query for conversation_key";
    },
  },
  {
    id: "snapshot.discriminatedUnion",
    run(md) {
      for (const t of ["TaskSnapshotData", "InlineTaskSnapshot", "ChunkedTaskSnapshotManifest", "ArtifactTaskSnapshotManifest"]) {
        if (!new RegExp(`export (type|interface) ${t}\\b`).test(md)) return `missing ${t}`;
      }
      if (!/export type TaskSnapshot = InlineTaskSnapshot \| ChunkedTaskSnapshotManifest \| ArtifactTaskSnapshotManifest/.test(md)) {
        return "TaskSnapshot is not a 3-way discriminated union";
      }
      return null;
    },
  },
  {
    id: "snapshot.chunkCarriesRefAndDigest",
    run(md) {
      const chunk = md.match(/type TaskSnapshotChunkResponse = \{[\s\S]*?\};/);
      if (!chunk) return "TaskSnapshotChunkResponse missing";
      for (const f of ["taskId", "snapshotRef", "chunkIndex", "chunkCount", "data", "sha256", "snapshotSha256"]) {
        if (!new RegExp(`\\b${f}\\b`).test(chunk[0])) return `chunk missing ${f}`;
      }
      return null;
    },
  },
  {
    id: "transport.envelopeHeadroom",
    run(md) {
      const m = md.match(/"maxEnvelopeBytes":\s*(\d+)/);
      const hard = md.match(/MAX_ENVELOPE_BYTES_HARD\s*=\s*(\d+)/);
      if (!m) return "maxEnvelopeBytes config missing";
      if (Number(m[1]) >= 1048576) return `config ${m[1]} >= transport 1048576`;
      if (!hard) return "MAX_ENVELOPE_BYTES_HARD not defined";
      if (Number(hard[1]) > 786432) return `hard cap ${hard[1]} > 786432`;
      if (Number(m[1]) > Number(hard[1])) return "config exceeds hard cap";
      return null;
    },
  },
  {
    id: "handshake.gatewayCursor",
    run(md) {
      if (!/lastSeqByGateway\?:/.test(md)) return "HelloRequest.lastSeqByGateway missing";
      return /gatewayLastSeq:\s*number/.test(md) ? null : "HelloResponse.gatewayLastSeq missing";
    },
  },
  {
    id: "attention.readCursorStrict",
    run(md) {
      if (!/lastReadSeq < lastTurnTerminalSeq/.test(md)) return "unread predicate not strict `<`";
      return /lastReadSeq >= lastTurnTerminalSeq/.test(md) ? null : "missing read predicate for the `>=` case";
    },
  },
  {
    id: "browser.hostLoss.dispatchLifecycle",
    run(md) {
      for (const code of ["browser.no_host", "browser.host_lost_after_dispatch", "browser.result_lost"]) {
        if (!md.includes(code)) return `missing ${code}`;
      }
      return /trước dispatch[\s\S]{0,200}none/i.test(md) ? null : "no 'before dispatch => none' rule";
    },
  },
  {
    id: "browser.egress.hasDestination",
    run(md) {
      return /destination:\s*"local-provider" \| "cloud-provider" \| "external-mcp" \| "logs-telemetry"/.test(md)
        ? null
        : "agentEgress has no destination/trust boundary";
    },
  },
  {
    id: "security.allowTask.scopeLimited",
    run(md) {
      return /allow_task`?:?\s*.*dataClass.*destination/s.test(md) || /dataClass \+ destination/.test(md)
        ? null
        : "allow_task scope does not include dataClass+destination";
    },
  },
  {
    id: "lock.usesOsLockNotMtime",
    run(md) {
      if (/lockTentativeMs/.test(md)) return "mtime-based tentative lock still specified";
      if (!/flock|LockFileEx/.test(md)) return "no OS advisory lock documented";
      return /fence/i.test(md) ? null : "no fencing token";
    },
  },
  {
    id: "lock.reclaimHasTests",
    run(md) {
      return /SIGSTOP[\s\S]{0,300}fence/i.test(md) ? null : "no suspended-owner / fence test";
    },
  },
  {
    id: "playwright.iframeProvisional",
    run(md) {
      // spike-B4 resolved (docs/adr/playwright-snapshot.md): iframe:"all"
      // is proven — the plan must carry the evidence marker, not a bare
      // or stale provisional claim.
      return /iframe: "all"`? \*\*(PROVISIONAL\(spike-B4\)|ĐÃ CHỨNG MINH)/.test(md)
        ? null
        : "Playwright iframe capability missing spike-B4 evidence marker";
    },
  },
  {
    id: "token.singleRefreshFlow",
    run(md) {
      if (/paseo_tool_token_refresh/.test(md) && !/Còn nhánh MCP/.test(md)) return "MCP refresh tool branch still specified";
      if (/idempotencyKey.*anti-replay|anti-replay.*idempotencyKey/i.test(md)) return "idempotency still called anti-replay";
      return null;
    },
  },
  {
    id: "migration.notDependentOnOldPlan",
    run(md) {
      return /giữ như v2|như v2 §/.test(md) ? "depends on an older plan version" : null;
    },
  },
  {
    id: "ddl.executes",
    run(md) {
      const sql = md.match(/```sql\r?\n([\s\S]*?)```/);
      if (!sql) return "no ```sql block found";
      const dir = mkdtempSync(join(tmpdir(), "plan-check-"));
      const ddlPath = join(dir, "ddl.sql");
      writeFileSync(ddlPath, sql[1]);
      const pyPath = join(dir, "ddlcheck.py");
      writeFileSync(
        pyPath,
        ["import sqlite3, sys", "con = sqlite3.connect(':memory:')", "con.executescript(open(sys.argv[1], encoding='utf-8').read())", ""].join("\n"),
      );
      const runners = [
        ["sqlite3", [":memory:", `.read ${ddlPath}`]],
        ["python3", [pyPath, ddlPath]],
        ["python", [pyPath, ddlPath]],
      ];
      for (const [cmd, args] of runners) {
        try {
          execFileSync(cmd, args, { stdio: "pipe" });
          return null;
        } catch (err) {
          if (err.code === "ENOENT") continue;
          const msg = String(err.stderr ?? err.message).trim().split("\n")[0];
          return `DDL execute failed (${cmd}): ${msg}`;
        }
      }
      return "DDL not executed: no sqlite3/python available";
    },
  },
  {
    id: "ddl.turnCheckAllowsQueuedTerminal",
    run(md) {
      const sql = md.match(/```sql\r?\n([\s\S]*?)```/);
      if (!sql) return "no sql block";
      const turnCheck = sql[1].match(/CREATE TABLE IF NOT EXISTS turns[\s\S]*?CHECK \(([\s\S]*?)\)\s*,?\s*FOREIGN KEY/);
      if (!turnCheck) return "turns CHECK not found";
      const c = turnCheck[1];
      if (!/status = 'queued'[\s\S]{0,120}queued_at IS NOT NULL/.test(c)) return "queued branch does not require queued_at";
      return /status IN \('cancelled','failed'\)[\s\S]{0,160}started_at IS NULL/.test(c)
        ? null
        : "no terminal-before-start branch";
    },
  },
];

function runChecks(md) {
  const results = [];
  for (const check of CHECKS) {
    let failure;
    try {
      failure = check.run(md);
    } catch (err) {
      failure = `threw: ${err.message}`;
    }
    results.push({ id: check.id, failure });
  }
  return results;
}

function selfTest() {
  // Mutate a synthetic plan in ways each check should catch.
  const cases = [
    ["identity.tabIntent.singleDeclaration", (md) => md + "\ntype TabIntent = { x: 1 };\n"],
    ["lock.usesOsLockNotMtime", () => "lockTentativeMs"],
    ["persistence.attention.notAColumn", () => "attention TEXT"],
    ["transport.envelopeHeadroom", () => '"maxEnvelopeBytes": 1048576'],
  ];
  const real = readFileSync(DEFAULT_PLAN, "utf8");
  let failed = 0;
  for (const [id, mutate] of cases) {
    const check = CHECKS.find((c) => c.id === id);
    const mutated = mutate(real);
    const res = check.run(mutated);
    if (res === null) {
      console.log(`SELFTEST FAIL: ${id} did not detect mutation`);
      failed++;
    } else {
      console.log(`selftest ok  : ${id} detected -> ${String(res).slice(0, 60)}`);
    }
  }
  // And the pristine plan must pass every check, otherwise self-test is meaningless.
  for (const r of runChecks(real)) {
    if (r.failure) {
      console.log(`SELFTEST FAIL: pristine plan fails ${r.id}: ${r.failure}`);
      failed++;
    }
  }
  console.log(failed ? `\nself-test FAILED (${failed})` : "\nself-test passed");
  process.exit(failed ? 1 : 0);
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) selfTest();

const planPath = args[0] ?? DEFAULT_PLAN;
const md = readFileSync(planPath, "utf8");
const results = runChecks(md);

let failed = 0;
for (const { id, failure } of results) {
  if (failure) {
    failed++;
    console.log(`FAIL  ${id}: ${failure}`);
  } else {
    console.log(`ok    ${id}`);
  }
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
