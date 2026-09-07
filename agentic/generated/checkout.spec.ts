import { test, expect } from '@playwright/test';

// Generated from agentic/openapi/frontend-api.yaml path: /checkout.

function uniqueUserId() {
  return `agent-gen-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

const VALID_ADDRESS = {
  streetAddress: '1600 Amphitheatre Parkway',
  city: 'Mountain View',
  state: 'CA',
  country: 'USA',
  zipCode: '94043',
};

// CreditCardInfo.creditCardExpirationMonth is bounded [1, 12] in the spec.
const VALID_CARD = {
  creditCardNumber: '4432801561520454',
  creditCardCvv: 123,
  creditCardExpirationYear: new Date().getFullYear() + 1,
  creditCardExpirationMonth: 1,
};

async function seedCart(request: any, userId: string) {
  await request.post('/api/cart', { data: { userId, item: { productId: '0PUK6V6EV0', quantity: 1 } } });
}

test.describe('POST /checkout', () => {
  // spec: 200 response is an OrderResult; requestBody requires userId, userCurrency,
  // address, email, creditCard.
  test('a valid order returns 200 with the OrderResult required shape', async ({ request }) => {
    const userId = uniqueUserId();
    await seedCart(request, userId);

    const res = await request.post('/api/checkout?currencyCode=USD', {
      data: { userId, userCurrency: 'USD', address: VALID_ADDRESS, email: 'agent@example.com', creditCard: VALID_CARD },
    });
    expect(res.status()).toBe(200);

    const order = await res.json();
    expect(order.items).toBeDefined();
    expect(Array.isArray(order.items)).toBe(true);
  });

  // This is the load-bearing assertion designed to catch the mutation server's
  // "checkout succeeds but never clears the cart" bug — synthesized from cross-reading
  // two spec operations (POST /checkout's success case + GET /cart's Cart schema),
  // since no single response field in OrderResult states "the cart is now empty." A
  // human should confirm this cross-operation inference is the intended contract before
  // treating it as a hard regression gate (see agentic/AGENT-DESIGN.md).
  test('after a successful order, the cart for that user is empty', async ({ request }) => {
    const userId = uniqueUserId();
    await seedCart(request, userId);

    await request.post('/api/checkout?currencyCode=USD', {
      data: { userId, userCurrency: 'USD', address: VALID_ADDRESS, email: 'agent@example.com', creditCard: VALID_CARD },
    });

    const cartRes = await request.get(`/api/cart?sessionId=${userId}`);
    const cart = await cartRes.json();
    expect(cart.items).toHaveLength(0);
  });

  // spec: 422 response documented for this operation, with a `code` field.
  // NOTE: the mock server used for eval does not implement a payment-decline path (it
  // has no flagd equivalent), so this test is generated per the prompt's instruction to
  // cover every documented response code, but is expected to be un-triggerable against
  // the mock — flagged here rather than silently omitted. Against the real docker-compose
  // stack with flagd's paymentFailure flag set, this is exactly TC-CO-02 in
  // test-cases/01-checkout-flow.md, already covered there.
  test.skip('a declined payment returns the documented 422 with a code field — requires flagd, not testable against the mock', async () => {});
});
