import type { BrowserToolName } from "./tool.js";
import type { BrowserBackendId } from "./backend.js";

/**
 * Risk levels — classifier output vocabulary (plan §4.8).
 * "hard_block" and "deny" are terminal: approval can NEVER bypass them.
 */
export type RiskLevel =
  | "read"
  | "low"
  | "data_entry"
  | "data_entry_sensitive"
  | "external_mutation"
  | "financial"
  | "deny"
  | "hard_block";

export interface ActionContext {
  backendId: BrowserBackendId;
  profileId: string;
  tabId: number | string;
  url: string;
  origin: string;
  action: BrowserToolName;
  target?: {
    ref?: string;
    role?: string;
    tag?: string;
    inputType?: string;
    label?: string;
    name?: string;
    formAction?: string;
    method?: string;
    autosave?: boolean;
    isPassword?: boolean;
    isPayment?: boolean;
    isDestructive?: boolean;
  };
  dataEgress?: "none" | "page-local" | "network-form" | "download";
  /**
   * Data LEAVING the browser. Separate dimension: dataClass × destination
   * (trust boundary). Plan §4.8 P1.7/P1.8.
   */
  agentEgress?: {
    dataClass: "none" | "page-text" | "screenshot" | "attachment";
    destination: "local-provider" | "cloud-provider" | "external-mcp" | "logs-telemetry";
    /** page shows signs of sensitive non-password data (PII, email, card, address…) */
    sensitiveContent?: boolean;
  };
  /** public post/send/publish/submit side effect */
  publicSideEffect?: boolean;
  /** file picker, site blocks synthetic events */
  requiresUserGesture?: boolean;
  withinTabScope: boolean;
  /** false when classifier cannot determine target/form/origin semantics → fail closed */
  contextResolved: boolean;
}
