import { describe, expect, test } from "vitest";

import { listAttachmentMenuItems } from "../src/sidepanel/attachment-menu.js";

describe("attachment menu", () => {
  test("shows only implemented attachment actions in scan order", () => {
    expect(listAttachmentMenuItems("ko").map((item) => item.action)).toEqual([
      "add-files",
      "toggle-plan-mode",
      "toggle-goal-mode",
      "attach-tabs",
      "attach-screenshot",
      "saved-prompts",
    ]);
  });

  test("hides goal mode when the provider does not support it", () => {
    const actions = listAttachmentMenuItems("en", { goalModeSupported: false }).map((item) => item.action);

    expect(actions).not.toContain("toggle-goal-mode");
    expect(actions).toContain("toggle-plan-mode");
  });

  test("does not expose unsupported or project actions", () => {
    const items = listAttachmentMenuItems("en");

    expect(items.every((item) => item.enabled)).toBe(true);
    expect(items.map((item) => item.action)).not.toContain("project");
    expect(items.map((item) => item.action)).not.toContain("recent-files");
    expect(items.map((item) => item.action)).not.toContain("deep-research");
  });

  test("renders the plan mode control as a toggle entry", () => {
    const item = listAttachmentMenuItems("ko").find((entry) => entry.action === "toggle-plan-mode");

    expect(item).toMatchObject({
      label: "플랜 모드",
      icon: "list-checks",
      kind: "toggle",
      enabled: true,
    });
  });
});
