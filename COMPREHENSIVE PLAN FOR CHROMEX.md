# COMPREHENSIVE PLAN FOR CHROMEX — v4.2.3 (lock ownership, event correlation, checker)

> **Trạng thái hiện tại (ghi đè kết luận cũ trong các bảng traceability):**
> - **Gate A (semantic): CHƯA KÝ** — chờ duyệt §0.0 (v4.2.1 consistency) + §0.1 (v4.1 P0).
> - **Gate A-final (implementation): spikes ĐÃ XONG** — B5 (IPC: unix socket + token, `docs/adr/ipc-transport.md`), B6 (`browserInstanceId` qua chromePpid, `docs/adr/browser-instance.md` + `native-host/browser-instance.ts`), B7 (`synchronous=FULL` giữ nguyên, `docs/adr/durability.md` + `store/db.ts`). Còn lại là sign-off/verification, không còn spike mở. Ba mục này **không** chặn Gate A semantic.
> - **Gate C (implementation-ready): CHƯA ĐẠT** — theo 10 tiêu chí §12.
> - **`synchronous = FULL`:** **đã chốt** làm mặc định. B7 chỉ xem xét có lý do hạ xuống NORMAL; nếu hạ phải cập nhật cam kết §5.6.
>
> **Lịch sử:** v4 → v4.1 → v4.2 → v4.2.1 → v4.2.2 → **v4.2.3**. v4.2.3 giới hạn phạm vi: (a) thay mtime-based reclaim bằng **OS lock + fencing token**, (b) envelope ràng buộc `type`⇄`payload` ở compile-time, (c) bổ sung 2 error code thiếu, (d) sửa tên event trong invariant, (e) checker chặt hơn + có `--self-test`.
> **Chưa** phải “implement mọi thứ ngay” — mục tiêu là đưa Gate A/B về trạng thái ký được, Gate C là chi tiết hoá theo PR.
> **Repo audit:** `main` @ `9744c6a`; npm workspaces; Vitest. Untracked tại thời điểm audit: chính file plan này. Không có thay đổi source đang chờ.
> **Packages:** `@codex-sidepanel/{shared,bridge,native-host,extension}`.
> **Reference:** `.tmp/paseo` (subsystem-level: `agent-sdk-types`, `provider-registry`, `provider-runner`, `mcp-server`, `browser-tools/{broker,tools,policy,errors}`, `provider-snapshot-manager`, `agent-storage`, `providers/claude/*`).
> **Ưu tiên:** Codex + Claude Code first-class. Claude **spike sớm** (Gate B), không chờ hết Browser Runtime.
> **Browser:** default `chrome-extension` (tab/session thật); `playwright-isolated` là backend opt-in; **không xoá** Playwright capability hiện có.

---

## 0.000 Patch v4.2.2 → v4.2.3 (traceability)

| # | Vấn đề | Sửa | Vị trí |
|---|---|---|---|
| **A** | Reclaim lock bằng `mtime > 10s` vẫn race: process bị suspend > 10s vẫn tin mình là owner; metadata rỗng không cho biết PID để kiểm tra | **Bỏ mtime hoàn toàn.** Ownership = **OS advisory lock** (`flock` POSIX / `LockFileEx` Windows) trên file cố định; OS nhả khi process chết. Thêm **fencing token** (ULID) mọi lần acquire; mọi ghi state phải khớp fence hiện tại, lệch ⇒ từ chối + tự shutdown. Không `unlink` để reclaim. Crash table 5a/5a′ + 5 test bắt buộc (gồm SIGSTOP > 10s và resume với fence cũ) | §3.3.1, §3.3.2 |
| **B** | `browser.host_lost_after_dispatch`, `browser.result_lost` dùng trong bảng nhưng thiếu trong union | Thêm cả hai vào `ProtocolErrorCode` + hàng phân loại `retryable/requiresUserAction/sideEffectState` | §4.2 |
| **C** | Invariant #5 còn ghi `approval.expired` (error code, không phải event) | Đổi thành `permission.expired`; ghi rõ `approval.expired` là error code | §4.4 |
| **D** | Envelope `type: XType; payload: X` cho phép lệch type↔payload | `DurableTaskEventEnvelope` / `DurableGatewayEventEnvelope` thành **distributive mapped union** `{ [E in Union as E["type"]]: { type: E["type"]; payload: E } }[Union["type"]]`; envelope union tham chiếu hai alias này | §4.1, §4.4 |
| **E** | Checker lỏng, không tái lập được tiêu chí; có nguy cơ pass rỗng | Viết lại: 30 check có `id`, mỗi check trả lý do fail; thêm **`--self-test`** chứng minh checker phát hiện mutation; sửa false-positive (prose vs declaration, event vs error code, CRLF) | §4.11, `scripts/plan/check-plan-consistency.mjs` |

---

## 0.00 Consistency patch v4.2.1 → v4.2.2 (traceability)

| # | Vấn đề | Sửa | Vị trí |
|---|---|---|---|
| **P0.1** | Cấp seq bằng `MAX(seq)` → lùi sau prune | Cấp `tasks.last_seq + 1` trong `BEGIN IMMEDIATE`; `MAX(seq)` chỉ để audit (`MAX <= last_seq`) | §7.2 |
| **P0.2** | Lock orphan khi crash giữa `wx` và ghi metadata | (v4.2.2 dùng tentative+mtime → **đã bị thay** ở v4.2.3 bằng OS lock + fence) | §3.3.1, §3.3.2 |
| **P0.3** | “Không ai giữ cả hai lock” trái handoff | Đổi thành “**không process nào sở hữu đồng thời** cả hai”; overlap giữa 2 process trong handoff là **được phép** | §3.3.1 |
| **P0.4** | Invariant đòi `turn.started` cho turn queued bị cancel | Tách 2 nhánh theo `started_at`: đã start ⇒ 1 started + 1 terminal; terminal trước start ⇒ **không** started + 1 terminal | §4.4 |
| **P0.5** | `lastReadSeq <= terminal` đánh dấu unread sai khi vừa đọc | Đổi thành `<`; định nghĩa khởi tạo/cập nhật `lastReadSeq`, và `= snapshot.lastSeq` khi nhận snapshot | §4.6 |
| **P0.6** | Durable gateway envelope vẫn nhận `GatewayEvent` rộng | Thêm `GatewayNotice`, `DurableGatewayEvent`, `DurableGatewayEventType`; ephemeral envelope dùng `GatewayNotice`; envelope dựng lại từ union thay vì `Extract` | §4.1, §4.4 |
| **P0.7** | Template insert turn thiếu `queued_at` | Thêm `queued_at` vào INSERT + UPSERT (`COALESCE` giữ giá trị cũ); CHECK đòi `queued_at NOT NULL` cho queued/running | §4.4.1, §7.2 |
| **P0.8** | Chunking chưa phải contract | `TaskSnapshot` thành discriminated union: `InlineTaskSnapshot` / `ChunkedTaskSnapshotManifest` / `ArtifactTaskSnapshotManifest`; `TaskSnapshotData` là base; chunk có `taskId/snapshotRef/chunkIndex/chunkCount/data/sha256/snapshotSha256` | §4.6 |
| **P0.9** | Hello thiếu gateway cursor | Thêm `lastSeqByGateway?` (default 0) + `gatewayLastSeq` | §4.6 |
| **P1.1** | Queued turn sau restart | Giữ `queued`; **không** tự chạy; UI hỏi [Tiếp tục queue]/[Huỷ] | §5.6 |
| **P1.2** | Snapshot mất assistant message lớn | `assistantMessageRef`, `sha256`, `bytes`, `missing` | §4.6 |
| **P1.3** | Snapshot tool call thiếu ref input | `inputArtifactRef`/`outputArtifactRef` + `inputMissing`/`outputMissing` | §4.6 |
| **P1.4** | `task.purged` không replay được | Bỏ khỏi task stream; thêm `gateway.task_purged` tombstone (replayable) | §4.4 |
| **P1.5** | `conversation_key` chưa có integrity check | SQL integrity check bắt buộc ở startup + test | §7.2 |
| **P1.6** | Host mất khi tool chạy: 3 kết cục chưa phân định | Thêm dispatch lifecycle: `browser.no_host` (trước dispatch, none) / `browser.host_lost_after_dispatch` (unknown) / `browser.result_lost` (reconcile) | §4.2, §5.2.1, §6.1 |
| **P1.7** | `agentEgress` thiếu đích | Đổi thành object `{dataClass, destination, sensitiveContent}` | §4.8 |
| **P1.8** | `allow_task` cấp egress quá rộng | Scope thêm `dataClass+destination`; cấm egress ngoài `local-provider` hoặc `sensitiveContent` | §4.8 |
| **P1.9** | `browser.no_host` thiếu side-effect | Bảng phân loại 3 code theo lifecycle | §4.2 |
| **P1.10** | Hard cap = transport limit | `MAX_ENVELOPE_BYTES_HARD = 786432`; transport 1 MiB tách riêng | §4.1 |
| **P1.11** | Playwright `iframe:"all"` tuyên bố chắc | `PROVISIONAL(spike-B4)`; tách `filePicker` vs `setInputFiles` | §6.5 |
| **C1** | Diagram concurrent host còn `max 10s` | Dùng `startupTimeoutMs` | §3.3.3 |
| **C2** | Snapshot `startedAt?` vs `TurnRecord` nullable | Thống nhất `number \| null` | §4.6 |
| **C3** | `approval.expired` chưa có trong union | Thêm `permission.expired` (durable) | §4.4 |
| **C4** | `provider.notice` chưa rõ durable/ephemeral | Chốt **durable** (auditable) | §4.4 |
| **C5** | §4.11 không tái lập được | Thêm script `scripts/plan/check-plan-consistency.mjs` + command | §4.11 |

---

## 0.0 Consistency pass v4.2 → v4.2.1 (traceability)

| # | Vấn đề | Sửa | Vị trí |
|---|---|---|---|
| 1 | Envelope `type/payload` chỉ TaskEvent, nhưng `task.sync` chứa cả AgentEvent | Thêm `DurableAgentEvent`, `DurableTaskEvent = DurableAgentEvent \| TaskEvent`, `DurableTaskEventType`; envelope + sync + log dùng chung | §4.1, §4.4 |
| 2 | `TurnRecord.startedAt` bắt buộc; CHECK chặn cancel turn queued | `startedAt: number \| null`, `createdAt/queuedAt/endedAt`; CHECK cho phép terminal trước khi chạy; state machine có `queued→cancelled/failed` | §4.7, §5.2, §7.2 |
| 3 | `TabIntent` khai báo 2 lần (interface + union) | Xoá `interface TabIntent`, giữ **một** union `active_resolved \| explicit \| untitled` | §4.7 |
| 4 | `maxEnvelopeBytes` config = 1 MiB (không headroom) | Config mặc định **786432**; transport hard cap 1048576 tách riêng, validate | §5.8, §4.1 |
| 5 | Startup lock không giải phóng khi endpoint đã có | Bước 4: **close fd + unlink** startup lock rồi connect | §3.3.1 |
| 6 | §6.8 nói “same-origin only” trái §4.5 `none` | MVP = **`none`** cho mọi iframe (kể cả same-origin) | §6.8 |
| 7 | State machine “host lost → paused” trái bảng phân loại | Sửa thành “**unrecoverable** host loss”; host disconnect dùng grace + attention | §5.2, §5.2.1 |
| 8 | `tasks.conversation_key` comment FK nhưng không khai | Chốt cardinality: task 1—1 conversation hiện tại (`is_current=1` + unique partial index); **không** FK (tránh cycle) | §7.2 |
| 9 | `gateway.last_seq` chưa seed | Migration seed `'0'` + `COALESCE` khi cấp seq | §7.2 |
| 10 | `TaskSyncResponse/GatewaySyncResponse.events: Envelope[]` | Ràng buộc `stream` + đúng `taskId`; typed envelope | §4.6 |
| 11 | `gateway.notice` trong durable union nhưng không persist | `DurableGatewayEvent` loại notice; notice là ephemeral, không seq | §4.4 |
| 12 | `turn_finished` “unread” không có read cursor | Thêm `TaskRecord.lastReadSeq`; attention dựa trên so sánh seq | §4.7 |
| 13 | Queue chưa khớp persist `turn.started` trước provider | Tách 1a (nhận prompt → `queued`) / 1b (khỏi queue → `started` + provider), 2 transaction | §4.4.1 |
| 14 | `tool.*.input/output` unbounded | Bounded + redacted; `inputArtifactRef`/`outputArtifactRef`; `assistant.message` lớn → artifact | §4.1, §4.4 |
| 15 | Còn nhánh MCP `paseo_tool_token_refresh` | Xoá; chỉ còn Gateway chủ động refresh | §9.1 |
| 16 | L1 “SW idle” trái §1.5 | Tách 3 lớp: panel / SW / NM connection | §7.1 |
| 17 | Cơ chế chống trùng bị gọi sai tên | Đổi thành **duplicate-execution protection** (`toolCallId`); nêu giới hạn bearer token | §9.1 |
| 18 | `turn.failed` dùng `error: string` riêng | Dùng `ProtocolError` normalized | §4.4 |
| 19 | 3 timeout khác nhau (10s/15s/15s) | Một `startupTimeoutMs` là deadline tổng; backoff nằm trong | §3.3.1 |
| 20 | Chunk snapshot chưa có size/verify toàn bộ | Chunk ≤256 KiB + `sha256` mỗi chunk + `snapshotSha256` | §4.4 |
| 21 | Gate status diễn đạt sai (B6/B7 chặn Gate A) | Header ghi đúng: Gate A chờ ký contract; **B5/B6/B7 chặn Gate A-final**, không chặn Gate A; `FULL` đã chốt (B7 chỉ xét hạ) | header, §12 |

---

## 0.1 Phản hồi review v4.1 (traceability — v4.2)

| Review | Xử lý | Vị trí |
|---|---|---|
| **P0.1** Audit sai MV3 lifecycle (native port giữ SW sống) | Viết lại §1.5: port đang mở **giữ SW sống** (Chrome ≥105); sự cố là **bridge bị buộc vào lifetime NM**. Nêu 4 nhóm sự kiện + yêu cầu Chrome tối thiểu; forced SW termination là test, không phải “idle bình thường” | §1.5, §3.1 |
| **P0.2** `browserInstanceId` chưa xử lý extension reload/update/disable | Bảng 4 sự kiện vs `storage.session`; `storage.session` chỉ là candidate; `getContexts()` không đủ bằng chứng; reload mất ID → **`needs_confirmation`**, không `stale`; thêm `HostIdentityConfidence` (`known`/`degraded`) | §3.2, §12 B6 |
| **P0.3** Degraded affinity gộp nhầm (`"degraded"` string) | Bỏ chuỗi `"degraded"` khỏi key; degraded affinity chỉ sống trong `connectionId`, không persist | §3.2, §6.1 |
| **P0.4** `HelloRequest.browserInstanceId` không nullable; `host.register` gửi sai loại state | `browserInstanceId: string \| null` ở **mọi** contract; `host.register` gửi `identityConfidence`, **không** `bindingState`; `BrowserBindingState` do Gateway tính theo task | §4.6, §6.1, §6.1.1, §3.2 |
| **P0.5** Diagram còn “ready trước recovery” | Viết lại diagram: lock → config → store → **recovery+commit** → runtime → IPC → publish ready; `gateway.starting` chỉ cho non-hello | §3.3.3, §5.1 |
| **P0.6** Trộn `wx` với write-temp+rename cho lock | Tách bảng: lock = `open('wx')` + giữ fd + ghi qua fd + fsync; endpoint = tmp+rename. `startedAt` = **OS process start** | §3.3.1 |
| **P0.7** `turns.started_at NOT NULL` không biểu diễn queued | `created_at NOT NULL`, `queued_at`, `started_at` nullable, `ended_at`; **CHECK** theo status | §7.2, §4.6 |
| **P0.8** `attention` mâu thuẫn (state machine vs SQL) | **Bỏ cột** `attention`; thành **derived** `TaskAttention`; `pause_reason` persisted + CHECK `paused ⇔ reason` | §4.7, §5.2, §7.2 |
| **P0.9** Error code dùng nhưng thiếu registry | Registry đầy đủ + `ProtocolError` 6 field (`retryable`, `requiresUserAction`, `sideEffectState`…); thêm `gateway.starting/unresponsive/not_ready`, `browser.confirmation_required/backend_mismatch`, `proto.auth_expired`, `artifact.missing` | §4.2 |
| **P1.1** Task/Gateway event chưa có union | Thêm `TaskEvent` + `GatewayEvent` + `GATEWAY_EVENT_REPLAYABLE`; `task.snapshot` là response, không phải event; `gateway.notice` không replay | §4.4 |
| **P1.2** Snapshot có thể vượt NM 1 MiB | `MAX_ENVELOPE_BYTES=768KiB`, `MAX_EVENT_PAYLOAD_BYTES=256KiB`; durable event không bị cắt; snapshot dùng `storage: inline|chunked|artifact` + `TaskSnapshotChunk` | §4.1, §4.6 |
| **P1.3** Snapshot chưa tự mô tả input provider nhận | `userMessages.input: TurnInput`, `redactedFields`, `inputCompleteness`; `pendingApprovals` thành derived | §4.6, §4.3 |
| **P1.4** Pause semantics nhập nhằng | `PauseReason` (4 giá trị) + bảng hành vi; tách “user pause” vs “recovery pause” | §4.7, §5.2.1 |
| **P1.5** `browser_instance_id` vừa identity vừa runtime | `origin_browser_instance_id` (bất biến) vs `binding_json` (runtime) | §4.7, §7.2, §4.9 |
| **P1.6** Artifact TTL xoá khi task còn sống | TTL **chỉ** sau terminal/release; nếu buộc xoá → `missing` + `non_resumable_context` | §5.5 |
| **P1.7** DDL/transaction chưa hoàn chỉnh | Factory connection (WAL/FULL/FK/busy_timeout), seq cấp **trong** transaction, UPSERT thay `INSERT OR REPLACE`, SQL thật, `SCHEMA_VERSION` độc lập doc version | §7.2 |
| **P1.8** `jti` bị mô tả sai chức năng | Đổi thành token generation id; chống trùng dùng `toolCallId`; refresh flow duy nhất (Gateway chủ động) + drain trước restart MCP; grace 60s | §9.1 |
| **P1.9** Fingerprint thiếu fieldIdentity/salt protection | `fieldIdentity` từ structural path/role/name/type; salt `TRUSTED_CONTEXTS`; rotate policy; không persist plaintext | §6.2 |
| **P1.10** iframe same-origin claim quá mức | MVP capability = **`none`**; `same-origin` chỉ sau implementation + test | §4.5, §6.4 |
| **P1.11** Contract phụ thuộc “như v2” | Inline đầy đủ; thêm **Type inventory** §4.10; §4.3/§4.5/§9.2 hết tham chiếu v2 | §4.3, §4.5, §9.2, §4.10 |
| **P1.12** `startTurn` trả `turnId` mơ hồ | Trả `{accepted, providerTurnId?}`; 3 ID tách biệt; idempotent `clientMessageId` | §4.3, §4.4.1 |
| **P1.13** §3.4 ghi B6 cho IPC | Sửa thành **B5** | §3.4 |
| **P1.14** Header/§0.1 mâu thuẫn trạng thái Gate A | Header ghi trạng thái hiện tại; §0.1 là lịch sử | header |
| **P1.15** Claude spike nằm cả Gate B và PR-I | Spike = B3 (Gate B); PR-I chỉ adapter/UI sau ADR | §17 |
| **P1.16** Open decisions đã chốt | Ghi rõ “đã chốt” vs “còn mở” cho synchronous và refresh token | §18 |
| **P1.17** Nhãn version lẫn lộn | Bỏ `(v3)` khỏi heading; MVP acceptance → v4.2; schema version tách khỏi doc version | nhiều nơi |

---

## 0.2 Phản hồi review v3 (traceability — v4)

| Review | Xử lý trong v4 | Vị trí |
|---|---|---|
| **P0-1** `hostInstanceId` làm hỏng reconnect khi SW bị thu hồi | Thêm **`browserInstanceId`** (sống theo vòng đời Chrome session, không theo process). Affinity gắn `browserInstanceId`, **không** `hostInstanceId`; `hostInstanceId` chỉ dùng để phát hiện “host mới”. Có acceptance test SW-restart | §3.2, §6.1, §7.3 #1 |
| **P0-2** Gateway lock ownership tự mâu thuẫn | Tách **startup lock** (native host giữ, ngắn hạn, transfer protocol) và **lifetime lock** (Gateway sở hữu tới shutdown). Bảng crash-at-each-point + ai được reclaim | §3.3.1–§3.3.3 |
| **P0-3** SQL `PRIMARY KEY (stream, COALESCE(...))` không hợp lệ | Sentinel `task_id TEXT NOT NULL DEFAULT ''`; thêm FK/ON DELETE, unique `client_message_id`, transaction boundary, migration test, chốt durability mức flush | §7.2 |
| **P0-4** `TaskSnapshot` thiếu user messages | Bổ sung `userMessages`, attachments/refs, turn lifecycle, tool summary + outcome, permission history; quy định thứ tự prune cấm bỏ user prompt | §4.6, §5.5 |
| **P1-5** Seq gap vs backpressure (M5) | Tách **durable seq** (chỉ event log) và **ephemeral delta stream** (`turnId + deltaOffset`, lossy, không có seq) | §4.1, §4.4, §5.4 |
| **P1-6** SW sleep vs host loss vs Gateway crash (M6) | Bảng phân loại 6 sự kiện × Task/Turn; grace period cho host disconnect; SW sleep **không** đổi state | §5.2, §7.3 |
| **P1-7** `profileId`/`clientId` “durable” sai wording (M7) | Sửa thành **stable trong vòng đời installation**; có thể mất khi uninstall/reset; không hứa identity vĩnh viễn | §3.2, §11 |
| **P1-8** `TabIntent.active` tự bind nhầm tab sau restart (M8) | **Resolve active → runtime binding tại thời điểm tạo task**; sau restart **không** dùng active tab hiện tại; uniqueness check cho URL/title; không duy nhất → hỏi user | §4.9 |
| **P1-9** Fingerprint thiếu form value, trộn cấu trúc/trạng thái (M9) | Tách **`structuralFingerprint`** (refs) và **`stateFingerprint`** (verify); value hash có loại trừ password/PII | §6.2 |
| **P1-10** Permission heuristic chưa fail-safe | Thêm **external data egress** là risk dimension riêng; form submit không rõ side effect → approval; unknown target/context → **fail closed**; `allow_task` có scope hẹp + TTL | §4.8 |
| **P1-11** Tool token gọi “opaque” sai, thiếu refresh | Đổi tên **signed token**; canonical serialization; **refresh RPC** + rotate trước hết hạn; token không rời scope | §9.1 |
| **P1-12** Named Pipe threat model | Ghi rõ: chống **user khác** trên máy; **không** chống malware cùng user; không phải nhận diện process Chrome | §3.4.3 |

**Trạng thái:** Gate A **chưa sign-off**; xem §12 cho *Gate A (semantic)* / *Gate A-final* / *Gate C*.

---

## 0.3 Phản hồi review v2 (traceability)

> Lịch sử review được giữ nguyên để truy vết: §0.1 (v4.1→v4.2), §0.2 (v3→v4), §0.3 (v2→v3), §0.4 (v4→v4.1).

