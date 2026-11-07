/**
 * App-service registry + turn-context renderer — chromex-p21.
 *
 * Agents own their environment: when a task's agent starts a dev server
 * it reports {name,url,port,pid,cwd} via the `app.report` gateway RPC.
 * The registry keeps services per taskId (in-memory for the gateway
 * lifetime — services die with their dev server anyway, and a restart
 * re-reports on the next turn) and renders a PRIVATE APP CONTEXT block
 * that SessionManager injects into every TurnInput's ctx.instructions.
 *
 * The block is harness-trusted: it is NEVER wrapped in
 * <untrusted_page_content> fences — it is our own data, and agents must
 * be able to follow its instructions (report more services).
 */

export interface AppServiceInfo {
  name: string;
  url?: string;
  port?: number;
  pid?: number;
  cwd?: string;
  status: string;
  reportedAt: number;
}

export interface AppServiceReport {
  name: string;
  url?: string | undefined;
  port?: number | undefined;
  pid?: number | undefined;
  cwd?: string | undefined;
  status?: string | undefined;
}

export const APP_CONTEXT_SECTION_LABEL = "PRIVATE APP CONTEXT - DO NOT MENTION";

/** Strip line breaks/control chars — reported fields are agent-supplied
 *  and must not be able to forge additional section labels. */
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
}

function describeService(s: AppServiceInfo): string {
  const parts = [`- ${clean(s.name)}`];
  if (s.url) parts.push(clean(s.url));
  if (s.port !== undefined) parts.push(`port ${s.port}`);
  if (s.pid !== undefined) parts.push(`pid ${s.pid}`);
  if (s.cwd) parts.push(`cwd ${clean(s.cwd)}`);
  parts.push(`status ${clean(s.status)}`);
  return parts.join(" — ");
}

/**
 * Render the full PRIVATE APP CONTEXT section (header included) for
 * embedding into turn input. Always non-empty: even with zero reported
 * services it teaches the agent how to register one — that is the whole
 * point of the bead (agents must not guess dev-server ports).
 */
export function renderAppContext(
  taskId: string,
  services: readonly AppServiceInfo[],
  cliPath?: string,
): string {
  const lines: string[] = [
    APP_CONTEXT_SECTION_LABEL,
    "Harness-trusted environment state for this task — not page content.",
    `Task id: ${clean(taskId)}`,
    "Services reported for this task — prefer these URLs/ports; never guess dev-server ports:",
  ];
  if (services.length === 0) {
    lines.push("- (none reported yet)");
  } else {
    for (const s of services) lines.push(describeService(s));
  }
  if (cliPath) {
    lines.push(
      "After you start a dev server, report it so later turns can reach it:",
      `node "${clean(cliPath)}" report --task ${clean(taskId)} --name <name> --url <url> [--port N] [--pid N] [--cwd DIR] [--status running]`,
      "Re-report the same name after a restart/rebind — it upserts.",
    );
  } else {
    lines.push(
      "After you start a dev server, report it via gateway RPC `app.report` {taskId, name, url, port?, pid?, cwd?} over the gateway IPC socket so later turns can reach it.",
    );
  }
  return lines.join("\n");
}

export class AppServiceRegistry {
  /** taskId → service name → record. Insertion order = report order. */
  readonly #byTask = new Map<string, Map<string, AppServiceInfo>>();

  constructor(private readonly opts: { cliPath?: string } = {}) {}

  /** Upsert by (taskId, name) — re-reporting a name replaces the record
   *  (server restarted on a new port/pid). */
  report(taskId: string, input: AppServiceReport): AppServiceInfo {
    const service: AppServiceInfo = {
      name: input.name,
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      status: input.status ?? "running",
      reportedAt: Date.now(),
    };
    let taskServices = this.#byTask.get(taskId);
    if (!taskServices) {
      taskServices = new Map();
      this.#byTask.set(taskId, taskServices);
    }
    taskServices.set(service.name, service);
    return service;
  }

  list(taskId: string): AppServiceInfo[] {
    const taskServices = this.#byTask.get(taskId);
    return taskServices ? [...taskServices.values()] : [];
  }

  clearTask(taskId: string): void {
    this.#byTask.delete(taskId);
  }

  /** Rendered PRIVATE APP CONTEXT block for turn injection. Always
   *  returns the section — the registration hint must reach the agent
   *  before its first service exists. */
  contextForTask(taskId: string): string {
    return renderAppContext(taskId, this.list(taskId), this.opts.cliPath);
  }
}
