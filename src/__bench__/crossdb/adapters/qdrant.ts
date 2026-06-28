/**
 * adapters/qdrant.ts — the QDRANT vector-DB adapter (Docker-backed, pure-JS client).
 *
 * DUMB store: it indexes every asserted fact as a 64-d point (the SAME deterministic
 * embedding every engine uses) with a {entity, attribute, value} payload, and recalls by
 * VECTOR nearest-neighbour filtered to the cued entity, then majority-votes the value
 * among the retrieved neighbours (trust-blind — copies count as evidence). It has NO
 * provenance/independence model, so under the cheap-Sybil attack the FALSE fleet fills
 * the retrieved set and wins once A > H ⇒ poison_correct_rate = 0. That is the EXPECTED,
 * HONEST result and the whole point of the comparison.
 *
 * LIFECYCLE: `setup()` starts `qdrant/qdrant` (force-removing any stale container of the
 * same name first), waits for the REST port + a real `getCollections()` handshake, then
 * creates the collection. `close()` force-removes the container so nothing leaks. If the
 * image won't pull / the container won't start / the port never opens, `setup()` throws a
 * one-line reason and the runner marks the adapter SKIPPED and continues.
 *
 * WRITES are buffered and flushed in batches (per-point upserts over the network would
 * dominate write_hz unfairly); `flush()` upserts the buffer with `wait:true` so the data
 * is durable before footprint measurement.
 *
 * FOOTPRINT (fair, on-disk best-effort): `du -sb /qdrant/storage` inside the container —
 * the actual bytes Qdrant wrote for the collection (segments + WAL). Measured once, right
 * after the first flush (N facts), and cached for the sync `footprintBytes()`.
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; the client is loaded via a
 * runtime dynamic import so an absent package skips only THIS adapter (not the runner).
 */

import type { Fact, Cue, RankedFact, MemoryAdapter } from "../adapter.js";
import { EMBED_DIM } from "../embeddings.js";
import {
  assertDockerRunning,
  runContainer,
  removeContainer,
  waitForPort,
  waitForReady,
  dockerExec,
} from "../dockerUtil.js";

const CONTAINER = "idb-bench-qdrant";
const IMAGE = "qdrant/qdrant:latest";
const HOST = "127.0.0.1";
const PORT = 6333;
const COLLECTION = "bench";
const TOP_K = 256; // large vs H so copy-count, not tie order, decides the recalled value.
const BATCH = 256;

/** Minimal structural typing of the bits of @qdrant/js-client-rest we use. */
interface QdrantPoint {
  id: number;
  vector: number[];
  payload: { entity: string; attribute: string; value: string };
}
interface QdrantHit {
  payload?: { value?: string } | null;
  score?: number;
}
interface QdrantClientLike {
  getCollections(): Promise<unknown>;
  createCollection(name: string, body: unknown): Promise<unknown>;
  upsert(name: string, body: { wait: boolean; points: QdrantPoint[] }): Promise<unknown>;
  search(name: string, body: unknown): Promise<QdrantHit[]>;
}
interface QdrantCtor {
  new (opts: { url: string; port: number; checkCompatibility?: boolean }): QdrantClientLike;
}

export function createQdrantAdapter(): MemoryAdapter {
  let client: QdrantClientLike | null = null;
  let buffer: QdrantPoint[] = [];
  let pointId = 0;
  let diskBytes = 0;
  let measured = false;

  async function flushBuffer(): Promise<void> {
    if (client === null || buffer.length === 0) return;
    for (let i = 0; i < buffer.length; i += BATCH) {
      const points = buffer.slice(i, i + BATCH);
      await client.upsert(COLLECTION, { wait: true, points });
    }
    buffer = [];
  }

  function measureDisk(): void {
    try {
      const out = dockerExec(CONTAINER, ["du", "-sb", "/qdrant/storage"]);
      const n = Number.parseInt(out.split(/\s+/)[0] ?? "0", 10);
      if (Number.isFinite(n)) diskBytes = n;
    } catch {
      diskBytes = 0; // du absent in image ⇒ report n/a (documented in results.md).
    }
  }

  return {
    name: "Qdrant (docker)",

    async setup(): Promise<void> {
      assertDockerRunning();
      runContainer({ name: CONTAINER, image: IMAGE, ports: [[PORT, PORT]] });
      await waitForPort(HOST, PORT, 60_000);

      const mod = (await import("@qdrant/js-client-rest")) as unknown as {
        QdrantClient: QdrantCtor;
      };
      const c = new mod.QdrantClient({ url: `http://${HOST}`, port: PORT, checkCompatibility: false });
      await waitForReady(() => c.getCollections().then(() => undefined), 60_000);
      client = c;

      await client.createCollection(COLLECTION, {
        vectors: { size: EMBED_DIM, distance: "Cosine" },
      });
      buffer = [];
      pointId = 0;
      diskBytes = 0;
      measured = false;
    },

    writeFact(f: Fact): void {
      buffer.push({
        id: pointId++,
        vector: Array.from(f.embedding),
        payload: { entity: f.entity, attribute: f.attribute, value: f.value },
      });
    },

    async flush(): Promise<void> {
      await flushBuffer();
      if (!measured) {
        measureDisk();
        measured = true;
      }
    },

    async recall(cue: Cue): Promise<RankedFact[]> {
      if (client === null) return [];
      const hits = await client.search(COLLECTION, {
        vector: Array.from(cue.embedding),
        limit: TOP_K,
        with_payload: true,
        filter: { must: [{ key: "entity", match: { value: cue.entity } }] },
      });
      // Trust-blind majority vote among the retrieved neighbours (copies = evidence).
      const tally = new Map<string, number>();
      for (const h of hits) {
        const v = h.payload?.value;
        if (typeof v === "string") tally.set(v, (tally.get(v) ?? 0) + 1);
      }
      const out: RankedFact[] = [];
      for (const [value, count] of tally) out.push({ value, score: count });
      out.sort((a, b) => b.score - a.score);
      return out;
    },

    footprintBytes(): number {
      return diskBytes;
    },

    async close(): Promise<void> {
      client = null;
      buffer = [];
      removeContainer(CONTAINER);
    },
  };
}
