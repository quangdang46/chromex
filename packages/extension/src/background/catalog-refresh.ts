import type { CodexModelOption } from "@codex-sidepanel/shared";

export interface CatalogRefreshDecisionInput {
  inFlight: boolean;
  lastRequestedWorkspaceRoot: string | null;
  workspaceRoot: string | undefined;
  force: boolean | undefined;
}

export const FALLBACK_CODEX_MODELS: CodexModelOption[] = [
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    description: "Fallback model used when the Codex app-server model catalog is temporarily unavailable.",
    isDefault: true,
    supportsImages: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
    additionalSpeedTiers: ["fast"],
    supportsParallelToolCalls: true,
    supportsSearchTool: true,
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    description: "Fallback model used when the Codex app-server model catalog is temporarily unavailable.",
    isDefault: false,
    supportsImages: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
    additionalSpeedTiers: ["fast"],
    supportsParallelToolCalls: true,
    supportsSearchTool: true,
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    description: "Fallback coding model used when the Codex app-server model catalog is temporarily unavailable.",
    isDefault: false,
    supportsImages: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
    additionalSpeedTiers: ["fast"],
    supportsParallelToolCalls: true,
    supportsSearchTool: true,
  },
];

export interface CatalogAffectingSettingsInput {
  previousWorkspaceRoot: string | undefined;
  nextWorkspaceRoot: string | undefined;
  previousCodexBinPath: string | undefined;
  nextCodexBinPath: string | undefined;
  previousCustomModels?: readonly string[];
  nextCustomModels?: readonly string[];
}

export function normalizeCatalogWorkspaceRoot(workspaceRoot?: string): string {
  return workspaceRoot?.trim() ?? "";
}

export function normalizeCatalogSettingsPath(value?: string): string {
  let normalized = value?.trim() ?? "";
  while (
    normalized.length >= 2 &&
    ((normalized.startsWith("\"") && normalized.endsWith("\"")) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

export function shouldTriggerCatalogRefresh(input: CatalogRefreshDecisionInput): boolean {
  if (input.inFlight) {
    return false;
  }

  if (input.force) {
    return true;
  }

  return normalizeCatalogWorkspaceRoot(input.workspaceRoot) !== input.lastRequestedWorkspaceRoot;
}

export function shouldRefreshCatalogAfterSettingsUpdate(input: CatalogAffectingSettingsInput): boolean {
  return (
    normalizeCatalogSettingsPath(input.previousWorkspaceRoot) !== normalizeCatalogSettingsPath(input.nextWorkspaceRoot) ||
    normalizeCatalogSettingsPath(input.previousCodexBinPath) !== normalizeCatalogSettingsPath(input.nextCodexBinPath) ||
    (input.previousCustomModels ?? []).join("\n") !== (input.nextCustomModels ?? []).join("\n")
  );
}

export function resolveCatalogModelState(input: {
  modelRequestFailed: boolean;
  models: unknown[];
}): "loading" | "ready" | "empty" | "error" {
  if (input.modelRequestFailed) {
    return "error";
  }

  return input.models.length ? "ready" : "empty";
}

export function isRecoverableModelCatalogAuthError(message: string): boolean {
  return /api[- ]?key auth|incorrect api key|invalid_api_key|openai authentication is required/iu.test(message);
}

export function recoverModelCatalogAfterAuthError(input: {
  previousModels: CodexModelOption[];
  selectedModel: string | null | undefined;
}): CodexModelOption[] {
  if (input.previousModels.length) {
    return input.previousModels;
  }
  const selectedModel = input.selectedModel?.trim() ?? "";
  if (!selectedModel || FALLBACK_CODEX_MODELS.some((model) => model.id === selectedModel)) {
    return FALLBACK_CODEX_MODELS;
  }
  return [
    {
      id: selectedModel,
      label: selectedModel,
      description: "Previously selected model.",
      isDefault: true,
      supportsImages: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
      additionalSpeedTiers: ["fast"],
      supportsParallelToolCalls: true,
      supportsSearchTool: true,
    },
    ...FALLBACK_CODEX_MODELS.map((model) => ({ ...model, isDefault: false })),
  ];
}

export function mergeCustomCatalogModels(
  models: CodexModelOption[],
  customModelIds: readonly string[],
): CodexModelOption[] {
  const seen = new Set(models.map((model) => model.id));
  const extras: CodexModelOption[] = [];
  for (const rawId of customModelIds) {
    const id = rawId.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    extras.push({
      id,
      label: id,
      description: "Custom model configured in extension settings.",
      isDefault: false,
      supportsImages: false,
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
      supportsParallelToolCalls: true,
      supportsSearchTool: false,
    });
  }
  return extras.length ? [...models, ...extras] : models;
}

export function resolveSelectedCatalogModel(input: {
  selectedModel: string | null | undefined;
  models: Array<{ id: string; isDefault?: boolean }>;
}): string {
  const selectedModel = input.selectedModel?.trim() ?? "";
  if (selectedModel && input.models.some((model) => model.id === selectedModel)) {
    return selectedModel;
  }

  return input.models.find((model) => model.isDefault)?.id ?? input.models[0]?.id ?? "";
}