## 0.4 Phản hồi review v4 (traceability — v4.1)

| Review | Xử lý | Vị trí |
|---|---|---|
| **R1** DDL `events` vẫn có FK `task_id` mâu thuẫn sentinel | **Xóa FK khỏi DDL thật**, thêm `CHECK` phân biệt stream; cascade task xoá tường minh trong transaction; startup integrity check | §7.2 |
| **R2** Gateway ready trước recovery | Đổi thứ tự: store → **recovery scan** → provider/browser/session → IPC listen (trả `gateway.starting`) → publish endpoint “ready” | §5.1 |
| **R3** `stateFingerprint` salt theo snapshot | Salt **theo installation** (cùng chỗ `profileId`), có `saltEpoch`; so sánh chỉ khi cùng epoch | §6.2 |
| **R4** Reclaim lock khi ping fail dù owner sống | Chỉ reclaim khi **PID + start-time** chứng minh chết; owner sống + ping fail → `gateway.unresponsive`, không spawn/xoá lock; thêm test | §3.3.1, §3.3.2 |
| **R5** `browserInstanceId` không nhất quán | Chuẩn hóa: `string \| null`, `BrowserBindingState` enum dùng chung `hello` + `host.register`; thêm field vào `host.register`; sửa comment `profileId`; degraded mode rõ | §3.2, §4.6, §6.1, §6.1.1 |
| **R6** Snapshot thiếu `missing`, tên `contextCalls` | `attachments.missing`, `toolCalls.inputSummary/outputMissing`, `userMessages.toolCallIds`; một tên duy nhất cho tool/context calls; quy tắc “đủ tái dựng input provider nhận” | §4.6 |
| **R7** ack thiếu `stream` | Thêm `stream` vào discriminated union ack | §4.1 |
| **R8** Delta vẫn có retention row | Xoá dòng delta retention; ghi rõ delta chỉ buffer RAM | §5.5 |
| **R9** Gateway seq không có sync/cursor | Thêm `gateway_state('gateway.last_seq')`, `lastSeqByGateway`, `GatewaySyncRequest/Response` | §4.6, §7.2 |
| **R10** Thiếu CHECK trong DDL | Đã đưa CHECK vào DDL | §7.2 |
| **R11** Transaction chưa có gateway stream | Tách 2 transaction templates: task stream và gateway stream | §7.2 |
| **R12** `PRAGMA synchronous` ghi như per-table | Sửa: thuộc tính connection/database; FULL mặc định toàn DB; connection riêng cho bulk là tối ưu tùy chọn | §7.2 |
| **R13** Rebind active vs Chrome restart | Bảng phân biệt SW restart (tự reconnect) vs Chrome restart (bắt buộc user xác nhận, descriptor chỉ gợi ý) | §4.9 |
| **R14** Gate A mâu thuẫn (sign-off vs phụ thuộc B6/B7) | Tách **Gate A (semantic sign-off)** và **Gate A-final (sau spike)**; phần phụ thuộc đánh dấu `PROVISIONAL(spike-Bn)` | §12 |

---

| Review | Xử lý trong v3 | Vị trí |
|---|---|---|
| **B1** Task/Session/Turn gộp một state machine | Tách **3 state machine** độc lập: Conversation (session), Task, Turn. Định nghĩa `task.cancel` vs `turn.interrupt`, `task.send` sau terminal, resume rules | §5.2, §5.3, §4.7 |
| **B2** Gateway startup/lifetime contract mỏng | Thêm **contract đầy đủ**: detached spawn, atomic lock, PID reuse, atomic endpoint write, shutdown policy, retry/backoff; 3 sequence diagram (cold start, concurrent hosts, crash/restart) | §3.3, §3.7, §5.1 |
| **B3** Multi-client browser ownership chưa định nghĩa | Thêm **identity model**: `profileId` (durable), `hostInstanceId`, `connectionId`, `clientId`; task **bound** profile; không auto takeover; cross-profile rules | §3.6, §6.1 |
| **B4** Event protocol chưa khép kín | Thêm `user.message.created`, `task.snapshot`, `task.sync`, định nghĩa `ack`, **gateway-level events**, response discriminated union, gap/duplicate/out-of-order, size/backpressure, `ToolOutcome` có `unknown`, durable checkpoint | §4.1, §4.4, §5.5, §5.6 |
| **B5** Permission theo tên action | **Contextual risk model**: origin/tab scope, field/action semantics, data egress, public side effect, trusted-gesture caveat, autosave; approval gắn (action, target, data) | §4.8, §6.7 |
| **B6** Named Pipe ACL chưa chứng minh | **Spike bắt buộc** + tiêu chí pass/fail; TCP+token là fallback hợp lệ; token lifecycle (create/store/rotate/protect/log) | §3.4, §3.4.1 |
| **M1** AgentSession thiếu semantics Paseo | Bổ sung `getRuntimeInfo`, `getAvailableModes/getCurrentMode`, `getPendingPermissions`, `respondToPermission→{followUp?}`, `canStopRuntime`, `interrupt` ownership guarantee; định nghĩa **turnId race** | §4.3, §4.4.1 |
| **M2** Claude priority vs roadmap mâu thuẫn | **Claude spike ở Gate B/PR-A+**, version floor + mechanism ADR trước khi hoàn tất Codex migration; ghi rõ MVP = Codex, first-class = cả hai | §8.3, §12 |
| **M3** Playwright: runtime ≠ backend | Tách **4 vai trò** (runtime manager / isolated backend / dev-test / gateway runtime dep); xác minh `page.accessibility.snapshot()` trước khi chốt | §6.5 |
| **M4** tabId không durable | Tách **durable intent / runtime binding / snapshot binding**; restart → re-resolve hoặc hỏi user | §4.9, §6.1 |
| **M5** Host registration privacy | **Capability-first registration**; không gửi URL/title auto; `listTabs` theo nhu cầu + permission; internal pages; iframe `all_frames:false` | §6.1.1 |
| **M6** Backend intent nguồn gốc | **Intent sources** (user instruction > task options > config > availability); model **không** đổi pin; khóa `chrome-extension` khi user yêu cầu | §6.3 |
| Minor §1.5 | Sửa: port thuộc **background**, không phải sidepanel; panel close ≠ port close; nêu đúng SW/browser lifecycle | §1.5 |
| Minor §4.1 | Response **discriminated union** + runtime validation | §4.1 |
| Minor `reasoning.delta` | Không persist raw reasoning mặc định; chỉ expose summary/status; flag off | §4.4, §7.3 |
| Minor §5.2 waiting_user | Tách task status vs turn status | §5.2 |
| Minor §5.3 durability window | Định nghĩa **durable checkpoint + max loss** | §5.6 |
| Minor §5.4 archive/compaction | Thêm checkpoint + archive policy | §5.5 |
| Minor §5.5 permission lifecycle | Phân biệt permission provider vs browser tool | §4.8, §5.7 |
| Minor §6.2 fingerprint | Định nghĩa inputs/version/stability | §6.2 |
| Minor §6.3 verification | Tách **observation** vs **semantic success** | §6.3 |
| Minor §8.2 Codex persist timing | Xác minh rollout timing bằng test | §8.2 |
| Minor §9.1 tool token | **signed** token (payload đọc được) + scope/expiry/refresh/log rules — sửa lại ở v4 §9.1 | §9.1 |
| Minor §10 feature RPC | `provider.feature.*` có **schema per feature** | §10 |
| Minor §12 PR-C/PR-D | Gateway skeleton chạy **không cần store** (in-memory) trước SQLite | §12 |
| Minor §15 flag default | Regression test cho workflow dựa mode cũ | §15 |
| Capability đồng nhất giả tưởng | Thêm **capability caveat** (dialogs, file picker, trusted gesture, cross-origin iframe, browser chrome) | §6.8 |

---

## 1. Current-state audit

### 1.1 Bản đồ & kích thước

```text
packages/shared/src/      types.ts 591 · action-cards.ts 960 · agentic-route.ts 904 · profiles.ts 375
                          prompt-routing.ts 219 · harness.ts 204 · context-budget.ts 181
packages/bridge/src/      codex-plane.ts 3930 · harness.ts 713 · app-server-mappers.ts 615
                          image-assets.ts 526 · codex-app-server.ts 437 · agentic-router.ts 403
                          browser-actions.ts 375 · codex-discovery.ts 372 · skill-archives.ts 330
                          prompt.ts 275 · router.ts 258 · playwright-runtime.ts 253 · cli.ts 173
packages/native-host/src/ relay.ts 140 · environment.ts 182 · framing.ts
packages/extension/src/   background/index.ts 5086 · background/storage.ts 579
                          content/index.ts 2566 · content/dom-text.ts 333 · sidepanel/*
scripts/                  smoke-extension.mjs · generate-webstore-assets.mjs · package/install/diagnose
```

### 1.2 Luồng hiện tại

**Chat (Codex):** sidepanel → background → `route.plan` (`background/index.ts:1978`) → background → `prompt.send` → `AppServerCodexPlane` → event stream → `bridge-event-routing.ts` → UI.

**Browser DOM (tab thật):**

```
background lấy control tab
  → content {type:"page.dom.snapshot"}                    [background/index.ts:2375,2477]
  → collectBrowserDomSnapshot()                           [content/index.ts:1857; cap 80 @1860]
  → bridge.request("browser.action.plan")                 [background/index.ts:2396,2498]
  → CodexBrowserActionPlane.plan()                        [browser-actions.ts:26; timeout 25s]
  → content {type:"page.dom.perform", steps}              [background/index.ts:2422,2528]
  → click|focus|fill|select|submit|scroll|highlight       [content/index.ts:2023-2036,1824-1851]
```

Kết luận giữ nguyên: đường DOM thao tác tab thật **không dùng Playwright**.

### 1.3 RPC inventory

Nhóm method trong `bridge/src/router.ts` (58 case): account, catalog (models/apps/plugins/skills/mcp), thread/turn/session/prompt, goal/plan, routing (`route.plan`, `browser.action.plan`), image, voice/dictation/translation, workspace/config/playwright runtime, diagnostics, local file/profile.

`bridge/src/index.ts` export `codex-plane`, `browser-actions`, `agentic-router`, `playwright-runtime`, `router`.

### 1.4 Dependency graph (grep)

```
cli.ts ─▶ codex-plane ─▶ codex-app-server ─▶ app-server-mappers
       ├▶ browser-actions ─▶ codex-app-server, agentic-router(extractJsonObject)
       ├▶ agentic-router ─▶ codex-app-server, harness
       ├▶ playwright-runtime
       └▶ router(deps)
native-host/relay.ts ─▶ spawn bridge/dist/cli.js
background/native-bridge-client.ts ─▶ NM port "com.codex.sidepanel.bridge"
content/index.ts ─▶ DOM only
```

`codex-plane.ts` chỉ được `cli.ts`, `index.ts`, test import → wrap/extract không đụng UI.

### 1.5 Lifecycle hiện tại — **viết lại theo tài liệu Chrome (v4.2)**

Sự thật chính xác:

- Native Messaging port do **`background/native-bridge-client.ts`** giữ (`chrome.runtime.connectNative`), **không phải sidepanel**. Sidepanel đóng **không trực tiếp** đóng port.
- **Một port Native Messaging đang mở giữ Extension Service Worker sống** (Chrome ≥ 105). SW **không** bị thu hồi theo idle timer trong khi port còn mở.
- Port đóng khi: **native host exit/crash**, extension reload/update/disable, Chrome quit, lỗi pipe, hoặc extension tự `disconnect()`.
- `native-host/src/relay.ts` spawn bridge (`:17-20`) và kill+exit khi stdin end / SIGTERM / SIGINT / bridge exit / broken pipe (`:27-44`, `:100-108`).

**Hệ quả (lập luận đúng cho Persistent Gateway):** không phải “SW bị thu hồi thường xuyên”, mà là **bridge/Gateway hiện bị buộc vào vòng đời Native Messaging port**:

- Host crash/exit → port đóng → bridge bị kill → **mất toàn bộ task/turn/permission đang chạy**.
- Extension reload/update/disable → port đóng → như trên.
- SW có thể bị Chrome **force terminate** (test/devtools, resource pressure, extension reload race) → port đóng và không tự khôi phục trạng thái.
- Không có nơi nào giữ task ngoài process bridge; nên bất kỳ sự kiện nào giết bridge đều giết công việc.

**Vì vậy:** Gateway phải tồn tại **độc lập** với vòng đời Native Messaging host và extension connection. Khi browser host mất kết nối, Gateway vẫn giữ provider sessions, task state, pending approvals và recovery metadata; browser operations chỉ được thực hiện lại khi browser host reconnect hợp lệ.

**Phiên bản Chrome tối thiểu hỗ trợ:** ≥ 105 (SW lifetime kéo dài bởi native port). Với bản cũ hơn, hành vi SW-lifetime khác và **không** được coi là môi trường hỗ trợ; UI phải cảnh báo.

**Ghi chú test:** “forced SW termination” là **kịch bản phục hồi bắt buộc phải test**, nhưng **không** được mô tả là tình huống idle bình thường khi native port đang mở.

### 1.6 Hotspots

`background/index.ts` 5.086; `codex-plane.ts` 3.930; `content/index.ts` 2.566; `shared/agentic-route.ts` 904; `app-server-mappers.ts` 615.

### 1.7 Chưa xác minh (minh bạch)

- Hành vi Windows thật: forced SW termination, `connectNative` khi Chrome quit, extension reload/update, multi-window, multi-profile, incognito.
- Toàn bộ nhánh UI đọc `BridgeEvent` (cần mapping pass P1).
- Test hiện có cho `playwright-runtime`/`agentic-router`.
- `page.accessibility.snapshot()` theo version Playwright đang pin.
- Codex App Server thời điểm rollout/thread resumable.

---

## 2. Paseo research (đối chiếu contract)

### 2.1 Subsystem đã đọc

| Paseo | Path | Dùng để |
|---|---|---|
| Contract | `agent/agent-sdk-types.ts` | `AgentClient/AgentSession/capabilities/persistence` |
| Registry | `agent/provider-registry.ts` | factory/override/profile wrap |
| Runner | `agent/providers/provider-runner.ts` | turn → timeline → terminal |
| MCP | `agent/mcp-server.ts` | catalog → MCP server |
| Broker | `browser-tools/broker.ts` | host registry, affinity, fan-out, stranded, timeout |
| Tools | `browser-tools/tools.ts` | tool schema, refs, URL policy |
| Policy | `browser-tools/policy.ts`, `config.ts` | tool enablement |
| Catalog cache | `provider-snapshot-manager.ts` | single-flight, deadline, content hash |
| Persistence | `agent-storage.ts` | stored record schema, workspace index, resume-on-startup |
| Claude | `providers/claude/*` (dir-level) | capability/permission/stream/resume patterns |

### 2.2 `AgentSession` semantics Paseo ↔ Chromex (M1)

| Paseo member | Chromex v3 | Ghi chú |
|---|---|---|
| `startTurn` | `startTurn` | + race rule §4.4.1 |
| `subscribe` | `subscribe` | |
| `streamHistory` | **`streamHistory(): AsyncGenerator<AgentEvent>`** | Optional; Gateway dùng cho import/history; không bắt buộc mọi provider |
| `getRuntimeInfo` | **có** `getRuntimeInfo(): Promise<RuntimeInfo>` | diagnostics/model/mode hiện tại |
| `getAvailableModes/getCurrentMode` | **có** (runtime) tách khỏi **catalog** | catalog = khả năng; runtime = trạng thái |
| `getPendingPermissions` | **có**, nhưng Gateway là source of truth (`approvals` store); session trả mirror | tránh 2 nguồn |
| `respondToPermission` | **`Promise<PermissionResponseResult>`** với `followUpPrompt?: TurnInput` | Paseo dùng cho chain dialog (vd select → comment) |
| `interrupt` | **có ownership guarantee**: resolve ⇒ không còn foreground turn cũ nào sẽ chạy tiếp; pending steers bị huỷ; adapter phải clear queue | khác “gửi signal rồi thôi” |
| `canStopRuntime` | **có** (optional) | quyết định idle shutdown an toàn |
| `close` | `close` | idempotent |

### 2.3 Broker pattern cần dịch

- Host registry + `supportedTools` + per-command capability check.
- Affinity theo `browserId` (Chromex: `(profileId, backendId, tabId)`).
- `list_tabs` fan-out khi nhiều host.
- Host disconnect → **stranded** (tab vẫn tồn tại, retryable) cho tới khi cùng host reconnect.
- Timeout + request/response correlation + cleanup pending khi host unregister.
- Policy gate qua config (`browserTools.enabled`).

### 2.4 Không copy

Không copy implementation Claude adapter (rất lớn), broker, storage. Chỉ dùng contract/pattern. Review license/attribution nếu port bất kỳ đoạn nào.

---

## 3. ADRs

### 3.1 ADR-001 — Gateway persistent, tách khỏi Native Messaging

**Quyết định:** Gateway là Node process riêng, `detached`, không kế thừa stdio của native host, không bị kill khi NM port đóng.

**Lý do:** hiện bridge bị **buộc vào lifetime của Native Messaging port** (§1.5). Host crash, extension reload/update/disable, hoặc forced SW termination đều kill bridge và mất task/turn/permission. Gateway độc lập giữ provider sessions + task state + approvals qua các sự kiện đó.

**Rejected:** gateway trong extension (không có Node); gateway gắn NM stdio (lifetime sai).

### 3.2 ADR-002 — Identity model (B3, sửa P0-1/P1-7)

**Năm** định danh. Điểm sửa so với v3: **thêm `browserInstanceId`** để affinity không chết khi MV3 SW bị thu hồi; và `profileId`/`clientId` không còn được mô tả là “durable vĩnh viễn”.

| ID | Sống qua | Phạm vi | Sinh bởi | Dùng cho |
|---|---|---|---|---|
| `profileId` | **vòng đời installation** (mất khi uninstall / xoá `storage.local` / reset profile) | một Chrome profile + một lần cài extension | extension lần đầu chạy, lưu `storage.local` | Bind task với profile; chặn lẫn profile; **không** phải danh tính bảo mật |
| `clientId` | như `profileId` | một cài đặt extension | extension | Log/telemetry |
| `browserInstanceId` — **`string \| null`** | **vòng đời Chrome browser session** (sống qua SW restart, mất khi Chrome quit/restart hoặc profile bị reset) | một lần chạy Chrome | background lần đầu sau khi Chrome start; lưu ở nơi **sống qua SW restart** | **Affinity tab**; phân biệt “cùng browser” vs “browser mới”. **`null` = cơ chế chưa chứng minh được** (xem fallback) |
| `hostInstanceId` | **một process** background/native host | một instance process | native host/background khi connect | Phát hiện host mới; log; **không** dùng cho affinity |
| `connectionId` | một kết nối | một IPC/NM connection | Gateway cấp khi `hello` | Correlation, cleanup pending khi connection đóng |

**Cách `browserInstanceId` sống qua SW restart — ĐÃ CHỐT (B6, `docs/adr/browser-instance.md`):** native host mint ID một lần per (chromePpid, chromePpidStartedAt), persist trong gateway dataDir; SW restart giữ ID, extension reload/disable→enable mất ID → `needs_confirmation` (không `stale`), Chrome quit → ID mới. Phân tích ứng viên gốc giữ lại để tham chiếu:

| Sự kiện | Chrome còn chạy? | `chrome.storage.session` |
|---|---|---|
| Service Worker restart | có | **giữ** |
| Chrome restart | không | xoá |
| **Extension update / reload** | **có thể có** | **xoá** |
| **Extension disable → enable** | **có thể có** | **xoá** |

Vì vậy `storage.session` **không** đủ để phân biệt “Chrome restart” với “extension reload trong cùng Chrome run”. Cả hai đều mất ID → **không được** suy ra `stale` từ việc ID biến mất.

Ứng viên (chọn cái chứng minh được bằng test, ghi ADR):

1. `chrome.storage.session` — pass nếu chỉ cần sống qua SW restart; **fail** cho extension reload (ID mất nhưng Chrome còn).
2. Native host **supervisor** giữ state theo Chrome PID (process cha của NM host sống theo Chrome) và trả `browserInstanceId` qua `connectNative` — ứng viên **mạnh nhất** vì không phụ thuộc extension storage.
3. `browserInstanceId = profileId + ":" + chromePid` lấy qua native host (parent process chain).

Quy tắc bắt buộc:

- `storage.session` chỉ là **candidate**, không phải cơ chế đã xác nhận.
- `chrome.runtime.getContexts()` **không** đủ bằng chứng phân biệt browser restart vs extension reload.
- Nếu không chứng minh được “cùng Chrome run sau extension reload” → rơi vào **`needs_confirmation`**, **không** `stale`.
- `browserInstanceId` là **identity của một Chrome run**, **không** phải identity bảo mật, **không** dùng để xác thực browser process.

**Identity confidence của host (tách khỏi binding state của task):**

```ts
type HostIdentityConfidence = "known" | "degraded";
```

- `known` = có `browserInstanceId` không null **và** cơ chế đã qua spike.
- `degraded` = mọi trường hợp còn lại (null, hoặc cơ chế chưa xác nhận).
- `host.register` gửi `identityConfidence`, **không** gửi `bindingState` (binding là chuyện của task, Gateway tính).

Trong degraded mode:

- Gateway **không** dùng `hostInstanceId` thay thế cho affinity; affinity chỉ sống **trong cùng `connectionId`** (xem §6.1).
- Reconnect / host mới → binding state = **`needs_confirmation`** (không `stale`, không `ok`).
- Task `attention` → UI yêu cầu xác nhận tab; tool call trả `browser.confirmation_required`.
- `hello.features.browserInstanceId = false`.

**Hợp đồng binding state (một enum, dùng chung mọi contract):**

```ts
type BrowserBindingState = "ok" | "needs_confirmation" | "stale" | "none";
```

| Giá trị | Khi nào | UI | Tool call |
|---|---|---|---|
| `ok` | `browserInstanceId` khớp + tab còn | bình thường | chạy |
| `needs_confirmation` | degraded/unknown identity, hoặc tab khớp không duy nhất, hoặc extension reload mất ID | yêu cầu chọn/xác nhận tab | `browser.confirmation_required` |
| `stale` | `browserInstanceId` **xác định khác** (Chrome restart đã chứng minh) hoặc tab đã đóng | thông báo + chọn lại | `browser.stale_binding` |
| `none` | task chưa từng bind browser | — | chạy không cần browser |

`hello` và `host.register` dùng **cùng** quy tắc identity; `browserInstanceId` được phép `null` ở **mọi** contract (§4.6, §6.1, §6.1.1, §4.7, §7.2).

Quy tắc:

- `tabId` **chỉ** có nghĩa trong `(profileId, browserInstanceId, connectionId)`; Gateway **không bao giờ** so sánh `tabId` giữa hai profile hoặc hai browser instance.
- **Affinity key:**
  - có `browserInstanceId`: `profileId:browserInstanceId:backendId:tabId → hostInstanceId`
  - `browserInstanceId = null`: **không** dùng key bền; stash trong `Map<connectionId, Map<tabId, hostInstanceId>>`, sống theo connection. Không persist, không dùng chuỗi `"degraded"` làm identity.
