// S2 — Debug a live website: agent edits fixture code, drives the real
// extension browser at the result, verifies. Live-provider run
// (codex, model $CHROMEX_E2E_MODEL || "xxx") on the chrome-extension
// backend. Mirrors scripts/gateway-e2e-browsercode.mjs but with the real
// extension instead of playwright-isolated.
// BLOCKED when the provider cannot run — never faked.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { runScenario, sleep } from "./lib/harness.mjs";

const SCENARIO = "s2-debug-live";
const PROVIDER = process.env.CHROMEX_E2E_PROVIDER || "codex";
const MODEL = process.env.CHROMEX_E2E_MODEL || "xxx";
const TURN_DEADLINE_MS = Number(process.env.CHROMEX_E2E_TIMEOUT_MS || 420_000);
const BACKEND = { backendId: "chrome-extension", pinnedBy: "user" };
const TOKEN = `CHROMEX-VERIFIED-${randomUUID().slice(0, 8).toUpperCase()}`;

await runScenario(
  SCENARIO,
  async ({ runner, browser, evidence }) => {
    // fixture cwd + http server serving index.html (like browsercode e2e)
    const cwd = mkdtempSync(path.join(tmpdir(), "chromex-accept-s2-"));
    const indexPath = path.join(cwd, "index.html");
    writeFileSync(indexPath, `<!doctype html><html><body>\n<h1>before</h1>\n<p id="note">edit me</p>\n</body></html>\n`);
    const server = http.createServer((req, res) => {
      try {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(readFileSync(indexPath));
      } catch {
        res.writeHead(500);
        res.end("missing");
      }
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const BASE = `http://127.0.0.1:${port}/`;
    evidence.note(`fixture ${indexPath} at ${BASE} token ${TOKEN}`);

    try {
      const page = await browser.context.newPage();
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.bringToFront();

      let taskId;
      try {
        taskId = await runner.createTask({
          title: "s2 debug live e2e",
          cwd,
          providerId: PROVIDER,
          model: MODEL,
          backend: BACKEND,
          tabIntent: { scope: "untitled" },
        });
      } catch (e) {
        return { status: "BLOCKED", summary: `task.create failed: ${e?.message ?? e}` };
      }
      evidence.note(`task ${taskId}`);

      // Same MCP stdio fallback as s1 — codex 0.165 exposes MCP servers
      // as empty namespaces, so give the agent the concrete descriptor.
      let mcpDesc = null;
      try {
        mcpDesc = await runner.conn.request("browser.mcp.spawn", { taskId });
        evidence.note(`mcp descriptor scopeFile=${mcpDesc?.scopeFile}`);
      } catch (e) {
        evidence.note(`browser.mcp.spawn failed: ${e?.message ?? e}`);
      }
      const mcpFallback = mcpDesc
        ? [
            `If the browser tools are not callable as functions, drive the same MCP server yourself: run \`${mcpDesc.command} ${mcpDesc.args.join(" ")}\` with env CHROMEX_MCP_SCOPE_FILE=${mcpDesc.scopeFile} — it speaks MCP JSON-RPC on stdio; tool names are browser_page_navigate, browser_page_snapshot, browser_page_get, browser_page_extract, browser_page_click.`,
          ]
        : [];

      const prompt = [
        `You have MCP tools from the "chromex_browser" server (mcp__chromex_browser__browser_page_* or browser_page_*) AND normal file/shell tools. Working directory: ${cwd}`,
        `A tiny web app is served at ${BASE} from ${indexPath} (it currently shows <h1>before</h1>).`,
        `Do exactly this:`,
        `1. browser_page_navigate to ${BASE} and browser_page_snapshot to observe.`,
        `2. Edit ${indexPath}: change the <h1> text to exactly ${TOKEN}.`,
        `3. browser_page_navigate to ${BASE} again and browser_page_get/snapshot to verify the token is visible.`,
        `4. Reply with one line confirming the token you saw.`,
        ...mcpFallback,
      ].join("\n");

      let turnId;
      try {
        turnId = await runner.sendTurn(taskId, prompt);
      } catch (e) {
        return { status: "BLOCKED", summary: `task.send failed (provider unavailable?): ${e?.message ?? e}`, details: { taskId } };
      }

      const terminal = await runner.waitTerminal(taskId, turnId, TURN_DEADLINE_MS);
      await sleep(500);
      await evidence.screenshot(page, "s2-final");

      const onDisk = readFileSync(indexPath, "utf8");
      const served = await fetch(BASE).then((r) => r.text()).catch(() => "");
      const events = await runner.syncEvents(taskId);
      const classified = events.filter((e) => e.type === "browser.tool.classified");
      const actions = classified.map((e) => e.payload?.action).filter(Boolean);
      const navCount = actions.filter((a) => a === "browser.page.navigate").length;
      const OBSERVE = new Set(["browser.page.snapshot", "browser.page.get", "browser.page.extract", "browser.page.screenshot"]);
      const observes = actions.filter((a) => OBSERVE.has(a)).length;

      const pass =
        terminal?.type === "turn.completed" &&
        onDisk.includes(TOKEN) &&
        served.includes(TOKEN) &&
        navCount >= 2 &&
        observes >= 2;
      return {
        status: pass ? "PASS" : terminal ? "FAIL" : "BLOCKED",
        summary: pass
          ? "agent edited code, re-drove real browser, verified token end-to-end"
          : `terminal=${terminal?.type ?? "timeout"} disk=${onDisk.includes(TOKEN)} served=${served.includes(TOKEN)} nav=${navCount} obs=${observes}`,
        details: { taskId, turnId, terminal: terminal?.type, actions, onDiskHasToken: onDisk.includes(TOKEN), servedHasToken: served.includes(TOKEN) },
      };
    } finally {
      server.close();
    }
  },
  { autoAnswer: "allow", gatewayProviders: [PROVIDER] },
);
