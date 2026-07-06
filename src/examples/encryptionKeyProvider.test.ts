/**
 * examples/encryptionKeyProvider.test.ts — the reference env-var key provider
 * stays WORKING, not decorative. Exercises it end-to-end wired into
 * {@link createEncryptedStore}, plus its fail-closed error paths.
 */

import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { envKeyProvider } from "./encryptionKeyProvider.js";
import { createEncryptedStore } from "../store/encryptedStore.js";
import { createMemoryStore } from "../store/memoryStore.js";
import {
  asEpochMs,
  FactOrigin,
  FactState,
  Tier,
  type ContentHash,
  type EntityId,
  type Strand,
  type StrandId,
} from "../core/types.js";

const ENV_VAR = "IDB_TEST_ENCRYPTION_KEY";

function makeStrand(id: string, payload: unknown): Strand {
  return {
    id: id as StrandId,
    entity: "E1" as EntityId,
    attribute: null,
    payload,
    content_hash: `hash:${id}` as ContentHash,
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [],
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    salience: { s: 1, last_fire_time: asEpochMs(0), lambda: 0.1, fire_count: 0 },
    description_value: 0,
    observedAt: asEpochMs(0),
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
    register: null,
  };
}

afterEach(() => {
  delete process.env[ENV_VAR];
});

describe("envKeyProvider", () => {
  it("reads a valid base64 32-byte key and wires end-to-end into createEncryptedStore", () => {
    process.env[ENV_VAR] = randomBytes(32).toString("base64");
    const provider = envKeyProvider(ENV_VAR);

    const key = provider();
    expect(key.length).toBe(32);

    const store = createEncryptedStore(createMemoryStore(), provider);
    store.putStrand(makeStrand("a", { secret: "hello" }));
    expect(store.getStrand("a" as StrandId)?.payload).toEqual({ secret: "hello" });
  });

  it("re-reads the environment on every call (rotation takes effect without a restart)", () => {
    process.env[ENV_VAR] = randomBytes(32).toString("base64");
    const provider = envKeyProvider(ENV_VAR);
    const first = provider();

    process.env[ENV_VAR] = randomBytes(32).toString("base64");
    const second = provider();

    expect(first.equals(second)).toBe(false);
  });

  it("throws when the environment variable is missing", () => {
    delete process.env[ENV_VAR];
    const provider = envKeyProvider(ENV_VAR);
    expect(() => provider()).toThrow(/is not set/);
  });

  it("throws when the decoded key is not exactly 32 bytes", () => {
    process.env[ENV_VAR] = randomBytes(16).toString("base64");
    const provider = envKeyProvider(ENV_VAR);
    expect(() => provider()).toThrow(/decodes to 16 bytes/);
  });
});
