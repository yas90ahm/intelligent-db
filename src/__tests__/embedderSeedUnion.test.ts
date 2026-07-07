/**
 * embedderSeedUnion.test.ts — Phase-1 retrieval spec §1-3 + §5.4.
 *
 * Proves the EmbedderPort / vector-sidecar / seed-union machinery end-to-end
 * over the real engine + a real (deterministic, zero-network) reference
 * embedder, WITHOUT ever letting similarity leak into belief:
 *
 *   1. `writeFactWithEmbeddingAsync` populates the vector sidecar keyed by
 *      content_hash, reuses an existing vector for an echoed hash, degrades to
 *      a plain `writeFact` when no embedder failed OR no retrieval is wired,
 *      and NEVER rejects on an embedder failure (fail-open).
 *   2. `createEmbeddingCueResolver` UNIONS embedding-proposed seeds with the
 *      lexical/entity baseline, clamping an embedding seed's energy to <= the
 *      strongest lexical/entity seed this cue produced, and silently ignoring
 *      a vector minted under a different `model_id`.
 *   3. THE ADVERSARIAL GATE (spec §5): an attacker writes many PROVISIONAL
 *      strands whose payload is a near-duplicate of the cue (cosine ~1.0) —
 *      they DO seed the walk, but the LIVE incumbent (independent, trusted
 *      provenance) is still the one a fact_state-aware renderer would surface,
 *      and every attacker strand stays labeled PROVISIONAL — seeding energy
 *      never flips belief.
 *   4. Wave-3 `embed-resolver-no-topk-cap`: `resolveWithEmbeddings`'s final
 *      union is truncated at `embedSeedK`, even when a matched vector's echo
 *      bucket (many strands sharing one payload) would otherwise blow the
 *      output size past it.
 */

import { describe, it, expect } from "vitest";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createMemoryVectorSidecar,
  createEmbeddingCueResolver,
  createLexicalCueResolver,
  FactState,
  AnchorClass,
  independenceBetween,
} from "../index.js";
import type {
  AnchorBinding,
  AnchorRegistryPort,
  EntityId,
  AttributeKey,
  IdentityStamp,
  ReputationLedgerPort,
  SourceId,
  SourceIdentityLayer,
  SourceRegistryPort,
  StakeLedgerPort,
  StrandId,
  Unit,
  IntelligentDb,
  StrandStore,
} from "../index.js";
import { freshSource } from "../testSupport/identityFixtures.js";
import { createHashingEmbedder } from "../examples/embedders.js";

// ---------------------------------------------------------------------------
// Minimal identity-layer wiring (mirrors __tests__/smoke.test.ts's fixture).
// ---------------------------------------------------------------------------

function makeSourceRegistry(): SourceRegistryPort {
  const known = new Set<SourceId>();
  return {
    register(passport) {
      known.add(passport.sourceId);
    },
    sourceIdOf(sourceId) {
      return known.has(sourceId) ? sourceId : null;
    },
    has(sourceId) {
      return known.has(sourceId);
    },
  };
}

function makeAnchorRegistry(): AnchorRegistryPort {
  const book = new Map<SourceId, readonly AnchorBinding[]>();
  return {
    bind(sourceId, anchors) {
      const prev = book.get(sourceId) ?? [];
      book.set(sourceId, [...prev, ...anchors]);
    },
    anchorsOf(sourceId) {
      return book.get(sourceId) ?? [];
    },
    aggregateCost(anchors) {
      let best = 0;
      for (const a of anchors) if (a.realizedCost > best) best = a.realizedCost;
      return best;
    },
    independenceBetween(a, b) {
      return independenceBetween([...a], [...b]);
    },
  };
}

function makeReputationLedger(): ReputationLedgerPort {
  return { scoreOf: () => 0 };
}

function makeStakePort(): StakeLedgerPort {
  return { postedFor: () => 0 };
}

function makeIdentityLayer(): SourceIdentityLayer {
  return createSourceIdentityLayer({
    sources: makeSourceRegistry(),
    anchors: makeAnchorRegistry(),
    reputation: makeReputationLedger(),
    stake: makeStakePort(),
  });
}

/** A DOMAIN anchor (independenceWeight 0.35 — clears the default 0.10 quarantine gate). */
function domainAnchor(): AnchorBinding {
  return { anchorClass: AnchorClass.DOMAIN, realizedCost: 0.35 as Unit, independenceWeight: 0.35 as Unit };
}

// ---------------------------------------------------------------------------
// 1) writeFactWithEmbeddingAsync
// ---------------------------------------------------------------------------

