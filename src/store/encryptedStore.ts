/**
 * store/encryptedStore.ts — VALUE-LEVEL AES-256-GCM ENCRYPTION AT REST.
 *
 * `docs/specs/PHASE2_DURABILITY_SPEC.md` §3. This is a {@link StrandStore} ADAPTER,
 * not a new backend: {@link createEncryptedStore} wraps an existing store (the
 * in-memory backend, the durable SQLite backend, or any future one) and encrypts
 * exactly the CONTENT a strand carries — {@link Strand.payload} — before it ever
 * reaches the inner store, decrypting it back on every read. `store/sqliteStore.ts`
 * is not modified; this module composes with it entirely through the public
 * {@link StrandStore} contract (a pure Proxy composition — see below).
 *
 * WHAT IS ENCRYPTED vs WHAT STAYS PLAINTEXT (spec §3, stated loudly, on purpose):
 *   - ENCRYPTED: {@link Strand.payload} — the "opaque human/agent-readable payload
 *     of the claim" (core/types.ts). This is the one field this codebase's data
 *     model treats as CONTENT rather than graph shape.
 *   - PLAINTEXT (by design, never touched here): `id`, `content_hash`, `entity` /
 *     `attribute` (the seed-index keys the store indexes on), `origin`,
 *     `fact_state`, `tier`, `provenance` (root ids / independence-class ids /
 *     source ids — identity metadata, not fact content), `bridge`, `salience`,
 *     `description_value`, timestamps, and every {@link Edge} field. All of this is
 *     metadata the engine's indexing/traversal/trust machinery needs to operate
 *     without the key; encrypting it would either break `strandsByEntity` /
 *     `strandsByAttribute` (the seed indexes) or the share-normalization /
 *     adjudication machinery that reads edge weights and provenance untouched.
 *     This IS "value-level encryption, not full-file" exactly as the spec states —
 *     full-file secrecy (hiding the graph shape too) is OS-level FDE / SQLCipher
 *     territory and stays out of scope.
 *   - NOTE ON EDGES: the spec's generic phrasing also names "edge annotations" as
 *     content to encrypt. This codebase's {@link Edge} shape (core/types.ts) carries
 *     no free-text annotation field today — only numeric weights and structural
 *     ids, all of which are load-bearing traversal metadata — so there is currently
 *     nothing on an edge to encrypt. If a future edge gains a free-text annotation
 *     field, extend this adapter's edge path the same way `encryptStrand` handles
 *     `payload` today.
 *   - NOTE ON THE AUDIT CHAIN: `ratification/pendingLedger.ts`'s `verifyChain()` is
 *     untouched by this module and needs no key — it never embeds a strand's
 *     `payload` into its hash preimage (see `explain()` in `api.ts`, which reads
 *     `strand.payload` only for the facade's OWN return value, not for anything
 *     the ledger hashes). The chain hashes ledger-record shapes (contradiction-set
 *     ids, approvals, mutation receipts) that are already metadata, not content —
 *     so `verifyChain()` continues to work keyless on an encrypted database exactly
 *     as the spec describes, with zero changes required here.
 *
 * NONCE CEILING (`gcm-random-nonce-no-ceiling`, Wave 3 polish): each encryption
 * picks a fresh RANDOM 96-bit nonce (`randomBytes(GCM_IV_BYTES)`), never a
 * counter — the standard, simplest-to-get-right choice for a store where many
 * independent callers/processes could otherwise race a shared counter. Random
 * nonces are safe under AES-GCM only below a volume ceiling: NIST SP 800-38D's
 * birthday-bound guidance says a single key should not encrypt more than ~2^32
 * messages with random 96-bit IVs before the chance of an accidental nonce
 * collision (which breaks GCM's authentication AND confidentiality) stops being
 * negligible. This module now ENFORCES that bound rather than merely documenting
 * it: {@link createEncryptedStore}'s optional third argument tracks a running
 * encryption count per resolved key (fingerprinted by sha256, never the raw key
 * bytes) and (a) calls an optional `onApproachingNonceCeiling` hook once, edge-
 * triggered, when the count first crosses a configurable warn fraction (default
 * 50%) of the ceiling — the "rotate soon" signal — and (b) THROWS a typed
 * {@link NonceCeilingExceededError} and refuses to perform the encryption at all
 * once the count would reach the ceiling (default 2**32) — fail-closed, exactly
 * this codebase's discipline elsewhere: a caller must rotate `keyProvider()` to a
 * fresh key (an entirely live operation — see the module doc above) rather than
 * silently keep spending random nonces past the safe volume. The counter is keyed
 * per resolved key fingerprint, not globally, so rotating the key resets the
 * clock for the new key exactly as it should.
 *
 * FORMAT: each encrypted value is `iv (12B) || tag (16B) || ciphertext`, base64-
 * encoded into a small JSON envelope stored AS the strand's `payload` cell (so it
 * round-trips through the inner store's existing JSON persistence untouched).
 * AAD = the row's STABLE IDENTITY (`Strand.id`), so a ciphertext blob copied onto a
 * different row's `payload` fails authentication — GCM catches the swap, not just a
 * bit-flip.
 *
 * KEY SOURCING: `keyProvider: () => Buffer` (32 bytes, called on every op — a
 * rotated key takes effect immediately with no restart) is the caller's job. This
 * module ships NO key sourcing of its own; `src/examples/encryptionKeyProvider.ts`
 * has a reference env-var provider, EXAMPLE ONLY (not exported from the package
 * barrel) — real deployments should prefer an OS keychain / KMS.
 *
 * ZERO new runtime dependencies: `node:crypto` (Node stdlib) only.
 *
 * COMPOSITION MECHANISM: a {@link Proxy} over `inner` intercepts exactly the seven
 * methods that can hand back or accept a `Strand` (`getStrand`, `putStrand`,
 * `putStrandsBatch`, `neighbors`, `strandsByEntity`, `strandsByAttribute`,
 * `allStrands`); every other property (`getEdge`, `putEdge`, `outEdges`, `inEdges`,
 * `allEdges`, `recomputeOutWeightSum`, and the SQLite-only widening members
 * `close` / `beginTxn` / `integrityCheck` / `putEdgesBatch`) is forwarded to `inner`
 * UNCHANGED, with `this` rebound to `inner` so a class instance's private (`#`)
 * fields keep working through the proxy. This is why `createEncryptedStore` is
 * generic over `S extends StrandStore` and returns exactly `S`: wrap a
 * {@link SqliteStrandStore} and you get back something that still satisfies
 * {@link SqliteStrandStore} (transactions, integrity check, batch edges, close),
 * unmodified — only the strand payload path is intercepted.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type {
  AttributeKey,
  EntityId,
  Strand,
  StrandId,
} from "../core/types.js";
import type { NeighborView, StrandStore } from "./StrandStore.js";

// ---------------------------------------------------------------------------
// Key provider contract
// ---------------------------------------------------------------------------

/**
 * Supplies the 32-byte AES-256 key on demand. Called on every encrypt/decrypt —
 * cheap key rotation (swap what the closure returns; no store restart needed).
 * Sourcing (env var, OS keychain, KMS) is the deployment's job; this module never
 * caches or persists the returned key.
 */
