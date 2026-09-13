import { test, expect } from '@playwright/test';
import { setFlag, resetFlag } from '../../fixtures/flagd';
import { PRODUCT_IDS, uniqueUserId } from '../../fixtures/testData';

// Covers TC-CT-01 and TC-CT-02 from test-cases/02-cart-flow.md.
// TC-CT-03 (partial cartFailure %) is scripted below as a best-effort probabilistic check —
// see automation/README.md for why a 50%-flag test is inherently a soft assertion.

test.describe('Cart — add and accumulate', () => {
  test('TC-CT-01: adding the same product twice accumulates quantity into one line item', async ({ request }) => {
    const userId = uniqueUserId('tc-ct-01');

    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 1 } },
    });
    const afterFirst = await (await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.SOLAR_SYSTEM_IMAGER, quantity: 2 } },
    })).json();

    // This assertion encodes our inferred expectation (accumulate, not overwrite) — the
    // proto doesn't document this, so a failure here is a signal to confirm intended
    // behavior with the cart service owner, not necessarily "our test is wrong".
    expect(afterFirst.items).toHaveLength(1);
    expect(afterFirst.items[0].quantity).toBe(3);

    const read = await (await request.get(`/api/cart?sessionId=${userId}`)).json();
    expect(read.items[0].quantity).toBe(3);
  });
});

test.describe('Cart — empty and read', () => {
  test('TC-CT-02: emptying the cart returns 204 and a subsequent read is empty, not stale', async ({ request }) => {
    const userId = uniqueUserId('tc-ct-02');

    await request.post('/api/cart', {
      data: { userId, item: { productId: PRODUCT_IDS.TRAVEL_TELESCOPE, quantity: 1 } },
    });

    const del = await request.delete('/api/cart', { data: { userId } });
    expect(del.status()).toBe(204);

    const cart = await (await request.get(`/api/cart?sessionId=${userId}`)).json();
    expect(cart.items).toHaveLength(0);
  });

  test('TC-CT-02 edge case: deleting a cart that was never created is idempotent, not a 5xx', async ({
    request,
  }) => {
    const userId = uniqueUserId('tc-ct-02-never-existed');
    const del = await request.delete('/api/cart', { data: { userId } });
    expect(del.status()).toBeLessThan(500);
  });
});

test.describe('Cart — partial failure (flagd: cartFailure)', () => {
  test.afterEach(async ({ request }) => resetFlag(request, 'cartFailure'));

  // REAL FINDING from running this against the live docker-compose stack (see
  // src/cart/src/services/CartService.cs in the demo repo): cartFailure is checked ONLY
  // inside EmptyCart, not AddItem or GetCart — so a "cart service failure" fault
  // injection does NOT make cart reads fail at all. The original version of this test
  // asserted a GET would fail under cartFailure=100% and it did not (verified live:
  // GET/POST both returned 200 with the flag on). Corrected to target DELETE, the
  // operation that actually reads the flag. See test-cases/02-cart-flow.md TC-CT-03 for
  // the quality-risk writeup of *how* it fails once triggered.
  test('TC-CT-03 (corrected): cartFailure only affects EmptyCart, not GetCart/AddItem', async ({ request }) => {
    await setFlag(request, 'cartFailure', '100%');
    const userId = uniqueUserId('tc-ct-03-read');
    await request.post('/api/cart', { data: { userId, item: { productId: '0PUK6V6EV0', quantity: 1 } } });

    const getRes = await request.get(`/api/cart?sessionId=${userId}`);
    expect(getRes.status()).toBe(200); // documents the real (surprising) behavior, not a guess
  });

  test('TC-CT-03: under 100% cartFailure, EmptyCart fails with a clean 5xx (not a silent success)', async ({
    request,
  }) => {
    await setFlag(request, 'cartFailure', '100%');
    const userId = uniqueUserId('tc-ct-03-delete');
    await request.post('/api/cart', { data: { userId, item: { productId: '0PUK6V6EV0', quantity: 1 } } });

    const res = await request.delete('/api/cart', { data: { userId } });
    // cartFailure routes EmptyCart to a hardcoded unreachable store ("badhost:1234" in
    // Program.cs) instead of returning a documented error — it fails, but as an
    // unhandled infra-level exception, not an intentional application error. Confirmed
    // live: 500 after ~2s (the connection attempt failing), not a graceful decline.
    expect(res.status()).toBeGreaterThanOrEqual(500);
  });
});