- Reconnect:

  | Tình huống | Identity | Affinity | Task/Turn |
  |---|---|---|---|
  | SW restart (port còn/mở lại), Chrome + tab còn | giữ | giữ | không đổi |
  | Native host reconnect, `hostInstanceId` mới, cùng `browserInstanceId` | giữ | giữ, cập nhật host | không đổi |
  | **Extension reload/update/disable→enable** (Chrome còn) | **không xác định** | **mất** | `needs_confirmation` |
  | Chrome restart (`browserInstanceId` mới, đã chứng minh) | mới | invalid | `stale`; user chọn lại |

- **Task bound profile**: `task.profileId` bất biến. UI ở profile khác xem được task nhưng browser tool → `browser.wrong_profile`; “adopt” tạo task mới.
- **Wording:** tài liệu **không** hứa `profileId`/`clientId` tồn tại qua uninstall; không nhận reinstall là cùng profile.
- `profileId`/`clientId`/`browserInstanceId` **không** dùng để authorize bảo mật (§3.4.3); chỉ là namespace.

### 3.3 ADR-003 — Gateway startup/ownership contract (B2)

#### 3.3.1 Hai lock, một chủ sở hữu tại một thời điểm (sửa P0-2)

v3 để **native host và gateway cùng acquire một lock** — mâu thuẫn. v4 tách hai lock với **transfer protocol** rõ ràng:

| Lock | File | Ai giữ | Mục đích | Thời gian giữ |
|---|---|---|---|---|
| **Startup lock** | `gateway.start.lock` | native host/CLI (chỉ **một** người thắng) | Serialize việc “kiểm tra + spawn”; chống spawn trùng | Tới khi Gateway publish endpoint **hoặc** startup fail |
| **Lifetime lock** | `gateway.lock` | **Gateway** | Single-instance lâu dài; ai giữ lock này là Gateway “thật” | Tới khi Gateway shutdown |

**Quy trình (transfer protocol):**

```
NATIVE HOST / CLI:
  1. endpoint = readAtomic(dataDir/gateway.json)
     nếu endpoint && ping ok  -> connect, DONE (không spawn)
  2. acquire startup lock: open(startupPath,'wx')  -> giữ fd
       EEXIST -> đọc metadata; owner sống -> chờ endpoint trong cùng `startupTimeoutMs` (backoff 100..2000ms)
                  owner chết -> verify metadata rồi unlink, retry 'wx'
  3. ghi metadata QUA CHÍNH FD VỪA MỞ (write + fsync). KHÔNG rename, KHÔNG đổi inode.
  4. re-check endpoint (double-checked): có & ping ok
       -> close fd + unlink startup lock (đã có Gateway; không cần giữ lock); connect; DONE
  5. spawn gateway detached; chờ gateway.json + ping ok — **tổng deadline `startupTimeoutMs` (mặc định 15s)**, gồm cả bước 2 nếu có chờ
       OK   -> close fd + unlink startup lock; connect; DONE
       FAIL -> kill child (nếu còn), log tail, unlink, trả lỗi typed

GATEWAY (process mới):
  A. acquire lifetime lock: open('gateway.lock','wx') -> giữ fd -> ghi metadata qua fd + fsync
       EEXIST:
         owner sống + ping ok    -> "already running"; exit 0
         owner sống + ping FAIL  -> "unresponsive"; exit 3 (KHÔNG reclaim)
         owner chết (verified)   -> unlink → retry 'wx' (max 3)
  B. load config
  C. open store + migrate
  D. RECOVERY SCAN + COMMIT           <-- trước mọi traffic
  E. build providers / browser / sessions
  F. bind IPC listener (chỉ trả `gateway.starting` cho mọi request trừ hello)
  G. write endpoint (tmp+rename) + log "ready"  -> giờ mới phục vụ task/sync
```

**Atomicity — OS lock + fencing, KHÔNG dựa vào mtime (sửa P0.2 v4.2.3):**

| Mục đích | Cơ chế | KHÔNG dùng |
|---|---|---|
| **Ownership (chống 2 owner)** | **OS advisory lock** trên file cố định: POSIX `flock(fd, LOCK_EX\|LOCK_NB)`; Windows `LockFileEx(fd, LOCKFILE_EXCLUSIVE_LOCK\|FAIL_IMMEDIATELY)`. OS giải phóng khi process chết → không cần đoán bằng mtime | `wx` + mtime timeout; suy diễn từ sự tồn tại file; tin rằng giữ fd = đã lock |
| **Metadata & fencing** | sau khi giữ OS lock, ghi `{pid, startedAt, execPath, fence}` vào **chính file đang lock** (truncate+write+fsync qua fd), `fence` = ULID tăng đơn điệu | rename/tmp thay file lock; ghi metadata trước khi có lock |
| **Publish endpoint** | `gateway.json.tmp` + `fs.rename` (cùng volume) + `fence` của owner | ghi trực tiếp; endpoint không có fence |

**Vì sao `mtime > N giây` không đủ (và đã bị loại bỏ):** process A tạo/giữ lock rồi bị **suspend** > N giây trước khi ghi metadata; B thấy file cũ, xoá và lock mới; A thức dậy vẫn tin mình là owner → **hai owner**. Mtime không phân biệt được “đang chuẩn bị” với “đã chết”, và metadata rỗng không cho B biết PID nào để kiểm tra.

**Fencing token (bắt buộc):**

- Mọi thao tác ghi trạng thái (event, task, endpoint) **phải** kiểm tra `fence` hiện tại của lock **trong cùng critical section**: `SELECT fence FROM lock_state` / đọc lại file, nếu `fence != fence_của_tôi` → **từ chối ghi** và tự shutdown.
- Gateway/endpoint mang `fence`; client gửi `hello.fence`; Gateway từ chối (`stale_fence`) nếu fence không còn là owner.
- Reclaim = lấy OS lock thành công; khi đó **tăng** `fence` (ULID mới) và publish. Process cũ không thể ghi vì fence đã đổi và nó không còn giữ OS lock.
- **Không bao giờ** `unlink` lock file để reclaim (unlink phá inode đang lock trên POSIX). Chỉ `unlink` khi **đã giữ** OS lock và dọn sau shutdown.

**Windows:** `LockFileEx` giữ theo handle; process chết → OS nhả. Không dùng “file tồn tại” làm tín hiệu.

`startedAt` = **process start time lấy từ OS** (nếu lấy được), không phải thời điểm app ghi file. Nếu chỉ có app-time, ghi rõ trong ADR là *best-effort*, và dùng thêm `execPath` + `kernelStartTime` để giảm false-positive PID reuse.

Quy tắc bắt buộc:

1. **Không process nào sở hữu đồng thời cả hai lock.** Native host chỉ sở hữu *startup lock*; Gateway chỉ sở hữu *lifetime lock*. Trong giai đoạn handoff, **hai process khác nhau** giữ hai lock khác nhau — overlap này **được phép** và là chủ đích.
2. **Chỉ Gateway được reclaim lifetime lock.** Native host **không bao giờ** unlink `gateway.lock`.
3. **Chỉ native host/CLI reclaim startup lock**, chỉ khi metadata ownership khớp.
4. **Lock file không bị rename/replace/unlink** trong suốt thời gian giữ. Metadata ghi qua fd. Reclaim **chỉ** qua OS lock, không qua mtime.
5. **PID reuse guard:** `pid` + `startedAt` + `execPath` (+ `kernelStartTime` nếu có); “còn sống” chỉ khi khớp.
6. **Atomic endpoint:** tmp+rename, reader bỏ qua `.tmp`; chứa `{version, transport, path|port, gatewayPid, startedAt, tokenRef}` — không token raw.
7. **Detached spawn:** `detached:true, stdio:'ignore', windowsHide:true`, `unref()`; log → `gateway.log` (rotate).
8. **Shutdown:** không tự thoát khi client đóng; không thoát khi còn task `active` hoặc approval `pending`.
9. **Retry native host:** backoff 250ms→5s (jitter), tối đa 30s; startup lock đang bị host khác giữ → chờ, không spawn.
10. **Một deadline duy nhất:** `startupTimeoutMs` (default 15s) là **deadline tổng** cho cold start (chờ lock + spawn + chờ endpoint). Mọi backoff/poll nằm bên trong deadline; không diagram/step nào tự đặt timeout riêng.

#### 3.3.2 Ai reclaim khi crash ở từng điểm (bắt buộc)

**Quy tắc gốc (P0 v4.1):** *ping thất bại **không** phải bằng chứng owner đã chết.* Chỉ reclaim khi **process identity** chứng minh owner đã chết (PID không còn + start-time/execPath không khớp). Nếu process còn sống nhưng không phản hồi → **`gateway.unresponsive`**: chờ, báo lỗi cho UI, **không** spawn Gateway thứ hai.

| # | Crash tại | Trạng thái disk | Điều kiện reclaim | Ai reclaim | Hành vi |
|---|---|---|---|---|---|
| 1 | Native host chết **trước** spawn | startup lock tồn tại | owner PID chết + metadata khớp | Native host kế tiếp | Reclaim startup lock → tiếp tục |
| 2 | Native host chết **sau** spawn, **trước** ready | startup lock tồn tại; endpoint chưa có | owner PID chết | Native host kế tiếp | Reclaim startup lock; thử connect trong `startupTimeoutMs` trước (Gateway con có thể đang khởi động); hết hạn mới spawn |
| 3 | Gateway chết **sau** lifetime lock, **trước** endpoint | `gateway.lock` owner chết | PID chết + start-time khớp | Gateway mới | Reclaim lifetime lock → bind → publish |
| 4 | Gateway chết **sau** endpoint | `gateway.lock` + `gateway.json`; ping fail | PID chết (đã xác minh) | Gateway mới | Reclaim lock; overwrite endpoint atomically |
| 5 | Endpoint còn nhưng process **chết** | `gateway.json` stale | PID chết | Native host | Spawn; Gateway mới reclaim lifetime lock |
| 5a | **Crash sau khi giữ OS lock, trước khi ghi metadata** | lock file tồn tại, metadata có thể rỗng; **OS lock đã được nhả** khi process chết | **Chỉ** thử `flock`/`LockFileEx` non-blocking: thành công ⇒ owner chết, được reclaim; thất bại ⇒ đang có owner sống, **chờ** | Native host/Gateway | Không xoá file; lấy lock → tăng `fence` → ghi metadata mới → publish |
| 5a' | **Process bị suspend > N giây** (vẫn giữ OS lock) | lock file cũ | `flock`/`LockFileEx` **thất bại** ⇒ **không reclaim** | — | Chờ tiếp, trả `gateway.unresponsive`; mtime **không** được dùng để reclaim |
| 5b | **Process còn sống nhưng ping fail** (đang recovery / IPC chưa bind / treo) | lifetime lock + endpoint cũ | **KHÔNG reclaim** | — | Trả `gateway.unresponsive`; retry backoff; UI thông báo “gateway chưa sẵn sàng”. **Không** spawn mới, **không** xoá lock |
| 6 | Hai host cùng cold start | Một thắng startup lock | owner còn sống | Host thua | Chỉ chờ endpoint; không spawn; không reclaim lock |
| 7 | Gateway bind IPC fail (port/pipe bị chiếm) | lifetime lock giữ | Gateway tự biết | Gateway | Release lifetime lock, exit non-zero; host trả lỗi typed (tối đa 2 lần/5 phút) |

**Không được:** để native host unlink `gateway.lock`; để Gateway unlink `gateway.start.lock`; reclaim vì ping fail khi owner còn sống; reclaim theo mtime; bỏ qua `fence` khi ghi state; hai process cùng coi mình là owner.

**Test bắt buộc cho lock:**
1. A giữ lock → B `flock` fail → B không spawn, không xoá.
2. A chết (kill) → B `flock` thành công → B tăng `fence`, publish endpoint mới.
3. A bị SIGSTOP > 10s → B vẫn fail `flock` → không reclaim (chứng minh mtime không dùng).
4. A cũ resume sau khi B đã reclaim → A ghi state với `fence` cũ → **bị từ chối** + A tự shutdown.
5. Windows: `LockFileEx` giữ theo handle; kill process → handle đóng → B lock được.

**Test bắt buộc:** giả lập Gateway còn sống nhưng chưa bind IPC (sleep trong startup) → host thứ hai **không** spawn, **không** xoá lock, trả `gateway.unresponsive`.

#### 3.3.3 Sequence diagrams

**Cold start**

```
Ext(bg)  NativeHost  Gateway(absent)  FS
  |--connect native-->|                  |
  |                   |--read endpoint-->| (missing)
  |                   |--create lock---->| OK
  |                   |--spawn detached->| (process starts)
  |                   |--wait endpoint-->| (poll 15s)
  |                   |<--gateway.json---|
  |                   |--hello-----------> Gateway
  |<--hello response--|                  |
```

**Hai native host khởi động đồng thời (startup lock)**

```
H1 --create gateway.start.lock('wx')--> FS  (OK, owner)
H2 --create gateway.start.lock('wx')--> FS  (EEXIST)
H2 --read owner{pid,startedAt}; owner sống -> wait endpoint (backoff, trong startupTimeoutMs)
H1 --spawn gw (detached)-------------> (process)
gw --create gateway.lock('wx')-------> FS  (OK, lifetime owner)
gw --bind IPC; write gateway.json----> FS
H1 --ping ok -> release gateway.start.lock -> connect -> hello
H2 --ping ok -> connect -> hello (không spawn, không đụng lifetime lock)
```

**Gateway restart sau crash (recovery TRƯỚC ready — sửa P0.5)**

```
H1 --ping fail -> read gateway.json (stale) -> create gateway.start.lock (OK)
H1 --spawn gw2
gw2 --lifetime lock('wx') -> EEXIST -> owner verified dead -> unlink -> retry -> OK
gw2 --load config
gw2 --open store + migrate
gw2 --RECOVERY SCAN + COMMIT:  turns running -> tool unknown + turn.unknown; tasks active -> paused
gw2 --build providers/browser/sessions
gw2 --bind IPC (trả gateway.starting cho request không phải hello)
gw2 --write gateway.json (atomic) + log ready
H1  --ping ok -> unlink startup lock -> connect -> hello{lastSeqByTask}
gw2 --serve task.sync -> replay/snapshot (state đã recovered)
UI: hiển thị "paused, resume?" (không auto-resume mutating work)
```

**Gateway crash & restart (client view)**

```
client --request--> (ECONNREFUSED/EPIPE) -> mark disconnected UI
client --backoff--> read endpoint -> ping fail -> verify owner dead -> (host spawns gw2)
gw2  --[recovery trước ready như trên]
client --hello{lastSeqByTask}--> gateway (chỉ sau ready)
gateway --task.sync--> client: paused + replay
```

### 3.4 ADR-004 — IPC transport & token (B5)

#### 3.4.1 Quyết định

| Nền tảng | Transport | Lý do |
|---|---|---|
| Windows | **Named pipe** `\\.\pipe\chromex-gw-<sha256(userSid+dataDir)[:16]>` | Không mở TCP; scope theo user; không firewall prompt |
| macOS/Linux | Unix domain socket (`0700` dir) | Tương đương |
| Fallback (nếu spike pipe fail) | `127.0.0.1` + random port + **opaque token file** | Cross-platform, token bảo vệ |

**Spike bắt buộc trước khi chọn (Gate A → **B5**):**

| # | Test | Pass criteria |
|---|---|---|
| 1 | User A tạo gateway; **User B** connect | B bị từ chối (đây là mục tiêu bảo mật thực sự) |
| 2 | Process **cùng user** không có token | Không connect được **không** phải mục tiêu; chỉ cần không crash và log rõ |
| 3 | Gateway restart, pipe cũ còn | Không nhận nhầm connection; endpoint recreated |
| 4 | Hai Chrome profile cùng user connect | Cả hai kết nối được, `profileId` tách |
| 5 | Node `net.createServer(pipe)` trên Windows với ACL cụ thể | Chứng minh được kiểm soát ACL (hoặc ghi rõ giới hạn) |

Nếu test 1 không đạt bằng cách vận hành Node mặc định mà **không** thêm native module: **chọn TCP+token** làm mặc định, không cố ép pipe.

#### 3.4.3 Threat model (P1-12)

Phải ghi rõ trong ADR và docs, không quảng bá quá mức:

| Mục tiêu | Đạt được? | Ghi chú |
|---|---|---|
| Chống **user khác** trên cùng máy kết nối Gateway | **Có** (pipe ACL / unix socket `0700` / token file user-only) | Mục tiêu chính |
| Chống **process bất kỳ cùng user** (malware, script) | **Không** | Process cùng user đọc được token file; ACL OS không phân biệt Chrome với process khác |
| Nhận diện “đây là Chrome Native Host thật” | **Không** (MVP) | Cần cơ chế xác thực process (code signing, parent-process check) — chưa chứng minh; không hứa |
| Chống kết nối không có credential | **Có** (token) | Token = credential, không phải danh tính |

Hệ quả: token/ACL là **giảm bề mặt**, không phải sandbox. Không đặt quyền hạn nhạy cảm duy nhất sau token nếu model đe doạ gồm process cùng user. Nếu sau này cần phân biệt process, phải có ADR riêng với bằng chứng (ví dụ kiểm tra parent process chain + signature) — **không** giả định.

#### 3.4.2 Token

- **Opaque token 32 bytes** (không JWT), Gateway sinh lúc start, lưu `dataDir/auth/token` quyền user-only (Windows: `icacls` user-only; POSIX `0600`), **không** đặt trong `gateway.json`.
- Client đọc token file (native host chạy cùng user) và gửi `hello{token}`. Sai/thiếu → đóng connection + log (không log token).
- Rotation: khi gateway restart sinh token mới; native host re-read.
- Token **không** truyền qua CLI args/env của child process (tránh lộ trong process list).
- Tool token (§9.1) là token **riêng**, ngắn hạn, khác auth token.

### 3.5 ADR-005 — Versioning/handshake

`hello` request/response (§4.6). Protocol contract backward-compatible; feature gating một lần qua `features`. Mismatch protocol major → từ chối với `proto.version_mismatch` + thông điệp cập nhật.

### 3.6 ADR-006 — Naming

- RPC method dotted `"task.create"`, correlate bằng `id`; stream riêng qua `kind:"event"`.
- MCP exposure map `browser.page.click` → `browser_page_click` (snake, an toàn mọi client) **hoặc** giữ dotted nếu client chấp nhận — chốt khi implement MCP endpoint, ghi ADR.
- Backend id: `chrome-extension`, `playwright-isolated`, `playwright-cdp` (research only).

### 3.7 ADR-007 — Task/Conversation/Turn model (B1)

**Quyết định:** 3 object, 3 state machine độc lập.

| Object | Ý nghĩa | Durable | State machine |
|---|---|---|---|
| **Conversation** | Phiên logic với provider (native handle) | có (`persistence`) | `opening → open → closed`; `stale` khi resume fail |
| **Task** | Một công việc user giao, ghim provider/profile/backend/cwd | có | `queued → active → completed / failed / cancelled`; `active ⇄ paused` |
| **Turn** | Một lần prompt | có (event log) | `queued → running → completed / failed / cancelled / unknown` |

Ánh xạ hiện tại: `session.open/resume` ≈ Conversation; `prompt.send` ≈ Turn; chưa có Task.

Luật:

