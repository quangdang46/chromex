import type { PageContextEnvelope, PromptEnvelope, ProfileTemplate, RawPageCapture, VisionAsset } from "./types.js";

const DOM_SUMMARY_TRANSPORT_LIMIT = 240_000;

/**
 * Prompt-injection defense (chromex-rvs): page-derived fields are
 * interpolated into the same prompt blob as USER REQUEST and the PRIVATE
 * * section labels. A hostile page can embed text that forges those
 * labels ("PRIVATE PAGE CONTEXT 2", "USER REQUEST", the ask-user tag) to
 * corrupt section parsing or impersonate instructions.
 *
 * `defusePageContentLabels` neutralizes every known structural label
 * inside untrusted content by replacing its whitespace/underscore runs
 * with "·" — readable, but no longer equal to (or substring-matching) the
 * real label, tag, or marker. Legitimate page prose almost never contains
 * these exact phrases; when it does the defused form still reads fine.
 */
const PAGE_CONTENT_LABEL_PATTERN = new RegExp(
  `(?:${[
    String.raw`USER\s+REQUEST`,
    String.raw`PRIVATE\s+PAGE\s+CONTEXT(?:\s+\d+)?`,
    String.raw`PRIVATE\s+ASSISTANT\s+BEHAVIOR`,
    String.raw`PRIVATE\s+ROUTING\s+CONTEXT`,
    String.raw`PRIVATE\s+CONVERSATION\s+CONTEXT`,
    String.raw`PRIVATE\s+INSTRUCTION\s+PROFILE`,
    String.raw`PRIVATE\s+PROFILE\s+QUESTION\s+TOOL`,
    String.raw`HARNESS\s+APPENDIX`,
    String.raw`ATTACHED\s+FILE(?:\s+\d+)?`,
    String.raw`OVERSIZED\s+PAGE\s+CONTEXT\s+FILE`,
    String.raw`chromex_ask_user_question`,
    String.raw`untrusted_page_content`,
    String.raw`CHROMEX_UNTRUSTED_BROWSER_DATA`,
  ].join("|")})\\b`,
  "giu",
);

export function defusePageContentLabels(value: string): string {
  return value.replace(PAGE_CONTENT_LABEL_PATTERN, (match) => match.replace(/[\s_]+/gu, "·"));
}

/** Deep-defuse string values (and keys) inside adapter payloads — page
 *  adapters return arbitrary JSON whose strings reach the prompt. */
function defuseAdapterStrings(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return defusePageContentLabels(value);
  }
  if (value === null || typeof value !== "object" || depth >= 6) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => defuseAdapterStrings(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      defusePageContentLabels(key),
      defuseAdapterStrings(nested, depth + 1),
    ]),
  );
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function summarizeDomText(bodyText: string): string {
  const cleaned = cleanText(bodyText);
  if (cleaned.length <= DOM_SUMMARY_TRANSPORT_LIMIT) {
    return cleaned;
  }

  return `${cleaned.slice(0, DOM_SUMMARY_TRANSPORT_LIMIT - 1).trimEnd()}…`;
}

export function normalizePageContext(raw: RawPageCapture): PageContextEnvelope {
  const visionAssets: VisionAsset[] = [];

  if (raw.screenshotRef) {
    visionAssets.push({
      ref: raw.screenshotRef,
      kind: "screenshot" as const,
    });
  }

  for (const image of raw.images.slice(0, 2)) {
    const width = image.width ?? image.naturalWidth;
    const height = image.height ?? image.naturalHeight;
    const asset: VisionAsset = {
      ref: image.url,
      kind: "page-image",
      originUrl: image.url,
    };

    if (typeof width === "number") {
      asset.width = width;
    }

    if (typeof height === "number") {
      asset.height = height;
    }

    visionAssets.push(asset);
  }

  return {
    metadata: {
      url: defusePageContentLabels(raw.metadata.url),
      title: defusePageContentLabels(raw.metadata.title),
      domain: defusePageContentLabels(raw.metadata.domain),
    },
    selectionText: defusePageContentLabels(cleanText(raw.selectedText)),
    domSummary: defusePageContentLabels(summarizeDomText(raw.bodyText)),
    visionAssets,
    adapterPayload:
      raw.adapterPayload === null ? null : (defuseAdapterStrings(raw.adapterPayload) as Record<string, unknown>),
    privacyFlags: raw.privacyFlags,
  };
}

export function createPromptEnvelope(
  profile: ProfileTemplate,
  message: string,
  contexts: PageContextEnvelope[],
): PromptEnvelope {
  return {
    profile,
    message: message.trim(),
    contexts,
  };
}
