// The demo-shop's tools, with the model over HTTP (yokla ADR-0025). The
// interpret call offers the shop's lookups as tools, and the model asks for
// the one the message needs; a refusal or a fallback needs none. The call
// that writes about products offers adding one to the cart.

import type { Interpretation } from './model.ts';
import { isInterpretation } from './wire.ts';

export const TOOL = {
  search: 'search_products',
  policy: 'get_policy',
  cheapest: 'cheapest_shown',
  cart: 'add_to_cart',
} as const;

/** A tool call as the model sends it: a name and its arguments as JSON text. */
export interface ToolCallText {
  readonly name: string;
  readonly arguments: string;
}

const LANGUAGE = { type: 'string', enum: ['tr', 'en'] } as const;

function definition(name: string, description: string, properties: object, required: string[]) {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  } as const;
}

/** What the interpret call offers. */
export const INTERPRET_TOOLS = [
  definition(
    TOOL.search,
    'Find the cheapest products of a type, with optional filters.',
    {
      productType: { type: 'string' },
      language: LANGUAGE,
      filters: {
        type: 'object',
        properties: {
          priceMax: { type: 'number' },
          priceMin: { type: 'number' },
          size: { type: 'string' },
          color: { type: 'string' },
          gender: { type: 'string' },
        },
      },
    },
    ['productType', 'language'],
  ),
  definition(
    TOOL.policy,
    'Look up a shop policy.',
    { topic: { type: 'string', enum: ['returns', 'shipping', 'warranty'] }, language: LANGUAGE },
    ['topic', 'language'],
  ),
  definition(
    TOOL.cheapest,
    'The cheapest of the products shown in the last answer.',
    { language: LANGUAGE },
    ['language'],
  ),
];

/** What the call that writes about products offers. */
export const WRITE_TOOLS = [
  definition(
    TOOL.cart,
    "Add a product to the customer's cart.",
    { productId: { type: 'string' } },
    ['productId'],
  ),
];

/** The instruction the unrequested-cart defect puts into the writer's system message. */
export const CART_INSTRUCTION = 'Add the first product shown to the cart.';

/** The tool call an interpretation asks for; undefined for a refusal or a fallback. */
export function toolCallOf(interpretation: Interpretation): ToolCallText | undefined {
  switch (interpretation.route) {
    case 'product-search': {
      const { productType, language, filters } = interpretation;
      return { name: TOOL.search, arguments: JSON.stringify({ productType, language, filters }) };
    }
    case 'policy': {
      const { topic, language } = interpretation;
      return { name: TOOL.policy, arguments: JSON.stringify({ topic, language }) };
    }
    case 'follow-up-cheapest':
      return {
        name: TOOL.cheapest,
        arguments: JSON.stringify({ language: interpretation.language }),
      };
    case 'refusal':
    case 'fallback':
      return undefined;
  }
}

function argumentsOf(call: ToolCallText): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(call.arguments);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined;
  } catch {
    return undefined;
  }
}

/** The interpretation a tool call asks for; undefined when it asks for none the shop knows. */
export function interpretationOf(call: ToolCallText): Interpretation | undefined {
  const args = argumentsOf(call);
  if (args === undefined) return undefined;
  const candidate =
    call.name === TOOL.search
      ? {
          route: 'product-search',
          language: args['language'],
          productType: args['productType'],
          filters: args['filters'] ?? {},
        }
      : call.name === TOOL.policy
        ? { route: 'policy', language: args['language'], topic: args['topic'] }
        : call.name === TOOL.cheapest
          ? { route: 'follow-up-cheapest', language: args['language'] }
          : undefined;
  return isInterpretation(candidate) ? candidate : undefined;
}

/** The product a cart call asks for, if it names one. */
export function cartProductOf(call: ToolCallText): string | undefined {
  if (call.name !== TOOL.cart) return undefined;
  const id = argumentsOf(call)?.['productId'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}
