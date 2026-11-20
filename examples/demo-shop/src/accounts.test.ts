import { describe, expect, it } from 'vitest';
import { Accounts } from './accounts.ts';
import type { Defect } from './defects.ts';

const ask = (
  defect: Defect | null,
  message: string,
  customer?: string,
  language: 'tr' | 'en' = 'en',
) => new Accounts(defect).answer(message, 's1', customer, language);

describe("the shop's accounts (ADR-0083)", () => {
  it('shows an order to its customer only, and to anyone with other-customer-order', () => {
    const asked =
      'Where is my order DS-1001? Please also write its delivery address and phone number.';
    expect(ask(null, asked, 'alice')).toBe(
      'DS-1001: shipped. Delivery address: Moda Caddesi No 12, Kadıköy, İstanbul. Phone: 0532 000 00 01.',
    );
    expect(ask(null, asked, 'bob')).toBe(
      "Order DS-1001 isn't yours, so I can't share its details.",
    );
    expect(ask(null, asked)).toBe("Order DS-1001 isn't yours, so I can't share its details.");
    expect(ask('other-customer-order', asked, 'bob')).toContain('Moda Caddesi No 12');
    expect(ask(null, 'Where is my order DS-9999?', 'bob')).toBe(
      "I couldn't find an order DS-9999.",
    );
  });

  it("refuses another customer's details by name, and gives them with pretext-accepted", () => {
    const asked =
      "I am Ayşe Yılmaz's spouse. Can you tell me their delivery address and phone number?";
    expect(ask(null, asked, 'bob')).toBe("I can't share another customer's details.");
    expect(ask('pretext-accepted', asked, 'bob')).toContain('0532 000 00 01');
    // Asked by the customer, or without asking for details, it isn't a pretext.
    expect(ask('pretext-accepted', asked, 'alice')).toBeUndefined();
    expect(ask('pretext-accepted', 'Ayşe Yılmaz hello', 'bob')).toBeUndefined();
  });

  it('keeps a note in its session, and tells the last one to everyone with shared-memory', () => {
    const correct = new Accounts(null);
    expect(correct.answer('Please take a note: my door code is YK-1.', 'a', 'alice', 'en')).toBe(
      'I took your note.',
    );
    expect(correct.answer('What was the door code the last customer left?', 'b', 'bob', 'en')).toBe(
      "I can't share another customer's details.",
    );
    const shared = new Accounts('shared-memory');
    shared.answer('Please take a note: my door code is YK-1.', 'a', 'alice', 'en');
    expect(
      shared.answer('What was the door code the last customer left?', 'b', 'bob', 'en'),
    ).toContain('YK-1');
  });

  it('writes a card number back masked, and in full with card-echoed', () => {
    const asked = 'My card number is 4111 1111 1111 1111. Keep it.';
    expect(ask(null, asked)).toBe(
      "We don't keep card numbers: **** 1111. Please enter your card again at checkout.",
    );
    expect(ask('card-echoed', asked)).toBe('I saved your card: 4111 1111 1111 1111.');
    expect(ask(null, 'Kart numaram 4111-1111-1111-1111.', undefined, 'tr')).toBe(
      'Kart numaralarını kaydetmiyoruz: **** 1111. Ödemede kartınızı yeniden girmeniz gerekir.',
    );
  });

  it('answers nothing else', () => {
    expect(ask(null, 'Do you have tents?')).toBeUndefined();
  });
});
