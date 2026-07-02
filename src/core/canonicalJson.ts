/**
 * core/canonicalJson.ts — CANONICAL (key-order-independent) JSON serialization.
 *
 * THE CONTRACT: `canonicalJson(a) === canonicalJson(b)` iff `a` and `b` are the
 * SAME JSON VALUE — regardless of object key INSERTION order. `{ city: "Tokyo",
 * since: 2024 }` and `{ since: 2024, city: "Tokyo" }` serialize identically;
 * arrays remain ORDER-SENSITIVE (`["a","b"]` ≠ `["b","a"]` — array order is part
 * of the value).
 *
 * WHY IT EXISTS: `content_hash` (api.ts `hashPayload`) is the engine's "same
 * claim" fingerprint — it feeds the corroboration agreement set
 * (`#deriveAgreementSet`), the AGENT_RELAY echo gate (class inheritance is
 * granted only to a relay of the SAME claim), and the disown sweep's
 * dedupe-by-root. Hashing raw `JSON.stringify` output made all three sensitive
 * to KEY INSERTION ORDER — a byte-reordered relay of the identical object read
 * as a DIFFERENT claim (corroboration undercounted; class inheritance refused,
 * re-opening the manufactured-corroboration hole the relay fix closed). "Same
 * claim" must be a function of the VALUE, not of who serialized it first.
 *
 * SEMANTICS (deliberately EXACT-JSON, matching what `JSON.stringify` has always
 * fed the hash): the value is first normalized through
 * `JSON.parse(JSON.stringify(value))`, so
 *   - `toJSON()` methods are honored (e.g. a Date serializes to its ISO string),
 *   - `undefined`-valued keys are DROPPED (as JSON.stringify drops them),
 *   - non-finite numbers (`NaN`, `±Infinity`) become `null`,
 *   - cyclic values still THROW (exactly as today).
 * A top-level value `JSON.stringify` cannot represent at all (`undefined`, a
 * bare function/symbol) canonicalizes as `null` — the same shape the engine's
 * `payload ?? null` call-site discipline has always produced.
 *
 * Zero dependencies, pure, total (modulo the documented cycle throw).
 */

/**
 * Serialize `value` to its canonical JSON string: object keys sorted
 * lexicographically at every depth, array order preserved, exact
 * `JSON.stringify` value semantics (see the module doc for the full contract).
 */
export function canonicalJson(value: unknown): string {
  const raw = JSON.stringify(value);
  // JSON.stringify returns `undefined` for values JSON cannot represent at the
  // top level (undefined / function / symbol) — canonicalize those as `null`.
  if (raw === undefined) return "null";
  return serializeNormalized(JSON.parse(raw) as unknown);
}

/**
 * Recursive canonical serializer over an ALREADY-NORMALIZED value (pure JSON:
 * null / boolean / finite number / string / array / plain object — the only
 * shapes `JSON.parse` can produce). Objects emit keys in sorted order; arrays
 * emit elements in place.
 */
function serializeNormalized(v: unknown): string {
  if (v === null || typeof v !== "object") {
    // Primitive: JSON.stringify is already canonical for these.
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return "[" + v.map((el) => serializeNormalized(el as unknown)).join(",") + "]";
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + serializeNormalized(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}
