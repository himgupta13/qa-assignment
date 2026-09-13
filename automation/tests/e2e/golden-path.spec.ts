import { test, expect } from '@playwright/test';

// One deliberately small UI E2E test: browse -> add to cart -> checkout. This exists to
// verify the layers are actually wired together through the browser (routing, client-side
// state, real DOM). It does NOT re-verify business logic already covered at the API layer
// in tests/api/ — see automation-strategy.md for why E2E stays intentionally thin here.
//
// Complementary to (not a replacement for) the demo repo's own
// src/frontend/cypress/e2e/Checkout.cy.ts, which already covers this golden path in
// Cypress; this is our Playwright equivalent so the whole suite runs from one command.
// Selectors below are the app's own `data-cy` hooks (src/frontend/utils/enums/CypressFields.ts),
// read directly from source rather than guessed.
//
// REAL FINDINGS from running this live, in the order hit:
// 1. The CheckoutForm's visible field labels ("E-mail Address", "Street Address", etc.)
//    are plain <p> tags, not real <label for=...> elements — Playwright's getByLabel
//    (accessible-name lookup) timed out against them entirely, because they carry no
//    accessible-name association to their input. Itself a minor a11y gap worth flagging
//    to engineering (a screen reader user gets the same disconnect). Worked around it
//    because the form also ships pre-filled with valid sample data (email, address, a
//    working test card number, expiration, CVV), so the golden path just submits as-is.
// 2. CypressFields.CheckoutItem / data-cy="checkout-item" is DEAD in this flow: it's set
//    on components/CheckoutItem/CheckoutItem.tsx, but the order-confirmation page
//    (pages/cart/checkout/[orderId]/index.tsx) renders its own inline S.OrderItem
//    markup instead and carries no data-cy hooks at all — confirmed by reading both
//    files after this locator resolved to 0 elements against the live app. Asserting on
//    real rendered content (heading text + the actual product name) instead of a
//    data-cy hook that turned out to not exist on this page.
test('browse, add a product to the cart, and complete checkout', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-cy=home-page]')).toBeVisible({ timeout: 15_000 });

  // data-cy="product-name" only exists on the product detail page (pages/product/[productId]),
  // not on the homepage card — confirmed by reading both files — so grab it after navigating.
  await page.locator('[data-cy=product-card]').first().click();
  await page.waitForURL(/\/product\//, { timeout: 15_000 });
  const productNameLocator = page.locator('[data-cy=product-name]');
  await expect(productNameLocator).toBeVisible({ timeout: 15_000 });
  const productName = await productNameLocator.textContent();
  await page.locator('[data-cy=product-add-to-cart]').click();

  // Adding an item auto-navigates to /cart (confirmed in the app's own Cypress suite).
  await page.waitForURL(/\/cart$/, { timeout: 15_000 });
  await expect(page.locator('[data-cy=cart-item-count]')).toContainText('1');

  // Checkout form is pre-filled with valid sample data — submit as-is.
  await page.locator('[data-cy=checkout-place-order]').click();

  await page.waitForURL(/\/checkout/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Your order is complete!' })).toBeVisible();
  await expect(page.getByText('Order ID:')).toBeVisible();
  await expect(page.getByText(productName!.trim())).toBeVisible();
});