- Task `completed` = **không còn turn nào active và không chờ user**; `task.send` sau đó **mở turn mới** (task → `active`), **không** tạo task mới; conversation giữ nguyên.
- `task.cancel` = dừng task: interrupt turn hiện tại + deny pending permissions + task `cancelled` + không nhận `send` nữa (trừ `task.reopen`).
- `turn.interrupt` = dừng **một turn**, task vẫn `active`, có thể `send` tiếp.
- `task.pause` (user) = **không** nhận turn mới, **không** interrupt turn đang chạy; `pauseReason="user_requested"`; `task.resume` phục hồi và nhận turn mới.
- Task bị pause bởi **recovery** (`gateway_restart`) hoặc **browser_unavailable**/**provider_unavailable**: turn đang chạy chuyển terminal tương ứng (`unknown`/`failed`) **trước** khi task `paused`; resume **không** tự chạy lại turn — chỉ cho phép `task.send` mới.
- Resume eligibility: Conversation `open` hoặc resumable handle; task `paused`; nếu provider không resume được → UI hỏi “start new conversation”.

---

## 4. Contracts

### 4.1 Envelope — discriminated union (B4 / minor)

**Hai kênh tách biệt (sửa P1-5):** *durable* (có `seq`, replay được) và *ephemeral* (lossy, **không** có `seq`).

```ts
export type Envelope =
  | { v: 1; kind: "request";  id: string; method: string; taskId?: string; payload?: unknown }
  | { v: 1; kind: "response"; id: string; result: unknown }
  | { v: 1; kind: "response"; id: string; error: ProtocolError }   // XOR với result
  // durable event: có seq, được ghi log, replay được
  // task stream payload = DurableTaskEvent = AgentEvent(durable) | TaskEvent (§4.4)
  // type ⇄ payload được ràng buộc (distributive), không thể lệch — xem DurableTaskEventEnvelope
  | DurableTaskEventEnvelope
  | DurableGatewayEventEnvelope
  // ephemeral event: KHÔNG có seq, KHÔNG replay, có thể bị gộp/bỏ
  | { v: 1; kind: "event"; reliability: "ephemeral"; taskId: string; turnId: string; type: "assistant.delta" | "reasoning.delta";
      deltaOffset: number; text: string; ts: number }
  | { v: 1; kind: "event"; reliability: "ephemeral"; stream: "gateway"; type: "gateway.notice";
      payload: GatewayNotice; ts: number }   // không seq, không persist
  | { v: 1; kind: "ack"; stream: "task";    taskId: string; seq: number; renderedAt?: number }
  | { v: 1; kind: "ack"; stream: "gateway";                 seq: number; renderedAt?: number };
```

- Response: **đúng một** trong `result|error`; validate runtime (Zod) → vi phạm = `proto.invalid`.
- **Durable seq chỉ tăng cho durable event.** Ephemeral delta **không** tiêu thụ seq, nên không bao giờ tạo gap.
- Delta có `deltaOffset` = tổng số ký tự của turn tính tới trước chunk này; client dùng để phát hiện **mất delta** (offset không liền mạch) → đánh dấu “text không đầy đủ” và chờ `assistant.message` (durable) để thay thế. Không resync bằng `task.sync` cho delta.
- Khi turn kết thúc, Gateway **luôn** phát durable `assistant.message` (text cuối cùng) → client luôn có bản đầy đủ dù đã mất delta.
- Event cấp Gateway dùng `stream:"gateway"` + seq toàn cục; **không** gắn `taskId` giả. `gateway.notice` là **ephemeral** (không seq) — xem §4.4.
- **Một union duy nhất cho task stream:** `DurableTaskEvent = DurableAgentEvent | TaskEvent`. Envelope, `task.sync`, event log, snapshot đều dùng union này; không nơi nào tự chọn riêng `AgentEvent` hay `TaskEvent`.
- Legacy `{id, method, params}` / `{id, result|error}` / `{event}` → compat layer.

Giới hạn & backpressure (sửa P1.2 — Native Messaging cap):

| Giới hạn | Giá trị | Ghi chú |
|---|---|---|
| Transport (Chrome NM) | **1 MiB** từ native host → extension | Không kiểm soát được, phải chừa headroom |
| `MAX_ENVELOPE_BYTES` (internal) | **768 KiB** (0.75 × transport) | Đo **sau** JSON serialize + UTF-8 encode, gồm envelope fields |
| `MAX_EVENT_PAYLOAD_BYTES` | 256 KiB | Event vượt → coi là envelope quá lớn |
| `task.snapshot` | **không** đi trong 1 envelope | stream/chunk hoặc artifact-backed (§4.6) |

- Durable event **không bao giờ** bị trim để vừa giới hạn. Nếu event không vừa → biến nó thành **artifact + reference** (payload lớn) hoặc chia batch envelope (`chunked: true, chunkIndex, chunkCount`).
- Event bắt buộc giữ nguyên vẹn: `user.message.created`, `assistant.message`, `permission.*`, terminal turn. Không được cắt nội dung của các event này.
- `assistant.message` (final) có thể > 256 KiB → Gateway lưu **artifact** (`assistantMessageRef`) và giữ `text` đầy đủ **chỉ** nếu vừa giới hạn; `TaskSnapshot` đọc từ artifact. Không cắt text rồi tuyên bố “full”.
- `tool.started.input` / `tool.completed.output`: normalize + redact **trước khi persist**; vượt giới hạn → `inputArtifactRef`/`outputArtifactRef`.

**Chunking:** `TaskSnapshotChunk` ≤ `MAX_SNAPSHOT_CHUNK_BYTES` (256 KiB); mỗi chunk có `sha256`; **toàn snapshot** có `snapshotSha256` để verify sau khi ghép.
- Response vượt giới hạn → `proto.payload_too_large` + gợi ý dùng snapshot/pagination; **không** cắt rồi trả “thành công”.
- **Hard limits (không cấu hình vượt):** `NM_TRANSPORT_LIMIT_BYTES = 1048576` (giới hạn **transport**, ngoài tầm kiểm soát); `MAX_ENVELOPE_BYTES_HARD = 786432` (internal hard cap — **bằng** default, nên operator không thể nới tới sát transport); `MAX_ENVELOPE_BYTES_DEFAULT = 786432`; `MAX_EVENT_PAYLOAD_BYTES = 262144`; `MAX_SNAPSHOT_CHUNK_BYTES = 262144`.
- Delta coalesce `coalesceWindowMs` (50ms); client chậm → `gateway.notice{backpressure:"deltas_dropped"}` (ephemeral) rồi ngừng delta.
- Không drop durable event vì client chậm; ngắt connection → client `task.sync`.

### 4.2 Protocol errors — registry duy nhất (sửa P0.9)

Mọi code dùng trong spec **phải** có ở đây. Không section nào được tự phát minh code mới.

```ts
export type ProtocolErrorCode =
  // protocol / transport
  | "proto.invalid" | "proto.unsupported" | "proto.auth_failed" | "proto.auth_expired"
  | "proto.version_mismatch" | "proto.unknown_method" | "proto.payload_too_large"
  // gateway lifecycle
  | "gateway.starting" | "gateway.unresponsive" | "gateway.not_ready" | "gateway.shutting_down"
  // task / conversation / turn
  | "task.not_found" | "task.busy" | "task.invalid_state" | "task.cancelled" | "task.paused"
  | "task.queue_full" | "task.backend_locked"
  | "conversation.not_resumable"
  | "turn.not_found" | "turn.not_active" | "turn.already_running" | "turn.interrupt_timeout"
  // provider
  | "provider.unavailable" | "provider.auth_required" | "provider.spawn_failed"
  | "provider.model_invalid" | "provider.turn_failed" | "provider.turn_timeout"
  | "provider.steer_unavailable" | "provider.interrupt_failed" | "provider.not_resumable"
  // browser
  | "browser.no_host" | "browser.backend_unavailable" | "browser.backend_mismatch"
  | "browser.wrong_profile" | "browser.confirmation_required"
  | "browser.tab_not_found" | "browser.tab_closed" | "browser.not_in_scope"
  | "browser.stale_snapshot" | "browser.stale_binding" | "browser.element_not_found"
  | "browser.navigated" | "browser.timeout" | "browser.denied" | "browser.ambiguous_target"
  | "browser.host_lost_after_dispatch" | "browser.result_lost"
  | "browser.unsupported_command" | "browser.verification_failed" | "browser.gesture_required"
  // approval / artifacts
  | "approval.not_found" | "approval.expired" | "approval.already_decided"
  | "artifact.missing" | "artifact.too_large"
  | "internal";

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;                     // user-facing, đã redact
  retryable: boolean;
  requiresUserAction: boolean;
  sideEffectState: "none" | "known" | "unknown";   // quan trọng cho browser action đã dispatch
  details?: Record<string, unknown>;   // bounded + redacted
}
```

Bảng phân loại (dùng để test registry):

| Code | retryable | requiresUserAction | sideEffectState |
|---|---|---|---|
| `gateway.starting` / `gateway.not_ready` | ✅ | ❌ | none |
| `gateway.unresponsive` | ✅ | ✅ | none |
| `proto.auth_expired` | ✅ (refresh) | ❌ | none |
| `browser.confirmation_required` / `browser.ambiguous_target` | ❌ | ✅ | none |
| `browser.stale_binding` / `stale_snapshot` | ✅ (re-snapshot) | ❌ | none |
| `browser.timeout` | ⚠️ | ❌ | **unknown** |
| `browser.no_host` (**trước** dispatch) | ✅ | ❌ | **none** — chưa gửi lệnh, an toàn retry |
| `browser.host_lost_after_dispatch` (**sau** dispatch, chưa có result) | ❌ | ✅ | **unknown** — **không** retry mutating |
| `browser.result_lost` (host đã trả result nhưng connection đứt trước khi Gateway persist) | ⚠️ | ✅ | **known** (theo result) nhưng phải reconcile |
| `browser.denied` | ❌ | ✅ | none |
| `provider.turn_failed` | ⚠️ | ❌ | unknown |
| `artifact.missing` | ❌ | ❌ | none |

### 4.3 Agent provider contract

```ts
export interface RuntimeInfo {
  provider: ProviderId;
  sessionId: string | null;
  model: string | null;
  modeId: string | null;
  thinkingOptionId?: string | null;
  extra?: Record<string, unknown>;
}

export interface AgentSession {
  readonly provider: ProviderId;
  readonly sessionKey: string;
  readonly capabilities: AgentCapabilityFlags;

  /** Gateway sở hữu `turnId` chính thức và truyền vào `input.gatewayTurnId`.
   *  Promise chỉ trả id của provider (nếu có) — KHÔNG trả `turnId` để tránh nhầm identity. */
  startTurn(input: TurnInput): Promise<{ accepted: true; providerTurnId?: string }>;
  steer?(input: TurnInput): Promise<{ status: "accepted" | "unavailable" }>;
  /** Ownership guarantee: khi resolve, không còn foreground turn cũ nào sẽ chạy tiếp;
   *  pending steers bị huỷ; adapter đã clear queue nội bộ. */
  interrupt(): Promise<void>;
  canStopRuntime?(): boolean;

  respondToPermission(requestId: string, response: PermissionResponse): Promise<PermissionResponseResult>;
  getPendingPermissions(): PermissionRequest[];      // mirror; Gateway là nguồn chính

  subscribe(listener: (e: AgentEvent) => void): () => void;
  streamHistory?(): AsyncGenerator<AgentEvent>;      // import/history; optional

  getRuntimeInfo(): Promise<RuntimeInfo>;
  getAvailableModes(): Promise<AgentMode[]>;
  getCurrentMode(): Promise<string | null>;
  setMode?(modeId: string): Promise<void | AgentProviderNotice>;
  setModel?(model: string | null): Promise<void>;
  setThinkingOption?(id: string | null): Promise<void | AgentProviderNotice>;
  listCommands?(): Promise<SlashCommand[]>;

  describePersistence(): AgentPersistenceHandle | null;   // null cho tới khi resumable thực sự
  close(): Promise<void>;
}

export interface PermissionResponseResult {
  /** Provider đôi khi trả follow-up prompt sau khi trả lời permission (vd select → comment). */
  followUpPrompt?: TurnInput;
}
```

**`TurnInput` (định nghĩa đầy đủ — sửa P1.3):**

```ts
export type ProviderId = string;

export interface TurnInput {
  /** Gateway-assigned. Adapter phải dùng để gắn event, không tự sinh. */
  gatewayTurnId: string;
  clientMessageId: string;
  /** Nội dung người dùng: text + parts có thứ tự (text/image/file/structured). */
  content: TurnContentPart[];
  ctx?: {
    attachments?: AttachmentRef[];      // file/ảnh đã materialize
    contextRefs?: ContextRef[];         // snapshot/tab/history
    instructions?: string;              // system-ish bổ sung theo turn (không phải system prompt)
    metadata?: Record<string, unknown>;
  };
}

export type TurnContentPart =
  | { type: "text"; text: string }
  | { type: "image"; artifactRef: string; mimeType: string }
  | { type: "file"; artifactRef: string; name: string; mimeType: string }
  | { type: "structured"; schema: string; data: unknown };

export interface AttachmentRef {
  id: string; name: string; mimeType: string; sizeBytes: number; kind: string;
  artifactRef?: string;      // artifact store
  missing?: boolean;         // file gốc đã bị xoá
}

export interface ContextRef {
  kind: "snapshot" | "tab" | "file" | "history";
  ref: string; label?: string;
}
```

**`AgentProvider` (đầy đủ — không tham chiếu v2):**

```ts
export interface AgentProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: AgentCapabilityFlags;
  isAvailable(signal?: AbortSignal): Promise<{ available: boolean; version?: string; reason?: string }>;
  fetchCatalog(opts: FetchCatalogOptions): Promise<ProviderCatalog>;
  createSession(config: AgentSessionConfig, ctx: LaunchContext): Promise<AgentSession>;
  resumeSession(handle: AgentPersistenceHandle, config: Partial<AgentSessionConfig>, ctx: LaunchContext): Promise<AgentSession>;
  getDiagnostic?(): Promise<{ diagnostic: string }>;
  shutdown?(): Promise<void>;
}
```

Các type còn lại (`AgentCapabilityFlags`, `AgentMode`, `ProviderCatalog`, `FetchCatalogOptions`, `LaunchContext`, `AgentSessionConfig`, `AgentPersistenceHandle`, `AgentProviderNotice`, `SlashCommand`, `Usage`, `PermissionRequest`, `PermissionResponse`, `PermissionDecision`) là **bắt buộc** trong `packages/shared/src/agent/*` và được liệt kê ở §4.10.

**Ai tạo turn tiếp theo sau `followUpPrompt`:** **Gateway**, không phải adapter. Adapter chỉ trả `followUpPrompt`; Gateway kiểm tra capability, tạo `gatewayTurnId` mới, persist `user.message.created`, rồi gọi `startTurn`. Không để adapter tự chạy turn (tránh 2 owner).

### 4.4 Normalized events (đóng kín)

```ts
export type AgentEvent =
  // conversation
  | { type: "conversation.opened"; sessionKey: string; provider: ProviderId; persistence: AgentPersistenceHandle | null }
  | { type: "conversation.closed"; sessionKey: string; reason?: string }
  // user/turn lifecycle
  | { type: "user.message.created"; turnId: string; message: TurnInput; clientMessageId: string }
  | { type: "turn.started"; turnId: string; clientMessageId?: string }
  | { type: "assistant.delta"; turnId: string; text: string }            // EPHEMERAL
  | { type: "reasoning.delta"; turnId: string; text: string }            // EPHEMERAL (xem flag)
  | { type: "assistant.message"; turnId: string; text: string;
      assistantMessageRef?: string }   // DURABLE final; text lớn → artifact, text có thể rỗng
  | { type: "reasoning.summary"; turnId: string; summary: string }       // DURABLE, không phải raw reasoning
  | { type: "tool.started"; turnId: string; toolCallId: string; tool: string;
      input?: unknown;            // BOUNDED + redacted; > MAX_EVENT_PAYLOAD_BYTES ⇒ artifactRef
      inputArtifactRef?: string;
      source: "provider" | "browser" }
  | { type: "tool.completed"; turnId: string; toolCallId: string; tool: string;
      outcome: ToolOutcome;
      output?: unknown;           // BOUNDED + redacted; lớn ⇒ outputArtifactRef
      outputArtifactRef?: string;
      verified?: VerificationResult }
  | { type: "permission.requested"; turnId?: string; request: PermissionRequest }
  | { type: "permission.resolved"; requestId: string; decision: PermissionDecision }
  | { type: "permission.expired"; requestId: string; reason: "task_terminal" | "restart" | "provider_unavailable" }
  | { type: "usage"; turnId?: string; usage: Usage }
  | { type: "turn.completed"; turnId: string; stopReason?: string }
  | { type: "turn.failed"; turnId: string; error: ProtocolError }   // normalized, đã redact (§4.2)
  | { type: "turn.cancelled"; turnId: string; reason?: string }
  | { type: "turn.unknown"; turnId: string; reason: string }              // crash/reconnect không xác định
  | { type: "provider.notice"; level: "info" | "warn"; message: string };   // DURABLE (auditable, giữ trong stream)

export type ToolOutcome = "succeeded" | "failed" | "cancelled" | "unknown";
export type VerificationResult = boolean | "unknown";

/** Phân loại cho protocol (§4.1): quyết định event có seq hay không. */
export const EPHEMERAL_EVENT_TYPES = ["assistant.delta", "reasoning.delta"] as const;

/** AgentEvent sau khi loại ephemeral — phần nằm trong task stream durable. */
export type DurableAgentEvent = Exclude<AgentEvent, { type: "assistant.delta" | "reasoning.delta" }>;
/** Union DUY NHẤT cho task stream (envelope, task.sync, event log, snapshot). */
export type DurableTaskEvent = DurableAgentEvent | TaskEvent;
export type DurableTaskEventType = DurableTaskEvent["type"];

/** Envelope đã ràng buộc stream — dựng lại từ union, KHÔNG dùng Extract từ envelope rộng. */
/** Envelope phân phối theo từng event → `type` và `payload.type` KHÔNG thể lệch nhau. */
export type DurableTaskEventEnvelope = {
  [E in DurableTaskEvent as E["type"]]: {
    v: 1; kind: "event"; reliability: "durable"; stream: "task";
    taskId: string; seq: number; ts: number;
    type: E["type"];
    payload: E;
  };
}[DurableTaskEvent["type"]];

export type DurableGatewayEventEnvelope = {
  [E in DurableGatewayEvent as E["type"]]: {
    v: 1; kind: "event"; reliability: "durable"; stream: "gateway";
    seq: number; ts: number;
    type: E["type"];
    payload: E;
  };
}[DurableGatewayEvent["type"]];
```

**TaskEvent / GatewayEvent (sửa P1.1 — tách union, không dùng prose):**

```ts
export type TaskEvent =
  | { type: "task.created"; taskId: string; profileId: string; providerId: ProviderId; backend: BackendBinding }
  | { type: "task.status_changed"; from: TaskStatus; to: TaskStatus; pauseReason?: PauseReason }
  | { type: "task.backend_changed"; from: BackendBinding; to: BackendBinding; by: "user"; }
  | { type: "task.attention_changed"; attention: TaskAttention | null }
  | { type: "task.tab_binding"; state: BrowserBindingState; profileId: string; browserInstanceId: string | null }
  | { type: "task.completed" } | { type: "task.failed"; error: ProtocolError }
  | { type: "task.cancelled"; reason: string };
  // `task.purged` KHÔNG thuộc task stream (event sẽ bị xoá cùng task).
  // Purge phát tombstone ở GATEWAY stream: gateway.task_purged (§4.4), retention riêng.

export type GatewayEvent =
  | { type: "gateway.started"; version: string; recoveredTurns: number; recoveredTasks: number }
  | { type: "gateway.restarted"; reason: "crash" | "user" | "update"; previousUptimeMs?: number }
  | { type: "gateway.notice"; level: "info" | "warn"; message: string; backpressure?: "deltas_dropped" }
    // ^ EPHEMERAL: không seq, không persist, không replay. Nếu cần audit → bảng riêng.
  | { type: "gateway.provider.changed"; providerId: ProviderId; available: boolean; version?: string }
  | { type: "gateway.catalog.updated"; providerId: ProviderId; contentHash: string }
  | { type: "gateway.task_purged"; taskId: string; purgedAt: number; reason: "user" | "retention" };

export type TaskEventType = TaskEvent["type"];
export type GatewayEventType = GatewayEvent["type"];

/** Persist? (durable stream) hay chỉ notification tạm? */
export type GatewayNotice = Extract<GatewayEvent, { type: "gateway.notice" }>;
export type DurableGatewayEvent = Exclude<GatewayEvent, GatewayNotice>;
export type DurableGatewayEventType = DurableGatewayEvent["type"];
export const GATEWAY_EVENT_REPLAYABLE: ReadonlySet<GatewayEventType> = new Set([
  "gateway.started", "gateway.restarted", "gateway.provider.changed", "gateway.catalog.updated",
  "gateway.task_purged",
]);
// `gateway.notice` là EPHEMERAL: gửi qua envelope `reliability:"ephemeral"`, KHÔNG seq, KHÔNG persist.
```

- `task.snapshot` **không** phải event — nó là **response** (`TaskSnapshot`). Snapshot không nằm trong event log; Gateway dựng từ state.
- `task.sync` trả **durable** event của task stream; payload là `DurableTaskEvent = DurableAgentEvent | TaskEvent` (một union, một `type` namespace). Client dispatch theo `type`.
- `gateway.notice` là **ephemeral**: envelope `{ reliability:"ephemeral", stream:"gateway", type:"gateway.notice" }`, **không** `seq`, không persist, không replay.

**Invariants (có test):**

1. **Turn đã start** (`started_at NOT NULL`): đúng 1 `turn.started` và đúng 1 terminal (`turn.completed|failed|cancelled|unknown`).
1b. **Turn terminal trước khi start** (`queued → cancelled|failed`, `started_at NULL`): **không** có `turn.started`; vẫn đúng 1 terminal event. Hai nhánh loại trừ nhau dựa trên `turns.started_at`, không dựa trên sự tồn tại của event.
2. Không event của turn A trong turn B (session đơn luồng foreground).
3. Không `assistant.delta` sau terminal của chính turn.
4. Mỗi `tool.started` có đúng 1 `tool.completed`, **kể cả** khi crash → `outcome:"unknown"` (xem §5.6).
5. Mỗi `permission.requested` có đúng 1 `permission.resolved` **hoặc** `permission.expired` (không dùng tên `approval.expired` — đó là error code, không phải event).
6. `user.message.created` **trước** `turn.started` cùng `turnId`.
7. `assistant.message` (nếu có) xuất hiện trước terminal.
8. **Durable** event trong một task có seq tăng đơn điệu, **không gap** — kể cả khi delta bị drop (§4.1).
9. `deltaOffset` của các delta còn nhận được là tăng dần; gap offset chỉ được phép nếu client đã báo `deltas_dropped` hoặc reconnect.
10. Mỗi turn kết thúc có `assistant.message` durable **khi** provider có text đầu ra (kể cả khi delta bị drop) — ngoại lệ: turn failed trước khi có text.

#### 4.4.1 Turn ID race

**Ba ID tách biệt:**

| ID | Ai cấp | Ý nghĩa |
|---|---|---|
| `gatewayTurnId` | **Gateway** (ULID), trước provider call | ID chính thức trong event log, DB, UI |
| `providerTurnId` | Provider, nếu có | Dùng nội bộ để map event native |
| `clientMessageId` | Client (UI), echo lại | Idempotency cho `task.send`; unique trong task |

Luồng:

1a. **Nhận prompt:** Gateway cấp `gatewayTurnId`; persist `user.message.created` + row `turns(status='queued', created_at, queued_at)` **cùng transaction**. *Không* persist `turn.started` ở đây.
1b. **Lấy khỏi queue:** khi session sẵn sàng (turn trước terminal), persist `turn.started` + `started_at` **rồi mới** gọi provider. Hai thời điểm là hai transaction (turn thứ 2 chờ turn thứ 1).
2. Gọi `session.startTurn({ gatewayTurnId, clientMessageId, ... })`; adapter **phải** gắn `gatewayTurnId` cho mọi event nó phát.
3. Adapter trả `{accepted:true, providerTurnId?}`; Gateway lưu `providerTurnId → gatewayTurnId`.
4. Event provider đến **trước** khi promise resolve → buffer theo `gatewayTurnId` từ `TurnInput`; không drop.
5. Event thiếu turnId → chỉ gán được khi session có **đúng một** turn active; nếu không → log + drop (không đoán).
6. `startTurn` reject (không phải abort do interrupt) → vẫn phát terminal cho turn đã persist: `turn.failed{code:"provider.turn_failed"}`; DB `turns.status='failed'`, `ended_at` set.
7. `startTurn` reject do interrupt trong lúc gọi → `turn.cancelled`.
8. `task.send` cùng `clientMessageId` đã tồn tại (retry) → trả lại `gatewayTurnId` cũ (idempotent), **không** tạo turn mới.

### 4.5 Browser backend contract

**Contract đầy đủ (không tham chiếu version cũ):**

```ts
export interface BrowserBackendCapabilities {
  existingUserTabs: boolean;
  existingUserSession: boolean;
  isolatedProfile: boolean;
  multiTab: boolean;
  dom: boolean;
  accessibility: boolean;
  screenshot: boolean;
  upload: boolean;
  /** Mức đã CHỨNG MINH bằng test. MVP extension = "none" (mọi iframe, kể cả same-origin).
   *  `all_frames:false` KHÔNG tự tạo capability nào. `same-origin` chỉ sau implementation + test. */
  iframe: "none" | "same-origin" | "all";
  nativeDialogs: boolean;                      // extension: CDP Page domain (đã verify headless); playwright: false
  filePicker: boolean;                         // extension: chỉ qua user gesture; playwright: true
  trustedGesture: boolean;                     // extension: true — mọi gesture tool có args.trusted qua CDP (đã verify headless)
  browserChrome: boolean;                      // false (không điều khiển thanh địa chỉ/UI Chrome)
  networkInspection?: boolean;
  attachToRunningChrome?: boolean;
}
```

Không được quảng bá “hỗ trợ mọi thao tác web”. `browser.gesture_required` trả khi action cần user gesture thật (file picker, một số click bị site chặn synthetic).

### 4.6 Handshake / sync / snapshot (B4)

```ts
export interface HelloRequest {
  clientVersion: string; protocolVersion: 1;
  clientId: string; profileId: string;
  browserInstanceId: string | null;          // null ⇒ degraded (§3.2)
  hostInstanceId: string;
  lastSeqByTask?: Record<string, number>;
  /** Cursor gateway stream; thiếu ⇒ 0. */
  lastSeqByGateway?: number;
}
export interface HelloResponse {
  gatewayVersion: string; protocolVersion: 1;
  providers: Array<{ id: ProviderId; available: boolean; capabilities: AgentCapabilityFlags }>;
  backends: Array<{ id: BrowserBackendId; available: boolean; capabilities: BrowserBackendCapabilities }>;
  tasks: Array<{
    taskId: string; profileId: string; status: TaskStatus; lastSeq: number;
    activeTurnId?: string | null;
    /** browser binding còn hợp lệ với browserInstanceId mà client vừa gửi hay không */
    browserBinding: BrowserBindingState;   // §3.2 — ok | needs_confirmation | stale | none
  }>;
  features: Record<string, boolean>;
  tokenRotated?: boolean;
  /** Seq mới nhất của gateway stream — client dùng để quyết định replay. */
  gatewayLastSeq: number;
}

