/**
 * adapters/redisVector.ts — the REDIS-STACK (RediSearch) vector adapter (Docker-backed,
 * pure-JS `redis`).
 *
 * DUMB store: each fact is a HASH `fact:<id>` carrying {entity (TAG), attribute, value,
 * embedding (FLOAT32 64-d)} and a FLAT VECTOR index over `embedding`; recall is a
 * RediSearch KNN filtered to the cued entity (`(@entity:{e})=>[KNN k @embedding $vec]`),
 * then a majority vote on `value` among the k nearest (trust-blind — copies count as
 * evidence). No provenance/independence model ⇒ under the cheap-Sybil attack the FALSE
 * fleet fills the KNN and wins once A > H ⇒ poison_correct_rate = 0. The EXPECTED, HONEST
 * result and the whole point of the comparison.
 *
 * LIFECYCLE: `setup()` starts `redis/redis-stack` (force-removing any stale container
 * first), waits for the port + for the RediSearch module to answer `FT.CREATE` (the
 * module loads a moment after the port opens), then (re)creates the index. `close()`
 * disconnects and force-removes the container. Image-pull / start / connect failures
 * throw a one-line reason ⇒ SKIPPED.
 *
 * WRITES are buffered and flushed as a pipelined burst of HSETs (node-redis batches
 * concurrent commands onto the socket).
 *
 * FOOTPRINT (best-effort, DB-reported): Redis is an IN-MEMORY store, so there is no
 * meaningful on-disk file mid-run; we report `INFO memory` `used_memory` (the dataset's
 * resident bytes) and DOCUMENT that this is RAM, not on-disk — the directive's sanctioned
 * "Redis DBSIZE/INFO memory" best-effort. Measured once after the first flush, cached for
 * the sync `footprintBytes()`.
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `redis` is loaded via a
 * runtime dynamic import so an absent package skips only THIS adapter.
 */

import type { Fact, Cue, RankedFact, MemoryAdapter } from "../adapter.js";
import { EMBED_DIM } from "../embeddings.js";
import {
  assertDockerRunning,
  runContainer,
  removeContainer,
  waitForPort,
} from "../dockerUtil.js";

const CONTAINER = "idb-bench-redis";
const IMAGE = "redis/redis-stack:latest";
const HOST = "127.0.0.1";
const PORT = 6379;
const IDX = "bench_idx";
const PREFIX = "fact:";
const TOP_K = 256;

/** Minimal structural typing of the node-redis surface we use. */
interface RedisSearchDoc {
  id: string;
  value: Record<string, unknown>;
}
interface RedisClientLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(event: string, cb: (e: unknown) => void): unknown;
  sendCommand(args: Array<string | Buffer>): Promise<unknown>;
  info(section: string): Promise<string>;
  ft: {
    search(
      index: string,
      query: string,
      opts: unknown,
    ): Promise<{ total: number; documents: RedisSearchDoc[] }>;
  };
}
interface RedisModule {
  createClient(opts: { url: string }): RedisClientLike;
}

/** Backslash-escape RediSearch TAG special chars so `entity` matches literally. */
function escapeTag(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, (ch) => `\\${ch}`);
}

/** Raw little-endian FLOAT32 bytes of an embedding (what RediSearch indexes). */
function vecBytes(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function createRedisVectorAdapter(): MemoryAdapter {
  let client: RedisClientLike | null = null;
  let buffer: Array<{ id: number; e: string; a: string; v: string; vec: Buffer }> = [];
  let factId = 0;
  let memBytes = 0;
  let measured = false;

  async function createIndex(c: RedisClientLike): Promise<void> {
    // Drop a stale index if present (ignore "unknown index"), then create fresh.
    try {
      await c.sendCommand(["FT.DROPINDEX", IDX]);
    } catch {
      /* no prior index */
    }
    await c.sendCommand([
      "FT.CREATE", IDX, "ON", "HASH", "PREFIX", "1", PREFIX,
      "SCHEMA",
      "entity", "TAG",
      "value", "TEXT",
      "embedding", "VECTOR", "FLAT", "6",
      "TYPE", "FLOAT32", "DIM", String(EMBED_DIM), "DISTANCE_METRIC", "COSINE",
    ]);
  }

  async function flushBuffer(): Promise<void> {
    if (client === null || buffer.length === 0) return;
    const c = client;
    const pending: Array<Promise<unknown>> = [];
    for (const row of buffer) {
      pending.push(
        c.sendCommand([
          "HSET", `${PREFIX}${row.id}`,
          "entity", row.e,
          "attribute", row.a,
          "value", row.v,
          "embedding", row.vec,
        ]),
      );
    }
    await Promise.all(pending);
    buffer = [];
  }

  return {
    name: "Redis-Stack (docker)",

    async setup(): Promise<void> {
      assertDockerRunning();
      runContainer({ name: CONTAINER, image: IMAGE, ports: [[PORT, PORT]] });
      await waitForPort(HOST, PORT, 60_000);

      const mod = (await import("redis")) as unknown as RedisModule;

      // Connect with retry (the server may refuse for a beat after the port opens).
      const deadline = Date.now() + 60_000;
      let lastErr = "no connection";
      while (Date.now() < deadline && client === null) {
        const c = mod.createClient({ url: `redis://${HOST}:${PORT}` });
        c.on("error", () => {
          /* swallow background reconnect noise */
        });
        try {
          await c.connect();
          await createIndex(c); // also probes that the RediSearch module is loaded
          client = c;
        } catch (err) {
          lastErr = err instanceof Error ? err.message.split("\n")[0]! : String(err);
          try {
            await c.disconnect();
          } catch {
            /* ignore */
          }
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      if (client === null) throw new Error(`redis handshake failed: ${lastErr}`);
      buffer = [];
      factId = 0;
      memBytes = 0;
      measured = false;
    },

    writeFact(f: Fact): void {
      buffer.push({
        id: factId++,
        e: f.entity,
        a: f.attribute,
        v: f.value,
        vec: vecBytes(f.embedding),
      });
    },

    async flush(): Promise<void> {
      await flushBuffer();
      if (!measured && client !== null) {
        try {
          const info = await client.info("memory");
          const m = /used_memory:(\d+)/.exec(info);
          memBytes = m ? Number.parseInt(m[1]!, 10) : 0;
        } catch {
          memBytes = 0;
        }
        measured = true;
      }
    },

    async recall(cue: Cue): Promise<RankedFact[]> {
      if (client === null) return [];
      const query = `(@entity:{${escapeTag(cue.entity)}})=>[KNN ${TOP_K} @embedding $vec AS dist]`;
      let docs: RedisSearchDoc[] = [];
      try {
        const res = await client.ft.search(IDX, query, {
          PARAMS: { vec: vecBytes(cue.embedding) },
          DIALECT: 2,
          RETURN: ["value"],
          SORTBY: { BY: "dist", DIRECTION: "ASC" },
          LIMIT: { from: 0, size: TOP_K },
        });
        docs = res.documents;
      } catch {
        return [];
      }
      const tally = new Map<string, number>();
      for (const d of docs) {
        const v = d.value["value"];
        if (typeof v === "string") tally.set(v, (tally.get(v) ?? 0) + 1);
      }
      const out: RankedFact[] = [];
      for (const [value, count] of tally) out.push({ value, score: count });
      out.sort((a, b) => b.score - a.score);
      return out;
    },

    footprintBytes(): number {
      return memBytes;
    },

    async close(): Promise<void> {
      if (client !== null) {
        try {
          await client.disconnect();
        } catch {
          /* best effort */
        }
        client = null;
      }
      removeContainer(CONTAINER);
    },
  };
}
