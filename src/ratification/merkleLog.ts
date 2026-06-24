/**
 * ratification/merkleLog.ts — MERKLE-ANCHORED, EXTERNALLY-WITNESSED TAMPER-EVIDENCE.
 *
 * Roadmap item 2 (ARCHITECTURE.md §3 "Merkle tree + published root"). This module
 * LAYERS a Certificate-Transparency-style (RFC 6962) Merkle log ON TOP of the
 * existing append-only, Ed25519-signed, hash-CHAINED {@link PendingLedger}. The chain
 * gives total order cheaply and `verifyChain()` detects edits/reorders GIVEN a trusted
 * latest hash — but it cannot prove inclusion or consistency, and a server operator can
 * DELETE or ROLL BACK the whole log undetectably. The Merkle layer fixes exactly that.
 *
 * PURELY ADDITIVE. We never edit `pendingLedger.ts`'s chain, records, or persistence;
 * we only READ `ledger.records()` and re-derive every leaf from the SAME canonical
 * preimage the chain already commits to ({@link recordPreimage}) — so a Merkle leaf is
 * byte-identical to what `verifyChain` already protects. The Merkle tree is RECOMPUTED
 * on demand from the records (the records ARE the leaves — single source of truth, no
 * desync possible). Only the Signed Tree Heads (the witness artifact the operator
 * cannot recompute away) are persisted.
 *
 * RFC 6962 DOMAIN SEPARATION (the core correctness invariant): a leaf and an interior
 * node are NEVER hashed the same way.
 *   leafHash(rec)  = sha256( 0x00 ‖ utf8(recordPreimage(rec)) )
 *   nodeHash(l, r) = sha256( 0x01 ‖ l ‖ r )     over the RAW 32-byte digests
 *   empty root     = sha256( "" )
 * Hashes are carried as lowercase-hex STRINGS everywhere (matching the codebase's
 * convention and keeping proofs/STHs plain JSON); the 0x01 concat operates on the
 * decoded 32 raw bytes, never the hex text.
 *
 * THE GUARANTEE (precise, stated once, here):
 *   Given an authentic published STH from an independent witness, ANY deletion,
 *   rollback, reordering, post-anchor truncation, or split-view of the ledger is
 *   DETECTABLE. This is DETECTION, not prevention; it still assumes an uncompromised
 *   log-signer key. (A holder of a valid signer key can re-sign a coherent forged tree
 *   from genesis — the external witness is what removes the operator's freedom to do so
 *   silently, because the operator cannot un-publish an STH a witness already holds.)
 *
 * STACK NOTE: ESM + NodeNext (relative imports carry `.js`); `verbatimModuleSyntax`
 * (every type-only import uses `import type`); `node:crypto` only, no external deps.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type { EpochMs } from "../core/types.js";

import { sign, verify, sourceIdFromPublicKey } from "../identity/keys.js";
import type { KeyPair } from "../identity/keys.js";

import type { LedgerRecord, PendingLedger } from "./pendingLedger.js";
import { recordPreimage } from "./pendingLedger.js";

// ---------------------------------------------------------------------------
// Hash primitives (RFC 6962 domain separation; hex-string carried)
// ---------------------------------------------------------------------------

/** A SHA-256 digest as lowercase hex (64 chars). The proof / tree currency. */
export type Hash = string;

