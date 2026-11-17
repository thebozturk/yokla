// The catalog facts a case's expectations state, checked before it runs
// (ADR-0053, ADR-0054). `absentType: T` says the catalog holds no T;
// `productType` says it holds one of the types. Filters, `answerable` and
// `policyTopic` state no fact: their checks hold whatever the catalog holds.
// Without a catalog, or without types in it, nothing is known, and an
// unknown is not unmet.

import type { UnmetFacts } from '@yokla/core';
import type { EcommerceData } from './data.ts';
import { ecommerceExpectations } from './schema.ts';

const products = (count: number): string => `${String(count)} product${count === 1 ? '' : 's'}`;

export function catalogUnmetFacts(data: EcommerceData): UnmetFacts | undefined {
  const typed = [...(data.catalog?.values() ?? [])].flatMap((row) =>
    row.type === undefined ? [] : [{ id: row.id, type: row.type }],
  );
  if (typed.length === 0) return undefined;
  const separator = data.config.typeSeparator;
  // A catalog type the wanted one holds: itself, or one under it.
  const within = (type: string, wanted: string): boolean =>
    type === wanted || (separator !== undefined && type.startsWith(`${wanted}${separator}`));
  // An absent type is named as a shopper names it: any level of a type counts (ADR-0054).
  const holds = (type: string, absent: string): boolean =>
    within(type, absent) || (separator !== undefined && type.split(separator).includes(absent));

  return (expect) => {
    const unmet: string[] = [];
    const absent = expect['absentType'];
    if (typeof absent === 'string') {
      const found = typed.filter((row) => holds(row.type, absent));
      const [first] = found;
      if (first !== undefined) {
        unmet.push(
          `the catalog now holds ${absent}: ${products(found.length)}, such as ${first.id}`,
        );
      }
    }
    const asked = ecommerceExpectations.productType.safeParse(expect['productType']);
    if (asked.success) {
      const wanted = typeof asked.data === 'string' ? [asked.data] : asked.data;
      if (!typed.some((row) => wanted.some((type) => within(row.type, type)))) {
        unmet.push(`the catalog holds no ${wanted.join(' or ')}`);
      }
    }
    return unmet;
  };
}
