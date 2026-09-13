import { test, expect } from '@playwright/test';
import { setFlag, setProductCatalogFailure, resetFlag } from '../../fixtures/flagd';
import { PRODUCT_IDS, uniqueUserId, checkoutPayload } from '../../fixtures/testData';

// Covers TC-CO-01, TC-CO-02, TC-CO-03, TC-CO-04 from test-cases/01-checkout-flow.md.
// TC-CO-05 (currency mismatch) needs the currency service's actual conversion rate to
// assert against precisely — see automation/README.md "Not automated" for why that's
// deliberately left as a manual/exploratory case for now.

test.describe('Checkout — happy path', () => {
  test('TC-CO-01: placing an order with a valid cart clears the cart and returns a consistent order', async ({
    request,
  }) => {
    const userId = uniqueUserId('tc-co-01');

    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 2 } },
    });

    const cartBefore = await (await request.get(`/api/cart?sessionId=${userId}&currencyCode=USD`)).json();
    expect(cartBefore.items).toHaveLength(1);
    expect(cartBefore.items[0].quantity).toBe(2);

    const checkoutRes = await request.post('/api/checkout?currencyCode=USD', {
      data: checkoutPayload(userId),
    });
    expect(checkoutRes.status()).toBe(200);

    const order = await checkoutRes.json();
    expect(order.orderId).toBeTruthy();
    expect(order.shippingTrackingId).toBeTruthy();
    expect(order.items).toHaveLength(1);
    expect(order.items[0].item.quantity).toBe(2);

    // Server-side cart must be cleared after a successful order.
    const cartAfter = await (await request.get(`/api/cart?sessionId=${userId}&currencyCode=USD`)).json();
    expect(cartAfter.items).toHaveLength(0);
  });

  test('TC-CO-01 edge case: multiple distinct products all appear in the order, none dropped', async ({
    request,
  }) => {
    const userId = uniqueUserId('tc-co-01b');

    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 1 } },
    });
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.TRAVEL_TELESCOPE, quantity: 3 } },
    });

    const checkoutRes = await request.post('/api/checkout?currencyCode=USD', {
      data: checkoutPayload(userId),
    });
    expect(checkoutRes.status()).toBe(200);

    const order = await checkoutRes.json();
    const productIds = order.items.map((i: any) => i.item.productId).sort();
    expect(productIds).toEqual([PRODUCT_IDS.TRAVEL_TELESCOPE, PRODUCT_IDS.SOLAR_SYSTEM_IMAGER].sort());
  });
});

test.describe('Checkout — payment failure (flagd: paymentFailure)', () => {
  test.afterEach(async ({ request }) => resetFlag(request, 'paymentFailure'));

  test('TC-CO-02: a declined payment returns 422 PAYMENT_FAILED and preserves the cart', async ({ request }) => {
    await setFlag(request, 'paymentFailure', '100%');

    const userId = uniqueUserId('tc-co-02');
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 1 } },
    });

    const res = await request.post('/api/checkout?currencyCode=USD', {
      data: checkoutPayload(userId),
    });
    expect(res.status()).toBe(422);

    const body = await res.json();
    expect(body.code).toBe('PAYMENT_FAILED');
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);

    // A declined payment must not silently empty the cart — the customer should be able to retry.
    const cart = await (await request.get(`/api/cart?sessionId=${userId}`)).json();
    expect(cart.items).toHaveLength(1);
  });
});

test.describe('Checkout — unrelated downstream failure is not misclassified as a payment decline', () => {
  test.afterEach(async ({ request }) => setProductCatalogFailure(request, 'off'));

  test('TC-CO-03 (adapted): a product-catalog failure during order-item enrichment returns a generic 500, not PAYMENT_FAILED', async ({
    request,
  }) => {
    await setProductCatalogFailure(request, 'on');

    const userId = uniqueUserId('tc-co-03');
    // OLJCESPC7Z is the product productCatalogFailure targets.
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.EXPLORASCOPE, quantity: 1 } },
    });

    const res = await request.post('/api/checkout?currencyCode=USD', {
      data: checkoutPayload(userId),
    });
    expect(res.status()).toBe(500);

    const body = await res.json();
    expect(body.code).toBeUndefined();
    expect(typeof body.error).toBe('string');
  });
});

test.describe('Checkout — empty cart (CONFIRMED BUG, see test-cases/01-checkout-flow.md TC-CO-04)', () => {
  // This was written as an open ambiguity ("what SHOULD happen?") and resolved by running
  // it live: checking out an empty cart returns a bare 500 {"error":"Failed to place
  // order."} — an unhandled internal error, not a graceful 4xx validation response. That's
  // a real quality bug (a customer double-tapping through an emptied cart gets a generic
  // server-error page instead of "your cart is empty"), so this test now pins the CURRENT
  // (bad) behavior as a regression guard — a fix should change this test's expectation to
  // a 4xx, not the other way around.
  test('TC-CO-04: checking out with an empty cart 500s with a generic error, not a graceful 4xx (bug)', async ({
    request,
  }) => {
    const userId = uniqueUserId('tc-co-04');
    // Deliberately never add anything to the cart for this userId.

    const res = await request.post('/api/checkout?currencyCode=USD', {
      data: checkoutPayload(userId),
    });

    expect(res.status()).toBe(500);
    test.info().annotations.push({
      type: 'quality-risk',
      description:
        'CONFIRMED: empty-cart checkout returns an unhandled 500 instead of a 4xx validation error. See test-cases/01-checkout-flow.md TC-CO-04.',
    });
  });
});