/** Decode a 64-char hex digest to its 32 raw bytes. */
function hexToBytes(hex: Hash): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/** sha256 of raw bytes, hex. */
function sha256BytesHex(bytes: Uint8Array): Hash {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 of a UTF-8 string, hex. */
function sha256Utf8Hex(s: string): Hash {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * RFC 6962 §2.1 leaf hash: `sha256(0x00 ‖ leafPreimage)`. The 0x00 prefix is the
 * domain separator that makes a leaf un-confusable with an interior node.
 */
export function leafHashOfPreimage(preimage: string): Hash {
  const body = Buffer.from(preimage, "utf8");
  const buf = Buffer.concat([Buffer.from([0x00]), body]);
  return sha256BytesHex(new Uint8Array(buf));
}

/** The leaf hash of a ledger record (over the chain-committed canonical preimage). */
export function leafHashOf(rec: LedgerRecord): Hash {
  return leafHashOfPreimage(recordPreimage(rec));
}

/**
 * RFC 6962 §2.1 interior node hash: `sha256(0x01 ‖ left ‖ right)` over the RAW
 * 32-byte child digests (decoded from their hex), NOT their hex text.
 */
export function nodeHash(left: Hash, right: Hash): Hash {
  const buf = Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from(hexToBytes(left)),
    Buffer.from(hexToBytes(right)),
  ]);
  return sha256BytesHex(new Uint8Array(buf));
}

/** The RFC 6962 root of the EMPTY tree: `sha256("")`. */
export const EMPTY_TREE_ROOT: Hash = sha256Utf8Hex("");

/** Constant-time equality over two hex digests (length-checked first). */
function hashEqual(a: Hash, b: Hash): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Largest power of two STRICTLY LESS THAN n (the RFC 6962 split point `k`, n > 1). */
function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

// ---------------------------------------------------------------------------
// Merkle tree math (RFC 6962 §2.1: MTH, §2.1.1: PATH, §2.1.2: PROOF/SUBPROOF)
// ---------------------------------------------------------------------------

/**
 * RFC 6962 Merkle Tree Hash (MTH) over `leaves[lo, hi)`. Empty ⇒ {@link EMPTY_TREE_ROOT};
 * one leaf ⇒ that leaf hash; otherwise split at the largest power of two below the
 * span and combine the two subtree roots. O(n) with the leaf hashes already in hand.
 */
function mth(leaves: readonly Hash[], lo: number, hi: number): Hash {
  const n = hi - lo;
  if (n === 0) return EMPTY_TREE_ROOT;
  if (n === 1) return leaves[lo]!;
  const k = largestPowerOfTwoBelow(n);
  return nodeHash(mth(leaves, lo, lo + k), mth(leaves, lo + k, hi));
}

/**
 * RFC 6962 PATH(m, D[lo,hi)) — the inclusion-proof path for leaf index `m` (relative
 * to the whole tree) within the subtree spanning `[lo, hi)`. Returns the sibling
 * subtree roots from the leaf up to the subtree root.
 */
function path(leaves: readonly Hash[], m: number, lo: number, hi: number): Hash[] {
  const n = hi - lo;
  if (n === 1) return [];
  const k = largestPowerOfTwoBelow(n);
  if (m - lo < k) {
    // m is in the left subtree; sibling is the right subtree root.
    const sub = path(leaves, m, lo, lo + k);
    sub.push(mth(leaves, lo + k, hi));
    return sub;
  }
  // m is in the right subtree; sibling is the left subtree root.
  const sub = path(leaves, m, lo + k, hi);
  sub.push(mth(leaves, lo, lo + k));
  return sub;
}

/**
 * RFC 6962 SUBPROOF(m, D[lo,hi), b) — the recursive core of the consistency proof for
 * a prior tree of size `m` within the subtree `[lo, hi)`. `b` is true while we are on
 * the path that still includes the OLD tree's right edge (the first call has b=true).
 */
function subproof(
  leaves: readonly Hash[],
  m: number,
  lo: number,
  hi: number,
  b: boolean,
): Hash[] {
  const n = hi - lo;
  if (m === n) {
    // The old tree is exactly this subtree. If b, it is a perfect prior subtree and
    // we emit nothing; otherwise the verifier needs this subtree's root.
    return b ? [] : [mth(leaves, lo, hi)];
  }
  const k = largestPowerOfTwoBelow(n);
  if (m <= k) {
    // The old tree lives entirely in the left subtree; recurse left, then append the
    // right subtree root (always needed to rebuild the new tree's root).
    const sub = subproof(leaves, m, lo, lo + k, b);
    sub.push(mth(leaves, lo + k, hi));
    return sub;
  }
  // The old tree spans into the right subtree; the left subtree is a perfect prior
  // subtree (b becomes false), then recurse right for the remainder.
  const sub = subproof(leaves, m - k, lo + k, hi, false);
  sub.push(mth(leaves, lo, lo + k));
  return sub;
}

