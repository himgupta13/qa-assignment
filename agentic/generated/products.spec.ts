import { test, expect } from '@playwright/test';

// Generated from agentic/openapi/frontend-api.yaml paths: /products, /products/{productId}
// per agentic/prompts/generate-tests.md. Every assertion below traces to a field/type/
// response-code the spec actually declares — see the comment above each block for the
// spec clause it covers.

test.describe('GET /products', () => {
  // spec: 200 response is an array of Product; Product requires id, name, priceUsd.
  test('returns an array of products, each with the required fields', async ({ request }) => {
    const res = await request.get('/api/products');
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

  // spec: Money.currencyCode is minLength/maxLength 3 — the response should echo the
  // requested currencyCode back in that field.
  test('currencyCode query param is reflected in each product priceUsd.currencyCode', async ({ request }) => {
    const res = await request.get('/api/products?currencyCode=EUR');
    const body = await res.json();
    for (const product of body) {
      expect(product.priceUsd.currencyCode).toBe('EUR');
    }
  });
});

test.describe('GET /products/{productId}', () => {
  // spec: 200 response is a Product (required id, name, priceUsd).
  test('a valid productId returns 200 with the full Product shape', async ({ request }) => {
    const res = await request.get('/api/products/0PUK6V6EV0');
    expect(res.status()).toBe(200);

    const product = await res.json();
    expect(product.id).toBe('0PUK6V6EV0');
    expect(typeof product.name).toBe('string');
    expect(product.priceUsd).toBeDefined();
  });

  // spec: 404 response documented for this operation.
  test('a nonexistent productId returns the documented 404', async ({ request }) => {
    const res = await request.get('/api/products/DOES-NOT-EXIST');
    expect(res.status()).toBe(404);
  });

  // Money.nanos is bounded [-999999999, 999999999] in the spec — boundary sanity check
  // on whatever currency conversion produces (not a specific value, since the spec
  // doesn't fix conversion rates, just the field's legal range).
  test('priceUsd.nanos stays within the spec-declared bounds regardless of currency', async ({ request }) => {
    for (const currencyCode of ['USD', 'EUR', 'JPY']) {
      const res = await request.get(`/api/products/0PUK6V6EV0?currencyCode=${currencyCode}`);
      const product = await res.json();
      expect(product.priceUsd.nanos).toBeGreaterThanOrEqual(-999999999);
      expect(product.priceUsd.nanos).toBeLessThanOrEqual(999999999);
    }
  });
});