// RPC
type TaskSyncRequest  = { taskId: string; fromSeq: number; maxEvents?: number };
type TaskSyncResponse =
  // Chỉ event stream="task" của ĐÚNG taskId này, seq > fromSeq, liên tục.
  | { mode: "replay"; stream: "task"; taskId: string; events: DurableTaskEventEnvelope[]; nextSeq: number; hasMore: boolean }
  | { mode: "snapshot"; snapshot: TaskSnapshot; lastSeq: number };

type TaskSnapshotRequest = { taskId: string };

/** Snapshot phải TỰ ĐỦ để dựng lại hội thoại khi event log đã prune (sửa P0-4). */
export type TaskSnapshotData = {
  task: TaskRecord;
  conversation: {
    sessionKey: string; provider: ProviderId;
    persistence: AgentPersistenceHandle | null;
    state: "opening" | "open" | "closed" | "stale";
  };
  turns: Array<{
    turnId: string; status: TurnStatus; clientMessageId: string;
    createdAt: number; queuedAt?: number; startedAt: number | null; endedAt?: number | null;
    stopReason?: string;
  }>;
  /** BẮT BUỘC: mọi user prompt. Không bao giờ prune khỏi snapshot. */
  userMessages: Array<{
    turnId: string; clientMessageId: string; createdAt: number;
    /** Representation chuẩn hóa đúng như provider đã nhận (sửa P1.3). */
    input: TurnInput;
    /** true = đã redact một phần; xem redactedFields */
    redacted?: boolean;
    redactedFields?: string[];
    /** "full" | "partial" | "text_only" — mức tái dựng được */
    inputCompleteness: "full" | "partial" | "text_only";
    toolCallIds?: string[];
  }>;
  /** BẮT BUỘC: mọi assistant final message (kể cả khi text lớn nằm trong artifact). */
  assistantMessages: Array<{
    turnId: string; createdAt: number;
    /** Có thể rỗng nếu nội dung nằm trong artifact. */
    text: string;
    assistantMessageRef?: string;   // artifact ref cho nội dung lớn
    sha256?: string;
    bytes?: number;
    /** true khi nội dung gốc đã mất và artifact không còn */
    missing?: boolean;
  }>;
  /** Tool call summary + outcome. Đây LÀ "context/tool calls" của turn — một tên duy nhất. */
  toolCalls: Array<{
    turnId: string; toolCallId: string; tool: string; source: "provider" | "browser";
    outcome: ToolOutcome; verified?: VerificationResult;
    /** input đã normalize (bounded); chứa đủ để hiểu call làm gì */
    inputSummary?: unknown;
    inputArtifactRef?: string;
    inputMissing?: boolean;
    summary?: string;
    /** output lớn hoặc đã prune → cách truy xuất */
    outputArtifactRef?: string;
    outputMissing?: boolean;
  }>;
  /** Permission requests + decisions (kể cả đã resolve) — NGUỒN DUY NHẤT. */
  permissions: Array<{ request: PermissionRequest; decision: PermissionDecision | null; createdAt: number }>;
  // `pendingApprovals` = derived: permissions.filter(p => p.decision === null) — KHÔNG lưu riêng
  lastSeq: number;
  /** Ghi rõ snapshot này được tạo sau khi prune hay không, và mất phần nào. */
  rebuiltFrom: "event_log" | "archived_snapshot";
  truncatedDeltas?: boolean;
};

/** Ba hình thức vận chuyển — discriminated union, client switch theo `kind`. */
export type InlineTaskSnapshot = TaskSnapshotData & { storage: { kind: "inline" } };

export interface ChunkedTaskSnapshotManifest {
  storage: { kind: "chunked"; snapshotRef: string; chunkCount: number; totalBytes: number; snapshotSha256: string };
  /** metadata tối thiểu để UI hiển thị trước khi tải hết */
  taskId: string; lastSeq: number; rebuiltFrom: "event_log" | "archived_snapshot";
}
export interface ArtifactTaskSnapshotManifest {
  storage: { kind: "artifact"; artifactRef: string; sha256: string; bytes: number };
  taskId: string; lastSeq: number; rebuiltFrom: "event_log" | "archived_snapshot";
}
/** TaskSnapshot union — KHÔNG bắt buộc đủ dữ liệu khi chunked/artifact. */
export type TaskSnapshot = InlineTaskSnapshot | ChunkedTaskSnapshotManifest | ArtifactTaskSnapshotManifest;

// Đọc chunk
type TaskSnapshotChunkRequest = { taskId: string; snapshotRef: string; chunkIndex: number };
type TaskSnapshotChunkResponse = {
  taskId: string; snapshotRef: string;
  chunkIndex: number; chunkCount: number;
  data: string; sha256: string;          // sha256 của chunk
  snapshotSha256: string;                // verify sau khi ghép
};
```

**Quy tắc prune (không được vi phạm):**

1. `user.message.created`, `assistant.message`, `tool.completed`, `permission.*`, terminal turn **không bao giờ** bị prune khỏi dữ liệu dùng để tạo snapshot.
2. Chỉ **delta** (`assistant.delta`, `reasoning.delta`) và output tool lớn mới được prune/gộp.
3. Snapshot phải **tái dựng được input provider đã nhận**: attachment (kể cả đã mất → `missing:true` + `artifactRef`), context refs, tool call input summary và outcome/verification. Nếu chỉ đủ để hiển thị UI mà không đủ để hiểu lịch sử → **không đạt**.
4. Snapshot **không** chứa raw reasoning; nếu cần hiển thị, dùng `reasoning.summary`.

**`nextSeq` semantics:** = `lastSeqSentInThisBatch` (KHÔNG phải lastSeq+1). Client gửi lại `fromSeq = nextSeq` ở lần sync kế; server trả event `seq > fromSeq`. Nếu `hasMore=false`, `nextSeq` = seq mới nhất của stream.

**Ack semantics:** `ack{stream, taskId?, seq, renderedAt}` = client **đã nhận và đã render xong** tới `seq`; **không** phải “đã persist”. Ack **không** cần cho correctness — reconnect dùng `lastSeqByTask` / `lastSeqByGateway` (client tự lưu sau khi render). Ack chỉ dùng để: giới hạn buffer, dọn replay state.

**Gateway stream sync (bổ sung v4.1):** ngoài task stream, gateway stream có cursor riêng.

```ts
type GatewaySyncRequest  = { fromSeq: number; maxEvents?: number };
type GatewaySyncResponse =
  // Chỉ event stream="gateway" (durable), seq > fromSeq.
  | { mode: "replay"; stream: "gateway"; events: DurableGatewayEventEnvelope[]; nextSeq: number; hasMore: boolean }
  | { mode: "head";   lastSeq: number; snapshot?: { providers: ...; backends: ...; features: ... } };
```

- `HelloRequest` mang thêm `lastSeqByGateway?: number`; `HelloResponse` trả `gatewayLastSeq: number`.
- Gateway stream seq lưu bền trong `gateway_state('gateway.last_seq')` (§7.2) — cùng transaction với insert event.
- Prune gateway stream theo retention như task milestone; nếu client hỏi seq đã prune → `mode:"head"`.

**Delta retention (sửa v4.1):** delta **không** nằm trong event log → **không** có retention row. Chỉ có **buffer delta tạm trong bộ nhớ** (coalesce, tối đa `deltaBufferMaxPerTurn`); buffer này mất khi turn kết thúc, không persist, không prune. §5.5 không được liệt kê “Delta events retention”.

### 4.7 Task / Conversation / Turn records

```ts
export type TaskStatus = "queued" | "active" | "paused" | "completed" | "failed" | "cancelled";
export type TurnStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface TaskRecord {
  taskId: string;
  createdAt: number; updatedAt: number;
  status: TaskStatus;
  /** Chỉ khi status='paused' — vì sao (sửa P1.4). */
  pauseReason?: PauseReason | null;
  title?: string | null;
  profileId: string;                    // stable trong vòng đời installation (B3)
  providerId: ProviderId;
  conversationKey: string;              // logical session (B1)
  cwd: string;
  model?: string | null; modeId?: string | null; thinkingOptionId?: string | null;
  providerOptions?: Record<string, unknown> | null;
  backend: BackendBinding;
  tabIntent: TabIntent;                 // durable user intent (M4)
  /** Identity lúc tạo task — bất biến (P1.5). */
  originBrowserInstanceId?: string | null;
  /** Binding runtime hiện tại, cập nhật khi reconnect (không dùng làm identity gốc). */
  binding: { browserInstanceId: string | null; connectionId?: string; state: BrowserBindingState };
  lastSeq: number;
  /** Con trỏ đọc của UI (cập nhật từ `ack{stream:"task"}`), dùng cho attention "turn_finished". */
  lastReadSeq: number;
  error?: ProtocolError | null;
}

/** attention KHÔNG lưu DB — Gateway tính khi trả snapshot (P0.8). */
export type TaskAttention =
  | "approval_pending" | "turn_finished" | "error"
  | "browser_offline" | "needs_tab_confirmation";

export type PauseReason =
  | "user_requested" | "gateway_restart" | "browser_unavailable" | "provider_unavailable";

/** Derived: */
// attention =
//   approvals pending            -> "approval_pending"
//   binding.needs_confirmation   -> "needs_tab_confirmation"
//   browser host offline         -> "browser_offline"
//   last turn failed             -> "error"
//   last turn completed AND task.lastReadSeq > lastTurnTerminalSeq  -> KHÔNG attention
//   turn đã terminal AND task.lastReadSeq < lastTurnTerminalSeq -> "turn_finished"   (còn unread)
//   turn đã terminal AND task.lastReadSeq >= lastTurnTerminalSeq -> không attention    (đã đọc)
//   `lastReadSeq` cập nhật từ ack{stream:"task",seq}; khởi tạo 0; khi `task.sync` trả snapshot
//   (không replay) → đặt `lastReadSeq = snapshot.lastSeq` (client đã có toàn bộ state).
//   else                         -> null

export interface BackendBinding {
  backendId: BrowserBackendId;          // pinned at task.create; không đổi giữa turn
  pinnedBy: "user" | "policy" | "default";
  backendInstanceId?: string;           // playwright context id
}

export interface TurnRecord {
  turnId: string; taskId: string; status: TurnStatus;
  clientMessageId: string;
  createdAt: number;
  queuedAt?: number;
  /** null khi status='queued' (khớp DDL §7.2). */
  startedAt: number | null;
  endedAt?: number | null;
  stopReason?: string;
  error?: ProtocolError | null;
}
```

### 4.8 Permission/risk model (B5)

**Không phân loại theo tên action.** Risk được tính từ **action + target + page + data**:

```ts
export interface ActionContext {
  backendId: BrowserBackendId;
  profileId: string;
  tabId: number | string;
  url: string; origin: string;
  action: BrowserToolName;
  target?: {
    ref?: string; role?: string; tag?: string; inputType?: string;
    label?: string; name?: string; formAction?: string; method?: string;
    autosave?: boolean; isPassword?: boolean; isPayment?: boolean; isDestructive?: boolean;
  };
  dataEgress?: "none" | "page-local" | "network-form" | "download";
  /** Dữ liệu RỜI browser. Tách loại dữ liệu × ĐÍCH đến (trust boundary). */
  agentEgress?: {
    dataClass: "none" | "page-text" | "screenshot" | "attachment";
    destination: "local-provider" | "cloud-provider" | "external-mcp" | "logs-telemetry";
    /** true nếu page có dấu hiệu dữ liệu nhạy cảm KHÔNG phải password (PII, email, số thẻ, địa chỉ…) */
    sensitiveContent?: boolean;
  };
  publicSideEffect?: boolean;      // post/send/publish/submit công khai
  requiresUserGesture?: boolean;   // file picker, site chặn synthetic
  withinTabScope: boolean;
  /** false khi classifier không xác định được target/form/origin semantics. */
  contextResolved: boolean;
}
```

**Classifier (mặc định, fail-closed — sửa P1-10):**

| Tín hiệu | Risk |
|---|---|
| `snapshot/extract/list/get` | `read` (nhưng xét `agentEgress` riêng, xem dưới) |
| `screenshot` | `read` + `agentEgress:"screenshot"` |
| `scroll`, `tab.activate`; `navigate` tới http(s) **và** `contextResolved` | `low` |
| `navigate` không xác định được đích/side effect, hoặc URL là auth/payment/short-link/redirect | `external_mutation` (**approval**) |
| `type/fill/select` field thường (không password/payment/PII, không autosave, same-origin form) | `data_entry` (allow) |
| `type/fill` autosave / PII / password / payment / form cross-origin | `data_entry_sensitive` (**approval**) |
| `click` trên submit/send/post/publish/delete/confirm/pay, **hoặc** button thuộc form `method != GET`, **hoặc** `contextResolved=false` | `external_mutation` (**approval**) |
| Origin thanh toán/auth **hoặc** `target.isPayment` | `financial` (**approval + config + không auto**) |
| Ngoài tab scope / khác profile | **deny** |
| `evaluate` | ~~hard block~~ → **đã mở sau CDP tier**: mọi call = `external_mutation` approval (expression preview trong argsPreview), result = page-text egress; residual: JS đã duyệt vẫn có thể gây side-effect trong page (fetch…) ngoài tầm tool gate — chấp nhận có chủ đích, xem `docs/adr/debugger-tier.md` + `tool-server.ts` |
| đọc cookie/localStorage (tool riêng), tải binary | **hard block** (evaluate đã cover cookie/localStorage dưới approval) |
| `route` (fulfill/abort/modify — inject/sửa/chặn response) | `external_mutation` (**approval**, không allow_task); `unroute` = `low` |
| `webSocket`, `responseBody`, `network`, `console`, `find`, `get`… | `read` + `agentEgress:"page-text"` (như extract/find) |

**Ba quy tắc bắt buộc (fail-closed):**

1. **Form submit có side effect không rõ → approval.** Không chờ classifier “đoán” tên button.
2. **`agentEgress` là chiều risk riêng:** gửi page text/screenshot/attachment ra provider là dữ liệu rời browser. Chính sách: `read` cho phép, nhưng nếu page được đánh dấu nhạy cảm (origin trong `sensitiveOrigins`, có password field, URL chứa token) → **approval** trước khi gửi nội dung ra ngoài, và **không bao giờ** gửi giá trị password field.
3. **`contextResolved=false` → không mặc định `low`.** Hạ về `external_mutation` (approval) cho action mutating; với read → vẫn cho nhưng đánh dấu `partialContext` trong kết quả.

Approval gắn **snapshot + scope hẹp**:

```ts
interface PermissionRequest {
  requestId: string; taskId: string; turnId?: string;
  kind: "browser_action" | "provider_permission" | "data_entry_sensitive" | "agent_egress";
  risk: RiskLevel;
  summary: string;
  actionDigest: string;    // hash(canonical(tool,args,target ref,snapshotId,url,origin,dataEgress))
  details: { tool: string; argsPreview: unknown; origin: string; targetLabel?: string };
  options: Array<{ id: string; label: string; kind: "allow_once" | "allow_task" | "deny" }>;
}
```

Quy tắc:

- `actionDigest` **chỉ** áp dụng đúng action đó — args/target/snapshot/url/egress đổi → approval cũ **không** áp dụng.
- `allow_task`: scope = `tool + origin + targetFormIntent + dataClass + destination`; **TTL = task lifetime**. **Cấm** cho `financial`, `external_mutation`, `agent_egress.screenshot`, và **mọi** egress có `destination != "local-provider"` **hoặc** `sensitiveContent=true` → chỉ `allow_once`.
- Không coi page text là an toàn chỉ vì không có password field; `sensitiveContent` phải được classifier đánh giá (PII patterns) hoặc đánh dấu `unknown` → approval.
- Approval **không** bao giờ bypass hard blocks.

**Trusted gesture caveat:** DOM `element.click()` là synthetic; không thay thế user gesture. Nếu site yêu cầu gesture (file input, một số confirm) → `browser.gesture_required` + UI hướng dẫn user tự làm. Approval trong UI của Chromex **không** biến click synthetic thành trusted gesture.

### 4.9 Durable vs runtime binding (M4)

| Loại | Ví dụ | Persist? | Sau restart |
|---|---|---|---|
| Durable intent | `TabIntent.scope=explicit`, urlPattern/titleHint; `profileId`; `backendId` | có | dùng để **resolve lại** |
| Runtime binding | `tabId` Chrome, `hostInstanceId`, playwright `pageId` | **không** (chỉ trong bộ nhớ + task.runtime) | hết hiệu lực |
| Snapshot binding | `snapshotId`, `fingerprint` | metadata ngắn hạn (TTL) | invalid |

**Resolve `active` tại thời điểm tạo task (sửa P1-8):**

- `scope:"active"` **không** phải “luôn theo tab active hiện tại”. Khi `task.create`, Gateway **resolve ngay** thành `RuntimeTabBinding` cụ thể (`tabId` + `browserInstanceId` + url/title snapshot) và lưu **durable descriptor an toàn** (origin + path pattern + title hash + `resolvedAt`) — **không** lưu query string nhạy cảm hay URL đầy đủ.

**Phân biệt hai loại restart (sửa v4.1 — mâu thuẫn §3.2/§4.9):**

| Sự kiện | `browserInstanceId` | Hành vi |
|---|---|---|
| **SW restart** (cùng Chrome run, tab còn) | **giữ nguyên** | **tự reconnect** — không cần user; descriptor không dùng tới; binding `ok` |
| Native host reconnect (cùng Chrome run) | giữ nguyên | tự reconnect; cập nhật host binding |
| **Chrome restart** (đã chứng minh `browserInstanceId` mới) | **mới** | **KHÔNG** tự coi tab tìm được theo URL/title là tab cũ. Binding `stale`; user phải xác nhận. Descriptor chỉ **gợi ý** |
| Degraded mode (`browserInstanceId=null`) hoặc **extension reload** mất identity | null/unknown | `needs_confirmation` (KHÔNG `stale`); user xác nhận |

- Descriptor rebind **chỉ** được tự động trong nhánh SW restart (khi binding chưa hề mất). Với Chrome restart, luôn cần user xác nhận — kể cả khi có đúng một tab khớp.
- Uniqueness: nếu ≥2 tab cùng origin+path khớp → không tự chọn (áp dụng cho mọi trường hợp, kể cả gợi ý).
- `TabIntent.scope` mới:

```ts
type TabIntent =
  | { scope: "active_resolved"; resolved: DurableTabDescriptor }   // default: chốt lúc tạo task
  | { scope: "explicit"; refs: DurableTabDescriptor[] }
  | { scope: "untitled" };                                          // user chọn lại sau

interface DurableTabDescriptor {
  profileId: string;
  origin: string; pathPattern: string;      // ví dụ "/inbox/*"
  titleHash?: string;                       // hash, không plaintext
  resolvedAt: number;
  /** Chrome run mà task được tạo trên đó — KHÔNG bị ghi đè khi reconnect (P1.5). */
  originBrowserInstanceId?: string | null;
}
```

---

### 4.10 Type inventory (mọi type được dùng phải tồn tại trong `shared`)

| Type | File đích | Dùng ở |
|---|---|---|
| `ProviderId` | `agent/provider-id.ts` | mọi nơi |
| `AgentCapabilityFlags` | `agent/capabilities.ts` | provider, catalog, handshake |
| `AgentMode` | `agent/modes.ts` | catalog, session |
| `AgentModel` / `ProviderCatalog` | `agent/catalog.ts` | catalog |
| `FetchCatalogOptions` | `agent/catalog.ts` | provider |
| `LaunchContext` | `agent/launch.ts` | provider.create/resume |
| `AgentSessionConfig` | `agent/session-config.ts` | task.create |
| `AgentPersistenceHandle` | `agent/persistence.ts` | conversation, task |
| `AgentProvider` / `AgentSession` | `agent/provider.ts` | registry |
| `TurnInput` / `TurnContentPart` | `agent/turn-input.ts` | RPC, snapshot, provider |
| `AgentEvent` (+ `ToolOutcome`, `VerificationResult`) | `agent/events.ts` | stream |
| `TaskEvent` / `GatewayEvent` | `tasks/events.ts` | stream |
| `PermissionRequest` / `PermissionDecision` / `PermissionResponse` | `agent/permission.ts` | approval |
| `ProtocolError` / `ProtocolErrorCode` | `protocol/errors.ts` | envelope |
| `Envelope` | `protocol/envelope.ts` | transport |
| `TaskRecord` / `TurnRecord` / `TaskStatus` / `TurnStatus` / `PauseReason` / `TaskAttention` | `tasks/record.ts` | DB, RPC |
| `TaskSnapshot` / `TaskSnapshotChunk` | `tasks/snapshot.ts` | RPC |
| `BrowserBackendId` / `BrowserBackendCapabilities` / `BrowserBackend` | `browser/backend.ts` | runtime |
| `BrowserBindingState` / `HostIdentityConfidence` / `DurableTabDescriptor` / `TabIntent` | `browser/identity.ts` | hello, register, task |
| `BrowserSnapshot` / `BrowserElement` / `SnapshotRequest` | `browser/snapshot.ts` | tools |
| `BrowserToolContext` / `BrowserActionRequest` / `BrowserActionResult` | `browser/tool.ts` | tools |
| `ActionContext` / `RiskLevel` | `browser/risk.ts` | policy |
| `Usage` | `agent/usage.ts` | events |
| `SlashCommand` | `agent/commands.ts` | session |

**Quy tắc:** spec không được tham chiếu “như vX”; mọi type hoặc inline trong tài liệu, hoặc trỏ **file trong repo** ở bảng này.

### 4.11 Contract consistency checklist (chạy trước sign-off)

| # | Kiểm tra | Cách kiểm |
|---|---|---|
| 1 | Mọi `ProtocolErrorCode` dùng trong prose có trong registry §4.2 | `rg -o '"[a-z]+\.[a-z_]+"' spec` + so với union |
| 2 | Mọi event `type` dùng trong prose có trong `AgentEvent|TaskEvent|GatewayEvent` | idem |
| 3 | Mọi field ghi trong prose có trong interface tương ứng (vd `attention`, `pauseReason`, `inputCompleteness`) | review thủ công + typecheck |
| 4 | Mọi enum xuất hiện ≥2 nơi dùng **đúng một** định nghĩa (không inline lặp) | grep enum literal |
| 5 | `browserInstanceId` luôn là `string \| null` ở mọi contract | grep |
| 6 | `seq` chỉ tồn tại trên durable event | grep `seq` |
| 7 | Schema DDL chạy được trên SQLite thật | `sqlite3 :memory: < ddl.sql` |
| 8 | Mọi CHECK constraint khớp với state machine | test insert invalid rows |
| 9 | Không còn chuỗi “v2/v3” làm dependency | grep |
| 10 | Mọi capability tuyên bố có test hoặc `PROVISIONAL` | review §8.1, §6.5, §6.8 |

**Cách chạy (tái lập được):**

```bash
# Kiểm contract
node scripts/plan/check-plan-consistency.mjs "COMPREHENSIVE PLAN FOR CHROMEX.md"

