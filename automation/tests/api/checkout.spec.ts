import { test, expect } from '@playwright/test';
import { setFlag, setProductCatalogFailure, resetFlag } from '../../fixtures/flagd';
// (setFlag/resetFlag drive paymentFailure and cartFailure; setProductCatalogFailure drives the
// targeting-rule flag used by TC-CO-05b.)
import { PRODUCT_IDS, VALID_ADDRESS, uniqueUserId, checkoutPayload } from '../../fixtures/testData';

// Covers TC-CO-01 through TC-CO-06 from test-cases/01-checkout-flow.md (TC-CO-05b is the
// "unrelated downstream failure is not misclassified as a decline" edge case from TC-CO-05).
// TC-CO-07 (currency mismatch) needs the currency service's actual conversion rate to assert
// against precisely — see automation/README.md "Not automated" for why that's deliberately
// left as a manual/exploratory case for now.

test.describe('Checkout — happy path: single-item order', () => {
  test('TC-CO-01: a single-item order clears the cart and returns every mandatory field correctly', async ({
    request,
  }) => {
    const userId = uniqueUserId('tc-co-01');

    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 1 } },
    });

    const checkoutRes = await request.post('/api/checkout?currencyCode=USD', {
      data: checkoutPayload(userId),
    });
    expect(checkoutRes.status()).toBe(200);

    const order = await checkoutRes.json();

    // Mandatory fields per test-cases/01-checkout-flow.md's "Mandatory checkout-page fields"
    // reference: order ID, shipping address (as submitted), and per-item name/quantity/price.
    expect(order.orderId).toBeTruthy();
    expect(order.shippingTrackingId).toBeTruthy();
    expect(order.shippingAddress).toMatchObject(VALID_ADDRESS);
    expect(order.items).toHaveLength(1);

    const line = order.items[0];
    expect(line.item.quantity).toBe(1);
    expect(line.item.product.name).toBeTruthy();

    // items[].cost is the per-unit price the checkout API returns (confirmed live — see the
    // "CORRECTED ASSUMPTION" note in TC-CO-02 below for why this matters more at quantity > 1).
    // At quantity 1 it also happens to equal the line total, which is what the order
    // confirmation page displays and what this cross-check verifies against the catalog.
    const unitPriceRes = await request.get(`/api/products/${PRODUCT_IDS.SOLAR_SYSTEM_IMAGER}?currencyCode=USD`);
    const unitPrice = (await unitPriceRes.json()).priceUsd;
    expect(line.cost.units).toBe(unitPrice.units);
    expect(order.shippingCost.units).toBeGreaterThanOrEqual(0);

    // Server-side cart must be cleared after a successful order.
    const cartAfter = await (await request.get(`/api/cart?sessionId=${userId}&currencyCode=USD`)).json();
    expect(cartAfter.items).toHaveLength(0);
  });
});

test.describe('Checkout — happy path: multi-item, multi-quantity order', () => {
  test('TC-CO-02: multiple distinct products, at different quantities, all appear with correct line pricing', async ({
    request,
  }) => {
    const userId = uniqueUserId('tc-co-02');

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
    expect(order.items).toHaveLength(2);

    const productIds = order.items.map((i: any) => i.item.productId).sort();
    expect(productIds).toEqual([PRODUCT_IDS.TRAVEL_TELESCOPE, PRODUCT_IDS.SOLAR_SYSTEM_IMAGER].sort());

      const qty3Line = order.items.find((i: any) => i.item.productId === PRODUCT_IDS.TRAVEL_TELESCOPE);
    const unitPriceRes = await request.get(`/api/products/${PRODUCT_IDS.TRAVEL_TELESCOPE}?currencyCode=USD`);
    const unitPrice = (await unitPriceRes.json()).priceUsd;
    expect(qty3Line.item.quantity).toBe(3);
    expect(qty3Line.cost.units).toBe(unitPrice.units);

    // REAL FINDING from running this live: the two calls' `nanos` differed by 1
    // (949999999 vs. 950000000) — a sub-cent floating-point rounding artifact between two
    // independent price lookups for the same product/currency, not a whole-unit pricing
    // bug. Asserting exact equality here would make this test flaky on a rounding quirk
    // that isn't the thing TC-CO-02 cares about, so this uses a 1-nanos tolerance and
    // flags anything larger as a quality risk instead of silently loosening the check further.
    const nanoDelta = Math.abs(qty3Line.cost.nanos - unitPrice.nanos);
    expect(nanoDelta).toBeLessThanOrEqual(1);
    if (nanoDelta > 0) {
      test.info().annotations.push({
        type: 'quality-risk',
        description:
          `Unit price nanos for ${PRODUCT_IDS.TRAVEL_TELESCOPE} differ by ${nanoDelta} between ` +
          'GET /api/products and the checkout order response for the same product/currency — a ' +
          'sub-cent floating-point rounding inconsistency worth a look, not a functional bug.',
      });
    }

    // Order IDs must be unique per order, not a session-scoped constant — place a second
    // order in the same session and confirm the IDs differ.
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 1 } },
    });
    const secondOrder = await (
      await request.post('/api/checkout?currencyCode=USD', { data: checkoutPayload(userId) })
    ).json();
    expect(secondOrder.orderId).not.toBe(order.orderId);
  });
});