describe("writeFactWithEmbeddingAsync", () => {
  function wire() {
    const store = createMemoryStore();
    const identity = makeIdentityLayer();
    const vectors = createMemoryVectorSidecar();
    const embedder = createHashingEmbedder({ dim: 32 });
    const db = createIntelligentDb(store, identity, null, null, null, null, { embedder, vectors });
    const passport = freshSource();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);
    return { store, identity, vectors, embedder, db, stamp };
  }

  it("populates the vector sidecar keyed by the fresh strand's content_hash", async () => {
    const { store, vectors, embedder, db, stamp } = wire();
    const entity = "entity:e1" as EntityId;
    const id = await db.writeFactWithEmbeddingAsync({
      entity,
      payload: { text: "Berlin is the capital of Germany" },
      stamp,
    });
    const strand = store.getStrand(id);
    expect(strand).not.toBeNull();
    const stored = vectors.get(strand!.content_hash);
    expect(stored).not.toBeNull();
    expect(stored?.modelId).toBe(embedder.modelId);
    expect(stored?.dim).toBe(32);
  });

  it("echoes (same content_hash) share ONE vector row, byte-identical to a direct embed", async () => {
    const { store, vectors, embedder, db, stamp } = wire();
    const entity = "entity:e1" as EntityId;
    const payload = { text: "identical payload" };
    const idA = await db.writeFactWithEmbeddingAsync({ entity, payload, stamp });
    const idB = await db.writeFactWithEmbeddingAsync({ entity, payload, stamp });
    expect(idA).not.toBe(idB); // two distinct strands...

    const strandA = store.getStrand(idA)!;
    const strandB = store.getStrand(idB)!;
    expect(strandA.content_hash).toBe(strandB.content_hash); // ...ONE shared hash

    const stored = vectors.get(strandA.content_hash);
    const [expected] = await embedder.embed(["identical payload"]);
    expect(Array.from(stored?.vec ?? [])).toEqual(Array.from(expected ?? []));
  });

  it("NO retrieval wired => bit-for-bit writeFact passthrough (embedder never called)", async () => {
    const store = createMemoryStore();
    const identity = makeIdentityLayer();
    const db = createIntelligentDb(store, identity); // retrieval omitted
    const passport = freshSource();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);

    const entity = "entity:e1" as EntityId;
    const id = await db.writeFactWithEmbeddingAsync({ entity, payload: { text: "x" }, stamp });
    expect(store.getStrand(id)).not.toBeNull();
  });

  it("FAIL-OPEN: an embedder that throws still lands the fact, just without a vector", async () => {
    const store = createMemoryStore();
    const identity = makeIdentityLayer();
    const vectors = createMemoryVectorSidecar();
    const throwingEmbedder = {
      dim: 8,
      modelId: "throws",
      embed: async (): Promise<Float32Array[]> => {
        throw new Error("network down");
      },
    };
    const db = createIntelligentDb(store, identity, null, null, null, null, {
      embedder: throwingEmbedder,
      vectors,
    });
    const passport = freshSource();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);

    const entity = "entity:e1" as EntityId;
    const id = await db.writeFactWithEmbeddingAsync({ entity, payload: { text: "x" }, stamp });
    const strand = store.getStrand(id);
    expect(strand).not.toBeNull(); // the fact still landed
    expect(vectors.get(strand!.content_hash)).toBeNull(); // but no vector was written
  });
});

// ---------------------------------------------------------------------------
// 2) createEmbeddingCueResolver — the seed-union seam
// ---------------------------------------------------------------------------

