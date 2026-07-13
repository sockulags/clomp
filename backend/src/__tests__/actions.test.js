const { ACTION_CATALOG, isKnownAction, getAction, isValidActionFormat } = require('../actions');

describe('action catalog', () => {
  test('every entry has soc2 and nis2 tags and a valid namespaced action', () => {
    for (const entry of ACTION_CATALOG) {
      expect(isValidActionFormat(entry.action)).toBe(true);
      expect(entry.soc2.length).toBeGreaterThan(0);
      expect(entry.nis2.length).toBeGreaterThan(0);
      expect(entry.title).toBeTruthy();
    }
  });

  test('isKnownAction and getAction agree', () => {
    expect(isKnownAction('patch.applied')).toBe(true);
    expect(getAction('patch.applied').title).toBe('Patch applied');
    expect(isKnownAction('made.up.action')).toBe(false);
    expect(getAction('made.up.action')).toBeNull();
  });

  test('action format validation', () => {
    expect(isValidActionFormat('access.review.completed')).toBe(true);
    expect(isValidActionFormat('custom.thing_2')).toBe(true);
    expect(isValidActionFormat('single')).toBe(false); // must be namespaced
    expect(isValidActionFormat('Upper.Case')).toBe(false);
    expect(isValidActionFormat('has space.x')).toBe(false);
    expect(isValidActionFormat('')).toBe(false);
    expect(isValidActionFormat(null)).toBe(false);
    expect(isValidActionFormat('a'.repeat(200) + '.b')).toBe(false); // too long
  });
});
