/**
 * Zod request-payload schemas for Gateway RPC methods — P1-07 / §4.6.
 *
 * Every new-contract method validates its payload BEFORE dispatch;
 * violations → `proto.invalid`. Legacy compat payloads keep their own
 * (looser) shapes and are translated in compat.ts.
 */

import { z } from "zod";

const taskId = z.string().min(1);
const clientMessageId = z.string().min(1).max(128);
const turnInputContent = z.array(z.record(z.string(), z.unknown())).min(1);

export const taskCreateSchema = z.object({
  profileId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  cwd: z.string().min(1),
  title: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  modeId: z.string().nullable().optional(),
  thinkingOptionId: z.string().nullable().optional(),
  providerOptions: z.record(z.string(), z.unknown()).nullable().optional(),
  conversationKey: z.string().optional(),
  resumeFrom: z.string().optional(), // compat: session.resume
  backend: z
    .object({
      backendId: z.enum(["chrome-extension", "playwright-isolated", "playwright-cdp"]),
      pinnedBy: z.enum(["user", "policy", "default"]),
    })
    .optional(),
  tabIntent: z
    .union([
      z.object({ scope: z.literal("untitled") }),
      z.object({
        scope: z.literal("active_resolved"),
        resolved: z.record(z.string(), z.unknown()),
      }),
      z.object({
        scope: z.literal("explicit"),
        refs: z.array(z.record(z.string(), z.unknown())).min(1),
      }),
    ])
    .optional(),
  browserInstanceId: z.string().nullable().optional(),
});

export const taskSendSchema = z.object({
  taskId,
  clientMessageId,
  content: turnInputContent,
  ctx: z.record(z.string(), z.unknown()).optional(),
});

export const taskIdSchema = z.object({ taskId });

export const taskSteerSchema = taskSendSchema; // same TurnInput shape

export const turnInterruptSchema = z.object({
  taskId,
  turnId: z.string().optional(),
});

export const permissionRespondSchema = z
  .object({
    requestId: z.string().min(1),
    optionId: z.string().min(1).optional(),
    answers: z.record(z.string(), z.array(z.string())).optional(),
  })
  .refine(
    (v) => v.optionId !== undefined || (v.answers !== undefined && Object.keys(v.answers).length > 0),
    { message: "permission.respond requires optionId or answers" },
  );

export const taskSyncSchema = z.object({
  taskId,
  fromSeq: z.number().int().min(0),
  maxEvents: z.number().int().min(1).max(10_000).optional(),
});

export const taskSnapshotSchema = z.object({ taskId });

export const taskSnapshotChunkSchema = z.object({
  taskId,
  snapshotRef: z.string().min(1),
  chunkIndex: z.number().int().min(0),
});

export const browserToolCallSchema = z.object({
  taskId: z.string().min(1),
  toolCallId: z.string().min(1).optional(),
  turnId: z.string().optional(),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  token: z.string().min(1),
});

export const taskPurgeSchema = z.object({
  taskId: z.string().min(1),
});

export const gatewaySyncSchema = z.object({
  fromSeq: z.number().int().min(0).optional(),
  maxEvents: z.number().int().min(1).max(10_000).optional(),
});

export const providerCatalogSchema = z.object({
  providerId: z.string().min(1).optional(),
  forceRefresh: z.boolean().optional(),
});

export const configReadSchema = z.object({}).passthrough();

export const configUpdateSchema = z.object({
  patch: z.record(z.string(), z.unknown()),
});

export const browserBackendSchema = z.object({
  backend: z.enum(["chrome-extension", "playwright-isolated", "playwright-cdp"]).optional(),
});

export const artifactUploadSchema = z.object({
  taskId,
  kind: z.string().min(1).max(64),
  mimeType: z.string().min(1).max(128),
  /** base64 payload — decoded cap enforced in handler (artifact.too_large) */
  dataBase64: z.string().min(1),
});

/**
 * route.plan / browser.action.plan — legacy pre-prompt planning payloads.
 * The planner consumes the full AgenticRouteInput / DOM snapshot; schemas
 * pin the fields the normalizers dereference and pass the rest through.
 */
export const routePlanSchema = z
  .object({
    message: z.string(),
    selectedProfileId: z.string(),
    selectedModel: z.string(),
    models: z.array(z.record(z.string(), z.unknown())),
    readStrategyOverride: z.string(),
    explicitAttachments: z.array(z.string()),
    fileAttachments: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export const browserActionPlanSchema = z
  .object({
    message: z.string(),
    snapshot: z.record(z.string(), z.unknown()),
    locale: z.string().optional(),
    generatedText: z.string().optional(),
  })
  .passthrough();
