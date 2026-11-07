import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

function readNormalizedSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

const sidepanelSource = readNormalizedSource("src/sidepanel/index.ts");
const backgroundSource = readNormalizedSource("src/background/index.ts");
const legacyEventsSource = readNormalizedSource("src/background/gateway/legacy-events.ts");
const i18nSource = readNormalizedSource("src/sidepanel/i18n.ts");
const stylesSource = readNormalizedSource("public/sidepanel.css");
const typesSource = readNormalizedSource("src/types.ts");

describe("permission approval card wiring", () => {
  test("every non-question permission kind reaches permission.approval.requested", () => {
    expect(legacyEventsSource).toContain('type: "permission.approval.requested"');
    expect(legacyEventsSource).toContain("permissionApprovalLegacyEvent");
    // ask-user prompts keep the question wizard
    expect(legacyEventsSource).toContain('type: "plan.user_input.requested"');
  });

  test("permission.expired is translated so pending cards cannot dangle", () => {
    expect(legacyEventsSource).toContain('case "permission.expired"');
    expect(legacyEventsSource).toContain('type: "permission.expired"');
    expect(sidepanelSource).toContain('event.type === "permission.expired"');
    expect(sidepanelSource).toContain("clearPendingApproval()");
  });

  test("approval card renders context and answers via permission.respond", () => {
    expect(sidepanelSource).toContain("function renderApprovalPanel");
    expect(sidepanelSource).toContain("function applyApprovalRequest");
    expect(sidepanelSource).toContain("function submitApprovalResponse");
    expect(sidepanelSource).toContain('type: "permission.respond"');
    expect(sidepanelSource).toContain("data-approval-option");
    expect(sidepanelSource).toContain("approvalPendingOptionId");
    // real option ids from the request, deny styled as danger
    expect(sidepanelSource).toContain('option.kind === "deny"');
    // task-scoped grants (allow_task / allow_egress_task) render with the
    // task-scope accent — the option label itself comes from the gateway
    expect(sidepanelSource).toContain('option.kind === "allow_egress_task"');
    expect(sidepanelSource).toContain("task-scope");
    expect(stylesSource).toContain(".approval-option.danger");
    expect(stylesSource).toContain(".approval-option.task-scope");
    expect(backgroundSource).toContain('case "permission.respond"');
    expect(backgroundSource).toContain('bridge.request("permission.respond"');
  });

  test("approval events are conversation-scoped and buffered-event safe", () => {
    expect(sidepanelSource).toContain('case "permission.approval.requested"');
    expect(sidepanelSource).toContain('case "permission.resolved"');
    expect(sidepanelSource).toContain('case "permission.expired"');
    expect(i18nSource).toContain("kindDataEntrySensitive");
    expect(i18nSource).toContain("kindAgentEgress");
    expect(i18nSource).toContain("riskExternalMutation");
    expect(i18nSource).toContain("approval: {");
  });
});

describe("verified trace badge", () => {
  test("verified flows event → trace item → badge", () => {
    expect(legacyEventsSource).toContain("isVerificationResult(payload.verified)");
    expect(typesSource).toContain('verified?: boolean | "unknown"');
    expect(sidepanelSource).toContain("message-trace-line-verified");
    expect(i18nSource).toContain('verified: "Verified"');
    expect(i18nSource).toContain('verifyUnknown: "Unverified"');
  });
});

describe("snapshot rebuild honesty", () => {
  test("snapshotToMessages emits a restore notice and synthetic trace items", () => {
    const snapshotSource = readNormalizedSource("src/background/gateway/snapshot-messages.ts");
    expect(snapshotSource).toContain("snap-restore-notice");
    expect(snapshotSource).toContain("history restored");
    expect(snapshotSource).toContain("snapshot.toolCalls");
    expect(snapshotSource).toContain("snap-tool-");
  });
});