export type KeyProvider = () => Buffer;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Why an encrypted-store operation refused to produce plaintext. */
export type EncryptedStoreErrorReason =
  /** GCM authentication failed: wrong key, or the ciphertext/AAD was tampered with. */
  | "AUTH_FAILED"
  /** The stored `payload` cell is not a recognized encrypted envelope. */
  | "MALFORMED_CIPHERTEXT"
  /** `keyProvider()` did not return a 32-byte Buffer. */
  | "INVALID_KEY_LENGTH";

/**
 * A typed, named integrity error from the encrypted store. NEVER a raw crash: a
 * wrong key or a flipped ciphertext byte surfaces as one of these, naming the row
 * (`rowId` — the strand id whose `payload` failed to decrypt), so a caller can log
 * or alert on exactly which record is unreadable without a partial/garbage read
 * ever escaping this module.
 */
export class EncryptedStoreIntegrityError extends Error {
  readonly reason: EncryptedStoreErrorReason;
  readonly rowId: string;

  constructor(rowId: string, reason: EncryptedStoreErrorReason, message: string) {
    super(message);
    this.name = "EncryptedStoreIntegrityError";
    this.reason = reason;
    this.rowId = rowId;
  }
}

/**
 * Thrown by {@link createEncryptedStore}'s write path when the resolved key
 * (identified only by its sha256 `keyFingerprint`, never raw bytes) has already
 * performed `encryptionCount` AES-256-GCM encryptions with random 96-bit
 * nonces — at or beyond `maxEncryptionsPerKey` (see the module doc's NONCE
 * CEILING section). Refusing here is a fail-closed safety measure, not a data
 * error: the fix is to rotate `keyProvider()` to return a fresh key (a live
 * swap, no restart needed — see the module doc) and retry.
 */
export class NonceCeilingExceededError extends Error {
  readonly keyFingerprint: string;
  readonly encryptionCount: number;
  readonly maxEncryptionsPerKey: number;

