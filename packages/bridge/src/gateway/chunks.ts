/**
 * TaskSnapshot chunk transport — plan §4.6 / P1-7.
 *
 * `task.snapshot` returns an InlineTaskSnapshot when the serialized
 * payload fits; otherwise a ChunkedTaskSnapshotManifest and the chunks
 * are served one-per-request via `task.snapshot.chunk` (≤256 KiB each,
 * per-chunk sha256 + whole-snapshot sha256 for reassembly verify).
 *
 * Chunks live in memory only: a gateway restart invalidates
 * snapshotRef, and clients re-request `task.snapshot` — acceptable
 * because snapshots are derived state, not durable events.
 */

import { createHash, randomBytes } from "node:crypto";

import {
  MAX_SNAPSHOT_CHUNK_BYTES,
  type ChunkedTaskSnapshotManifest,
  type InlineTaskSnapshot,
  type TaskSnapshot,
  type TaskSnapshotChunkResponse,
} from "@codex-sidepanel/shared";

export const MAX_INLINE_SNAPSHOT_BYTES = 512 * 1024;

interface StoredSnapshot {
  taskId: string;
  /** utf8 JSON of the full inline snapshot */
  data: string;
  snapshotSha256: string;
  chunks: Buffer[];
  chunkSha256: string[];
  createdAt: number;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export class SnapshotChunkStore {
  private snapshots = new Map<string, StoredSnapshot>();
  private readonly maxSnapshots: number;

  constructor(maxSnapshots = 64) {
    this.maxSnapshots = maxSnapshots;
  }

  /**
   * Store a snapshot; returns the wire form (inline or chunked
   * manifest). Caller passes the ALREADY-BUILT snapshot data.
   */
  put(taskId: string, snapshot: InlineTaskSnapshot): TaskSnapshot {
    const data = JSON.stringify(snapshot);
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes <= MAX_INLINE_SNAPSHOT_BYTES) {
      return snapshot;
    }

    const buf = Buffer.from(data, "utf8");
    const chunks: Buffer[] = [];
    for (let off = 0; off < buf.length; off += MAX_SNAPSHOT_CHUNK_BYTES) {
      chunks.push(buf.subarray(off, Math.min(off + MAX_SNAPSHOT_CHUNK_BYTES, buf.length)));
    }
    const snapshotRef = `snap_${randomBytes(12).toString("hex")}`;
    const record: StoredSnapshot = {
      taskId,
      data,
      snapshotSha256: sha256(buf),
      chunks,
      chunkSha256: chunks.map((c) => sha256(c)),
      createdAt: Date.now(),
    };
    // bound memory: evict oldest
    while (this.snapshots.size >= this.maxSnapshots) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
    this.snapshots.set(snapshotRef, record);

    const manifest: ChunkedTaskSnapshotManifest = {
      storage: {
        kind: "chunked",
        snapshotRef,
        chunkCount: chunks.length,
        totalBytes: bytes,
        snapshotSha256: record.snapshotSha256,
      },
      taskId,
      lastSeq: snapshot.lastSeq,
      rebuiltFrom: snapshot.rebuiltFrom,
    };
    return manifest;
  }

  get(taskId: string, snapshotRef: string, chunkIndex: number): TaskSnapshotChunkResponse | null {
    const rec = this.snapshots.get(snapshotRef);
    if (!rec || rec.taskId !== taskId) return null;
    const chunk = rec.chunks[chunkIndex];
    if (!chunk) return null;
    return {
      taskId,
      snapshotRef,
      chunkIndex,
      chunkCount: rec.chunks.length,
      // base64 keeps binary-safe transport inside JSON envelopes
      data: chunk.toString("base64"),
      sha256: rec.chunkSha256[chunkIndex]!,
      snapshotSha256: rec.snapshotSha256,
    };
  }

  drop(taskId: string): void {
    for (const [ref, rec] of this.snapshots) {
      if (rec.taskId === taskId) this.snapshots.delete(ref);
    }
  }
}
