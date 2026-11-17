// The catalog facts a case's expectations state, checked before it runs
// (ADR-0053, ADR-0054, ADR-0055). `absentType: T` says the catalog holds no
// T; `productType` says it holds one of the types; a product id a turn
// expects among the products says the catalog holds that product. Filters,
// `answerable` and `policyTopic` state no fact: their checks hold whatever
// the catalog holds. Without a catalog nothing is known, and without types
// in it nothing about types: an unknown is not unmet.

import type { UnmetFacts } from '@yokla/core';
import { PRODUCTS } from './checks/common.ts';
import type { EcommerceData } from './data.ts';
import { ecommerceExpectations } from './schema.ts';

const products = (count: number): string => `${String(count)} product${count === 1 ? '' : 's'}`;

/** A catalog type the wanted one holds: itself, or one under it by the separator. */
function within(type: string, wanted: string, separator: string | undefined): boolean {
  return type === wanted || (separator !== undefined && type.startsWith(`${wanted}${separator}`));
}

/**
 * Whether a catalog type holds a type expected absent: itself, under it, or
 * with it as one of its levels, as shoppers name types (ADR-0054).
 */
export function holdsAbsent(type: string, absent: string, separator: string | undefined): boolean {
  return (
    within(type, absent, separator) ||
    (separator !== undefined && type.split(separator).includes(absent))
  );
}

/** The product ids an expectation names among the products evidence (ADR-0055). */
function expectedIds(expect: Readonly<Record<string, unknown>>): string[] {
  const evidence = expect['evidence'];
  const collection: unknown =
    typeof evidence === 'object' && evidence !== null ? Reflect.get(evidence, PRODUCTS) : undefined;
  const ids: unknown =
    typeof collection === 'object' && collection !== null
      ? Reflect.get(collection, 'includes')
      : undefined;
  // A case's includes are strings (core's evidence expectation).
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

export function catalogUnmetFacts(data: EcommerceData): UnmetFacts | undefined {
  const { catalog } = data;
  if (catalog === undefined) return undefined;
  const typed = [...catalog.values()].flatMap((row) =>
    row.type === undefined ? [] : [{ id: row.id, type: row.type }],
  );
  const separator = data.config.typeSeparator;

  return (expect) => {
    const unmet: string[] = [];
    const absent = expect['absentType'];
    if (typed.length > 0 && typeof absent === 'string') {
      const found = typed.filter((row) => holdsAbsent(row.type, absent, separator));
      const [first] = found;
      if (first !== undefined) {
        unmet.push(
          `the catalog now holds ${absent}: ${products(found.length)}, such as ${first.id}`,
        );
      }
    }
    const asked = ecommerceExpectations.productType.safeParse(expect['productType']);
    if (typed.length > 0 && asked.success) {
      const wanted = typeof asked.data === 'string' ? [asked.data] : asked.data;
      if (!typed.some((row) => wanted.some((type) => within(row.type, type, separator)))) {
        unmet.push(`the catalog holds no ${wanted.join(' or ')}`);
      }
    }
    const missing = expectedIds(expect).filter((id) => !catalog.has(id));
    if (missing.length > 0) unmet.push(`the catalog holds no product ${missing.join(', ')}`);
    return unmet;
  };
}