  constructor(keyFingerprint: string, encryptionCount: number, maxEncryptionsPerKey: number) {
    super(
      `createEncryptedStore: refusing to encrypt — key fingerprint ${keyFingerprint} has already ` +
        `performed ${String(encryptionCount)} AES-256-GCM encryptions with random 96-bit nonces, at ` +
        `or beyond the configured safe ceiling of ${String(maxEncryptionsPerKey)} (NIST SP 800-38D's ` +
        `random-IV birthday bound). Rotate keyProvider() to a fresh key to continue — it takes effect ` +
        `immediately, no restart required.`,
    );
    this.name = "NonceCeilingExceededError";
    this.keyFingerprint = keyFingerprint;
    this.encryptionCount = encryptionCount;
    this.maxEncryptionsPerKey = maxEncryptionsPerKey;
  }
}

// ---------------------------------------------------------------------------
// Nonce-volume ceiling tracking (gcm-random-nonce-no-ceiling)
// ---------------------------------------------------------------------------

/** NIST SP 800-38D's documented safe volume for AES-GCM with random 96-bit IVs. */
export const DEFAULT_MAX_ENCRYPTIONS_PER_KEY = 2 ** 32;

/** Fraction of {@link DEFAULT_MAX_ENCRYPTIONS_PER_KEY} at which the approaching-ceiling hook fires by default. */
export const DEFAULT_NONCE_CEILING_WARN_FRACTION = 0.5;

/** Info passed to {@link EncryptedStoreCeilingOptions.onApproachingNonceCeiling}. */
export interface ApproachingNonceCeilingInfo {
  /** sha256 fingerprint of the resolved key — never the raw key bytes. */
  readonly keyFingerprint: string;
  /** Encryptions performed so far under this key (through this store instance). */
  readonly encryptionCount: number;
  readonly maxEncryptionsPerKey: number;
}

/** Configures the per-key GCM nonce-volume ceiling (module doc's NONCE CEILING section). */
export interface EncryptedStoreCeilingOptions {
  /**
   * Hard ceiling on encryptions performed under the SAME resolved key before
   * this adapter refuses to encrypt further, throwing
   * {@link NonceCeilingExceededError}. Default {@link DEFAULT_MAX_ENCRYPTIONS_PER_KEY}
   * (2**32 — NIST SP 800-38D's random-96-bit-IV safe bound). Lower this only to
   * exercise the ceiling logic in tests; production callers should rotate the
   * key long before the default fires.
   */
  readonly maxEncryptionsPerKey?: number;
  /**
   * Fraction of `maxEncryptionsPerKey` at which {@link onApproachingNonceCeiling}
   * fires. Default {@link DEFAULT_NONCE_CEILING_WARN_FRACTION} (0.5).
   */
  readonly warnAtFraction?: number;
  /**
   * Called ONCE (edge-triggered, not level-triggered — a hot write loop never
   * spams this) per key, the moment its running encryption count first crosses
   * `warnAtFraction * maxEncryptionsPerKey`. This is the "rotate soon" signal,
   * strictly before the hard ceiling above starts refusing writes. Omitted by
   * default (no-op) — deployments that care wire logging/alerting here.
   */
  readonly onApproachingNonceCeiling?: (info: ApproachingNonceCeilingInfo) => void;
}

/** Per-store-instance nonce-ceiling bookkeeping, keyed by key fingerprint (never raw key bytes). */
interface NonceCeilingTracker {
  readonly maxEncryptionsPerKey: number;
  readonly warnAtFraction: number;
  readonly onApproachingNonceCeiling?: ((info: ApproachingNonceCeilingInfo) => void) | undefined;
  readonly counts: Map<string, number>;
  readonly warned: Set<string>;
}

function makeNonceCeilingTracker(opts?: EncryptedStoreCeilingOptions): NonceCeilingTracker {
  return {
    maxEncryptionsPerKey: opts?.maxEncryptionsPerKey ?? DEFAULT_MAX_ENCRYPTIONS_PER_KEY,
    warnAtFraction: opts?.warnAtFraction ?? DEFAULT_NONCE_CEILING_WARN_FRACTION,
    onApproachingNonceCeiling: opts?.onApproachingNonceCeiling,
    counts: new Map(),
    warned: new Set(),
  };
}

/**
 * Fingerprint `key` (sha256, hex) and account for ONE encryption about to
 * happen under it. Throws {@link NonceCeilingExceededError} BEFORE performing
 * any crypto work if the key is already at/over its ceiling (fail-closed — no
 * wasted encryption, no nonce spent). Otherwise records the encryption and, on
 * the call where the running count first crosses the warn fraction, fires
 * `tracker.onApproachingNonceCeiling` exactly once for this key.
 */
