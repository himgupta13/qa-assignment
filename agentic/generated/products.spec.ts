import { test, expect } from '@playwright/test';
import { PRODUCT_IDS, NONEXISTENT_PRODUCT_ID } from '../../automation/fixtures/testData';

// Generated from agentic/openapi/frontend-api.yaml paths: /products, /products/{productId}
// per agentic/prompts/generate-tests.md.
//
// PROVENANCE: written by the second generation run (Claude Code session f4cf2bd9, see
// agentic/transcripts/), whose prompt pointed at agentic/generated-test/. The agent made the
// eval harness scan any agentic/generated*/ directory so both suites were evaluated side by
// side; a human then replaced the first run's agentic/generated/ output with these files (a
// plain `mv`, done outside any agent session). Comments below that mention "generated-test/"
// or "the sibling agentic/generated/ suite" refer to that earlier layout. See AGENT-DESIGN.md.
//
// The mock server (agentic/eval/mock-server.js) only seeds two products — Explorascope
// (OLJCESPC7Z) and the Solar System Color Imager (0PUK6V6EV0) — unlike the real
// docker-compose app's full catalog, so success-path assertions below are scoped to those
// two real seeded IDs from automation/fixtures/testData.ts, not the others also defined
// there (TRAVEL_TELESCOPE etc. would 404 against the mock).

test.describe('GET /products (listProducts)', () => {
  // spec: 200 is an array of Product; Product requires id, name, priceUsd; Money (priceUsd)
  // requires currencyCode, units, nanos.
  test('returns an array of products, each satisfying the required Product/Money fields', async ({ request }) => {
    const res = await request.get('/api/products?currencyCode=USD');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);

    for (const product of body) {
      expect(typeof product.id).toBe('string');
      expect(typeof product.name).toBe('string');
      expect(product.priceUsd).toBeDefined();
      expect(typeof product.priceUsd.currencyCode).toBe('string');
      expect(typeof product.priceUsd.units).toBe('number');
      expect(typeof product.priceUsd.nanos).toBe('number');
    }
  });

  // The `currencyCode` query parameter only means anything if it actually changes what
  // Money.currencyCode comes back as — this is the parameter's documented purpose, not an
  // invented assertion.
  test('currencyCode query param is reflected in every product priceUsd.currencyCode', async ({ request }) => {
    const res = await request.get('/api/products?currencyCode=EUR');
    const body = await res.json();
    for (const product of body) {
      expect(product.priceUsd.currencyCode).toBe('EUR');
    }
  });

  // Boundary: Money.currencyCode has minLength/maxLength 3 in the spec. Checked here (once,
  // for the array endpoint) rather than duplicated in GET /products/{productId} below, since
  // both operations return the same Money schema.
  test('priceUsd.currencyCode is always exactly 3 characters, per the spec-declared bounds', async ({ request }) => {
    for (const currencyCode of ['USD', 'EUR', 'JPY']) {
      const res = await request.get(`/api/products?currencyCode=${currencyCode}`);
      const body = await res.json();
      for (const product of body) {
        expect(product.priceUsd.currencyCode.length).toBe(3);
      }
    }
  });

  // GAP: the spec documents no error response at all for this operation (no 4xx/5xx), so
  // per the prompt's "don't invent behavior the spec doesn't state" instruction, no error
  // test is generated here — nothing in the spec says what an invalid/empty currencyCode
  // should do.
});

test.describe('GET /products/{productId} (getProduct)', () => {
  // spec: 200 response is a Product (required id, name, priceUsd).
  test('a valid productId returns 200 with the full Product shape', async ({ request }) => {
    const res = await request.get(`/api/products/${PRODUCT_IDS.SOLAR_SYSTEM_IMAGER}?currencyCode=USD`);
    expect(res.status()).toBe(200);

    const product = await res.json();
    expect(product.id).toBe(PRODUCT_IDS.SOLAR_SYSTEM_IMAGER);
    expect(typeof product.name).toBe('string');
    expect(product.priceUsd).toBeDefined();
    expect(typeof product.priceUsd.currencyCode).toBe('string');
    expect(typeof product.priceUsd.units).toBe('number');
    expect(typeof product.priceUsd.nanos).toBe('number');
  });

  // spec: 404 is explicitly documented for this operation. This is also the exact case
  // agentic/AGENT-DESIGN.md documents as catching a REAL bug when this generated suite was
  // pointed at the live docker-compose app (BASE_URL=http://localhost:8080) instead of the
  // mock: the frontend BFF route has no error handling around the gRPC call and returns a
  // bare 500 instead of this documented 404. Against the mock (both faithful and mutated
  // modes implement this branch identically) this test passes; against the real app it's
  // expected to fail and expose that gap.
  test('a nonexistent productId returns the documented 404', async ({ request }) => {
    const res = await request.get(`/api/products/${NONEXISTENT_PRODUCT_ID}`);
    expect(res.status()).toBe(404);
  });

  // Boundary: Money.nanos is bounded [-999999999, 999999999] in the spec. The spec doesn't
  // fix conversion rates, so this checks the range invariant holds, not a specific value.
  test('priceUsd.nanos stays within the spec-declared bounds regardless of currency', async ({ request }) => {
    for (const currencyCode of ['USD', 'EUR', 'JPY']) {
      const res = await request.get(`/api/products/${PRODUCT_IDS.SOLAR_SYSTEM_IMAGER}?currencyCode=${currencyCode}`);
      const product = await res.json();
      expect(product.priceUsd.nanos).toBeGreaterThanOrEqual(-999999999);
      expect(product.priceUsd.nanos).toBeLessThanOrEqual(999999999);
    }
  });

  // NOT hard-asserted: JPY is a zero-decimal ISO-4217 currency in real life, so a "correct"
  // conversion should report nanos=0 for it — this is exactly what agentic/eval/mock-server.js's
  // MODE=mutated deliberately breaks. But the OpenAPI spec never states which currencies are
  // zero-decimal (it only bounds nanos generically), so asserting nanos===0 for JPY specifically
  // would be inventing a business rule the contract doesn't state, not testing the contract.
  // Flagged as an observation instead of a hard failure, per the prompt's "flag the gap, don't
  // invent" instruction — a human should decide whether the spec should be extended to state
  // this before a test enforces it.
  test('JPY conversion is observed for a zero-decimal-currency rounding risk (flag only, not a hard assertion)', async ({
    request,
  }, testInfo) => {
    const res = await request.get(`/api/products/${PRODUCT_IDS.SOLAR_SYSTEM_IMAGER}?currencyCode=JPY`);
    const product = await res.json();
    if (product.priceUsd.nanos !== 0) {
      testInfo.annotations.push({
        type: 'quality-risk',
        description:
          'GET /products/{productId}?currencyCode=JPY returned a non-zero nanos ' +
          `(${product.priceUsd.nanos}). JPY is a zero-decimal currency in practice, so this is worth a ` +
          "look, but the spec doesn't declare which currencies are zero-decimal, so this isn't asserted " +
          'as a hard failure. See test-cases/03-product-catalog-currency.md TC-PC-01 for the same risk ' +
          'called out from the human side.',
      });
    }
  });
});