# Tự kiểm tra checker: mutate bản sao và yêu cầu check tương ứng FAIL
node scripts/plan/check-plan-consistency.mjs --self-test
```

- Mỗi check có `id` ổn định và trả **lý do fail** (không chỉ boolean).
- `--self-test` chứng minh checker **không pass rỗng**: nó chèn mutation vào bản sao (khai báo `TabIntent` thứ hai, đưa lại cơ chế reclaim theo mtime, thêm cột attention vào DDL, nâng envelope limit lên sát transport) và yêu cầu check tương ứng bắt được; đồng thời plan gốc phải pass toàn bộ.
- **Phạm vi:** regex + state-machine fence scan + **execute DDL thật** (`sqlite3`, fallback `python3`). **Không** thay typecheck/runtime test — phần đó chạy ở PR-A khi types tồn tại.
- Kết quả lần chạy gần nhất (v4.2.3): `30 passed, 0 failed` (exit 0); `--self-test` pass.

---

## 5. Gateway internals

### 5.1 Process model

```
gateway/main.ts
 1. parse env/args (CHROMEX_GATEWAY_HOME)
 2. acquire **lifetime lock** (ADR-003 §3.3.1); nếu thua → verify owner, KHÔNG reclaim khi owner còn sống
 3. load config (validate; backup + migrate)
 4. open store + run schema migrations (fail → exit non-zero, không publish endpoint)
 5. **recovery scan — TRƯỚC khi nhận traffic:**
      turns status='running'      -> emit tool.completed{unknown} cho tool chưa đóng
                                     emit turn.unknown{reason:"gateway_restart"}
      tasks status='active'       -> paused
      approvals status='pending'  -> giữ pending (UI hiện lại)
      events task mồ côi          -> repair/alert (§7.2)
      flush/commit xong mới đi tiếp
 6. build ProviderRegistry (codex, claude spike-ready)
 7. build BrowserRuntime (hosts:{}, backends:[chrome-extension, playwright-isolated?])
 8. build TaskManager/SessionManager/ApprovalStore
 9. start IPC server: **listen() trước** (nhận connection nhưng trả `gateway.starting` cho mọi request trừ `gateway.hello`)
10. write endpoint atomically + log "ready"; từ đây mới phục vụ request đầy đủ
11. signal shutdown: stop accepting, interrupt policy, flush, close
```

Crash recovery rule: **không** tự resume turn; task `active` → `paused`; turn `running` → `unknown`; UI quyết định. Không áp dụng cho SW sleep / host reconnect (§5.2.1).

### 5.2 State machines (B1)

**Task**

```
queued ──activate──▶ active ──┬── all turns terminal & không chờ approval ──▶ completed
                             ├── error không recoverable ──▶ failed
                             ├── task.cancel ──▶ cancelled
                             └── task.pause / gateway restart / unrecoverable host loss ──▶ paused
                                 // host disconnect KHÔNG tự pause: xem §5.2.1
paused ──task.resume──▶ active
paused ──task.cancel──▶ cancelled
completed ──task.send──▶ active            // mở turn mới, cùng conversation
cancelled ──task.reopen──▶ active          // tùy chọn; chỉ khi conversation resumable
```

**Turn**

```
queued ──start──▶ running ──┬── completed
                            ├── failed
                            ├── cancelled (turn.interrupt / task.cancel)
                            └── unknown  (gateway crash/host lost trong lúc chạy, không xác định)
queued ──cancelled (task.cancel trước khi start: started_at NULL, ended_at set)
queued ──failed   (không thể bắt đầu: provider unavailable trước khi start)
```

**Conversation**

```
opening ──▶ open ──▶ closed
open ──resume fail──▶ stale
```

Quan hệ: task có nhiều turn tuần tự (foreground) + có thể có background turns (P2+, chưa làm). `waiting_user` **không** phải task/turn status: đó là **derived** `TaskAttention` (§4.7), **không** lưu DB.

#### 5.2.1 Phân loại sự kiện → task/turn state (sửa P1-6)

v3 mâu thuẫn: “host lost → paused” nhưng “SW idle khi turn running → vẫn active”. Bảng dưới là **chuẩn**, cập nhật theo tài liệu Chrome (§1.5): **native port đang mở giữ SW sống**, nên “SW bị thu hồi” chỉ xảy ra khi port đã đóng hoặc Chrome force-terminate — không phải idle bình thường.

| Sự kiện | Task | Turn đang chạy | Browser binding | Ghi chú |
|---|---|---|---|---|
| Side panel đóng | **không đổi** | **không đổi** | giữ | panel chỉ là UI |
| **Forced SW termination** (port đã đóng / Chrome kill); Gateway sống; Chrome + tab còn | **không đổi** | **không đổi** | giữ nếu cùng `browserInstanceId` | test recovery; **không** mô tả là idle thường |
| **Extension reload/update/disable→enable** (Chrome còn) | **không đổi** | không đổi | **`needs_confirmation`** nếu mất identity | xem §3.2 |
| Native host reconnect, `hostInstanceId` mới, cùng `browserInstanceId` | **không đổi** | không đổi | giữ, cập nhật host | |
| Browser host disconnect (NM đóng) — **không** có tool đang chạy | `active`, attention derived `"browser_offline"` sau `reconnectGraceMs` | tiếp tục nếu provider không cần browser; nếu cần tool → chờ | chờ reconnect | **không** pause ngay |
| browser host mất khi tool đang chạy | sau grace: `paused` | tool → `unknown`; turn tiếp tục hoặc `unknown` theo provider | stranded | **phân biệt 3 mốc:** trước dispatch → `none`; sau dispatch chưa result → `unknown`; có result nhưng chưa persist → `known` + reconcile. Không retry mutating |
| Chrome restart (`browserInstanceId` mới) | `paused` | turn giữ nếu provider không cần browser; tool sau đó → `stale_binding` | invalid | user chọn lại tab |
| Gateway crash/restart | `paused` | **`unknown`** | giữ affinity nếu `browserInstanceId` còn | không auto-resume |
| Provider process crash | `paused` nếu resumable, `failed` nếu không | `unknown`/`failed` | giữ | UI hỏi resume |
| User `task.pause` | `paused` | không interrupt (mặc định); config cho phép interrupt | giữ | |

Nguyên tắc: **chỉ** hạ task xuống `paused` khi **không thể tiếp tục an toàn** hoặc **mất nguồn sự thật**; SW sleep/host chập chờn dùng grace + attention, không pause.

### 5.3 Session manager

```ts
class SessionManager {
  ensureConversation(task): Promise<LiveConversation>;   // create/resume theo task.conversationKey + persistence
  startTurn(taskId, input): Promise<{turnId}>;           // serialize, persist-first
  steer(taskId, input): Promise<...>;                    // capability-gated
  interruptTurn(taskId, turnId): Promise<...>;           // gọi session.interrupt() + chờ ownership
  cancelTask(taskId): Promise<...>;                      // interrupt + deny approvals + status
  handleEvent(taskId, event): void;                      // normalize → persist → publish
}
```

Ordering trên mỗi task:

```
user.message.created (persist, checkpoint)
turn.started          (persist, checkpoint)
... events (buffered; persist theo checkpoint §5.6)
terminal              (persist, checkpoint)
```

`interruptTurn` phải chờ adapter resolve **và** emit `turn.cancelled|unknown`; timeout `turn.interrupt_timeout` → task `paused`, turn `unknown` (không đoán đã dừng).

### 5.4 Event log & replay

- **Durable seq** đơn điệu trong từng stream; task stream theo `taskId`, gateway stream toàn cục. Ephemeral delta **không** có seq, **không** nằm trong event log (§4.1).
- Event log chỉ chứa durable event → replay luôn liền mạch, không gap.
- Retention/compaction (§5.5) có thể bỏ dữ liệu cũ, nhưng **luôn** đủ để dựng `TaskSnapshot`: user messages, assistant final, tool summary+outcome, permission history, turn lifecycle.
- `task.sync`: replay durable từ `fromSeq` (tối đa `maxEvents`, default 500); nếu `fromSeq` đã prune → `{mode:"snapshot"}`.
- Rebuild UI: `TaskSnapshot` là bản đủ; nếu client còn `lastSeq` hợp lệ thì replay durable tiếp từ đó (delta không cần replay).
- Kiểm tra: với mọi `task.sync` trả `replay`, `events[0].seq === fromSeq + 1` và `events[i+1].seq === events[i].seq + 1`.

### 5.5 Retention, archive, compaction (minor)

| Dữ liệu | Giữ | Ghi chú |
|---|---|---|
| **User messages** | tới `retentionDays` — **không bao giờ prune trong khi task còn** | Bắt buộc cho `TaskSnapshot` (§4.6) |
| **Assistant final messages** | như trên | idem |
| **Tool summary + outcome + permission history** | như trên | idem |
| Milestone events | tới `retentionDays` (default 14) | không prune khi task active |
| (**Không có** delta retention) | — | Delta là ephemeral, **không persist**; chỉ buffer trong RAM, mất khi turn xong (§4.1, §4.6) |
| Milestone pruning | `maxEventsPerTask` (default 20000) | chỉ prune event **đã compact vào snapshot**; luôn giữ user/assistant/tool/permission (§4.6 quy tắc) |
| Approvals | tới khi task terminal + 7 ngày | pending không bao giờ prune |
| Artifacts (screenshot/file) | **không xoá khi task còn `active`/`paused`/resumable**; TTL 7 ngày **chỉ tính từ khi task terminal** hoặc artifact được release | xoá file vật lý, event giữ `artifact_ref`; nếu buộc xoá vì quota → đánh dấu `missing:true` + task `non_resumable_context` |
| Full DOM snapshot | **không** lưu | chỉ metadata + extract bounded |
| Raw reasoning | **không** lưu mặc định | chỉ `reasoning.summary` nếu provider cung cấp summary; flag `storeReasoning=false` default |

Archive: khi task terminal quá retention → `tasks.archived=1` + `events` compact về milestone + 1 `task.snapshot` checkpoint; export/import JSON tùy chọn.

### 5.6 Durability window & crash recovery (B4)

**Phạm vi cam kết:** số liệu dưới đây là **max loss khi process crash** (Gateway bị kill). Với power loss/OS crash, cam kết phụ thuộc `PRAGMA synchronous` (§7.2): `FULL` → giữ cam kết; `NORMAL` → transaction vừa commit có thể mất. Không được tuyên bố “0” vô điều kiện.

| Thời điểm | Durable? | Max loss khi **process** crash |
|---|---|---|
| `user.message.created` | **trước** khi gửi provider | 0 (không mất prompt) |
| `turn.started` | trước khi gửi provider | 0 |
| `assistant.delta` | **không persist** (ephemeral) | mất toàn bộ delta của turn đang chạy; KHÔNG ảnh hưởng durable seq |
| `assistant.message` | trước terminal của turn | 0 khi turn đã terminal; nếu crash **giữa** turn → turn `unknown`, UI biết text có thể thiếu |
| `tool.started` | **trước** khi dispatch tool | 0 |
| `tool.completed` | sau khi host trả kết quả | tool đang chạy khi crash → **`unknown`** khi restart (không giả vờ failed/succeeded) |
| `permission.requested` | trước khi UI | 0 |
| `permission.resolved` | sau quyết định | nếu crash giữa → giữ `pending` khi restart, user quyết lại (không tự deny) |
| terminal turn | checkpoint (cùng transaction với task last_seq) | 0 |

Restart recovery:

```
for each turn status=running:
   emit tool.completed{outcome:"unknown"} cho mọi tool.started chưa completed
   emit turn.unknown{reason:"gateway_restart"}
   task → paused (chỉ Gateway restart; SW sleep không vào nhánh này — §5.2.1)
for each turn status='queued':
   GIỮ queued; task → paused(pause_reason='gateway_restart')
   KHÔNG tự chạy khi resume. UI hiện "queue có N prompt chờ" + nút [Tiếp tục queue] / [Huỷ]
   → chỉ khi user chọn Tiếp tục mới start turn (side effect chưa xảy ra vì chưa gọi provider)
for each approval pending:
   giữ pending; UI hiện lại; user quyết
```

**Không replay side effect.** Tool `unknown` không được tự chạy lại; UI/agent phải quan sát (snapshot) trước.

### 5.7 Permission lifecycle: provider vs browser tool (minor)

| Loại | Ai tạo | Ai resolve | Khi provider mất kết nối |
|---|---|---|---|
| `provider_permission` (agent hỏi quyền dùng tool nội bộ) | adapter | user → `permission.respond` → adapter | resolve `deny` (reason `provider_unavailable`) |
| `browser_action` approval (Gateway policy) | Gateway | user → `permission.respond` → Gateway | **giữ** pending; task pause; resolve khi task resume hoặc user deny |
| `data_entry_sensitive` | Gateway | user | idem |

Approval idempotent: respond 2 lần → `approval.already_decided`.

### 5.8 Config

```jsonc
{
  "version": 1,
  "gateway": {
    "ipc": { "transport": "auto" },          // auto|pipe|tcp|unix  (auto => platform default + spike)
    "autoStart": true,
    "idleExitMs": 0,                          // 0 = không tự thoát
    "startupTimeoutMs": 15000,
    "reconnectGraceMs": 15000,
    "deltaFlushMs": 750,
    "maxEnvelopeBytes": 786432,   // 768 KiB; hard cap 1048576 (NM transport) — validate
  },
  "providers": {
    "codex":  { "enabled": true, "command": null, "env": {}, "models": null, "additionalModels": null, "defaultModel": null },
    "claude": { "enabled": false, "command": null, "env": {}, "models": null, "additionalModels": null, "defaultModel": null }
  },
  "browser": {
    "defaultBackend": "auto",
    "allowedBackends": ["chrome-extension", "playwright-isolated"],
    "playwright": { "enabledByUser": false },
    "defaultTabScope": "active",
    "snapshot": { "maxElements": 80, "maxTextChars": 12000 },
    "policy": { "allowEvaluate": false, "allowUpload": false, "requireApprovalForDataEntryOnAutosave": true }
  },
  "tasks": { "queueWhileRunning": true, "retentionDays": 14, "maxEventsPerTask": 20000 },
  "storeReasoning": false
}
```

---

## 6. Browser runtime

### 6.1 Host registry & identity (B3/M4)

```ts
interface BrowserHost {
  connectionId: string;
  profileId: string;                  // stable trong vòng đời installation (§3.2), KHÔNG durable vĩnh viễn
  clientId: string;                   // như profileId
  hostInstanceId: string;             // per process
  browserInstanceId: string | null;   // per Chrome run — affinity key (§3.2); null ⇒ degraded
  identityConfidence: HostIdentityConfidence;  // 'known' | 'degraded' (§3.2)
  backendId: "chrome-extension";      // extension host
  supportedTools: BrowserToolName[];
  capabilities: BrowserBackendCapabilities;
  connectedAt: number;
  tabs: Map<number, TabMeta>;         // populated lazily (§6.1.1)
}
```

Affinity (hai chế độ — không trộn):
- **known**: `Map<`${profileId}:${browserInstanceId}:${backendId}:${tabId}`, hostInstanceId>` — sống tới khi Chrome run kết thúc.
- **degraded** (`browserInstanceId === null`): `Map<connectionId, Map<tabId, hostInstanceId>>` — chỉ sống theo connection, **không persist**, không dùng chuỗi giả làm identity.

`hostInstanceId` chỉ là “ai đang giữ tab *bây giờ*”, không phải identity của tab.

Khi host disconnect:

- pending request thuộc connection đó: nếu **chưa gửi** → `browser.no_host{sideEffectState:"none",retryable:true}`; nếu **đã gửi** → `browser.host_lost_after_dispatch{sideEffectState:"unknown",retryable:false}`.
- affinity key = **`profileId:browserInstanceId:backendId:tabId`** → `hostInstanceId` (sửa P0-1). Affinity **không** invalidate khi chỉ `hostInstanceId`/`connectionId` đổi. Tab `stranded` cho tới khi host mới của **cùng `browserInstanceId`** reconnect; `browserInstanceId` **khác** (Chrome restart) → `stale`.
- `browserInstanceId` do extension cung cấp trong `host.register` (§3.2); **`null` nếu degraded**. Degraded → binding = `needs_confirmation`, **không** `stale`, **không** dùng `hostInstanceId` thay affinity.

#### 6.1.1 Privacy-first registration (M5)

- `browser.host.register` gửi **chỉ**: `profileId`, `clientId`, `hostInstanceId`, `browserInstanceId` (**nullable**), **`identityConfidence`** (`known`\|`degraded`), `backendId`, `capabilities`, `supportedTools`, `extensionVersion`. **Không** gửi `bindingState` (binding là của task, Gateway tính).
- **Không** gửi danh sách tab/URL/title khi register.
- `browser.tabs.list` gọi khi task cần; trả tab thuộc **profile hiện tại** + theo `page-access` permission hiện có; loại browser internal pages (`chrome://`, `chrome-extension://`, `edge://`, `about:`) → `listable:false` hoặc bỏ.
- Không lưu danh sách tab vào event log; chỉ lưu tab đã dùng (id + origin rút gọn) trong `task.runtime` nếu cần.
- `TabMeta` trả về: `{tabId, url (redacted query nếu policy), origin, title (optional), active, windowId?}`; **URL đầy đủ** chỉ khi tool cần (navigate/verify) và trong scope.
- iframe: manifest hiện `all_frames:false` → capability **`iframe:"none"`** trong MVP. `same-origin` chỉ được tuyên bố sau khi có implementation (DOM traversal hoặc inject theo frameId) + test thật. `framePath` trong `BrowserElement` là **mô hình dữ liệu**, chưa phải implementation.

### 6.2 Snapshot & fingerprint — tách 2 loại (sửa P1-9)

| Loại | Dùng cho | Bao gồm form value? |
|---|---|---|
| `structuralFingerprint` | Quyết định **element ref còn hợp lệ hay không** | **Không** |
| `stateFingerprint` | Quyết định **trang đã thay đổi / verify** | **Có**, dạng hash, loại trừ password |

```ts
interface StructuralInputs {
  version: 1;
  elementCount: number; interactiveCount: number;
  elements: Array<{ role: string; name?: string; tag: string; type?: string; boundsBucket: [number,number,number,number] }>;
  framePathSignature?: string;
}
interface StateInputs {
  version: 1;
  structural: string;                 // hash của structural
  urlOriginPath: string;              // bỏ query nhạy cảm
  readyState: string; scrollBucket: [number, number];
  /** hash từng field, KHÔNG plaintext; password/payment luôn loại trừ (giá trị "[redacted]") */
  fieldValueHashes: Array<{ ref: string; valueHash: string; sensitive: boolean }>;
  checkedRoles?: Array<{ ref: string; checked: boolean }>;
}
```

- `structuralFingerprint = "sfp1:" + sha256(canonical(StructuralInputs))` — đổi khi element thêm/xoá/đổi nhãn/vị trí đáng kể. **Không** đổi khi user gõ text → refs **không** stale vì lý do gõ chữ.
- `stateFingerprint = "tfp1:" + sha256(canonical(StateInputs))` — đổi khi value/checked/scroll/URL đổi; dùng cho verify (§6.3).

**Salt của field hash (sửa v4.1 — phải ổn định giữa các snapshot để so sánh được):**

| Thuộc tính | Quy định |
|---|---|
| Nguồn salt | `HMAC key` sinh 1 lần cho **mỗi cài đặt extension** (lưu cùng `storage.local`, cùng chỗ `profileId`), **không** theo snapshot, **không** theo tab |
| Vòng đời | Ổn định tới khi extension storage bị xoá (reinstall/reset) → salt mới, fingerprint cũ **không so sánh được** (chấp nhận: so sánh chỉ trong 1 lần cài) |
| Phạm vi | Chỉ dùng nội bộ cho fingerprint/verify; **không** gửi ra ngoài; **không** persist giá trị field |
| Thuật toán | `valueHash = base64url(HMAC-SHA256(salt, canonical({tabOrigin, ref, value})))`, cắt 16 byte |
| Password/PII | Luôn `"[redacted]"`, **không** HMAC; không đóng góp vào `stateFingerprint` |

- Nếu salt phải đổi (reinstall) → `stateFingerprint` cũ vô hiệu; Gateway **không** so sánh cross-install; snapshot cũ bị bỏ.
- `snapshotId = "snap:" + ulid`, metadata TTL 5 phút, LRU 32/task; lưu `structuralFingerprint` + `stateFingerprint` + `saltEpoch` + timestamp.

**`fieldIdentity` (sửa P1.9):** để `fieldValueHashes` so sánh được giữa 2 snapshot, mỗi field cần identity ổn định:
`fieldIdentity = sha256(structuralPath | role | name | type | formIndex)` — **không** phụ thuộc giá trị. Nếu không xác định được identity duy nhất (DOM đổi cấu trúc) → không so sánh field đó, trả `verified:"unknown"`.

**Salt storage & rotation:**
- Salt lưu `chrome.storage.local`, set access level **TRUSTED_CONTEXTS** nếu API hỗ trợ (`chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"})`) để content script không đọc trực tiếp.
- `saltEpoch` tăng khi salt đổi (reinstall/xoá storage). Không rotate định kỳ trong MVP; nếu rotate, **phải** coi mọi `stateFingerprint` cũ là không so sánh được.
- Không persist plaintext field value ở bất kỳ đâu (kể cả snapshot/event).
- Stale ref khi: `structuralFingerprint` khác, tab đóng, navigation, hoặc snapshotId quá TTL. **Không** stale chỉ vì `stateFingerprint` đổi.
- Verify dùng `stateFingerprint` + evidence riêng (không dùng structural để suy ra thành công). So sánh `stateFingerprint` chỉ khi **cùng `saltEpoch`**; khác epoch → `verified:"unknown"`.

### 6.3 Verification: observation vs semantic success (minor)

Hai tầng, không gộp:

| Tầng | Trả về | Ý nghĩa |
|---|---|---|
| **Observation** | `evidence: { urlChanged?, fingerprintChanged?, valueReflected?, scrollDelta? }` | chỉ “trang đã thay đổi như kỳ vọng quan sát được” |
| **Semantic success** | `verified: true | false | "unknown"` | suy luận từ observation + action type |

- `verified:true` **chỉ** khi có bằng chứng khớp loại action (navigate → URL đổi; type/fill → value reflected; scroll → delta).
- Click: `verified` chỉ `true` nếu có **targeted** evidence (element biến mất/aria-expanded đổi/URL đổi/known side-effect region xuất hiện); fingerprint đổi **không đủ** → `"unknown"`.
- `verified:false` khi evidence **mâu thuẫn** (vd value không đổi).
- **Không** retry mutating action dựa trên `unknown`.

### 6.4 Extension backend

Split `content/index.ts` (giữ hành vi; có regression test trước khi split):

```
content/snapshot.ts     collectBrowserDomSnapshot (+ config cap, fingerprint, roles/name)
content/actions.ts      DOM executor (click/focus/fill/select/submit/scroll/highlight)
content/refs.ts         ref ↔ element, resolve + ambiguity
content/verify.ts       observation sau action
content/transport.ts    message types
background/browser-runtime/{host-register,tool-dispatcher,tab-scope,approvals,screenshot}.ts
```

Giữ nguyên đường cũ (`browser.action.plan`) trong compat mode.

### 6.5 Playwright: 4 vai trò tách biệt (M3)

