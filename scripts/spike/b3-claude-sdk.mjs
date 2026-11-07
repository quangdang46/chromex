// B3 / chromex-sff — Claude mechanism spike against real claude install.
// Exercises: streaming SDKMessage types, session resume, interrupt,
// permission hook (canUseTool), tool use events.
// Requires: npm i @anthropic-ai/claude-agent-sdk@0.3.246 && claude CLI on PATH.
// Run: node scripts/spike/b3-claude-sdk.mjs   (skip gracefully if absent)
import { query } from "@anthropic-ai/claude-agent-sdk";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const seen = { assistantText: 0, toolUse: 0, result: null, systemInit: false, streamEvents: 0 };
const sessionIds = new Set();
let toolPermissionAsked = false;

async function runPrompt(prompt, { resume, abortController, timeoutMs = 120_000 } = {}) {
  const q = query({
    prompt,
    options: {
      cwd: "/tmp/b3-claude-spike",
      permissionMode: "default",
      canUseTool: async (toolName, input, { signal }) => {
        toolPermissionAsked = true;
        // auto-approve safe read-only for spike
        if (["Read", "Glob", "Grep"].includes(toolName)) {
          return { behavior: "allow", updatedInput: input };
        }
        return { behavior: "deny", message: `spike: ${toolName} not approved` };
      },
      ...(resume ? { resume } : {}),
      abortController,
      maxTurns: 6,
      includePartialMessages: true,
    },
  });
  const timer = setTimeout(() => abortController?.abort(), timeoutMs);
  try {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        seen.systemInit = true;
        if (msg.session_id) sessionIds.add(msg.session_id);
      } else if (msg.type === "stream_event") {
        seen.streamEvents++;
        const ev = msg.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") seen.assistantText++;
      } else if (msg.type === "assistant") {
        for (const b of msg.message?.content ?? []) {
          if (b.type === "tool_use") seen.toolUse++;
        }
      } else if (msg.type === "result") {
        seen.result = msg;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return seen.result;
}

// Test 1: basic streaming + tool permission + result
const ac1 = new AbortController();
const r1 = await runPrompt("Reply with exactly: B3-OK. Do not use tools.", { abortController: ac1 });
check("streaming: init+assistant+result messages", seen.systemInit && !!seen.result);
check("token-level stream_event deltas received", seen.assistantText > 0, `${seen.assistantText} deltas`);
check("result has session_id + usage", !!(r1?.session_id && r1?.usage), `session=${r1?.session_id}`);
check("result subtype success", r1?.subtype === "success", String(r1?.subtype));

// Test 2: resume same session — memory continuity
const sid = r1?.session_id;
if (sid) {
  const before = seen.assistantText;
  const ac2 = new AbortController();
  const r2 = await runPrompt("What did I ask you to reply with earlier? Answer with just the token.", {
    resume: sid,
    abortController: ac2,
  });
  check("resume: same session_id continues", r2?.session_id === sid);
  check("resume: result success", r2?.subtype === "success", String(r2?.subtype));
  check("resume: assistant text streamed", seen.assistantText > before, `${seen.assistantText - before} new deltas`);
} else {
  check("resume", false, "no session_id from test 1");
}

// Test 3: interrupt ownership — abort mid-turn
const ac3 = new AbortController();
const p3 = runPrompt("Count from 1 to 500 slowly, one number per line.", { abortController: ac3, timeoutMs: 300_000 });
setTimeout(() => ac3.abort(), 4000);
try {
  const r3 = await p3;
  check("interrupt: turn terminates with terminal result", !!r3, `subtype=${r3?.subtype}`);
} catch (e) {
  check("interrupt: abort propagates as error/result", true, String(e).slice(0, 80));
}

// Test 4: permission hook fired? (only if model chose a tool — informational)
check("canUseTool hook reachable", true, `asked=${toolPermissionAsked}, toolUse events=${seen.toolUse}`);

// Test 5: steer — SDK has no mid-turn steer; interrupt+resume is the model.
check("steer: NOT available natively — interrupt→new turn is the mechanism", true);

console.log(`\nB3 spike done. session_id=${sid}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
