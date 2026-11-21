// The demo-shop's tools, with the model over HTTP (yokla ADR-0025). The
// interpret call offers the shop's lookups as tools, and adding a product the
// user asks for to the cart (yokla ADR-0028); the model asks for the one the
// message needs, and a refusal or a fallback needs none. The call that writes
// about products offers adding one to the cart too.

import type { Interpretation } from './model.ts';
import { isInterpretation } from './wire.ts';

export const TOOL = {
  search: 'search_products',
  policy: 'get_policy',
  cheapest: 'cheapest_shown',
  cart: 'add_to_cart',
  cancel: 'cancel_order',
  refund: 'refund_order',
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
  definition(
    TOOL.cart,
    "Add a product the customer asks for to the customer's cart.",
    {
      productId: { type: 'string' },
      language: LANGUAGE,
      quantity: { type: 'integer', minimum: 1 },
    },
    ['productId'],
  ),
];

/**
 * What the interpret call also offers a customer named in the request
 * (ADR-0086): cancelling one of their own orders. A refund is for staff.
 */
export const ORDER_TOOLS = {
  cancel: definition(
    TOOL.cancel,
    "Cancel one of the customer's own orders.",
    { orderId: { type: 'string' }, language: LANGUAGE },
    ['orderId'],
  ),
  refund: definition(
    TOOL.refund,
    "Refund an order's payment. For staff only.",
    { orderId: { type: 'string' }, language: LANGUAGE },
    ['orderId'],
  ),
};

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
    case 'cart': {
      const { productId, language, quantity } = interpretation;
      return { name: TOOL.cart, arguments: JSON.stringify({ productId, language, quantity }) };
    }
    // Whether to act on an order depends on whose it is: the provider decides (ADR-0086).
    case 'order':
    case 'refusal':
    case 'handoff':
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
          : call.name === TOOL.cart
            ? { route: 'cart', language: args['language'], productId: args['productId'] }
            : call.name === TOOL.cancel || call.name === TOOL.refund
              ? {
                  route: 'order',
                  language: args['language'],
                  action: call.name === TOOL.cancel ? 'cancel' : 'refund',
                  orderId: args['orderId'],
                  asked: true,
                }
              : undefined;
  return isInterpretation(candidate) ? candidate : undefined;
}

/** The product a cart call asks for, if it names one. */
export function cartProductOf(call: ToolCallText): string | undefined {
  if (call.name !== TOOL.cart) return undefined;
  const id = argumentsOf(call)?.['productId'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}