| Thành phần | File | Vai trò | Dependency |
|---|---|---|---|
| `PlaywrightRuntimeManager` | `bridge/src/playwright-runtime.ts` (giữ) | detect/cài Chromium | `playwright-core` (runtime) |
| `PlaywrightIsolatedBackend` | **mới** `bridge/src/browser/backends/playwright/` | thực thi tool trên context riêng | `playwright-core` (runtime) |
| Dev/test driver | `scripts/lib/playwright-driver.mjs` (mới, nếu cần) | smoke/asset test | root `devDependencies` |
| Gateway runtime dep | `bridge/package.json` | cần cho backend isolated khi bật | **giữ `dependencies`** (không chuyển sang dev) |

- **Không** chuyển `playwright-core` sang devDependencies (v2 sai ở điểm này) trừ khi quyết định bỏ backend isolated.
- Backend isolated có thể **lazy-load** `playwright-core` chỉ khi bật → nếu không cài, `browser.backend_unavailable`.
- **Spike trước khi chốt API:** xác minh `page.accessibility.snapshot()` tồn tại/ổn định theo version pin (`^1.59.1`), hoặc dùng DOM walker fallback. Ghi ADR kết quả.
- Capabilities: `existingUserTabs:false, existingUserSession:false, isolatedProfile:true`, `iframe: "all"` **PROVISIONAL(spike-B4)** — chỉ tuyên bố sau khi có test frame thật (same-origin + cross-origin).
- `filePicker` ≠ `setInputFiles`: backend Playwright **có thể** `setInputFiles` (upload theo path) nhưng **không** mở được native file picker của user. Capability phải phản ánh đúng từng cái.
- Không dùng backend này để “mượn” session user. `playwright-cdp` = research backlog, ADR riêng, `attachToRunningChrome=true` chỉ khi chứng minh được.

### 6.6 Backend selection — intent sources (M6)

Thứ tự quyền (cao → thấp):

1. **User instruction** trong turn (“dùng tab đang đăng nhập”, “mở browser riêng”) → pin cứng.
2. **Task creation options** do UI xác nhận (`backend: "chrome-extension" | "playwright-isolated" | "auto"`).
3. **Config** (`browser.defaultBackend`, `allowedBackends`).
4. **Availability** + task intent classifier (tất định, không phải model).

- Model **không** có API đổi backend. Nếu model gọi tool cần tab thật mà pin = isolated → `browser.backend_mismatch`; nếu cần isolated mà pin = extension → idem.
- `auto` resolve **một lần** ở `task.create` và ghi `BackendBinding.pinnedBy`. Đổi giữa task chỉ qua `task.setBackend` (user action, ghi audit).
- Nếu pin = `chrome-extension` và backend không available → **fail** (`browser.backend_unavailable`), không fallback.

### 6.7 Permission enforcement điểm

```
tool call → validate schema/token/scope
          → build ActionContext (url/origin/target/dataEgress)
          → classify risk
          → nếu cần approval: persist approval + event permission.requested → chờ (task attention)
          → dispatch tới host
          → host trả result + observation
          → verify (semantic) → tool.completed
```

`ActionContext` được log (redacted) để audit; approval `actionDigest` chống replay.

### 6.8 Capability caveats (không giả tưởng đồng nhất)

- **Browser chrome** (thanh địa chỉ, menu, DevTools): không hỗ trợ.
- **Native dialogs** (alert/confirm/prompt tuỳ site, file picker): `browser.gesture_required` hoặc `unsupported_command`.
- **Trusted gestures**: synthetic click không đáp ứng mọi site (file upload, một số login flow) → yêu cầu user.
- **Iframe**: MVP capability = **`none`** — `all_frames:false` nghĩa là content script không inject vào frame nào; không thấy/không click được nội dung trong **mọi** iframe (kể cả same-origin). `same-origin` chỉ bật sau implementation + test (P2+).
- **Canvas/WebGL/custom widgets**: snapshot có thể thiếu; cần screenshot + user/vision (không tự đoán).
- **Cross-profile**: không hỗ trợ trong một task (B3).
- **File download/upload**: file picker cần user; download path do Chrome quản lý, không can thiệp.

---

## 7. Persistence

### 7.1 Bốn lớp persistence + trục task/turn (bổ sung theo review)

| Lớp | Sống khi | Chết khi | Lưu |
|---|---|---|---|
| L1 UI (panel) | side panel mở | panel đóng | không (state UI) |
| L1b SW (background) | SW alive — **được giữ sống bởi native port đang mở** (§1.5) | port đóng + Chrome terminate | không |
| L1c Native Messaging connection | port mở | host exit/crash, extension reload/update/disable, Chrome quit | không |
| L2 Gateway process | process còn | crash/exit/máy tắt | lock + endpoint |
| L3 Provider runtime | adapter process còn | idle/crash/restart | provider-owned |
| L4 Conversation resumability | có handle resumable | handle invalid | `conversations.persistence` |
| **L5 Task/Turn state** (trục độc lập) | trên disk | retention/archive | `tasks`, `turns`, `events` |

L5 không phụ thuộc L2/L3/L4: task `paused` vẫn hiển thị sau restart kể cả khi conversation `stale`.

### 7.2 Schema (v4.1 — sửa P0-3 + review R1/R10–R12)

**Durability level (chốt — sửa v4.1):**

- `PRAGMA synchronous` là thuộc tính **của connection/database**, **không** bật riêng được cho từng bảng.
- `journal_mode = WAL` luôn (persistent per database).
- **Mặc định `synchronous = FULL`** cho toàn database (đáp ứng cam kết “process crash = 0 loss” **và** power-loss loss tối thiểu).
- Alternative nếu B7 đo FULL không chấp nhận được: `synchronous = NORMAL` **toàn database** + thu hẹp cam kết: “max loss = 0 **chỉ với process crash**; power loss/OS crash có thể mất transaction vừa commit”.
- Có thể dùng connection **riêng** với `synchronous=FULL` cho luồng ghi recovery-critical và connection `NORMAL` cho bulk (ví dụ retention prune) — nhưng đây là tối ưu **chưa cần ở MVP**, ghi rõ nếu làm.
- §5.6 phải đổi theo lựa chọn trên (không tuyên bố “0” vô điều kiện khi NORMAL).

