const { canonicalize } = require('../canonical');

describe('canonicalize', () => {
  test('sorts object keys at every level and strips whitespace', () => {
    expect(canonicalize({ z: [1, 'two', null, true], a: { y: 2, x: 1 }, s: 'å"' }))
      .toBe('{"a":{"x":1,"y":2},"s":"å\\"","z":[1,"two",null,true]}');
  });

  test('encodes primitives like JSON.stringify', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize('a\nb')).toBe('"a\\nb"');
  });

  test('omits undefined object values, nulls undefined array items', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalize([undefined, 1])).toBe('[null,1]');
  });

  test('is stable regardless of key insertion order', () => {
    const a = { first: 1, second: { deep: true, arr: [1, 2] } };
    const b = { second: { arr: [1, 2], deep: true }, first: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  test('empty object and array', () => {
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
  });

  test('rejects functions', () => {
    expect(() => canonicalize(() => {})).toThrow(TypeError);
  });
});