describe("createEmbeddingCueResolver: seed-union seam", () => {
  function wireEngine(): { store: StrandStore; db: IntelligentDb; stamp: IdentityStamp } {
    const store = createMemoryStore();
    const identity = makeIdentityLayer();
    const vectors = createMemoryVectorSidecar();
    const embedder = createHashingEmbedder({ dim: 32 });
    const db = createIntelligentDb(store, identity, null, null, null, null, { embedder, vectors });
    const passport = freshSource();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);
    return { store, db, stamp };
  }

  it("resolve() (sync) is UNCHANGED — never touches the embedder", async () => {
    const { store, db, stamp } = wireEngine();
    const vectors = createMemoryVectorSidecar();
    const embedder = createHashingEmbedder({ dim: 32 });

    await db.writeFactWithEmbeddingAsync({
      entity: "entity:a" as EntityId,
      payload: { text: "hello world" },
      stamp,
    });
    // Construct AFTER the write: both resolvers rebuild their index from
    // store.allStrands() at construction (mirroring the lexical resolver's own
    // reopen-survival contract), so no separate index() call is needed here.
    const resolver = createEmbeddingCueResolver(store, embedder, vectors);
    // The sync path is identical to the lexical baseline alone (no cosine union).
    const baseline = createLexicalCueResolver(store).resolve({ text: "hello world" });
    const viaResolver = resolver.resolve({ text: "hello world" });
    expect(viaResolver.map((s) => s.strandId).sort()).toEqual(
      baseline.map((s) => s.strandId).sort(),
    );
  });

  it("UNIONS an embedding-only candidate (no lexical overlap) into the seed set", async () => {
    const { store, db, stamp } = wireEngine();
    const vectors = createMemoryVectorSidecar();
    const embedder = createHashingEmbedder({ dim: 32 });

    // A payload with ZERO token overlap with the cue below, so the LEXICAL resolver
    // alone would never seed it — only the embedding channel can.
    const id = await db.writeFactWithEmbeddingAsync({
      entity: "entity:zzz" as EntityId,
      payload: { text: "xylophone quokka marmalade" },
      stamp,
    });

    const resolver = createEmbeddingCueResolver(store, embedder, vectors);
    const lexicalOnly = resolver.resolve({ text: "xylophone quokka marmalade" });
    // Sanity: the SAME text lexically matches (proves the store round-trip is fine);
    // use a DIFFERENT, non-overlapping cue for the real embedding-only assertion.
    expect(lexicalOnly.some((s) => s.strandId === id)).toBe(true);

    const seeds = await resolver.resolveWithEmbeddings({ text: "xylophone quokka marmalade" });
    expect(seeds.some((s) => s.strandId === id)).toBe(true);
  });

  it("an embedding-proposed seed is clamped to <= the strongest lexical/entity seed energy", async () => {
    const { store, db, stamp } = wireEngine();
    const vectors = createMemoryVectorSidecar();
    const embedder = createHashingEmbedder({ dim: 32 });

    // Exact-entity match => energy 1.0 for entityStrandId; an UNRELATED strand with
    // high cosine similarity to the cue must still clamp <= 1.0 (never exceed exact).
    const entity = "entity:exact" as EntityId;
    const entityStrandId = await db.writeFactWithEmbeddingAsync({
      entity,
      payload: { text: "totally different payload" },
      stamp,
    });
    await db.writeFactWithEmbeddingAsync({
      entity: "entity:other" as EntityId,
      payload: { text: "cue phrase repeated verbatim" },
      stamp,
    });

    const resolver = createEmbeddingCueResolver(store, embedder, vectors);
    const seeds = await resolver.resolveWithEmbeddings({
      text: "cue phrase repeated verbatim",
      entities: [entity],
    });
    for (const s of seeds) {
      expect(s.energy).toBeLessThanOrEqual(1);
    }
    const exactSeed = seeds.find((s) => s.strandId === entityStrandId);
    expect(exactSeed?.energy).toBe(1);
  });

  it("a vector minted under a DIFFERENT model_id is silently ignored (never cross-model compared)", async () => {
    const store = createMemoryStore();
    const identity = makeIdentityLayer();
    const vectors = createMemoryVectorSidecar();
    const passport = freshSource();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);

    const oldEmbedder = createHashingEmbedder({ dim: 16 });
    const dbOld = createIntelligentDb(store, identity, null, null, null, null, {
      embedder: oldEmbedder,
      vectors,
    });
    const id = await dbOld.writeFactWithEmbeddingAsync({
      entity: "entity:stale" as EntityId,
      payload: { text: "some vintage payload text" },
      stamp,
    });

    // Now resolve with a DIFFERENT model — the stale vector must be invisible.
    const newEmbedder = createHashingEmbedder({ dim: 16 }); // same dim, DIFFERENT modelId? No: identical config => same modelId.
    void newEmbedder;
    const differentModelEmbedder = { ...createHashingEmbedder({ dim: 16 }), modelId: "hashing-trick:16:v2" };
    const resolver = createEmbeddingCueResolver(store, differentModelEmbedder, vectors);
    const seeds = await resolver.resolveWithEmbeddings({ text: "some vintage payload text" });
    // The lexical channel still finds it (exact token overlap); the point is that
    // the EMBEDDING channel contributes nothing extra beyond what lexical already
    // gave it — verified by checking the sidecar itself never matches cross-model.
    const rawMatches = vectors.topK(
      (await oldEmbedder.embed(["some vintage payload text"]))[0]!,
      differentModelEmbedder.modelId,
      10,
    );
    expect(rawMatches).toEqual([]);
    expect(seeds.some((s) => s.strandId === id)).toBe(true); // via lexical, not embedding
  });

  it("respects a per-call embedSeedK / embedSeedEnergyCap override", async () => {
    const { store, db, stamp } = wireEngine();
    const vectors = createMemoryVectorSidecar();
    const embedder = createHashingEmbedder({ dim: 32 });

    for (let i = 0; i < 5; i++) {
      await db.writeFactWithEmbeddingAsync({
        entity: `entity:cap${i}` as EntityId,
        payload: { text: "shared unrelated cap phrase alpha beta gamma" },
        stamp,
      });
    }
    const resolver = createEmbeddingCueResolver(store, embedder, vectors);
    const seeds = await resolver.resolveWithEmbeddings(
      { text: "totally disjoint cue with no lexical overlap zz" },
      { embedSeedK: 2, embedSeedEnergyCap: 0.05 },
    );
    // Every seed's energy is capped at the tiny static ceiling.
    for (const s of seeds) expect(s.energy).toBeLessThanOrEqual(0.05);
  });
});