test.describe('Checkout — idempotency (flagd: none — a race condition, not a fault flag)', () => {
  // TC-CO-04 from test-cases/01-checkout-flow.md. Deliberately exercised, not assumed: fired
  // two genuinely concurrent identical checkout requests against a live docker-compose stack.
  //
  // CONFIRMED BUG: there is no idempotency protection at all. Two concurrent POST
  // /api/checkout calls for the same cart both returned 200 with two DIFFERENT order IDs —
  // a customer double-click (or a client retry racing the original request) produces two
  // separate orders and, presumably, two separate payment charges. Root cause: checkout
  // reads the cart, then clears it, but nothing serializes "read cart -> charge -> clear
  // cart" against a second concurrent request that reads the cart before the first one
  // clears it.
  //
  // Note this is specifically a CONCURRENCY bug, not a general retry-safety gap: a
  // *sequential* second checkout (waited for the first to fully complete before firing)
  // correctly hits the empty-cart path instead — verified live, second request got the
  // TC-CO-06 bug (500 "Failed to place order.") because the cart really was empty by then.
  // Only truly overlapping requests double-order.
  test('TC-CO-04: two concurrent checkout requests for the same cart both succeed and create two orders (CONFIRMED BUG)', async ({
    request,
  }) => {
    const userId = uniqueUserId('tc-co-04');
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 1 } },
    });

    const payload = checkoutPayload(userId);
    const [resA, resB] = await Promise.all([
      request.post('/api/checkout?currencyCode=USD', { data: payload }),
      request.post('/api/checkout?currencyCode=USD', { data: payload }),
    ]);

    expect(resA.status()).toBe(200);
    expect(resB.status()).toBe(200);

    const [orderA, orderB] = await Promise.all([resA.json(), resB.json()]);
    expect(orderA.orderId).not.toBe(orderB.orderId);

    test.info().annotations.push({
      type: 'quality-risk',
      description:
        'CONFIRMED: no idempotency protection on checkout — two concurrent identical requests for the ' +
        'same cart both succeed and create two separate orders (two distinct order IDs, both 200). A ' +
        'double-click or a client-side retry racing the original request results in a duplicate order ' +
        'and, presumably, a duplicate charge. See test-cases/01-checkout-flow.md TC-CO-04.',
    });
  });
});

test.describe('Checkout — payment failure (flagd: paymentFailure)', () => {
  test.afterEach(async ({ request }) => resetFlag(request, 'paymentFailure'));

  test('TC-CO-03: a declined payment returns 422 PAYMENT_FAILED and preserves the cart', async ({ request }) => {
    await setFlag(request, 'paymentFailure', '100%');

    const userId = uniqueUserId('tc-co-03');
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

test.describe('Checkout — cart-service failure during checkout (flagd: cartFailure)', () => {
  test.afterEach(async ({ request }) => resetFlag(request, 'cartFailure'));

  // TC-CO-05 from test-cases/01-checkout-flow.md. The test case was originally written
  // assuming a cart failure would abort checkout before payment. Reading src/checkout/main.go
  // shows the opposite order: PlaceOrder reads the cart, charges the card, ships, and only
  // THEN calls EmptyCart — and discards its error (`_ = cs.emptyUserCart(...)`). cartFailure
  // only affects EmptyCart (CartService.cs), so at 100% the observable behavior is:
  //
  // CONFIRMED BUG (verified live): checkout returns 200 with an orderId (the card WAS
  // charged), and the cart still contains the purchased items afterward. The customer sees a
  // confirmation page and a full cart. The obvious next click is "place order" again, which
  // charges them a second time for the same items. This is the "charged, state inconsistent"
  // risk test-strategy.md §1 names, and it is a silent one: no error is logged to the caller.
  test('TC-CO-05: with cartFailure=100%, checkout still succeeds and charges, but leaves the cart populated (CONFIRMED BUG)', async ({
    request,
  }) => {
    await setFlag(request, 'cartFailure', '100%');

    const userId = uniqueUserId('tc-co-05');
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 1 } },
    });

    const res = await request.post('/api/checkout?currencyCode=USD', {
      data: checkoutPayload(userId),
    });
    expect(res.status()).toBe(200);
    const order = await res.json();
    expect(order.orderId).toBeTruthy(); // an order exists, so the charge happened

    const cartAfter = await (await request.get(`/api/cart?sessionId=${userId}`)).json();
    expect(cartAfter.items).toHaveLength(1); // pinned CURRENT behavior: not cleared

    test.info().annotations.push({
      type: 'quality-risk',
      description:
        'CONFIRMED: a cart-service failure during checkout is swallowed. The order is placed and the ' +
        'card charged, but EmptyCart fails and the cart is left populated, inviting a duplicate order. ' +
        'Root cause: src/checkout/main.go ignores the emptyUserCart error. See TC-CO-05.',
    });
  });
});