function accountForEncryption(key: Buffer, tracker: NonceCeilingTracker): void {
  const fingerprint = createHash("sha256").update(key).digest("hex");
  const current = tracker.counts.get(fingerprint) ?? 0;
  if (current >= tracker.maxEncryptionsPerKey) {
    throw new NonceCeilingExceededError(fingerprint, current, tracker.maxEncryptionsPerKey);
  }
  const next = current + 1;
  tracker.counts.set(fingerprint, next);
  const warnAt = Math.ceil(tracker.maxEncryptionsPerKey * tracker.warnAtFraction);
  if (next >= warnAt && !tracker.warned.has(fingerprint)) {
    tracker.warned.add(fingerprint);
    tracker.onApproachingNonceCeiling?.({
      keyFingerprint: fingerprint,
      encryptionCount: next,
      maxEncryptionsPerKey: tracker.maxEncryptionsPerKey,
    });
  }
}

// ---------------------------------------------------------------------------
// AES-256-GCM primitives — iv(12) || tag(16) || ciphertext
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const AES_256_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const ENVELOPE_ALG = "AES-256-GCM" as const;

/** The JSON-safe shape a strand's `payload` cell holds once encrypted. */
interface EncryptedPayloadEnvelope {
  readonly __idbEncrypted: true;
  readonly alg: typeof ENVELOPE_ALG;
  /** base64(iv || tag || ciphertext). */
  readonly blob: string;
}

function isEnvelope(v: unknown): v is EncryptedPayloadEnvelope {
  if (typeof v !== "object" || v === null) return false;
  const rec = v as Record<string, unknown>;
  return rec["__idbEncrypted"] === true && typeof rec["blob"] === "string";
}

/** Validate the key length up front so a misconfigured provider fails loudly and
 * by name, rather than surfacing as an opaque `node:crypto` throw deep inside. */
function requireKey(keyProvider: KeyProvider): Buffer {
  const key = keyProvider();
  if (!Buffer.isBuffer(key) || key.length !== AES_256_KEY_BYTES) {
    throw new EncryptedStoreIntegrityError(
      "<keyProvider>",
      "INVALID_KEY_LENGTH",
      `createEncryptedStore: keyProvider() must return a ${AES_256_KEY_BYTES}-byte ` +
        `Buffer (an AES-256 key); got ${
          Buffer.isBuffer(key) ? `a ${key.length}-byte Buffer` : typeof key
        }.`,
    );
  }
  return key;
}

/** AAD = the row's stable identity, so a ciphertext cannot be swapped onto another
 * row's payload cell without GCM authentication catching it. */
function aadFor(id: StrandId): Buffer {
  return Buffer.from(String(id), "utf8");
}

