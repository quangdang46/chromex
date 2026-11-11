import type { UiLocale } from "./i18n.js";
import { getUiStrings } from "./i18n.js";

export type AttachmentMenuAction =
  | "add-files"
  | "toggle-plan-mode"
  | "toggle-goal-mode"
  | "attach-tabs"
  | "attach-screenshot"
  | "saved-prompts";

export interface AttachmentMenuItem {
  action: AttachmentMenuAction;
  label: string;
  icon: "paperclip" | "list-checks" | "target" | "video" | "scan" | "bookmark";
  section: "primary";
  enabled: boolean;
  kind?: "button" | "toggle";
  hasSubmenu?: boolean;
}

export function listAttachmentMenuItems(
  locale: UiLocale,
  options: { goalModeSupported?: boolean } = {},
): AttachmentMenuItem[] {
  const strings = getUiStrings(locale);
  const goalSupported = options.goalModeSupported !== false;
  return [
    {
      action: "add-files",
      label: strings.actions.attachFiles,
      icon: "paperclip",
      section: "primary",
      enabled: true,
    },
    {
      action: "toggle-plan-mode",
      label: locale === "ko" ? "플랜 모드" : "Plan mode",
      icon: "list-checks",
      section: "primary",
      enabled: true,
      kind: "toggle",
    },
    ...(goalSupported
      ? [
          {
            action: "toggle-goal-mode" as const,
            label: locale === "ko" ? "골 모드" : "Goal mode",
            icon: "target" as const,
            section: "primary" as const,
            enabled: true,
            kind: "toggle" as const,
          },
        ]
      : []),
    {
      action: "attach-tabs",
      label: strings.actions.attachTabs,
      icon: "video",
      section: "primary",
      enabled: true,
    },
    {
      action: "attach-screenshot",
      label: strings.actions.attachScreenshot,
      icon: "scan",
      section: "primary",
      enabled: true,
    },
    {
      action: "saved-prompts",
      label: strings.actions.savedPrompts,
      icon: "bookmark",
      section: "primary",
      enabled: true,
    },
  ];
}