**Primary key:** không dùng biểu thức trong PRIMARY KEY. Dùng **sentinel `''`** cho gateway stream.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Cardinality (chốt): task 1—1 conversation hiện tại. Lịch sử conversation (nếu có) giữ `task_id`
-- và đánh dấu `state='closed'`, nhưng chỉ MỘT row có `is_current=1` mỗi task.
CREATE TABLE IF NOT EXISTS conversations (
  conversation_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
  provider_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('opening','open','closed','stale')),
  persistence_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversations_task ON conversations(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_one_current
  ON conversations(task_id) WHERE is_current = 1;
-- Thứ tự tạo trong MỘT transaction: INSERT tasks -> INSERT conversations(is_current=1)
-- (conversations.task_id có FK tới tasks; tasks.conversation_key KHÔNG có FK nên không cycle).
-- INTEGRITY CHECK bắt buộc ở startup (và test):
--   SELECT COUNT(*) FROM tasks t LEFT JOIN conversations c
--     ON c.conversation_key = t.conversation_key AND c.task_id = t.task_id AND c.is_current = 1
--   WHERE c.conversation_key IS NULL;   -- phải = 0
--   SELECT COUNT(*) FROM tasks t JOIN conversations c ON c.task_id=t.task_id
--   WHERE (SELECT COUNT(*) FROM conversations c2 WHERE c2.task_id=t.task_id AND c2.is_current=1) <> 1; -- phải = 0

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','active','paused','completed','failed','cancelled')),
  -- attention KHÔNG lưu (derived projection, §4.7)
  pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN
    ('user_requested','gateway_restart','browser_unavailable','provider_unavailable')),
  title TEXT,
  profile_id TEXT NOT NULL,
  origin_browser_instance_id TEXT,     -- identity lúc tạo task; BẤT BIẾN (P1.5)
  binding_json TEXT NOT NULL,          -- {browserInstanceId, connectionId, state} runtime
  provider_id TEXT NOT NULL,
  conversation_key TEXT NOT NULL,          -- trỏ tới conversations(conversation_key) có is_current=1
                                           -- KHÔNG dùng FK (cycle tasks<->conversations); enforce bằng
                                           -- invariant + idx_conversations_one_current
  cwd TEXT NOT NULL,
  model TEXT, mode_id TEXT, thinking_option_id TEXT,
  provider_options_json TEXT,
  backend_json TEXT NOT NULL,
  tab_intent_json TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  -- table constraints PHẢI sau mọi column (SQLite)
  CHECK ((status = 'paused') = (pause_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_tasks_profile_status ON tasks(profile_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','unknown')),
  client_message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  queued_at INTEGER,
  started_at INTEGER,                 -- NULL khi status='queued' (sửa P0.7)
  ended_at INTEGER,
  stop_reason TEXT, error_json TEXT,
  -- Invariant ở DB, không chỉ application:
  CHECK (
    (status = 'queued'  AND started_at IS NULL AND ended_at IS NULL AND queued_at IS NOT NULL) OR
    (status = 'running' AND started_at IS NOT NULL AND ended_at IS NULL AND queued_at IS NOT NULL) OR
    -- terminal sau khi đã chạy
    (status IN ('completed','failed','cancelled','unknown')
       AND started_at IS NOT NULL AND ended_at IS NOT NULL) OR
    -- terminal TRƯỚC khi chạy (cancel/không bắt đầu được): queued_at có, started_at NULL
    (status IN ('cancelled','failed') AND started_at IS NULL AND ended_at IS NOT NULL AND queued_at IS NOT NULL)
  ),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
  UNIQUE (task_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS idx_turns_task ON turns(task_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_one_running
  ON turns(task_id) WHERE status = 'running';      -- 1 foreground turn/task

CREATE TABLE IF NOT EXISTS events (
  stream TEXT NOT NULL CHECK (stream IN ('task','gateway')),
  task_id TEXT NOT NULL DEFAULT '',   -- '' = gateway stream (sentinel, không NULL)
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  turn_id TEXT,
  payload_json TEXT NOT NULL,
  milestone INTEGER NOT NULL DEFAULT 0,
  redacted INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (stream, task_id, seq),
  CHECK ((stream = 'gateway' AND task_id = '') OR (stream = 'task' AND task_id <> ''))
  -- KHÔNG có FOREIGN KEY(task_id): gateway stream dùng '' (xem giải thích dưới)
);
CREATE INDEX IF NOT EXISTS idx_events_task_seq ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_turn ON events(turn_id);
CREATE INDEX IF NOT EXISTS idx_events_gateway_seq ON events(seq) WHERE stream = 'gateway';

-- Con trỏ bền cho gateway stream (và các singleton state khác)
CREATE TABLE IF NOT EXISTS gateway_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- key = 'gateway.last_seq' => seq lớn nhất đã cấp cho gateway stream
-- SEED bắt buộc trong migration (P1.9):
--   INSERT INTO gateway_state(key, value, updated_at) VALUES ('gateway.last_seq','0',<ts>)
--       ON CONFLICT(key) DO NOTHING;
-- Cấp seq (trong BEGIN IMMEDIATE): next = COALESCE(last_seq,0)+1; insert; update gateway_state
-- KHÔNG dùng MAX(events.seq) cho gateway stream (cùng lý do prune).

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL, turn_id TEXT,
  request_json TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','allowed','denied','expired')),
  decision_json TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(task_id, status);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL,
  mime TEXT, bytes INTEGER, created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

CREATE TABLE IF NOT EXISTS provider_state (
  provider_id TEXT PRIMARY KEY,
  catalog_json TEXT, fetched_at INTEGER,
  auth_state_json TEXT
);
```

**FK với sentinel (đã sửa ở DDL, v4.1):** `events` **không** có `FOREIGN KEY(task_id)` trong khối SQL ở trên — đây là bản DDL duy nhất, không có “cách thay thế nào khác”. Lý do: gateway stream dùng `task_id=''`, sẽ luôn vi phạm FK. Thay vào đó:

- `CHECK ((stream='gateway' AND task_id='') OR (stream='task' AND task_id<>''))` — đã có trong DDL.
- Cascade khi xoá task: xoá tường minh `DELETE FROM events WHERE task_id=? AND stream='task'` **trong cùng transaction** với xoá `tasks` row (không dựa vào FK cascade).
- Kiểm tra ở startup: `SELECT COUNT(*) FROM events e LEFT JOIN tasks t ON t.task_id=e.task_id WHERE e.stream='task' AND t.task_id IS NULL` phải = 0; nếu khác → log + repair/alert, không silent.

**Transaction boundary (bắt buộc — hai loại, tách rõ):**

**Connection setup — mọi connection (sửa P1.7a):**

```ts
// factory DUY NHẤT cho mọi connection (không mở sqlite3 trực tiếp ở nơi khác)
function openDb(path) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");   // per-connection/database, không per-table
  db.pragma("foreign_keys = ON");    // per-connection — phải set lại mỗi connection
  db.pragma("busy_timeout = 5000");
  return db;
}
```

**Sequence allocation (bắt buộc):** seq lấy **trong** transaction, dưới `BEGIN IMMEDIATE`:

- task: lấy `tasks.last_seq` của task đó **trong** `BEGIN IMMEDIATE`; seq mới = `last_seq + 1`. **KHÔNG** dùng `MAX(seq)` để cấp số (sau prune, `MAX(seq) < last_seq` → seq lùi).
  ```sql
  SELECT last_seq FROM tasks WHERE task_id = :taskId;   -- trong BEGIN IMMEDIATE
  -- next = last_seq + 1; insert event; UPDATE tasks SET last_seq = next
  ```
  `MAX(seq)` chỉ dùng cho **integrity audit**: `MAX(seq) <= tasks.last_seq` phải luôn đúng; vi phạm → báo lỗi, không tự sửa.
- gateway: `FROM gateway_state('gateway.last_seq')` (+1)

Không cấp seq ngoài transaction (race).

**Transaction templates (SQL thật):**

```sql
-- (1) Task stream: event + task.last_seq (+ turn nếu lifecycle)
BEGIN IMMEDIATE;
  INSERT INTO events (stream, task_id, seq, ts, type, turn_id, payload_json, milestone)
  VALUES ('task', :taskId, :seq, :ts, :type, :turnId, :payload, :milestone);
  UPDATE tasks SET last_seq = :seq, updated_at = :ts WHERE task_id = :taskId;
  -- nếu là turn lifecycle: UPSERT (KHÔNG INSERT OR REPLACE)
  INSERT INTO turns (turn_id, task_id, status, client_message_id, created_at, queued_at, started_at, ended_at, stop_reason, error_json)
  VALUES (:turnId, :taskId, :status, :clientMessageId, :createdAt, :queuedAt, :startedAt, :endedAt, :stopReason, :errorJson)
  ON CONFLICT(turn_id) DO UPDATE SET
    status = excluded.status,
    queued_at = COALESCE(turns.queued_at, excluded.queued_at),
    started_at = excluded.started_at,
    ended_at = excluded.ended_at, stop_reason = excluded.stop_reason, error_json = excluded.error_json;
COMMIT;

-- (2) Gateway stream: event + con trỏ bền
BEGIN IMMEDIATE;
  INSERT INTO events (stream, task_id, seq, ts, type, payload_json, milestone)
  VALUES ('gateway', '', :seq, :ts, :type, :payload, :milestone);
  INSERT INTO gateway_state (key, value, updated_at) VALUES ('gateway.last_seq', :seq, :ts)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
COMMIT;
```

**Không dùng `INSERT OR REPLACE`** cho turn lifecycle (REPLACE xoá+chèn → mất row identity/cascade side-effect); dùng `ON CONFLICT DO UPDATE`.

Không có trạng thái “event có nhưng row task/gateway_state chưa cập nhật” (hoặc ngược lại). Gateway stream **không** đụng `tasks`.

**Delete policy:**

- Không hard-delete task đang `active/paused`/có approval `pending`.
- Hard-delete chỉ qua `task.purge` (explicit) hoặc retention; khi đó xoá cascade (`tasks → turns/events/approvals/artifacts`) + xoá file artifact (best-effort, log nếu fail).
- `archived=1` = compact, **không** xoá user messages (§4.6 quy tắc prune).

**Migration tests:**

- **Schema version độc lập với document version.** Đặt hằng `SCHEMA_VERSION = 1` cho bản DDL ở §7.2 (v4.2). Document version (v4.2) và schema version **không** dùng chung số.
- Migration test: dựng DB bằng DDL cũ đã công bố (nếu có) hoặc bằng `SCHEMA_VERSION=0` fixture → chạy migration → assert dữ liệu giữ nguyên, PK/CHECK hợp lệ.
- `schema_migrations` idempotent: chạy 2 lần không lỗi.
- Startup với DB corrupt → backup `.corrupt-<ts>` + tạo DB mới + báo lỗi typed (không silent).

### 7.3 Recovery test cases (bắt buộc — sửa P1-6)

| # | Kịch bản | Expected |
|---|---|---|
| 1 | **Forced SW termination** trong lúc turn running (Chrome + tab còn); port đóng | task **vẫn `active`**; turn `running`; reconnect replay đủ; **không** mất prompt; affinity giữ (cùng `browserInstanceId`) |
| 1b | SW restart → `hostInstanceId` mới, cùng `browserInstanceId` | task không đổi; browser tool vẫn dispatch được |
| 1c | **Extension reload/update** (Chrome còn), identity không xác định | `needs_confirmation`; **không** `stale`; tool trả `browser.confirmation_required` |
| 1d | Native host crash (port đóng, Chrome còn) | task `active`; attention `browser_offline` sau grace; **không** mất turn |
| 2 | Gateway kill -9 khi browser tool đang chạy | tool → `unknown`, turn → `unknown`, task `paused`; **không** replay action |
| 3 | Gateway kill khi approval pending | approval giữ `pending`; UI hiện lại; respond được |
| 4 | Chrome quit/open lại (`browserInstanceId` mới) | `browser.stale_binding`; task `paused`; UI chọn tab lại; **không** tự dùng active tab mới |
| 4b | Chrome restart, `TabIntent=active_resolved`, 2 tab cùng origin+path | **không** tự chọn; `browser.ambiguous_target`; hỏi user |
| 5 | Hai profile: task ở A, UI mở ở B | xem được task; browser tool → `browser.wrong_profile`; “adopt” tạo task mới |
| 6 | Event prune rồi reconnect | `task.sync` → `snapshot`; snapshot có **đầy đủ user messages + assistant messages**; UI render được |
| 7 | Provider crash | task paused; persistence còn → resume; không → hỏi new conversation |
| 8 | User gửi prompt thứ 2 khi turn 1 running | config: queue (mặc định) → row `turns.status='queued'`, `started_at NULL`, có `user.message.created`; chỉ khi turn 1 terminal mới `turn.started`; hoặc `task.busy` |
| 8b | `task.cancel` khi turn 2 đang queued | turn 2 → `cancelled`, `started_at NULL`, `ended_at` set; DB CHECK cho phép |
| 9 | Delta bị drop (client chậm) rồi turn xong | durable seq **không gap**; `assistant.message` thay thế text; client không lỗi |
| 10 | Native host chết trước/sau spawn (bảng §3.3.2 #1/#2) | host kế tiếp reclaim startup lock; không spawn trùng Gateway |
| 11 | Hai host cold start đồng thời | đúng một Gateway; host thua chỉ chờ, không spawn, không đụng `gateway.lock` |
| 12 | Owner **bị SIGSTOP** > 10s rồi tiếp tục | host khác **không** reclaim (OS lock vẫn giữ); trả `gateway.unresponsive` |
| 13 | Owner chết; host mới acquire OS lock | `fence` tăng; endpoint mới mang fence mới |
| 14 | Owner cũ resume sau khi đã bị reclaim | ghi state với `fence` cũ → **bị từ chối**, process tự shutdown |

---

## 8. Providers

### 8.1 Capability matrix (mục tiêu, phải test trước khi tuyên bố)

| Capability | Codex | Claude Code | OpenCode (P4) | ACP (P4) |
|---|---|---|---|---|
| streaming | ✅ | ✅ (spike) | ✅ | ✅ |
| reasoning summary | ✅/⚠️ | ✅ (thinking) | ⚠️ | ⚠️ |
| tool events | ✅ | ✅ | ✅ | ✅ |
| interrupt (ownership) | ✅ | ✅ (test) | ✅ | ⚠️ |
| steer | ✅ | ? (P3-00) | ✅ | ❌ |
| resume | ✅ (thread) | ✅ (session) | ✅ | ⚠️ |
| model/mode/thinking | ✅ | ✅ (một phần) | ⚠️ | ⚠️ |
| permission prompts | ✅ | ✅ | ✅ | ✅ |
| MCP tools | ✅ | ✅ | ✅ | ✅ |
| images input | ✅ | ✅ | ⚠️ | ⚠️ |
| slash commands | ✅ | ✅ | ✅ | ⚠️ |
| usage | ✅ | ✅ | ⚠️ | ❌ |

### 8.2 Codex adapter (wrap-first)

- `providers/codex/{provider,session,app-server-client,mappers}.ts`; `app-server-client` = tách từ `codex-app-server.ts`.
- `startTurn` → dùng `createCodexTurnInputItems` (`prompt.ts`); subscribe map notification → `AgentEvent`; `interrupt` → `turn/interrupt` + chờ terminal.
- **Persistence timing test (minor §8.2):** xác minh khi nào `thread/start` tạo rollout resumable; **không** trả `describePersistence()` trước mốc đó. Viết test với App Server thật (skip nếu không cài) + mock fixture.
- **Permission mapping:** Codex approval policy (`approvalPolicy`, `plan.user_input`) → `PermissionRequest`; `respondToPermission` trả `followUpPrompt` nếu có chain.
- **Feature RPC (minor §10):** `provider.feature.codex.compact`, `.goal.get/.set/.clear`, `.account.status`, `.mcp.list/.reload`, `.skills.list`… mỗi feature có **schema riêng** (Zod), capability-gated; **không** có `provider.feature.call(method, params)` tự do.

### 8.3 Claude Code — **spike sớm (Gate B)**, không chờ Browser Runtime (M2)

**P3-00 phải chạy ở Gate B**, song song PR-B (Codex wrap). Mục tiêu: chốt mechanism + version floor + auth trước khi viết adapter đầy đủ.

| Option | Điều kiện pass |
|---|---|
| A. Claude Agent SDK (Node) | Windows chạy; stream token-level; permission hook; resume; MCP tools; không phá auth hiện có |
| B. CLI `claude` structured output | như trên, version floor xác định; parse ổn định |
| C. ACP mode | chỉ nếu A/B fail |

Output của spike: ADR ghi mechanism, version floor, capabilities thực tế (điền §8.1), giới hạn (không steer? không rewind?), cách bind tools.

**Roadmap:** MVP ship Codex (Phase 1/2); Claude adapter hoàn thiện ở Phase 3 nhưng **spike/ADR ở Gate B**, và provider contract **phải** được validate với Claude trước khi tuyên bố Codex migration “xong” (tránh contract tối ưu cho Codex). Cụ thể: trước khi đóng Phase 1, có 1 test “contract conformance” chạy bằng Claude stub/fixture.

### 8.4 Registry & catalog cache

- Factories + overrides + derived profiles; **persistence giữ provider gốc** + `metadata.profileOf`.
- Catalog cache: single-flight, deadline 120s, TTL 10 phút, invalidate khi config đổi; **không** tạo session để discovery.
- Capability effective = static ∩ runtime (nếu adapter báo thiếu → UI ẩn).

---

## 9. MCP / tool transport

### 9.1 Tool token — signed (không phải opaque) + refresh (sửa P1-11)

```ts
/** SIGNED token: payload đọc được (base64url), chữ ký bảo vệ toàn vẹn.
 *  KHÔNG phải opaque token và KHÔNG mã hoá payload. */
type ToolTokenPayload = {
  v: 1;
  taskId: string;
  profileId: string;
  backendId: BrowserBackendId;
  allowedTools: string[];
  iat: number; exp: number;
  jti: string;          // token generation id (KHÔNG phải anti-replay; token là bearer credential)
};
// token = base64url(canonicalJson(payload)) + "." + base64url(hmacSha256(secret, canonicalJson(payload)))
```

- **Canonical serialization** trước khi ký: JSON với key sort theo codepoint, không khoảng trắng, số nguyên (không float), UTF-8 NFC. Có test vector cố định để hai implementation cho cùng chữ ký.
- **Chỉ** `payload + signature` được ký; không ký header/thời gian bên ngoài.
- Secret: Gateway sinh lúc start, lưu `dataDir/auth/tool-secret` (0600 / ACL user-only), **không** log; khác auth token file.
- **TTL: 15 phút** (không phải “min(task lifetime)”); task dài **không** mất quyền vì có refresh.
**Duplicate-execution protection:** token **không** chống replay và **không** phải anti-replay. Retry an toàn dựa trên `toolCallId` (unique trong task): Gateway từ chối chạy lại một `toolCallId` đã có outcome. Bearer token bị lộ vẫn tạo được request mới với ID mới — đây là giới hạn đã biết, không phải lỗi spec.

- **Refresh flow (quyết định duy nhất — Gateway chủ động):
  - **Gateway chủ động refresh** (quyết định duy nhất; **không** có MCP refresh tool cho model): trước khi hết hạn 2 phút, Gateway gửi `tool.token.refreshed` qua kênh điều khiển của session; adapter cập nhật config/token. Adapter không hỗ trợ hot-update → Gateway **drain** in-flight calls rồi restart MCP connection.
  - Refresh **giữ** `taskId/profileId/allowedTools`; **không** mở rộng scope; `jti` mới; token cũ hợp lệ trong **grace window 60s** (cho request đang bay) rồi từ chối.
  - Adapter hỗ trợ hot-update → nhận token mới. Adapter **không** hỗ trợ → Gateway **drain** tool calls đang bay (chờ terminal/timeout) rồi mới restart MCP connection. Không restart giữa tool call.
- TTL/clock skew: chấp nhận |skew| ≤ 60s; quá → `proto.auth_failed`.
- Truyền cho provider: ưu tiên MCP header hoặc config file tạm (0600). **Không** CLI args. Nếu buộc env → redact trong diagnostics và ghi rõ giới hạn.
- Validate: signature (canonical), `exp`, `taskId` khớp task đang gọi, `allowedTools` ⊇ tool, `profileId` khớp host của task, `backendId` khớp pin.

### 9.2 Tool flow

1. Adapter phát tool call → Gateway kiểm tra token, scope, backend pin, tab scope.
2. Gateway dựng `ActionContext` (§4.8) → classify risk → có thể phát `permission.requested` và chờ.
3. Gateway dispatch `browser.tool.request` tới host, timeout per-tool (default 15s).
4. Host thực thi + observation → `browser.tool.result`.
5. Gateway verify (§6.3) → phát `tool.completed{outcome, verified}`.
6. `task.cancel` / `turn.interrupt` → Gateway gửi `browser.tool.cancel`; tool đang chạy → outcome `unknown` nếu không xác nhận được đã dừng.

### 9.3 Endpoint

- MCP server (stdio) spawn per provider session **hoặc** HTTP streamable trên pipe; chọn 1 và ghi ADR khi implement. Ưu tiên stdio (đơn giản, không cần port).
- Tool name map: internal `browser.page.click` → MCP `browser_page_click` nếu client cần; giữ map một chiều + test.

---

## 10. Migration map (RPC → mới)

| Legacy | v3 | Ghi chú |
|---|---|---|
| `session.open` | `task.create` | tạo conversation + task |
| `session.resume` | `task.create{resumeFrom: taskId}` hoặc `task.resume` | |
| `prompt.send` | `task.send` → turn | |
| `turn.interrupt` | `turn.interrupt{taskId,turnId}` | |
| `turn.steer` | `task.steer` | capability |
| `thread.list/read/turns.list` | `task.list/get/snapshot` | compat shape |
| `thread.compact.start` | `provider.feature.codex.compact` | schema riêng |
| `model.list` | `provider.catalog` | |
| `account.*`, `goal.*`, `skills.*`, `apps/plugins/mcp.*` | `provider.feature.codex.*` | schema riêng per feature |
| `plan.user_input.respond` | `permission.respond` (+ `followUpPrompt`) | |
| `route.plan`, `browser.action.plan` | **retired** (tool loop); legacy flag off | |
| `image.*`, `voice.*`, `dictation.*`, `translation.*` | `provider.feature.codex.*` | không thuộc agent core |
| `runtime.config.read/update` | `config.read/update` | |
| `runtime.playwright.status/install` | `browser.backend.status/install{backend:"playwright-isolated"}` | **giữ** capability |
| `workspace.harness.read` | `config.read` + `provider.feature` | |
| `diagnostics.*`, `local.file.reveal`, `profile.*` | giữ | |

Compat rule: handler legacy trả **cùng shape**; mỗi cái có `// COMPAT(legacy-rpc): vX, remove after <date>`.

---

## 11. Extension background migration

- Module mới: `gateway-client.ts` (envelope + hello + token + reconnect), `task-controller.ts` (task state/replay/attention), `browser-runtime/*`, `compat/legacy-methods.ts`.
- Dual path `gatewayMode` (default off), rollback = tắt flag.
- Reconnect: `hello{lastSeqByTask}` → `task.sync` per task → emit; nếu `mode:"snapshot"` → rebuild.
- `profileId`/`clientId`: sinh khi extension cài, lưu `storage.local`; **stable trong vòng đời installation**, **mất** nếu uninstall/xoá storage/reset profile → sinh id mới. Không hứa “durable vĩnh viễn”; không nhận reinstall là cùng profile.
- `browserInstanceId`: lưu ở nơi **sống qua SW restart nhưng mất khi Chrome quit** (cơ chế chọn bởi spike §3.2). Gửi trong `hello` và `host.register`.
- SW keepalive: không dựa vào hack; chấp nhận SW sleep, replay khi thức. SW sleep **không** làm task/turn đổi state (§5.2.1).

---

## 12. Phased plan (gate-driven)

### Gate A — semantic sign-off (chốt được ngay, không phụ thuộc spike)

Đây là những phần **có thể ký trước** vì không phụ thuộc kết quả thực nghiệm.

A1. Task/Conversation/Turn + phân loại sự kiện (§3.7, §5.2, §5.2.1) — sign-off.
A2. Gateway two-lock ownership + **crash table đã sửa “ping fail ≠ chết”** + startup **recovery-trước-ready** (§3.3.1–§3.3.3, §5.1) — sign-off.
A3. Identity **shape**: 5 id, `browserInstanceId: string|null`, `BrowserBindingState` enum, install-lifetime wording (§3.2, §6.1, §6.1.1) — sign-off **shape**; *cơ chế lấy id* để Gate A-final (B6).
A4. Envelope/event/replay/ack (gồm ack stream + gateway sync) + durable vs ephemeral + `TaskSnapshot` đầy đủ (§4.1, §4.4, §4.6, §5.4, §5.6) — sign-off.
A5. Permission contextual + `agentEgress` + fail-closed (§4.8) — sign-off.
A6. Persistence **shape**: DDL chạy được (không FK trên events, có CHECK), transaction boundary 2 loại, migration/corrupt-DB test (§7.2) — sign-off shape; *mức durability* để Gate A-final (B7).

### Gate A-final / implementation gate — chốt sau spike

Chỉ khi các mục dưới xong mới được **khoá** các phần phụ thuộc và coi contract là “final”:

- **B6 `browserInstanceId` spike**: chứng minh sống qua **SW restart**, **extension reload/update**, **extension disable→enable**, và reset khi **Chrome quit**. Kết quả: `known` vs `degraded`, `hello.features.browserInstanceId`. Nếu chỉ chứng minh được SW restart → **degraded** cho mọi trường hợp khác (`needs_confirmation`).
- **B7 durability benchmark**: `synchronous=FULL` vs `NORMAL` → chốt cam kết loss và cập nhật §5.6/§7.2.
- **B5 IPC spike**: chọn pipe vs TCP+token; threat model §3.4.3 ký.

Cho tới Gate A-final, PR-A/PR-B được phép bắt đầu **với các contract đã sign-off ở Gate A**, nhưng mọi phần phụ thuộc B5/B6/B7 phải:
- được đánh dấu **`PROVISIONAL(spike-Bn)`** trong code + spec,
- **không** bị khoá bằng migration dữ liệu không hồi được,
- có feature flag / fallback (degraded mode) sẵn.

### Gate B — research contracts (chạy song song)

B1. `AgentSession` vs Paseo (§2.2) — interface + conformance skeleton.
B2. Codex mapping + permission lifecycle (§8.2) — fixture tests.
B3. Claude spike (P3-00) — ADR + capability fill.
B4. Playwright 4 roles + accessibility API verification (§6.5) — ADR.
B5/B6/B7 như trên (chặn Gate A-final, **không** chặn PR-A/PR-B).

### Gate C — implementation-ready

Chỉ ký khi đạt **10 tiêu chí**:

1. Mỗi ID có owner, lifecycle, persistence, reset conditions (§3.2).
2. Mỗi state machine có transition table + terminal semantics (§5.2, §5.2.1).
3. Mỗi RPC có request/response/error/permission/idempotency (§4.6, §4.7, §10).
4. Mỗi event có reliability, stream, sequence policy, persistence policy (§4.1, §4.4).
5. Mỗi persistent entity có schema, index, FK, migration, delete policy (§7.2).
6. Mọi crash point có expected recovery state (§3.3.2, §7.3).
7. **Không** error/enum/field/API nào được dùng trong prose mà thiếu trong contract (§4.2 registry).
8. **Không** cross-reference tới bản plan cũ mà không có nội dung trong tài liệu hiện hành (§4.3/§4.5/§9.2 đã inline).
9. Mỗi PR có file list, test list, acceptance, rollback (§13, §17).
10. Mọi capability tuyên bố đều có test **hoặc** đánh dấu `PROVISIONAL`.

C1. File-by-file change list (§13).
C2. Sequence diagrams: cold start, concurrent host, gateway crash, host loss, permission, crash recovery, cross-profile.
C3. Test cases: input → expected event sequence → expected DB rows.
C4. **Contract consistency check** (§4.11) chạy trước khi ký.

### Phase 0 (sau Gate A)
P0-01 plan/README; P0-02 contracts (type-only); P0-03 planner không chọn engine + legacy flag; P0-04 background caps backend-aware (giữ Playwright status); P0-05 backendId/snapshotId/taskId optional; P0-06 ADR docs.

**P0 exit:** không đổi hành vi user; planner không chọn engine; Playwright capability còn; regression test workflow cũ (minor §15).

### Phase 1 — Gateway + Codex
P1-01 Gateway skeleton **in-memory store** (chạy không cần SQLite) + lock/IPC/hello/auth.
P1-02 SQLite store + migrations + DAO (thay in-memory; feature flag `store=sqlite`).
P1-03 native host relay + auto-start/retry (gatewayMode off default).
P1-04 provider registry + catalog cache.
P1-05 Codex adapter wrap + event mapper + persistence timing test.
P1-06 SessionManager + Task/Turn state machines + turnId race.
P1-07 Router + compat (all legacy methods).
P1-08 background gateway-client + task-controller + replay.
P1-09 browser tool server + tool loop (Codex) + policy skeleton.
P1-10 persistence/replay UI sync.
**P1 exit:** Codex e2e; reconnect; tool loop; `gatewayMode=off` vẫn chạy.

### Phase 2 — Browser hardening
P2-01 snapshot/fingerprint/refs; P2-02 stale/ambiguity/verify; P2-03 multi-tab/scope; P2-04 permission engine + approval UI + audit; P2-05 screenshot/extract/wait/upload; P2-06 budget/cancel; P2-07 backend selector + playwright-isolated + UI badge; P2-08 diagnostics/metrics.

### Phase 3 — Claude
P3-00 spike (Gate B), P3-01 provider, P3-02 session, P3-03 tool binding, P3-04 UI, P3-05 steer/cancel conformance, P3-06 Windows e2e, P3-07 config parity.

### Phase 4 — ACP/OpenCode/workflows. Phase 5 — cleanup/security/release.

---

## 13. File-level change list (initial)

| PR | Files create | Files modify | Files keep |
|---|---|---|---|
| PR-0 | `docs/adr/{browser-instance,ipc-transport,durability,playwright-snapshot}.md`, `scripts/spike/*` | — | toàn bộ source |
| PR-A | `shared/src/{protocol,agent,browser,tasks}/*`, `docs/adr/*` | `bridge/agentic-router.ts` (prompt), `extension/background/index.ts` (caps) | tất cả còn lại (Playwright runtime/skill/UI/smoke) |
| PR-B | `bridge/src/agents/providers/codex/*`, `agents/types.ts` | `bridge/codex-app-server.ts` (export/refactor nhẹ), `bridge/index.ts` | `codex-plane.ts` (wrap quanh) |
| PR-C | `bridge/src/gateway/{main,lock,ipc-server,hello}.ts`, `native-host/gateway-client.ts` | `native-host/relay.ts` | `bridge/cli.ts` (giữ, thêm gateway entry) |
| PR-D | `bridge/src/tasks/{store,state-machine,replay}.ts`, `migrations/*` | `gateway/main.ts` | — |
| PR-E | `extension/background/{gateway-client,task-controller}.ts`, `compat/legacy-methods.ts` | `native-bridge-client.ts`, `background/index.ts` | UI components |
| PR-F | `bridge/src/browser/{runtime,tool-server,policy,verifier}.ts` | agent tool binding | `browser-actions.ts` (legacy off) |
| PR-G | `browser/approvals.ts`, `extension/background/browser-runtime/approvals.ts` | sidepanel approval UI | — |
| PR-H | `bridge/src/browser/backends/playwright/*` | `playwright-runtime.ts` (reuse), `codex-skill-settings.ts` (nguồn mới + fallback) | i18n, install RPC |
| PR-I | `bridge/src/agents/providers/claude/*` | registry, UI picker | — |

---

## 14. Testing

- Unit: contracts (Zod), classifiers, fingerprint, state machines, token, replay, ack.
- Adapter fixtures: Codex notifications, Claude stream; **turnId race**, interrupt ownership, permission chain.
- Integration: gateway+store+provider mock+host mock; cold start/concurrent/crash (3 diagram ở §3.3.2).
- Extension: content split regression, background replay, dual-path.
- E2E: Windows/Chrome, Codex + (Phase 3) Claude; Playwright isolated opt-in task.
- Crash tests: kill -9 giữa tool/permission/turn → assert `unknown` + no replay.

### MVP acceptance (v4.2)

1. Điều khiển tab Chrome thật, đã đăng nhập. 2. Không tự mở browser riêng cho task mặc định. 3. Codex create/send/stream/interrupt/resume. 4. Claude: **spike ADR hoàn tất** + adapter Phase 3 (MVP core = Codex; first-class = cả hai, có conformance). 5. Browser tools list/get/snapshot/click/type/fill/select/scroll/navigate/wait (+screenshot). 6. **SW sleep + panel close không mất task/turn**; `hostInstanceId` đổi trong cùng browser instance không làm stale tab; gateway crash → paused + resume. 7. Approval cho external mutation/sensitive entry/agent egress; financial không auto. 8. Không lẫn provider/profile/tab scope. 9. Verified hoặc typed error. 10. Playwright capability hiện có vẫn hoạt động + isolated backend opt-in. 11. Durable event seq không gap khi delta bị drop. 12. Snapshot sau prune vẫn có user messages + assistant messages.

---

## 15. Rollout & flags

| Flag | Default | Rollback |
|---|---|---|
| `browserPolicyV2` (planner không chọn engine) | on ở PR-A **sau** regression test workflow cũ | off → planner cũ |
| `gatewayMode` | off | off → bridge per port |
| `store` (`memory`/`sqlite`) | memory ở PR-C, sqlite ở PR-D | memory |
| `toolLoop` | off → on cuối P1 | off → `legacySidecarPlanning` |
| `providers.claude.enabled` | false | false |
| `browser.playwright.enabledByUser` | false | false (install/status vẫn còn) |

Regression bắt buộc trước khi bật `browserPolicyV2`: các workflow hiện dựa `route.plan`/`browser.action.plan` (summary, active-tab action, image workflow) phải pass test tương ứng.

---

## 16. Definition of Done

- 3 state machine tách; recovery tests §7.3 (11 case) pass.
- Gateway single-instance với **two-lock transfer** + **OS advisory lock + fencing token** (không dùng mtime); crash tests §3.3.2 (gồm SIGSTOP >10s, resume với fence cũ, Windows LockFileEx); detached/owned shutdown đúng.
- Identity model: `browserInstanceId: string | null` thống nhất **mọi** contract; `HostIdentityConfidence`; spike B6 chứng minh 4 sự kiện (SW restart / extension reload / extension disable-enable / Chrome quit). Nếu không chứng minh được → degraded + `needs_confirmation` (không `stale`). Cross-profile rules enforced.
- Event protocol đóng kín: durable seq không gap khi delta drop, `TaskSnapshot` đủ user messages, `unknown` outcome, checkpoint loss có phạm vi rõ.
- Permission contextual + `agentEgress` + fail-closed + approval digest.
- Schema chạy được trên SQLite thật (DDL execute), CHECK phản ánh state machine (queued turn, paused⇔pause_reason), transaction template dùng UPSERT, seq cấp trong transaction, `SCHEMA_VERSION` tách khỏi doc version, migration + corrupt-DB test.
- **Contract consistency §4.11 chạy sạch** bằng `node scripts/plan/check-plan-consistency.mjs` (30 check, exit 0) **và** `--self-test` pass (chứng minh checker bắt được mutation, không pass rỗng).
- Codex + Claude dùng chung runtime; Playwright giữ (4 roles).
- Không còn `COMPAT` quá hạn; flag legacy có ngày xoá.

---

## 17. PR order

0. **PR-0 (Gate B spike, không ship)**: `browserInstanceId` (B6), IPC transport/ACL (B5), SQLite durability (B7), Playwright accessibility API (B4). Kết quả = ADR; chặn sign-off A3/§7.2.
1. **PR-A** contracts + planner policy + ADRs (Gate A artifacts).
2. **PR-B** Codex provider wrap + fixtures (không đổi wire).
3. **PR-C** Gateway skeleton (memory store) + IPC/lock + native relay opt-in.
4. **PR-D** SQLite store + state machines + replay + compat router.
5. **PR-E** background gateway client/task controller + replay + UI sync tối thiểu.
6. **PR-F** browser tool server + tool loop + policy skeleton + verify/stale.
7. **PR-G** approval engine + UI + audit.
8. **PR-H** backend selector + playwright-isolated + UI badge (giữ install/status).
9. **PR-I** Claude adapter + UI **sau khi** có ADR từ **B3 spike (Gate B, chạy song song PR-B)**. PR-I **không** lặp lại spike trừ khi ADR phải mở lại (đổi version/mechanism).

Mỗi PR: build/test/typecheck xanh; flag; test mới; `gatewayMode=off` không phá.

---

## 18. Open decisions

1. IPC transport sau spike (§3.4.1); threat model §3.4.3 phải ký trước khi chốt bảo mật.
2. Gateway distribution/update (bundled vs installer vs CLI).
3. Claude mechanism/version floor (P3-00).
4. MCP tool naming (dotted vs snake) + stdio vs HTTP.
5. Tool loop thay legacy planner hoàn toàn hay giữ deterministic cho một số flow.
6. Playwright isolated scope (chỉ opt-in; `upload`/`evaluate`/`emulate`(subset) đã có — evaluate luôn approval-gated).
7. Retention defaults + event size caps.
8. `profileId` multi-Chrome-profile UX (adopt task).
9. Background turns/subagents (P2+).
10. **Cơ chế `browserInstanceId`** (B6) — *đã chốt*: native-host supervisor mint per (chromePpid, chromePpidStartedAt), persist trong gateway dataDir (`docs/adr/browser-instance.md`). ID mất → `needs_confirmation`, không `stale`.
11. **`PRAGMA synchronous`** — *đã chốt `FULL` toàn database*; B7 benchmark xong, giữ FULL (`docs/adr/durability.md`, `store/db.ts`).
12. **Refresh token** — *đã chốt*: Gateway chủ động refresh (§9.1). *Còn mở*: adapter nào hot-update được, adapter nào buộc drain + restart MCP connection.

---

## 19. Không được làm

- Không xoá Playwright runtime/RPC/skill/UI/smoke khi chưa có ADR + test thay thế.
- Không để model đổi backend hoặc tự chuyển profile/tab.
- Không provider chạm Chrome API.
- ~~Không `browser.page.evaluate` cho agent MVP.~~ → **superseded**: evaluate đã triển khai (MAIN world, `args.frameId` tới OOPIF), luôn cần approval — quyết định ghi trong `tool-server.ts`/`risk.ts`/`docs/product-acceptance-matrix.md`.
- Không replay side effect; crash → `unknown`.
- Không dùng `tabId` làm durable identity.
- Không dùng `hostInstanceId` làm affinity key (phải dùng `browserInstanceId`).
- Không để native host unlink `gateway.lock`; không để Gateway unlink `gateway.start.lock`.
- Không dựa vào `scope:"active"` sau restart để lấy tab active hiện tại.
- Không dùng một fingerprint duy nhất cho cả ref-validity và verify.
- Không gán seq cho ephemeral delta.
- Không prune user messages khỏi dữ liệu tạo snapshot.
- Không tuyên bố “token opaque” (đây là signed token).
- Không tuyên bố chống malware cùng user bằng token/ACL.
- Không mô tả SW bị thu hồi do idle khi native port còn mở (sai theo tài liệu Chrome).
- Không suy ra `stale` khi chỉ mất `browserInstanceId` (extension reload) — phải `needs_confirmation`.
- Không dùng `hostInstanceId`/chuỗi `"degraded"` làm affinity identity.
- Không persist `attention` như cột DB; không dùng `INSERT OR REPLACE` cho turn.
- Không nhét `task.snapshot` vào một envelope vượt giới hạn Native Messaging.
- Không để `jti` được mô tả là chống replay khi token là bearer.
- Không viết `started_at NOT NULL` cho turn (queued chưa bắt đầu).
- Không trộn atomic lock (`wx`) với rename/tmp.
- Không tuyên bố “max loss = 0” khi `synchronous != FULL`.
- Không copy code Paseo khi chưa review license/attribution.
- Không breaking wire schema (field mới optional + `COMPAT` có ngày).
- Không tuyên bố “hỗ trợ mọi thao tác web” (xem §6.8).
- Không chạy full suite gây treo máy; chạy file liên quan.