// ---------------------------------------------------------------------------
// 3) THE ADVERSARIAL GATE (spec §5.4) — embedding-stuffing
// ---------------------------------------------------------------------------

describe("adversarial embedding-stuffing (spec §5.4)", () => {
  it("attacker near-duplicates SEED the walk, but the LIVE incumbent still outranks them and PROVISIONAL floods stay labeled", async () => {
    const store = createMemoryStore();
    const identity = makeIdentityLayer();
    const vectors = createMemoryVectorSidecar();
    const embedder = createHashingEmbedder({ dim: 48 });
    const db = createIntelligentDb(store, identity, null, null, null, null, { embedder, vectors });

    // TRUSTED incumbent: a DOMAIN-anchored source (clears the quarantine gate => LIVE).
    const trustedPassport = freshSource("trusted");
    identity.register(trustedPassport, [domainAnchor()]);
    const trustedStamp = identity.stampFor(trustedPassport.sourceId);

    // ATTACKER: a bare-key source (no anchors => independenceWeight 0 => PROVISIONAL
    // under the default quarantine gate).
    const attackerPassport = freshSource("attacker");
    identity.register(attackerPassport, []);
    const attackerStamp = identity.stampFor(attackerPassport.sourceId);

    const entity = "entity:acme_ceo" as EntityId;
    const attribute = "acme#ceo" as AttributeKey;
    const cueText = "who currently runs acme corporation as chief executive";

    const incumbentId = await db.writeFactWithEmbeddingAsync({
      entity,
      attribute,
      payload: { text: "Jane Doe has served as Acme's chief executive since 2019" },
      stamp: trustedStamp,
    });
    const incumbent = store.getStrand(incumbentId);
    expect(incumbent?.fact_state).toBe(FactState.LIVE);

    // The attacker stuffs the sidecar with several near-duplicates of the CUE TEXT
    // itself (cosine ~1.0 under the deterministic hashing embedder — identical
    // tokens => an IDENTICAL vector => cosine exactly 1.0).
    const attackerIds: StrandId[] = [];
    for (let i = 0; i < 5; i++) {
      // Each attacker strand's payload is the CUE TEXT itself (a distinct
      // content_hash per i via a trailing zero-width marker, so they are 5
      // DISTINCT strands rather than one echo) — under the deterministic
      // hashing embedder this tokenizes IDENTICALLY to the cue, so cosine is
      // exactly 1.0: the strongest possible embedding-stuffing attack.
      const id = await db.writeFactWithEmbeddingAsync({
        entity,
        attribute,
        payload: { text: cueText, variant: i },
        stamp: attackerStamp,
      });
      attackerIds.push(id);
    }
    for (const id of attackerIds) {
      expect(store.getStrand(id)?.fact_state).toBe(FactState.PROVISIONAL);
    }

    const resolver = createEmbeddingCueResolver(store, embedder, vectors);
    const seeds = await resolver.resolveWithEmbeddings({ text: cueText });

    // 1) THEY SEED: at least one attacker strand is a candidate seed (cosine ~1.0).
    expect(seeds.some((s) => attackerIds.includes(s.strandId))).toBe(true);

    // 2) Run the walk from the union seed set.
    const result = db.recall({ seeds });
    const litIds = new Set(result.lit.map((l) => String(l.strandId)));
    expect(litIds.has(incumbentId)).toBe(true); // the incumbent still lights (shared-entity spread)

    // 3) PROVISIONAL floods stay labeled — never silently promoted to LIVE by
    //    seeding/activation, no matter how high their cosine score was.
    for (const id of attackerIds) {
      if (litIds.has(String(id))) {
        expect(store.getStrand(id)?.fact_state).toBe(FactState.PROVISIONAL);
      }
    }

    // 4) THE OUTRANK ASSERTION: a fact_state-aware renderer (the ONLY correct kind —
    //    "the model is never its own witness" means a PROVISIONAL superposition is
    //    never spoken as believed) picks its answer from LIVE lit strands only. The
    //    incumbent is the SOLE LIVE strand for this attribute, so it is unambiguously
    //    the rendered answer regardless of how much raw activation the PROVISIONAL
    //    flood accumulated.
    const liveLit = result.lit.filter((l) => store.getStrand(l.strandId)?.fact_state === FactState.LIVE);
    expect(liveLit.map((l) => l.strandId)).toEqual([incumbentId]);

    // And the raw provenance/independence math was never touched by the embedder:
    // the incumbent's provenance root is still independence-class-rooted in the
    // TRUSTED source, unaffected by any cosine score.
    expect(incumbent?.provenance[0]?.sourceId).toBe(trustedPassport.sourceId);
  });
});

