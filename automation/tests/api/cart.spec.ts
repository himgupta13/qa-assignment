import { test, expect } from '@playwright/test';
import { setFlag, resetFlag } from '../../fixtures/flagd';
import { PRODUCT_IDS, uniqueUserId } from '../../fixtures/testData';

// Covers TC-CT-01 through TC-CT-04, TC-CT-07 and TC-CT-08 from test-cases/02-cart-flow.md
// TC-CT-04 (partial cartFailure %) is scripted below as a deterministic 100%-only check —
// see automation/README.md for why a percentage-based flag test is inherently a soft
// assertion below 100%.
// TC-CT-05 (session persistence across "relogin") and TC-CT-06 (multi-tab/multi-browser
// consistency) are NOT automated here — see automation/README.md "Not automated" for why:
// both are about client-side storage/browser-tab semantics the REST API has no way to
// observe (the API just sees whatever userId string a request sends; it has no concept of
// "a tab" or "a browser").

test.describe('Cart — mandatory field verification (happy path)', () => {
  test('TC-CT-01: a populated cart returns every mandatory field correctly, per item', async ({ request }) => {
    const userId = uniqueUserId('tc-ct-01');

    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 2 } },
    });
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.TRAVEL_TELESCOPE, quantity: 1 } },
    });

    const cart = await (await request.get(`/api/cart?sessionId=${userId}&currencyCode=USD`)).json();
    expect(cart.items).toHaveLength(2);

    for (const item of cart.items) {
      // Mandatory fields per test-cases/02-cart-flow.md's "Mandatory cart-page fields"
      // reference: item name, quantity, unit price — all present via the GET /api/cart
      // enrichment (ProductCatalogService.getProduct per item).
      expect(item.productId).toBeTruthy();
      expect(item.quantity).toBeGreaterThan(0);
      expect(item.product.name).toBeTruthy();
      expect(item.product.priceUsd.currencyCode).toBe('USD');
      expect(item.product.priceUsd.units).toBeGreaterThan(0);
    }
  });
});

test.describe('Cart — add and accumulate', () => {
  test('TC-CT-02: adding the same product twice accumulates quantity into one line item', async ({ request }) => {
    const userId = uniqueUserId('tc-ct-02');

    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 1 } },
    });
    const afterFirst = await (await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 2 } },
    })).json();

    expect(afterFirst.items).toHaveLength(1);
    expect(afterFirst.items[0].quantity).toBe(3);

    const read = await (await request.get(`/api/cart?sessionId=${userId}`)).json();
    expect(read.items[0].quantity).toBe(3);
  });
});

test.describe('Cart — empty and read', () => {
  test('TC-CT-03: emptying the cart returns 204 and a subsequent read is empty, not stale', async ({ request }) => {
    const userId = uniqueUserId('tc-ct-03');

    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.TRAVEL_TELESCOPE, quantity: 1 } },
    });

    const del = await request.delete('/api/cart', { data: { userId } });
    expect(del.status()).toBe(204);

    const cart = await (await request.get(`/api/cart?sessionId=${userId}`)).json();
    expect(cart.items).toHaveLength(0);
  });

  test('TC-CT-03 edge case: deleting a cart that was never created is idempotent, not a 5xx', async ({
    request,
  }) => {
    const userId = uniqueUserId('tc-ct-03-never-existed');
    const del = await request.delete('/api/cart', { data: { userId } });
    expect(del.status()).toBeLessThan(500);
  });
});

test.describe('Cart — partial failure (flagd: cartFailure)', () => {
  test.afterEach(async ({ request }) => resetFlag(request, 'cartFailure'));


  test('TC-CT-04 (corrected): cartFailure only affects EmptyCart, not GetCart/AddItem', async ({ request }) => {
    await setFlag(request, 'cartFailure', '100%');
    const userId = uniqueUserId('tc-ct-04-read');
    await request.post('/api/cart', { data: { userId, item: { productId: '0PUK6V6EV0', quantity: 1 } } });

    const getRes = await request.get(`/api/cart?sessionId=${userId}`);
    expect(getRes.status()).toBe(200); // documents the real (surprising) behavior, not a guess
  });

  test('TC-CT-04: under 100% cartFailure, EmptyCart fails with a clean 5xx (not a silent success)', async ({
    request,
  }) => {
    await setFlag(request, 'cartFailure', '100%');
    const userId = uniqueUserId('tc-ct-04-delete');
    await request.post('/api/cart', { data: { userId, item: { productId: '0PUK6V6EV0', quantity: 1 } } });

    const res = await request.delete('/api/cart', { data: { userId } });
    // cartFailure routes EmptyCart to a hardcoded unreachable store ("badhost:1234" in
    // Program.cs) instead of returning a documented error — it fails, but as an
    // unhandled infra-level exception, not an intentional application error. Confirmed
    // live: 500 after ~2s (the connection attempt failing), not a graceful decline.
    expect(res.status()).toBeGreaterThanOrEqual(500);
  });
});

