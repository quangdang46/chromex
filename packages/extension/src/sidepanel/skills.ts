import type { ProfileTemplate } from "@codex-sidepanel/shared";

import { localizeBuiltinProfileName } from "../profile-localization.js";
import { getUiStrings, type UiLocale } from "./i18n.js";

export interface SkillOption {
  id: string;
  name: string;
  prompt: string;
  description: string;
  builtin?: boolean;
  source?: "builtin" | "saved" | "project" | "user";
  readonly?: boolean;
  path?: string;
}

export type SlashCommandOption =
  {
    id: `profile:${string}`;
    kind: "profile";
    profileId: string;
    label: string;
    description: string;
    visual?: ProfileTemplate["visual"];
    active?: boolean;
  }
  | {
    id: "goal";
    kind: "goal";
    label: string;
    description: string;
  }
  | {
    id: "create-profile";
    kind: "create-profile";
    label: string;
    description: string;
  };

type SlashProfileCommandOption = Extract<SlashCommandOption, { kind: "profile" }>;

const SLASH_QUERY_PATTERN = /(?:^|\s)\/([\p{L}\p{N}\p{M}_\- ]*)$/iu;

export function extractSlashQuery(value: string): string | null {
  const match = SLASH_QUERY_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  return (match[1] ?? "").trim().toLowerCase();
}

export function listSkillOptions(_query: string, _customSkills: SkillOption[] = [], _locale: UiLocale = "en"): SkillOption[] {
  return [];
}

export function listSlashCommandOptions(
  query: string,
  _customSkills: SkillOption[] = [],
  profiles: ProfileTemplate[] = [],
  locale: UiLocale = "en",
  activeProfileId = "",
): SlashCommandOption[] {
  const normalized = query.trim().toLowerCase();
  const profileOptions = profiles
    .map<SlashProfileCommandOption>((profile) => ({
      id: `profile:${profile.id}` as const,
      kind: "profile",
      profileId: profile.id,
      label: localizeBuiltinProfileName(profile.id, profile.name, locale),
      description: "",
      ...(profile.visual ? { visual: profile.visual } : {}),
      ...(profile.id === activeProfileId ? { active: true } : {}),
    }))
    .filter((option) => matchesSlashOption(option, normalized));

  const strings = getUiStrings(locale);
  const goalOption: SlashCommandOption = {
    id: "goal",
    kind: "goal",
    label: strings.actions.goalMode,
    description: strings.actions.goalModeDescription,
  };

  const createProfileOption: SlashCommandOption = {
    id: "create-profile",
    kind: "create-profile",
    label: strings.actions.createProfileDirect,
    description: "",
  };

  return [
    ...profileOptions.sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active))),
    ...(matchesSlashOption(goalOption, normalized) ? [goalOption] : []),
    createProfileOption,
  ];
}

/**
 * Objective seed for the "/goal" command: everything the user typed,
 * minus the "/" token and a leading "goal" keyword. "/goal fix the
 * bug" and "please /fix bug" both yield a usable objective.
 */
export function slashGoalSeedFromDraft(draft: string): string {
  const match = SLASH_QUERY_PATTERN.exec(draft);
  const after = (match?.[1] ?? "").trim().replace(/^goal\b[\s\-–—:]*/iu, "").trim();
  const before = removeActiveSlashToken(draft).trim();
  return [before, after].filter(Boolean).join(" ");
}

export function removeActiveSlashToken(currentValue: string): string {
  return currentValue.replace(SLASH_QUERY_PATTERN, (match) => (match.startsWith(" ") ? " " : "")).trimEnd();
}

function matchesSlashOption(option: SlashCommandOption, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }

  const searchable = option.kind === "profile"
    ? [option.profileId, option.label, option.description]
    : [option.label, option.description];
  return searchable.some((value) => value.toLowerCase().includes(normalizedQuery));
}
