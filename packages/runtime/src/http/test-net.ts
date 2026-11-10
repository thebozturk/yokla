// Client addresses for targets that limit per address (design §11). Only the
// documentation ranges of RFC 5737 are used, so no real host is impersonated.

const RANGES = ['192.0.2', '198.51.100', '203.0.113'] as const;
const HOSTS_PER_RANGE = 254;
export const TEST_NET_SIZE = RANGES.length * HOSTS_PER_RANGE;

/** A deterministic TEST-NET address for a case or sample index; wraps after TEST_NET_SIZE. */
export function testNetAddress(index: number): string {
  const slot = ((Math.trunc(index) % TEST_NET_SIZE) + TEST_NET_SIZE) % TEST_NET_SIZE;
  const range = RANGES[Math.floor(slot / HOSTS_PER_RANGE)] ?? RANGES[0];
  return `${range}.${String((slot % HOSTS_PER_RANGE) + 1)}`;
}