function encryptValue(plaintext: Buffer, aad: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/** Decrypt `iv || tag || ciphertext`. On any authentication failure (wrong key OR a
 * flipped ciphertext/tag byte OR a mismatched AAD from a row swap) throws a named
 * {@link EncryptedStoreIntegrityError} with `reason: "AUTH_FAILED"` — never a raw
 * crash, never a silently-wrong plaintext (GCM cannot produce one: forged
 * ciphertext fails `final()` before any bytes are trusted). */
function decryptValue(blob: Buffer, aad: Buffer, key: Buffer, rowId: string): Buffer {
  if (blob.length < GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new EncryptedStoreIntegrityError(
      rowId,
      "MALFORMED_CIPHERTEXT",
      `encrypted store: ciphertext for row ${rowId} is shorter than IV+tag ` +
        `(${GCM_IV_BYTES + GCM_TAG_BYTES} bytes) — not a value this adapter wrote.`,
    );
  }
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(aad);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new EncryptedStoreIntegrityError(
      rowId,
      "AUTH_FAILED",
      `encrypted store: GCM authentication failed for row ${rowId} (wrong key, or ` +
        `the ciphertext was tampered with / swapped with another row's at rest).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Strand payload encrypt/decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt `s.payload` into an {@link EncryptedPayloadEnvelope}; every other field
 * of `s` is returned UNCHANGED (plaintext by design — see the module doc). The
 * payload is wrapped as `{ payload: s.payload }` before serializing so `undefined`
 * round-trips faithfully through `JSON.stringify`/`JSON.parse` exactly like every
 * other JSON value (a bare top-level `undefined` is not valid JSON on its own).
 *
 * `tracker` accounts for the ONE random nonce this call is about to spend under
 * the resolved key — see {@link accountForEncryption} — and throws
 * {@link NonceCeilingExceededError} before any crypto work if that key is
 * already at/over its configured ceiling (module doc's NONCE CEILING section).
 */
function encryptStrand(s: Strand, keyProvider: KeyProvider, tracker: NonceCeilingTracker): Strand {
  const key = requireKey(keyProvider);
  accountForEncryption(key, tracker);
  const plaintext = Buffer.from(JSON.stringify({ payload: s.payload }), "utf8");
  const blob = encryptValue(plaintext, aadFor(s.id), key);
  const envelope: EncryptedPayloadEnvelope = {
    __idbEncrypted: true,
    alg: ENVELOPE_ALG,
    blob: blob.toString("base64"),
  };
  return { ...s, payload: envelope };
}

/** Inverse of {@link encryptStrand}. Throws {@link EncryptedStoreIntegrityError} if
 * `s.payload` is not a recognized envelope, if the key is malformed, or if GCM
 * authentication fails. */
function decryptStrand(s: Strand, keyProvider: KeyProvider): Strand {
  if (!isEnvelope(s.payload)) {
    throw new EncryptedStoreIntegrityError(
      String(s.id),
      "MALFORMED_CIPHERTEXT",
      `encrypted store: strand ${String(s.id)} does not carry a recognized ` +
        `encrypted payload envelope (was it written without createEncryptedStore?).`,
    );
  }
  const key = requireKey(keyProvider);
  const blob = Buffer.from(s.payload.blob, "base64");
  const plaintext = decryptValue(blob, aadFor(s.id), key, String(s.id));
  const parsed = JSON.parse(plaintext.toString("utf8")) as { payload: unknown };
  return { ...s, payload: parsed.payload };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Wrap `inner` in a value-level AES-256-GCM encryption adapter. Returns something
 * satisfying the SAME concrete type as `inner` (pass a {@link SqliteStrandStore},
 * get back a fully-functional {@link SqliteStrandStore} — `close`/`beginTxn`/
 * `integrityCheck`/`putEdgesBatch` all keep working, forwarded untouched).
 *
 * Every read that can hand back a {@link Strand} decrypts its `payload`; every
 * write that accepts one encrypts it before it reaches `inner`. Everything else
 * (edges, adjacency, the seed indexes' KEYS, transactions, integrity checks) is
 * forwarded unchanged — the store never sees the plaintext content, and the
 * engine never has to change how it talks to the store.
 *
 * `ceiling` configures the per-key GCM nonce-volume ceiling (module doc's
 * NONCE CEILING section) — omit it to accept the documented safe default
 * (2**32 encryptions per resolved key before a hard refusal).
 *
 * @example
 *   const store = createEncryptedStore(createSqliteStore(path), () => aes256Key);
 *   const db = createIntelligentDb(store, identity); // drop-in, unchanged
 */
export function createEncryptedStore<S extends StrandStore>(
  inner: S,
  keyProvider: KeyProvider,
  ceiling?: EncryptedStoreCeilingOptions,
): S {
  const tracker = makeNonceCeilingTracker(ceiling);
  const overrides: Partial<StrandStore> = {
    getStrand(id: StrandId): Strand | null {
      const s = inner.getStrand(id);
      return s === null ? null : decryptStrand(s, keyProvider);
    },

    putStrand(s: Strand): void {
      inner.putStrand(encryptStrand(s, keyProvider, tracker));
    },

    putStrandsBatch(strands: Iterable<Strand>): void {
      const encrypted: Strand[] = [];
      for (const s of strands) encrypted.push(encryptStrand(s, keyProvider, tracker));
      inner.putStrandsBatch(encrypted);
    },

    neighbors(id: StrandId): NeighborView[] {
      return inner.neighbors(id).map((v) => ({
        edge: v.edge,
        strand: decryptStrand(v.strand, keyProvider),
      }));
    },

    strandsByEntity(entity: EntityId): Strand[] {
      return inner.strandsByEntity(entity).map((s) => decryptStrand(s, keyProvider));
    },

    strandsByAttribute(attr: AttributeKey): Strand[] {
      return inner.strandsByAttribute(attr).map((s) => decryptStrand(s, keyProvider));
    },

    allStrands(): Iterable<Strand> {
      function* gen(): Iterable<Strand> {
        for (const s of inner.allStrands()) yield decryptStrand(s, keyProvider);
      }
      return gen();
    },
  };

  return new Proxy(inner, {
    get(target, prop, _receiver): unknown {
      if (typeof prop === "string" && Object.hasOwn(overrides, prop)) {
        return (overrides as Record<string, unknown>)[prop];
      }
      // Pass-through: bind `this` to the REAL target (not the proxy) so a backend
      // whose methods close over private (`#`) fields keep working when invoked
      // through the wrapper.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
