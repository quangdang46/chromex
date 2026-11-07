export interface SlashCommand {
  name: string;
  description?: string;
  /** argument hint shown in UI, e.g. "/review <file>" */
  argumentHint?: string;
}