test.describe('Cart — currency switch', () => {
  test('TC-CT-07: switching currency re-converts every item, correctly and consistently, without changing quantities', async ({
    request,
  }) => {
    const userId = uniqueUserId('tc-ct-07');
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 2 } },
    });

    const usdCart = await (await request.get(`/api/cart?sessionId=${userId}&currencyCode=USD`)).json();
    const eurCart = await (await request.get(`/api/cart?sessionId=${userId}&currencyCode=EUR`)).json();

    // Quantities must be unchanged by a currency switch — only monetary values move.
    expect(eurCart.items[0].quantity).toBe(usdCart.items[0].quantity);
    expect(usdCart.items[0].product.priceUsd.currencyCode).toBe('USD');
    expect(eurCart.items[0].product.priceUsd.currencyCode).toBe('EUR');

    // Cross-check: the cart's EUR conversion must match a direct product-detail lookup in
    // EUR for the same product — confirms the cart isn't doing its own independent (and
    // potentially inconsistent) conversion from what GET /api/products reports.
    const directEur = await (
      await request.get(`/api/products/${PRODUCT_IDS.SOLAR_SYSTEM_IMAGER}?currencyCode=EUR`)
    ).json();
    expect(eurCart.items[0].product.priceUsd.units).toBe(directEur.priceUsd.units);
    expect(eurCart.items[0].product.priceUsd.nanos).toBe(directEur.priceUsd.nanos);
  });
});

test.describe('Cart — quantity update (delta-based)', () => {
  // Per test-cases/02-cart-flow.md TC-CT-08: the frontend implements "update quantity" as a
  // delta against the same add-item call (delta = newQuantity - oldQuantity), not a
  // dedicated "set quantity" endpoint — so this suite exercises that same delta pattern
  // directly against the API rather than assuming it's equivalent to a plain overwrite.
  test('TC-CT-08: increasing then decreasing quantity via delta recalculates correctly', async ({ request }) => {
    const userId = uniqueUserId('tc-ct-08');
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 2 } },
    });

    // Increase 2 -> 5 (delta +3).
    const afterIncrease = await (await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 3 } },
    })).json();
    expect(afterIncrease.items[0].quantity).toBe(5);

    // Decrease 5 -> 1 (delta -4, i.e. a NEGATIVE quantity in the AddItem request).
    const afterDecrease = await (await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: -4 } },
    })).json();
    expect(afterDecrease.items[0].quantity).toBe(1);

    const read = await (await request.get(`/api/cart?sessionId=${userId}`)).json();
    expect(read.items[0].quantity).toBe(1);
  });

  // CONFIRMED BUG, found by deliberately exercising the edge the manual test case flagged
  // ("attempt to reduce quantity below the dropdown's minimum") rather than assuming the
  // backend clamps it: AddItem has no lower-bound validation at all. Driving the delta
  // below zero produces a cart line with a NEGATIVE quantity that the API happily returns
  // and persists — not clamped to 0, not the item removed, not an error.
  test('TC-CT-08 (bug): reducing quantity below zero produces a negative-quantity line item, not a clamp or an error', async ({
    request,
  }) => {
    const userId = uniqueUserId('tc-ct-08-negative');
    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 2 } },
    });

    // Zero exactly: the item is NOT removed — it's returned with quantity 0 and full
    // product enrichment, as if it were still a normal line item.
    const atZero = await (await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: -2 } },
    })).json();
    expect(atZero.items).toHaveLength(1);
    expect(atZero.items[0].quantity).toBe(0);

    // Overshoot: a further decrease drives it negative.
    const negative = await (await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: -5 } },
    })).json();
    expect(negative.items[0].quantity).toBe(-5);

    const read = await (await request.get(`/api/cart?sessionId=${userId}`)).json();
    expect(read.items[0].quantity).toBe(-5);

    test.info().annotations.push({
      type: 'quality-risk',
      description:
        'CONFIRMED: POST /api/cart (AddItem) has no lower-bound validation on quantity. A quantity ' +
        'delta that crosses zero produces a persisted cart line with quantity 0 (not removed) or a ' +
        'negative quantity (e.g. -5), which then flows into checkout math unless something downstream ' +
        'clamps it — unverified whether it does. See test-cases/02-cart-flow.md TC-CT-08.',
    });
  });
});