// ---------------------------------------------------------------------------
// Proof shapes
// ---------------------------------------------------------------------------

/**
 * An RFC 6962 inclusion proof: leaf `leafIndex` is in a tree of size `treeSize` whose
 * root the verifier holds. `path` is the bottom-up list of sibling hashes (O(log n)).
 */
export interface InclusionProof {
  readonly leafIndex: number;
  readonly treeSize: number;
  readonly path: readonly Hash[];
}

// ---------------------------------------------------------------------------
// Signed Tree Head (the epoch witness artifact)
// ---------------------------------------------------------------------------

/**
 * A Signed Tree Head: the log's signed commitment that, at `timestamp`, the tree had
 * `tree_size` leaves and Merkle `root`. `sig` is an Ed25519 signature (base64url) by
 * the LOG SIGNER over `sha256(canonical(tree_size ‖ root ‖ timestamp))`. Two validly
 * signed STHs with the same `tree_size` but different `root` are NON-REPUDIABLE proof
 * the operator equivocated (split view).
 */
export interface STH {
  readonly tree_size: number;
  readonly root: Hash;
  readonly timestamp: EpochMs;
  /** Detached Ed25519 signature over utf8(sthDigest), base64url. */
  readonly sig: string;
  /** The log signer's source id (so a verifier can pin which key must verify). */
  readonly logSourceId: string;
}

/**
 * The canonical, hand-ordered preimage an STH's signature commits to (NEVER free-form
 * `JSON.stringify`). The leading "STH" tag domain-separates it from any other signed
 * artifact; the `‖`-equivalent unit separator is a char no hex/number/id contains.
 */
function sthDigest(tree_size: number, root: Hash, timestamp: EpochMs): Hash {
  return sha256Utf8Hex(
    ["STH", String(tree_size), root, String(timestamp)].join("␟"),
  );
}

/**
 * Sign an STH over the tree's current state. `signer` is the LOG key (reuse the same
 * passport that signs the chain). Pure: it does not publish.
 */
export function signTreeHead(
  signer: KeyPair,
  tree_size: number,
  root: Hash,
  timestamp: EpochMs,
): STH {
  const digest = sthDigest(tree_size, root, timestamp);
  const sigBytes = sign(signer.privateKeyPem, new Uint8Array(Buffer.from(digest, "utf8")));
  return {
    tree_size,
    root,
    timestamp,
    sig: Buffer.from(sigBytes).toString("base64url"),
    logSourceId: signer.sourceId as unknown as string,
  };
}

/**
 * Verify an STH's signature against the log's public key PEM. Recomputes the canonical
 * digest and checks the Ed25519 signature; also confirms `logSourceId` actually derives
 * from `logPubPem` (no forged signer id). Returns false (never throws) on any mismatch.
 */
export function verifyTreeHead(sth: STH, logPubPem: string): boolean {
  if (sourceIdFromPublicKey(logPubPem) !== (sth.logSourceId as unknown)) return false;
  const digest = sthDigest(sth.tree_size, sth.root, sth.timestamp);
  let sigBytes: Uint8Array;
  try {
    sigBytes = new Uint8Array(Buffer.from(sth.sig, "base64url"));
  } catch {
    return false;
  }
  return verify(logPubPem, new Uint8Array(Buffer.from(digest, "utf8")), sigBytes);
}

// ---------------------------------------------------------------------------
// Standalone verifiers (proof checking needs no tree — O(log n))
// ---------------------------------------------------------------------------

