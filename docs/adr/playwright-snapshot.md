# ADR: Playwright snapshot/accessibility strategy

Status: DECIDED (spike-B4 / chromex-uuy, 2026-11-07, playwright-core 1.59.1 + real Chrome)

## Evidence (scripts/spike/b4-playwright-snapshot.mjs — 6/7 checks)

- `page.accessibility.snapshot()` is **REMOVED** in playwright-core 1.59.1
  (`page.accessibility` is undefined). Candidate 1 rejected.
- `locator.ariaSnapshot()` works: YAML accessibility tree
  (`- button "Hi"`, `- link "link": /url: /x`). **Chosen API.**
- Parent `body` ariaSnapshot does NOT pierce iframes — iframe appears as
  a leaf `- iframe`. Implementation MUST enumerate `page.frames()` and
  snapshot each frame's body, prefixing refs with frame identity.
- Per-frame `frame.locator("body").ariaSnapshot()` reads iframe content
  (verified on srcdoc frame; Playwright frames are CDP-level so
  cross-origin frames are equally addressable).
- `setInputFiles(path)` uploads by path without any picker →
  `upload: true`, `filePicker: false` (native dialog undrivable).

## Decision

- Snapshot API: **`locator.ariaSnapshot()`** per frame, merged with
  frame-qualified refs. DOM-walker fallback only if ariaSnapshot output
  exceeds payload cap — then artifact-chunk per §4.1.
- `iframe` capability for `playwright-isolated`: **"all"** — justified by
  per-frame ariaSnapshot + Playwright's cross-origin frame access. The
  "all" claim requires the implementation to iterate frames; a
  single-body snapshot would silently miss iframe content.
- `filePicker: false`, `upload: true` confirmed.
- Version floor: playwright-core ≥ 1.49 (ariaSnapshot introduction);
  pinned `^1.59.1` satisfies it.

## Consequences

- `DEFAULT_BACKEND_CAPABILITIES["playwright-isolated"]` values stand:
  accessibility:true, iframe:"all", upload:true, filePicker:false.
- Backend implementation (`P2-07`) must implement frame-iterated
  ariaSnapshot; refs carry frame index/id for staleness checks.