test.describe('Checkout — unrelated downstream failure is not misclassified as a payment decline', () => {
  test.afterEach(async ({ request }) => setProductCatalogFailure(request, 'off'));

  test('TC-CO-05b: a product-catalog failure during order-item enrichment returns a generic 500, not PAYMENT_FAILED', async ({
    request,
  }) => {
    await setProductCatalogFailure(request, 'on');

    const userId = uniqueUserId('tc-co-05');
    // OLJCESPC7Z is the product productCatalogFailure targets.
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.EXPLORASCOPE, quantity: 1 } },
    });

    const res = await request.post('/api/checkout?currencyCode=USD', {
      data: checkoutPayload(userId),
    });
    expect(res.status()).toBe(500);

    // REAL FINDING from running this live, repeatedly: the 500 body is USUALLY the BFF's own
    // JSON error handler ({"error": "..."}), but occasionally comes back as a plain-text
    // "Internal Server Error" instead — most likely a framework/proxy-level error page
    // surfacing when the downstream call fails in a way the route's own catch doesn't
    // intercept in time. The status code (not PAYMENT_FAILED) is the part this test cares
    // about and is asserted unconditionally above; the body-shape checks only apply when the
    // body actually is JSON, so an intermittent plain-text error page doesn't flip this into
    // a flaky failure on top of a real, separate finding worth its own investigation.
    const rawBody = await res.text();
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      test.info().annotations.push({
        type: 'quality-risk',
        description:
          'TC-CO-05: a productCatalogFailure-induced checkout 500 returned a non-JSON body ' +
          `("${rawBody.slice(0, 80)}") instead of the BFF's usual {"error": "..."} shape — worth ` +
          'confirming with engineering whether this is a framework default error page bypassing the ' +
          "route's own error handling under this fault condition.",
      });
      return;
    }
    expect(body.code).toBeUndefined();
    expect(typeof body.error).toBe('string');
  });
});

test.describe('Checkout — empty cart (CONFIRMED BUG, see test-cases/01-checkout-flow.md TC-CO-06)', () => {
  // This was written as an open ambiguity ("what SHOULD happen?") and resolved by running
  // it live: checking out an empty cart returns a bare 500 {"error":"Failed to place
  // order."} — an unhandled internal error, not a graceful 4xx validation response. That's
  // a real quality bug (a customer double-tapping through an emptied cart gets a generic
  // server-error page instead of "your cart is empty"), so this test now pins the CURRENT
  // (bad) behavior as a regression guard — a fix should change this test's expectation to
  // a 4xx, not the other way around.
  test('TC-CO-06: checking out with an empty cart 500s with a generic error, not a graceful 4xx (bug)', async ({
    request,
  }) => {
    const userId = uniqueUserId('tc-co-06');
    // Deliberately never add anything to the cart for this userId.

    const res = await request.post('/api/checkout?currencyCode=USD', {
      data: checkoutPayload(userId),
    });

    expect(res.status()).toBe(500);
    test.info().annotations.push({
      type: 'quality-risk',
      description:
        'CONFIRMED: empty-cart checkout returns an unhandled 500 instead of a 4xx validation error. See test-cases/01-checkout-flow.md TC-CO-06.',
    });
  });
});
