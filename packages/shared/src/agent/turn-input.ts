import type { ProviderId } from "./provider-id.js";

/**
 * TurnInput — plan §4.3.
 * `gatewayTurnId` is Gateway-assigned; adapters MUST use it to tag events
 * and MUST NOT mint their own turn identity.
 */
export interface TurnInput {
  /** Gateway-assigned. Adapter must use it to attach events; never self-generate. */
  gatewayTurnId: string;
  clientMessageId: string;
  /** ordered user content: text + parts */
  content: TurnContentPart[];
  ctx?: {
    /** files/images already materialized */
    attachments?: AttachmentRef[];
    /** snapshot/tab/history references */
    contextRefs?: ContextRef[];
    /** per-turn supplementary instructions (not the system prompt) */
    instructions?: string;
    metadata?: Record<string, unknown>;
  };
}

export type TurnContentPart =
  | { type: "text"; text: string }
  | { type: "image"; artifactRef: string; mimeType: string }
  | { type: "file"; artifactRef: string; name: string; mimeType: string }
  | { type: "structured"; schema: string; data: unknown };

export interface AttachmentRef {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  /** artifact store reference */
  artifactRef?: string;
  /** true when the original file was deleted */
  missing?: boolean;
}

export interface ContextRef {
  kind: "snapshot" | "tab" | "file" | "history";
  ref: string;
  label?: string;
}

export type { ProviderId };
