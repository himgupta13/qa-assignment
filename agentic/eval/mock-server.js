#!/usr/bin/env node
// Minimal, dependency-free mock of the frontend BFF surface described in
// ../openapi/frontend-api.yaml. Exists so the eval layer can test the AGENT-GENERATED
// test suite without needing docker compose running — and, more importantly, so it can
// run in two modes:
//
//   MODE=faithful (default) — implements the spec correctly. Generated tests must PASS.
//   MODE=mutated            — deliberately violates the spec in a few specific ways.
//                             Generated tests must FAIL. If they don't, they're not
//                             actually asserting anything (see eval/run-eval.js).
//
// This is the "what stops it from generating nonsense" mechanism for the test-generation
// workflow: a generated suite that passes against BOTH modes is a suite of tautologies.
'use strict';

const http = require('http');

const MODE = process.env.MODE || 'faithful';
const PORT = process.env.PORT || 4000;

const PRODUCTS = [
  { id: 'OLJCESPC7Z', name: 'National Park Foundation Explorascope', priceUsd: { currencyCode: 'USD', units: 21, nanos: 950000000 }, categories: ['telescopes'] },
  { id: '0PUK6V6EV0', name: 'Solar System Color Imager', priceUsd: { currencyCode: 'USD', units: 175, nanos: 0 }, categories: ['accessories', 'telescopes'] },
];

let carts = {}; // userId -> [{productId, quantity}]

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY']);

function convert(money, toCode) {
  // Toy conversion table — good enough to exercise shape/consistency assertions.
  const rates = { USD: 1, EUR: 0.9, JPY: 149 };
  const rate = rates[toCode] ?? 1;
  const totalNanos = money.units * 1e9 + money.nanos;
  const converted = totalNanos * rate;
  const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.has(toCode);
  return {
    currencyCode: toCode,
    units: Math.trunc(converted / 1e9),
    // BUG (mutated): zero-decimal currencies (JPY) should always report nanos=0; the
    // mutated server "forgets" this and leaks a fractional sub-unit, mirroring the exact
    // rounding risk called out in test-cases/03-product-catalog-currency.md TC-PC-01.
    nanos: isZeroDecimal ? (MODE === 'mutated' ? 500000000 : 0) : Math.trunc(converted % 1e9),
  };
}

function findProduct(id) {
  return PRODUCTS.find((p) => p.id === id);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'products', ':id'] etc.
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : undefined;
    route(req.method, parts, url, json, res);
  });
});

function route(method, parts, url, body, res) {
  const currencyCode = url.searchParams.get('currencyCode') || 'USD';

  // GET /api/products
  if (method === 'GET' && parts.length === 2 && parts[1] === 'products') {
    return send(res, 200, PRODUCTS.map((p) => ({ ...p, priceUsd: convert(p.priceUsd, currencyCode) })));
  }

  // GET /api/products/:id
  if (method === 'GET' && parts.length === 3 && parts[1] === 'products') {
    const product = findProduct(parts[2]);
    if (!product) return send(res, 404, { error: 'not found' });
    return send(res, 200, { ...product, priceUsd: convert(product.priceUsd, currencyCode) });
  }

  // GET /api/cart
  if (method === 'GET' && parts.length === 2 && parts[1] === 'cart') {
    const sessionId = url.searchParams.get('sessionId');
    const items = carts[sessionId] || [];
    return send(res, 200, {
      userId: sessionId,
      items: items.map((i) => ({ ...i, product: findProduct(i.productId) })),
    });
  }

  // POST /api/cart
  if (method === 'POST' && parts.length === 2 && parts[1] === 'cart') {
    const { userId, item } = body;
    carts[userId] = carts[userId] || [];
    const existing = carts[userId].find((i) => i.productId === item.productId);
    if (existing) {
      // BUG (mutated): overwrite instead of accumulate quantity.
      existing.quantity = MODE === 'mutated' ? item.quantity : existing.quantity + item.quantity;
    } else {
      carts[userId].push({ ...item });
    }
    return send(res, 200, {
      userId,
      items: carts[userId].map((i) => ({ ...i, product: findProduct(i.productId) })),
    });
  }

  // DELETE /api/cart
  if (method === 'DELETE' && parts.length === 2 && parts[1] === 'cart') {
    const { userId } = body;
    carts[userId] = [];
    return send(res, 204, undefined);
  }

  // POST /api/checkout
  if (method === 'POST' && parts.length === 2 && parts[1] === 'checkout') {
    const { userId } = body;
    const items = carts[userId] || [];
    if (MODE === 'mutated') {
      // BUG (mutated): checkout "succeeds" but never clears the cart.
    } else {
      carts[userId] = [];
    }
    return send(res, 200, {
      orderId: 'mock-order-1',
      shippingTrackingId: 'mock-tracking-1',
      shippingCost: { currencyCode, units: 5, nanos: 0 },
      shippingAddress: body.address,
      items: items.map((i) => ({
        cost: convert(findProduct(i.productId)?.priceUsd || { currencyCode: 'USD', units: 0, nanos: 0 }, currencyCode),
        item: { productId: i.productId, quantity: i.quantity, product: findProduct(i.productId) },
      })),
    });
  }

  return send(res, 404, { error: `no mock route for ${method} ${url.pathname}` });
}

server.listen(PORT, () => {
  console.log(`[mock-server] mode=${MODE} listening on http://localhost:${PORT}`);
});

module.exports = { server };
