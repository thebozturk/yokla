import { describe, expect, it } from 'vitest';
import { isInterpretation } from './wire.ts';

describe('isInterpretation: orders and quantities (ADR-0086)', () => {
  it('takes an action on an order, asked for or not, with or without its id', () => {
    const order = {
      route: 'order',
      language: 'en',
      action: 'cancel',
      orderId: 'DS-1',
      asked: true,
    };
    expect(isInterpretation(order)).toBe(true);
    expect(
      isInterpretation({ route: 'order', language: 'tr', action: 'refund', asked: false }),
    ).toBe(true);
    expect(isInterpretation({ ...order, action: 'delete' })).toBe(false);
    expect(isInterpretation({ ...order, asked: 'yes' })).toBe(false);
    expect(isInterpretation({ ...order, orderId: 7 })).toBe(false);
  });

  it('takes a cart with a whole quantity of one or more, or none', () => {
    const cart = { route: 'cart', language: 'en', productId: 'STV-001' };
    expect(isInterpretation(cart)).toBe(true);
    expect(isInterpretation({ ...cart, quantity: 2 })).toBe(true);
    expect(isInterpretation({ ...cart, quantity: 0 })).toBe(false);
    expect(isInterpretation({ ...cart, quantity: 1.5 })).toBe(false);
    expect(isInterpretation({ ...cart, quantity: '2' })).toBe(false);
  });
});
