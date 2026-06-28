/**
 * adapters/pgvector.ts — the POSTGRES + pgvector adapter (Docker-backed, pure-JS `pg`).
 *
 * DUMB store: facts land in a table with a `vector(64)` column (the SAME deterministic
 * embedding every engine uses); recall is `ORDER BY embedding <-> $cue LIMIT k` filtered
 * to the cued entity, then a majority vote on `value` among the k nearest (trust-blind —
 * copies count as evidence). No provenance/independence model ⇒ under the cheap-Sybil
 * attack the FALSE fleet fills the k-NN and wins once A > H ⇒ poison_correct_rate = 0.
 * That is the EXPECTED, HONEST result and the whole point of the comparison.
 *
 * LIFECYCLE: `setup()` starts `pgvector/pgvector:pg16` (force-removing any stale
 * container first), waits for the port + a real `SELECT 1` handshake (Postgres needs a
 * few seconds to accept connections), then `CREATE EXTENSION vector` + the table + a
 * btree index on (entity, attribute). `close()` ends the client and force-removes the
 * container. Image-pull / start / connect failures throw a one-line reason ⇒ SKIPPED.
 *
 * WRITES are buffered and flushed as multi-row parameterized INSERTs (per-row round
 * trips would dominate write_hz); `flush()` commits the buffer.
 *
 * FOOTPRINT (fair, on-disk): `SELECT pg_database_size(current_database())` — Postgres's
 * own report of the bytes the database occupies on disk. Measured once after the first
 * flush (N facts), cached for the sync `footprintBytes()`.
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `pg` is loaded via a runtime
 * dynamic import so an absent package skips only THIS adapter.
 */

import type { Fact, Cue, RankedFact, MemoryAdapter } from "../adapter.js";
import { EMBED_DIM } from "../embeddings.js";
import { req } from "../util.js";
import {
  assertDockerRunning,
  runContainer,
  removeContainer,
  waitForPort,
} from "../dockerUtil.js";

const CONTAINER = "idb-bench-pg";
const IMAGE = "pgvector/pgvector:pg16";
const HOST = "127.0.0.1";
const PORT = 5432;
const PASSWORD = "bench";
const TOP_K = 256;
const ROWS_PER_INSERT = 800; // 800 rows x 4 params = 3200 < pg's 65535 param cap.

/** Minimal structural typing of the `pg` Client surface we use. */
interface PgClientLike {
  connect(): Promise<void>;
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}
interface PgClientCtor {
  new (cfg: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  }): PgClientLike;
}

/** pgvector accepts a vector literal as the text `[v0,v1,...]`. */
function toVectorLiteral(v: Float32Array): string {
  return `[${Array.from(v).join(",")}]`;
}

export function createPgVectorAdapter(): MemoryAdapter {
  let client: PgClientLike | null = null;
  let Ctor: PgClientCtor | null = null;
  let buffer: Array<{ e: string; a: string; v: string; vec: string }> = [];
  let diskBytes = 0;
  let measured = false;

  function newClient(): PgClientLike {
    return new Ctor!({
      host: HOST,
      port: PORT,
      user: "postgres",
      password: PASSWORD,
      database: "postgres",
    });
  }

  async function flushBuffer(): Promise<void> {
    if (client === null || buffer.length === 0) return;
    for (let i = 0; i < buffer.length; i += ROWS_PER_INSERT) {
      const chunk = buffer.slice(i, i + ROWS_PER_INSERT);
      const tuples: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const row of chunk) {
        tuples.push(`($${p++}, $${p++}, $${p++}, $${p++}::vector)`);
        params.push(row.e, row.a, row.v, row.vec);
      }
      await client.query(
        `INSERT INTO facts(entity, attribute, value, embedding) VALUES ${tuples.join(", ")}`,
        params,
      );
    }
    buffer = [];
  }

  return {
    name: "Postgres+pgvector (docker)",

    async setup(): Promise<void> {
      assertDockerRunning();
      runContainer({
        name: CONTAINER,
        image: IMAGE,
        ports: [[PORT, PORT]],
        env: { POSTGRES_PASSWORD: PASSWORD },
      });
      await waitForPort(HOST, PORT, 60_000);

      // `pg` ships no bundled types; load via runtime require (any) to avoid a TS7016.
      const mod = req("pg") as { Client?: PgClientCtor; default?: { Client: PgClientCtor } };
      Ctor = mod.Client ?? mod.default?.Client ?? null;
      if (Ctor === null) throw new Error("pg.Client constructor not found");

      // Postgres accepts the port before it accepts auth — retry a real handshake.
      const deadline = Date.now() + 60_000;
      let connected: PgClientLike | null = null;
      let lastErr = "no connection";
      while (Date.now() < deadline && connected === null) {
        const c = newClient();
        try {
          await c.connect();
          await c.query("SELECT 1");
          connected = c;
        } catch (err) {
          lastErr = err instanceof Error ? err.message.split("\n")[0]! : String(err);
          try {
            await c.end();
          } catch {
            /* ignore */
          }
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      if (connected === null) throw new Error(`postgres handshake failed: ${lastErr}`);
      client = connected;

      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await client.query("DROP TABLE IF EXISTS facts");
      await client.query(
        `CREATE TABLE facts (id serial PRIMARY KEY, entity text, attribute text, value text, embedding vector(${EMBED_DIM}))`,
      );
      await client.query("CREATE INDEX idx_ea ON facts(entity, attribute)");
      buffer = [];
      diskBytes = 0;
      measured = false;
    },

    writeFact(f: Fact): void {
      buffer.push({ e: f.entity, a: f.attribute, v: f.value, vec: toVectorLiteral(f.embedding) });
    },

    async flush(): Promise<void> {
      await flushBuffer();
      if (!measured && client !== null) {
        try {
          const r = await client.query("SELECT pg_database_size(current_database()) AS sz");
          const sz = r.rows[0]?.["sz"];
          diskBytes = typeof sz === "string" ? Number.parseInt(sz, 10) : Number(sz ?? 0);
        } catch {
          diskBytes = 0;
        }
        measured = true;
      }
    },

    async recall(cue: Cue): Promise<RankedFact[]> {
      if (client === null) return [];
      const r = await client.query(
        `SELECT value FROM facts WHERE entity = $1 ORDER BY embedding <-> $2::vector LIMIT $3`,
        [cue.entity, toVectorLiteral(cue.embedding), TOP_K],
      );
      const tally = new Map<string, number>();
      for (const row of r.rows) {
        const v = row["value"];
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
      if (client !== null) {
        try {
          await client.end();
        } catch {
          /* best effort */
        }
        client = null;
      }
      removeContainer(CONTAINER);
    },
  };
}
