import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sidepanelSource = readFileSync(resolve(process.cwd(), "src/sidepanel/index.ts"), "utf8");
const backgroundSource = readFileSync(resolve(process.cwd(), "src/background/index.ts"), "utf8");
const storageSource = readFileSync(resolve(process.cwd(), "src/background/storage.ts"), "utf8");
const typesSource = readFileSync(resolve(process.cwd(), "src/types.ts"), "utf8");
const css = readFileSync(resolve(process.cwd(), "public/sidepanel.css"), "utf8");

/**
 * P3-04 — provider picker plumbing. Source-level assertions (same
 * convention as settings-panel.test.ts): the picker must stay hidden
 * unless gatewayMode is on AND the gateway reports >1 provider, and
 * providerId must flow settings → session.open/model.list → compat.
 */
describe("agent provider picker (P3-04)", () => {
  test("agentProviderId is a first-class setting with codex default", () => {
    expect(typesSource).toContain("agentProviderId: string;");
    expect(storageSource).toContain('agentProviderId: "codex"');
    expect(storageSource).toContain("patch.agentProviderId ?? current.agentProviderId");
  });

  test("picker renders only in gatewayMode with multiple providers", () => {
    expect(sidepanelSource).toContain("function renderComposerProviderSelect");
    expect(sidepanelSource).toContain("!state.settings.gatewayMode || state.agentProviders.length < 2");
    expect(sidepanelSource).toContain('id="agent-provider-select"');
    expect(css).toContain(".composer-provider-select");
  });

  test("provider change persists via settings.update and re-fetches catalog", () => {
    expect(sidepanelSource).toContain('type: "settings.update"');
    expect(sidepanelSource).toContain("settings: { agentProviderId: providerId }");
    expect(sidepanelSource).toContain("scheduleInitialize({ forceCatalog: true })");
    expect(backgroundSource).toContain("patch.agentProviderId !== previousSettings.agentProviderId");
  });

  test("providerId flows into session.open and model.list", () => {
    expect(backgroundSource).toContain("providerId: settings.agentProviderId || \"codex\"");
    expect(backgroundSource).toContain("providerId: state.selectedProviderId");
    expect(backgroundSource).toContain('"provider.catalog"');
  });

  test("catalog providers populate picker state in ui.init payload", () => {
    expect(backgroundSource).toContain("state.agentProviders = providers.length");
    expect(backgroundSource).toContain("agentProviders: state.agentProviders");
    expect(backgroundSource).toContain("selectedProviderId: state.selectedProviderId");
    expect(sidepanelSource).toContain("state.agentProviders = payload.agentProviders ?? []");
  });
});
