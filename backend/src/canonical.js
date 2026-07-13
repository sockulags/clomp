/**
 * Canonical JSON serialization for hashing.
 *
 * Rules (must match scripts/verify-export.js and any SDK verifier exactly):
 *   - Object keys sorted lexicographically (code-unit order) at every level
 *   - No whitespace
 *   - Strings/numbers/booleans/null encoded as JSON.stringify encodes them
 *   - undefined object values are omitted; undefined in arrays becomes null
 *
 * The output feeds SHA-256, so any change here breaks every existing chain.
 */
function canonicalize(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(v => (v === undefined ? 'null' : canonicalize(v))).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k]));
    return '{' + parts.join(',') + '}';
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

module.exports = { canonicalize };
