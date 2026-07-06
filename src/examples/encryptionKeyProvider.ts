/**
 * examples/encryptionKeyProvider.ts — a REFERENCE {@link KeyProvider} for
 * {@link createEncryptedStore} (`docs/specs/PHASE2_DURABILITY_SPEC.md` §3).
 *
 * `createEncryptedStore`'s contract is deliberately minimal: `keyProvider: () =>
 * Buffer`. WHERE the 32-byte AES-256 key actually comes from — an environment
 * variable, an OS keychain, a KMS — is the deployment's job, not the engine's.
 * This module ships the simplest possible sourcing (an env var, base64-encoded)
 * as a copyable STARTING POINT, exactly like `examples/auditSinks.ts` ships
 * reference {@link AppendSink}s. It is typechecked and tested with the suite so
 * it can never silently rot, but it is deliberately NOT exported from the
 * package barrel — the API surface is the {@link KeyProvider} type; key sourcing
 * belongs to the deployment.
 *
 * PRODUCTION NOTE: an env var is the easy floor, not the recommended ceiling —
 * it is visible to anything that can read the process environment (child
 * processes, a crash dump, `/proc`). Prefer an OS keychain (DPAPI / Keychain /
 * libsecret) or a KMS-wrapped key for anything beyond local development; the
 * `KeyProvider` type is the same either way, only what backs the closure changes.
 *
 * KEY ROTATION: `createEncryptedStore` calls `keyProvider()` on every operation,
 * never caching it — swapping what this closure returns (e.g. re-reading the env
 * var, or backing it with a mutable ref updated by a rotation job) takes effect
 * immediately with no store restart. Rotating the key for DATA ALREADY WRITTEN
 * under the old key requires re-encrypting it (decrypt under the old key, encrypt
 * under the new, e.g. via a snapshot round-trip) — this provider only controls
 * which key NEW encrypt/decrypt calls use.
 *
 * STACK NOTE: ESM + NodeNext (relative imports carry `.js`); `verbatimModuleSyntax`
 * (type-only imports use `import type`). ZERO new runtime deps (node: builtins only).
 */

import type { KeyProvider } from "../store/encryptedStore.js";

const AES_256_KEY_BYTES = 32;

/**
 * Build a {@link KeyProvider} that reads a base64-encoded 32-byte AES-256 key from
 * the environment variable named `envVar` (default `IDB_ENCRYPTION_KEY`) on EVERY
 * call — so a process that re-reads its environment (or has the variable mutated
 * by a rotation script into the SAME process, e.g. via a config-reload path) picks
 * up a rotated key without a restart.
 *
 * Fails loudly (never silently falls back to "no encryption"): a missing/empty
 * variable, invalid base64, or a decoded length other than 32 bytes throws
 * immediately — the same fail-closed posture as every other trust decision in
 * this codebase.
 *
 * @example
 *   // Provision once, out-of-band:
 *   //   $ export IDB_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
 *   const store = createEncryptedStore(createSqliteStore(path), envKeyProvider());
 */
export function envKeyProvider(envVar = "IDB_ENCRYPTION_KEY"): KeyProvider {
  return (): Buffer => {
    const raw = process.env[envVar];
    if (raw === undefined || raw.length === 0) {
      throw new Error(
        `envKeyProvider: environment variable ${envVar} is not set. Provision a ` +
          `base64-encoded 32-byte AES-256 key, e.g.:\n` +
          `  export ${envVar}=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")`,
      );
    }
    let key: Buffer;
    try {
      key = Buffer.from(raw, "base64");
    } catch (err) {
      throw new Error(
        `envKeyProvider: ${envVar} is not valid base64: ${(err as Error).message}`,
      );
    }
    if (key.length !== AES_256_KEY_BYTES) {
      throw new Error(
        `envKeyProvider: ${envVar} decodes to ${key.length} bytes; expected exactly ` +
          `${AES_256_KEY_BYTES} (an AES-256 key). Re-provision with ` +
          `require('crypto').randomBytes(32).toString('base64').`,
      );
    }
    return key;
  };
}
