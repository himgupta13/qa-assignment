import { test, expect } from '@playwright/test';
import { PRODUCT_IDS, uniqueUserId, checkoutPayload } from '../../automation/fixtures/testData';

// Generated from agentic/openapi/frontend-api.yaml path: /checkout.
// See the PROVENANCE note in ./products.spec.ts: this was written to generated-test/ by the
// second generation run and later moved here by hand.

test.describe('POST /checkout (placeOrder)', () => {
  // spec: 200 response is an OrderResult. NOTE: OrderResult declares `properties` but no
  // `required` list at all — strictly nothing in it is spec-mandated to be present. The
  // checks below assert shape/type for orderId/items (which the mock's faithful
  // implementation always returns, and which the checkout flow makes no sense without),
  // rather than inventing a "required" constraint the spec doesn't state. This is flagged
  // as a likely spec-completeness gap worth fixing (add a `required` list to OrderResult)
  // rather than silently treated as settled.
  test('a valid order returns 200 with the OrderResult shape', async ({ request }) => {
    const userId = uniqueUserId('gen-checkout-happy');
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 2 } },
    });

    const res = await request.post('/api/checkout?currencyCode=USD', { data: checkoutPayload(userId) });
    expect(res.status()).toBe(200);

    const order = await res.json();
    expect(typeof order.orderId).toBe('string');
    expect(order.orderId.length).toBeGreaterThan(0);
    expect(Array.isArray(order.items)).toBe(true);
    expect(order.items).toHaveLength(1);

    const line = order.items[0];
    expect(line.item.productId).toBe(PRODUCT_IDS.SOLAR_SYSTEM_IMAGER);
    expect(line.item.quantity).toBe(2);
    expect(line.cost).toBeDefined();
    expect(typeof line.cost.currencyCode).toBe('string');
    expect(typeof line.cost.units).toBe('number');
    expect(typeof line.cost.nanos).toBe('number');
    expect(order.shippingAddress).toBeDefined();
  });

  // Cross-operation inference, NOT a single documented spec clause: no field in OrderResult
  // states "the cart is now empty" — this synthesizes POST /checkout's success case with GET
  // /cart's Cart schema. This is the exact inference agentic/AGENT-DESIGN.md flags for the
  // sibling agentic/generated/checkout.spec.ts and the one that catches the eval's
  // cart-not-cleared-after-checkout mutation. A human should confirm this cross-operation
  // read is really the intended contract before treating it as a hard regression gate.
  test('after a successful order, the cart for that user is empty', async ({ request }) => {
    const userId = uniqueUserId('gen-checkout-clears-cart');
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 1 } },
    });

    await request.post('/api/checkout?currencyCode=USD', { data: checkoutPayload(userId) });

    const cart = await (await request.get(`/api/cart?sessionId=${userId}`)).json();
    expect(cart.items).toHaveLength(0);
  });

  // spec: 422 is documented for this operation, with a `code: PAYMENT_FAILED` enum value.
  // The eval mock server (agentic/eval/mock-server.js) has no flagd equivalent and never
  // declines a payment — there is no input that triggers this against the mock, so per the
  // prompt's "don't invent behavior the spec doesn't state" instruction this is generated as
  // a documented-but-untestable-here case rather than fabricated. Already covered live
  // against the real docker-compose stack (flagd's paymentFailure flag) by
  // automation/tests/api/checkout.spec.ts TC-CO-03.
  test.skip('a declined payment returns the documented 422 with code=PAYMENT_FAILED — requires flagd, not testable against the mock', async () => {});

  // spec: 500 ("Unhandled downstream failure") is documented for this operation, but the
  // spec doesn't say what triggers it — there's no parameter/schema constraint to derive an
  // input from. The mock has no fault-injection path for this either. SPEC/TEST-CASES
  // DISAGREEMENT WORTH FLAGGING: test-cases/01-checkout-flow.md TC-CO-06 documents a
  // specific, confirmed live trigger for this same 500 (checking out an empty cart), but the
  // spec models 500 only as a generic downstream-failure case, not as empty-cart-specific
  // behavior — so this suite does not treat "empty cart" as if the spec had said so. Already
  // covered live via automation/tests/api/checkout.spec.ts (TC-CO-05 via flagd
  // productCatalogFailure, TC-CO-06 for the empty-cart case specifically).
  test.skip('an unhandled downstream failure returns the documented 500 — no spec-derivable trigger, and no fault-injection path in the mock', async () => {});

  // Boundary: CreditCardInfo.creditCardExpirationMonth has minimum: 1, maximum: 12. The
  // eval mock never validates the credit card at all (it accepts any checkout unconditionally),
  // so — same reasoning as the quantity boundary case in ./cart.spec.ts — this can't be a
  // hard "must be rejected" assertion without breaking Gate 3a against the faithful mock. It
  // asserts the server never crashes and flags an out-of-bounds month if silently accepted.
  for (const invalidMonth of [13, 0]) {
    test(`creditCardExpirationMonth=${invalidMonth} (outside the spec's [1,12] bounds) is rejected, or flagged if silently accepted`, async ({
      request,
    }, testInfo) => {
      const userId = uniqueUserId(`gen-checkout-month-${invalidMonth}`);
      await request.post('/api/cart', {
        data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 1 } },
      });

      const payload = checkoutPayload(userId, {
        creditCard: {
          creditCardNumber: '4432801561520454',
          creditCardCvv: 123,
          creditCardExpirationYear: new Date().getFullYear() + 1,
          creditCardExpirationMonth: invalidMonth,
        },
      });
      const res = await request.post('/api/checkout?currencyCode=USD', { data: payload });
      expect(res.status()).toBeLessThan(500);
      if (res.status() === 200) {
        testInfo.annotations.push({
          type: 'quality-risk',
          description:
            `POST /checkout accepted creditCardExpirationMonth=${invalidMonth} with a 200, despite the ` +
            'spec declaring minimum: 1, maximum: 12 — no validation rejects an out-of-bounds month.',
        });
      }
    });
  }

  // Boundary/format: PlaceOrderRequest.email is declared `format: email`. Same reasoning as
  // above — the mock doesn't validate it, so this flags rather than hard-fails.
  test('an invalid email format is rejected, or flagged if silently accepted', async ({ request }, testInfo) => {
    const userId = uniqueUserId('gen-checkout-bad-email');
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 1 } },
    });

    const payload = checkoutPayload(userId, { email: 'not-an-email' });
    const res = await request.post('/api/checkout?currencyCode=USD', { data: payload });
    expect(res.status()).toBeLessThan(500);
    if (res.status() === 200) {
      testInfo.annotations.push({
        type: 'quality-risk',
        description:
          'POST /checkout accepted email="not-an-email" with a 200, despite the spec declaring ' +
          'format: email — no format validation rejects a malformed address.',
      });
    }
  });

  // Required-field omission: PlaceOrderRequest requires email (among others). The mock never
  // reads `email` at all when building its response, so omitting it is safe to send (unlike
  // the CartItem case in ./cart.spec.ts) — it just can't crash the handler.
  test('omitting the required email field is rejected, or flagged if silently accepted', async ({
    request,
  }, testInfo) => {
    const userId = uniqueUserId('gen-checkout-no-email');
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 1 } },
    });

    const payload: any = checkoutPayload(userId);
    delete payload.email;
    const res = await request.post('/api/checkout?currencyCode=USD', { data: payload });
    expect(res.status()).toBeLessThan(500);
    if (res.status() === 200) {
      testInfo.annotations.push({
        type: 'quality-risk',
        description:
          'POST /checkout accepted a request missing `email` (required in PlaceOrderRequest) with a ' +
          '200 instead of a validation error.',
      });
    }
  });
});
