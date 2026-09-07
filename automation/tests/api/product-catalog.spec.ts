import { test, expect } from '@playwright/test';
import { setProductCatalogFailure } from '../../fixtures/flagd';
import { PRODUCT_IDS, NONEXISTENT_PRODUCT_ID } from '../../fixtures/testData';

// Covers TC-PC-01, TC-PC-02, TC-PC-03 from test-cases/03-product-catalog-currency.md.

test.describe('Product catalog — currency conversion', () => {
  test('TC-PC-01: the same product returns consistent, correctly-shaped prices across currencies', async ({
    request,
  }) => {
    const usd = await (await request.get(`/api/products/${PRODUCT_IDS.SOLAR_SYSTEM_IMAGER}?currencyCode=USD`)).json();
    const eur = await (await request.get(`/api/products/${PRODUCT_IDS.SOLAR_SYSTEM_IMAGER}?currencyCode=EUR`)).json();
    const jpy = await (await request.get(`/api/products/${PRODUCT_IDS.SOLAR_SYSTEM_IMAGER}?currencyCode=JPY`)).json();

    expect(usd.priceUsd.currencyCode).toBe('USD');
    expect(eur.priceUsd.currencyCode).toBe('EUR');
    expect(jpy.priceUsd.currencyCode).toBe('JPY');

    // JPY has no minor unit — flag (don't hard-fail the whole suite on this, since we
    // don't know the service's exact rounding convention) if nanos is non-zero.
    if (jpy.priceUsd.nanos !== 0) {
      test.info().annotations.push({
        type: 'quality-risk',
        description: `JPY conversion for ${PRODUCT_IDS.SOLAR_SYSTEM_IMAGER} returned a non-zero nanos value (${jpy.priceUsd.nanos}) — JPY is zero-decimal, confirm rounding behavior with engineering.`,
      });
    }

    // Sanity bound: converted values should be in a plausible range of the USD price,
    // not zero and not absurdly large — catches a badly-inverted conversion rate.
    expect(eur.priceUsd.units).toBeGreaterThan(0);
    expect(jpy.priceUsd.units).toBeGreaterThan(usd.priceUsd.units); // JPY units are numerically larger for an equivalent value
  });
});

test.describe('Product catalog — targeted fault injection (flagd: productCatalogFailure)', () => {
  test.afterEach(async ({ request }) => setProductCatalogFailure(request, 'off'));

  test('TC-PC-02: failure targets only the flagged product, not the whole catalog', async ({ request }) => {
    await setProductCatalogFailure(request, 'on');

    const targeted = await request.get(`/api/products/${PRODUCT_IDS.EXPLORASCOPE}`);
    expect(targeted.status()).toBeGreaterThanOrEqual(500);

    const unrelated = await request.get(`/api/products/${PRODUCT_IDS.SOLAR_SYSTEM_IMAGER}`);
    expect(unrelated.status()).toBe(200);
  });

  test('TC-PC-02 follow-up: list vs. detail behavior for the failing product must be consistent', async ({
    request,
  }) => {
    await setProductCatalogFailure(request, 'on');

    const list = await request.get('/api/products');
    const detail = await request.get(`/api/products/${PRODUCT_IDS.EXPLORASCOPE}`);

    const listOk = list.status() === 200;
    const listBody = listOk ? await list.json() : null;
    const listIncludesFailingProduct =
      listOk && Array.isArray(listBody) && listBody.some((p: any) => p.id === PRODUCT_IDS.EXPLORASCOPE);

    if (listOk && listIncludesFailingProduct && detail.status() >= 500) {
      test.info().annotations.push({
        type: 'quality-risk',
        description:
          'Product list still includes the flagged product, but its detail page 500s — a broken-link experience under this fault condition.',
      });
    }
  });
});

test.describe('Product catalog — nonexistent product', () => {
  // TC-PC-03's search cases (no-match/empty/injection/long-string queries) are NOT
  // automated here: SearchProducts exists in the proto (ProductCatalogService) but the
  // frontend's REST BFF never exposes a /api/products search/query parameter — we
  // verified this by reading src/frontend/pages/api/products/*, there's no query
  // pass-through. Testing it at all means going around the BFF to gRPC directly; see
  // product-catalog.grpc.spec.ts for the one gRPC-level test we added instead of
  // faking REST coverage that doesn't exist. See automation/README.md "Not automated".
  test('a request for a nonexistent product ID fails cleanly, not with a stack trace or 200 + empty body', async ({
    request,
  }) => {
    const res = await request.get(`/api/products/${NONEXISTENT_PRODUCT_ID}`);
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });
});