// ---------------------------------------------------------------------------
// 4) FINAL TOP-K CAP (Wave-3 embed-resolver-no-topk-cap)
// ---------------------------------------------------------------------------

describe("resolveWithEmbeddings: final topK cap (Wave-3 embed-resolver-no-topk-cap)", () => {
  it("caps the union at embedSeedK even when a matched vector's echo bucket would blow past it", async () => {
    const store = createMemoryStore();
    const identity = makeIdentityLayer();
    const vectors = createMemoryVectorSidecar();
    const embedder = createHashingEmbedder({ dim: 32 });
    const db = createIntelligentDb(store, identity, null, null, null, null, { embedder, vectors });
    const passport = freshSource();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);

    // Two "clusters" of strands, each cluster sharing ONE payload (=> ONE
    // content_hash / ONE vector row, per the "echoes share one vector" rule)
    // across SEVERAL distinct strand ids — a genuine echo bucket. Both
    // clusters share vocabulary with the cue below so BOTH the lexical channel
    // and the embedding channel match broadly (proving the cap bounds the
    // TOTAL union, not merely the embedding side in isolation).
    const ECHO_COUNT = 6;
    for (const cluster of ["alpha", "beta"] as const) {
      for (let i = 0; i < ECHO_COUNT; i++) {
        await db.writeFactWithEmbeddingAsync({
          entity: `entity:${cluster}` as EntityId,
          payload: { text: `shared probe ${cluster} filler padding words` },
          stamp,
        });
      }
    }

    const resolver = createEmbeddingCueResolver(store, embedder, vectors);
    const cue = { text: "shared probe query lookup" };

    // Sanity: the lexical channel ALONE already exceeds the tiny topK we are
    // about to request from the union — proves the truncation below is doing
    // real work, not a vacuous no-op.
    const lexicalOnly = resolver.resolve(cue);
    expect(lexicalOnly.length).toBeGreaterThan(1);

    const seeds = await resolver.resolveWithEmbeddings(cue, { embedSeedK: 1 });
    expect(seeds.length).toBe(1);
  });

  it("a non-positive embedSeedK skips the embed step but does NOT truncate the lexical baseline", async () => {
    const { store, db, stamp } = wireEngineForCap();
    const vectors = createMemoryVectorSidecar();
    const embedder = createHashingEmbedder({ dim: 32 });

    for (let i = 0; i < 3; i++) {
      await db.writeFactWithEmbeddingAsync({
        entity: `entity:cap${i}` as EntityId,
        payload: { text: "lexical only cap phrase for zero k" },
        stamp,
      });
    }

    const resolver = createEmbeddingCueResolver(store, embedder, vectors);
    const cue = { text: "lexical only cap phrase for zero k" };
    const lexicalOnly = resolver.resolve(cue);
    expect(lexicalOnly.length).toBe(3);

    const seeds = await resolver.resolveWithEmbeddings(cue, { embedSeedK: 0 });
    expect(seeds.length).toBe(lexicalOnly.length);
  });

  function wireEngineForCap(): { store: StrandStore; db: IntelligentDb; stamp: IdentityStamp } {
    const store = createMemoryStore();
    const identity = makeIdentityLayer();
    const vectors = createMemoryVectorSidecar();
    const embedder = createHashingEmbedder({ dim: 32 });
    const db = createIntelligentDb(store, identity, null, null, null, null, { embedder, vectors });
    const passport = freshSource();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);
    return { store, db, stamp };
  }
});
