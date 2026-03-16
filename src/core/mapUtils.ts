export function mapsEqual(
  expected: Record<string, string>,
  actual: Record<string, string>
): boolean {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (expectedKeys.length !== actualKeys.length) return false;
  for (let i = 0; i < expectedKeys.length; i += 1) {
    if (expectedKeys[i] !== actualKeys[i]) return false;
    const k = expectedKeys[i]!;
    if (expected[k] !== actual[k]) return false;
  }
  return true;
}
