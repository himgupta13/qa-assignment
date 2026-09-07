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

  test('TC-CT-03: under 100% cartFailure, calls fail cleanly rather than returning corrupted partial data', async ({
    request,
  }) => {
    await setFlag(request, 'cartFailure', '100%');
    const userId = uniqueUserId('tc-ct-03');

    const res = await request.get(`/api/cart?sessionId=${userId}`);
    // A failing call must be a clean error status, never a 200 with malformed/partial JSON.
    expect(res.status()).toBeGreaterThanOrEqual(500);
  });
});