/**
 * Verify an RFC 6962 inclusion proof: fold the leaf hash up through the sibling path,
 * choosing left/right at each level from the bit pattern of the leaf index within its
 * (shrinking) subtree, and constant-time-compare the reconstructed root to `root`. A
 * tampered record yields a different `leafHash`, so the fold cannot reach `root`.
 */
export function verifyInclusion(leafHash: Hash, proof: InclusionProof, root: Hash): boolean {
  const { leafIndex, treeSize, path: siblings } = proof;
  if (leafIndex < 0 || leafIndex >= treeSize) return false;
  if (treeSize === 0) return false;

  // RFC 6962 §2.1.1 verification: walk the index up, consuming the sibling list.
  let fn = leafIndex; // index within the current node span
  let sn = treeSize - 1; // last index within the current node span
  let r = leafHash;
  let i = 0;
  while (sn > 0) {
    if (i >= siblings.length) return false; // path too short
    const sib = siblings[i++]!;
    if (fn % 2 === 1 || fn === sn) {
      // current node is a right child (or the lone right edge): sibling on the left.
      r = nodeHash(sib, r);
      // climb until fn is even (skip the right-edge promotion case).
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      // current node is a left child: sibling on the right.
      r = nodeHash(r, sib);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  if (i !== siblings.length) return false; // path too long
  return hashEqual(r, root);
}

/**
 * Verify an RFC 6962 consistency proof: prove the tree of size `newSize` (root
 * `newRoot`) is an APPEND-ONLY EXTENSION of the tree of size `oldSize` (root `oldRoot`).
 * Reconstructs BOTH roots from the proof and compares each to the supplied root. A
 * rollback (`newSize < oldSize`) or a forked/altered tree fails reconstruction.
 *
 * Algorithm: RFC 6962 §2.1.2 verify. Handles the `oldSize` power-of-two short-circuit
 * (the old root is not in the proof when oldSize is a perfect subtree of the new tree).
 */
export function verifyConsistency(
  oldRoot: Hash,
  oldSize: number,
  newRoot: Hash,
  newSize: number,
  proof: readonly Hash[],
): boolean {
  if (oldSize < 0 || newSize < 0) return false;
  // Rollback / truncation: a "newer" tree that is not larger cannot extend the old one
  // unless it is literally identical.
  if (newSize < oldSize) return false;
  if (oldSize === 0) return true; // every tree extends the empty tree.
  if (oldSize === newSize) {
    // Same size ⇒ must be the SAME tree (equal roots) and an EMPTY proof.
    return proof.length === 0 && hashEqual(oldRoot, newRoot);
  }

  // RFC 6962 §2.1.2: if oldSize is an exact power of two, the old root is a perfect
  // subtree of the new tree and is NOT included in the proof — prepend it.
  const path: Hash[] = [...proof];
  const oldIsPow2 = (oldSize & (oldSize - 1)) === 0;
  if (oldIsPow2) path.unshift(oldRoot);

  if (path.length === 0) return false;

  let fn = oldSize - 1;
  let sn = newSize - 1;
  // Shift fn/sn down while fn is odd-aligned at the bottom right.
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }

  let i = 0;
  let fr = path[i]!; // running hash that must reconstruct the OLD root
  let sr = path[i]!; // running hash that must reconstruct the NEW root
  i++;

  while (i < path.length) {
    if (sn === 0) return false; // ran out of tree but proof remains
    const c = path[i++]!;
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }

  // sn must have collapsed to 0 (the whole new tree consumed) and both roots match.
  if (sn !== 0) return false;
  return hashEqual(fr, oldRoot) && hashEqual(sr, newRoot);
}

// ---------------------------------------------------------------------------
// PublicationSink port (publish each epoch STH to ≥2 independent sinks)
// ---------------------------------------------------------------------------

/**
 * A publication sink — an append-only place STHs are PUBLISHED to and later read back
 * by a witness. An independent sink is one the operator cannot rewrite (a third-party
 * append-only log, a notary, a peer). We ship an in-memory and a SQLite sink for tests;
 * real external sinks come later behind this same port.
 */
export interface PublicationSink {
  /** Publish (append) one STH. Append-only: prior STHs are never altered. */
  publish(sth: STH): void;
  /** The most-recently-published STH, or null if nothing has been published. */
  latest(): STH | null;
  /** Every published STH, in publication order. */
  history(): readonly STH[];
}

/** A trivial in-memory, append-only {@link PublicationSink}. */
export class InMemoryPublicationSink implements PublicationSink {
  readonly #history: STH[] = [];

  publish(sth: STH): void {
    this.#history.push(sth);
  }

  latest(): STH | null {
    return this.#history.length === 0 ? null : this.#history[this.#history.length - 1]!;
  }

  history(): readonly STH[] {
    return this.#history;
  }
}

// ---------------------------------------------------------------------------
// SQLite-backed sink (file/db witness for tests; mirrors the ledger db pattern)
// ---------------------------------------------------------------------------

/**
 * Load `node:sqlite`'s {@link DatabaseSync} via a runtime `require` — same rationale as
 * `pendingLedger.ts` / `store/sqliteStore.ts`: the `node:` built-in is newer than the
 * test transformer's hardcoded list, so a static import fails to bundle; the runtime
 * require is opaque to that analysis (ZERO external deps).
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/** A {@link PublicationSink} widened with {@link close} (for an owned db handle). */
export interface SqlitePublicationSink extends PublicationSink {
  /** Close the underlying handle (no-op for a borrowed, shared handle). */
  close(): void;
}

/** Narrow a SQLite output cell that must be a string. */
function sinkAsString(v: unknown): string {
  return v as string;
}

/**
 * Durable, append-only SQLite {@link PublicationSink}: `published_sths(seq INTEGER
 * PRIMARY KEY AUTOINCREMENT, json)` preserves publication order. Each row is one
 * serialized STH. Survives a reopen — a witness can hold its prior STH across restarts.
 */
class SqlitePublicationSinkImpl implements SqlitePublicationSink {
  readonly #db: DatabaseSyncType;
  readonly #ownsDb: boolean;
  readonly #insert;
  readonly #all;
  readonly #last;

  constructor(db: DatabaseSyncType, ownsDb: boolean) {
    this.#db = db;
    this.#ownsDb = ownsDb;
    if (ownsDb) {
      this.#db.exec("PRAGMA journal_mode=WAL");
      this.#db.exec("PRAGMA synchronous=NORMAL");
    }
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS published_sths (
         seq  INTEGER PRIMARY KEY AUTOINCREMENT,
         json TEXT NOT NULL
       )`,
    );
    this.#insert = this.#db.prepare("INSERT INTO published_sths (json) VALUES (?)");
    this.#all = this.#db.prepare("SELECT json FROM published_sths ORDER BY seq");
    this.#last = this.#db.prepare(
      "SELECT json FROM published_sths ORDER BY seq DESC LIMIT 1",
    );
  }

  publish(sth: STH): void {
    this.#insert.run(JSON.stringify(sth));
  }

  latest(): STH | null {
    const row = this.#last.get();
    if (row === undefined) return null;
    return JSON.parse(sinkAsString((row as { json: unknown }).json)) as STH;
  }

  history(): readonly STH[] {
    return this.#all.all().map((r) => JSON.parse(sinkAsString(r.json)) as STH);
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}

/**
 * Construct a durable, SQLite-backed {@link PublicationSink}. Pass EITHER a `path` (own
 * + close its WAL-mode handle) OR a shared, already-open `db` handle (`close()` is then
 * a no-op — only the owner closes).
 */
export function createSqlitePublicationSink(
  opts: { path: string } | { db: DatabaseSyncType },
): SqlitePublicationSink {
  if ("path" in opts) {
    return new SqlitePublicationSinkImpl(new DatabaseSync(opts.path), true);
  }
  return new SqlitePublicationSinkImpl(opts.db, false);
}

// ---------------------------------------------------------------------------
// Witness / split-view results
// ---------------------------------------------------------------------------

/** Why a witness check passed or failed. */
export type WitnessReason =
  | "OK"
  | "NO_PRIOR_STH"
  | "PRIOR_STH_BAD_SIG"
  | "ROLLBACK_OR_DELETION"
  | "CURRENT_STH_BAD_SIG";

/**
 * The result of a witness check: did the operator serve a valid consistency proof from
 * the witness's prior published STH to the current tree? `ok:false` with
 * `ROLLBACK_OR_DELETION` means a rollback/deletion was DETECTED (the prior STH cannot
 * be shown to be a prefix of the current tree).
 */
export interface WitnessResult {
  readonly ok: boolean;
  readonly reason: WitnessReason;
  /** The witness's prior STH that was checked (null if the sink had none). */
  readonly prior: STH | null;
  /** The current STH the prior was checked against. */
  readonly current: STH;
}

/** The result of a split-view scan over a set of STHs. */
export interface SplitViewResult {
  /** True iff non-repudiable equivocation was found. */
  readonly detected: boolean;
  /** Human-readable reason (the kind of equivocation). */
  readonly reason: "NONE" | "SAME_SIZE_DIFFERENT_ROOT" | "NON_MONOTONIC";
  /** The two conflicting STHs (the non-repudiable proof), when detected. */
  readonly conflicting: readonly [STH, STH] | null;
}

// ---------------------------------------------------------------------------
// The MerkleLog orchestrator
// ---------------------------------------------------------------------------

/**
 * The Merkle-anchored, witnessed log: wraps a {@link PendingLedger} (the leaves), the
 * LOG signer key, and ≥2 independent {@link PublicationSink}s. It recomputes the tree
 * from `ledger.records()` on demand (the records ARE the leaves) and publishes/witnesses
 * Signed Tree Heads.
 *
 * THE GUARANTEE (verbatim): Given an authentic published STH from an independent
 * witness, ANY deletion, rollback, reordering, post-anchor truncation, or split-view of
 * the ledger is DETECTABLE. Detection, not prevention; assumes an uncompromised
 * log-signer key.
 */
export interface MerkleLog {
  /** The number of leaves = number of records currently in the ledger. */
  treeSize(): number;

  /** The Merkle root over records `[0, treeSize)` in seq order (default: all). */
  merkleRoot(treeSize?: number): Hash;

  /** The leaf hash at a given seq (record index). */
  leafHashAt(seq: number): Hash;

  /** An RFC 6962 inclusion proof for the record at `seq` against the current tree. */
  inclusionProof(seq: number): InclusionProof;

  /** An inclusion proof for `seq` against a tree of exactly `treeSize` leaves. */
  inclusionProofAt(seq: number, treeSize: number): InclusionProof;

  /** An RFC 6962 consistency proof from `oldSize` to `newSize` (newSize ≤ treeSize). */
  consistencyProof(oldSize: number, newSize: number): Hash[];

  /** Sign the current tree state into an STH (does not publish). */
  signTreeHead(now: EpochMs): STH;

  /** Sign an STH over a tree of exactly `treeSize` leaves (a prefix; does not publish). */
  signTreeHeadAt(treeSize: number, now: EpochMs): STH;

  /**
   * Compute the current STH and PUBLISH it to every configured sink (an epoch
   * advance). Returns the published STH.
   */
  anchor(now: EpochMs): STH;

  /**
   * Publish the GENESIS STH (the empty tree, size 0) to every sink so pre-first-anchor
   * history is not attacker-choosable. Idempotent-friendly: call once at init.
   */
  publishGenesis(now: EpochMs): STH;

  /**
   * WITNESS CHECK against a sink's previously-published STH: the operator must serve a
   * consistency proof from that prior STH to the CURRENT tree. Failure (a smaller or
   * forked tree) is DETECTED and returned as `{ ok:false, reason:'ROLLBACK_OR_DELETION' }`.
   * Never throws on detection. The prior STH's own signature is re-verified first.
   */
  witness(sink: PublicationSink, now: EpochMs): WitnessResult;

  /** The log's public key PEM (so a verifier can check any STH this log signed). */
  logPublicKeyPem(): string;
}

/** Detect SPLIT-VIEW equivocation across a set of (validly signed) STHs. */
export function detectSplitView(sths: readonly STH[]): SplitViewResult {
  // (a) Two STHs of the SAME tree_size but DIFFERENT root ⇒ non-repudiable split view.
  const bySize = new Map<number, STH>();
  for (const s of sths) {
    const prior = bySize.get(s.tree_size);
    if (prior !== undefined && !hashEqual(prior.root, s.root)) {
      return {
        detected: true,
        reason: "SAME_SIZE_DIFFERENT_ROOT",
        conflicting: [prior, s],
      };
    }
    if (prior === undefined) bySize.set(s.tree_size, s);
  }

  // (b) Non-monotonic publication: a later-published STH whose tree_size is SMALLER
  //     than an earlier one is a rollback the operator equivocated about.
  let maxSize = -1;
  let maxStH: STH | null = null;
  for (const s of sths) {
    if (s.tree_size < maxSize && maxStH !== null) {
      return { detected: true, reason: "NON_MONOTONIC", conflicting: [maxStH, s] };
    }
    if (s.tree_size > maxSize) {
      maxSize = s.tree_size;
      maxStH = s;
    }
  }

  return { detected: false, reason: "NONE", conflicting: null };
}

/**
 * Implementation of {@link MerkleLog}. Recomputes leaf hashes from `ledger.records()`
 * on every operation (cheap; the records are the single source of truth and can never
 * desync from the chain). Persists nothing itself — STHs live in the injected sinks.
 */
class MerkleLogImpl implements MerkleLog {
  readonly #ledger: PendingLedger;
  readonly #signer: KeyPair;
  readonly #sinks: readonly PublicationSink[];

  constructor(deps: {
    ledger: PendingLedger;
    signer: KeyPair;
    sinks: readonly PublicationSink[];
  }) {
    this.#ledger = deps.ledger;
    this.#signer = deps.signer;
    this.#sinks = deps.sinks;
  }

  #leaves(upTo?: number): Hash[] {
    const recs = this.#ledger.records();
    const n = upTo === undefined ? recs.length : upTo;
    const out: Hash[] = [];
    for (let i = 0; i < n; i++) out.push(leafHashOf(recs[i]!));
    return out;
  }

  treeSize(): number {
    return this.#ledger.records().length;
  }

  merkleRoot(treeSize?: number): Hash {
    const size = treeSize ?? this.treeSize();
    if (size < 0 || size > this.treeSize()) {
      throw new Error(`merkleRoot: treeSize ${size} out of range [0, ${this.treeSize()}]`);
    }
    const leaves = this.#leaves(size);
    return mth(leaves, 0, leaves.length);
  }

  leafHashAt(seq: number): Hash {
    const recs = this.#ledger.records();
    if (seq < 0 || seq >= recs.length) {
      throw new Error(`leafHashAt: seq ${seq} out of range [0, ${recs.length})`);
    }
    return leafHashOf(recs[seq]!);
  }

  inclusionProof(seq: number): InclusionProof {
    return this.inclusionProofAt(seq, this.treeSize());
  }

  inclusionProofAt(seq: number, treeSize: number): InclusionProof {
    if (treeSize < 1 || treeSize > this.treeSize()) {
      throw new Error(`inclusionProof: treeSize ${treeSize} out of range [1, ${this.treeSize()}]`);
    }
    if (seq < 0 || seq >= treeSize) {
      throw new Error(`inclusionProof: seq ${seq} out of range [0, ${treeSize})`);
    }
    const leaves = this.#leaves(treeSize);
    return { leafIndex: seq, treeSize, path: path(leaves, seq, 0, leaves.length) };
  }

  consistencyProof(oldSize: number, newSize: number): Hash[] {
    if (oldSize < 0 || newSize < oldSize || newSize > this.treeSize()) {
      throw new Error(
        `consistencyProof: bad sizes old=${oldSize} new=${newSize} (treeSize ${this.treeSize()})`,
      );
    }
    if (oldSize === 0 || oldSize === newSize) return [];
    const leaves = this.#leaves(newSize);
    return subproof(leaves, oldSize, 0, newSize, true);
  }

  signTreeHead(now: EpochMs): STH {
    const size = this.treeSize();
    return signTreeHead(this.#signer, size, this.merkleRoot(size), now);
  }

  signTreeHeadAt(treeSize: number, now: EpochMs): STH {
    return signTreeHead(this.#signer, treeSize, this.merkleRoot(treeSize), now);
  }

  anchor(now: EpochMs): STH {
    const sth = this.signTreeHead(now);
    for (const sink of this.#sinks) sink.publish(sth);
    return sth;
  }

  publishGenesis(now: EpochMs): STH {
    const sth = signTreeHead(this.#signer, 0, EMPTY_TREE_ROOT, now);
    for (const sink of this.#sinks) sink.publish(sth);
    return sth;
  }

  witness(sink: PublicationSink, now: EpochMs): WitnessResult {
    const current = this.signTreeHead(now);
    const prior = sink.latest();
    if (prior === null) {
      return { ok: false, reason: "NO_PRIOR_STH", prior: null, current };
    }

    const pub = this.logPublicKeyPem();

    // The prior STH must itself be authentically signed by THIS log (else the witness
    // holds garbage and there is nothing to enforce).
    if (!verifyTreeHead(prior, pub)) {
      return { ok: false, reason: "PRIOR_STH_BAD_SIG", prior, current };
    }
    if (!verifyTreeHead(current, pub)) {
      return { ok: false, reason: "CURRENT_STH_BAD_SIG", prior, current };
    }

    // ROLLBACK / DELETION DETECTION: the operator must show the prior tree is a prefix
    // of the current tree. If the current tree is SMALLER than the prior, or the proof
    // cannot reconstruct the prior root, the log was rolled back / deleted.
    if (current.tree_size < prior.tree_size) {
      return { ok: false, reason: "ROLLBACK_OR_DELETION", prior, current };
    }
    let proof: Hash[];
    try {
      proof = this.consistencyProof(prior.tree_size, current.tree_size);
    } catch {
      // Prior claims a size larger than the live tree ⇒ truncation/deletion.
      return { ok: false, reason: "ROLLBACK_OR_DELETION", prior, current };
    }
    const ok = verifyConsistency(
      prior.root,
      prior.tree_size,
      current.root,
      current.tree_size,
      proof,
    );
    return ok
      ? { ok: true, reason: "OK", prior, current }
      : { ok: false, reason: "ROLLBACK_OR_DELETION", prior, current };
  }

  logPublicKeyPem(): string {
    return this.#signer.publicKeyPem;
  }
}

/**
 * Construct a {@link MerkleLog} over a {@link PendingLedger}, a LOG signer key, and ≥2
 * independent {@link PublicationSink}s. Publishing the same epoch STH to ≥2 sinks the
 * operator cannot jointly rewrite is what makes deletion/rollback/split-view detectable.
 *
 * @throws if fewer than 2 sinks are supplied (the witness guarantee requires it).
 */
export function createMerkleLog(deps: {
  ledger: PendingLedger;
  signer: KeyPair;
  sinks: readonly PublicationSink[];
}): MerkleLog {
  if (deps.sinks.length < 2) {
    throw new Error(
      "createMerkleLog: at least 2 INDEPENDENT publication sinks are required " +
        "(publishing each STH to ≥2 sinks the operator cannot jointly rewrite is what " +
        "makes deletion/rollback/split-view detectable).",
    );
  }
  return new MerkleLogImpl(deps);
}
