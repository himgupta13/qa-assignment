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
// REAL FINDING from running this live: the CheckoutForm's visible field labels
// ("E-mail Address", "Street Address", etc.) are plain <p> tags, not real <label for=...>
// elements — Playwright's getByLabel (accessible-name lookup) times out against them
// entirely, because they carry no accessible-name association to their input. This is
// itself a minor a11y gap worth flagging to engineering (a screen reader user gets the
// same disconnect), separate from why it broke this test. Also discovered live: every
// field on this form ships with a pre-filled, valid sample value (email, address, a
// working test card number, expiration, CVV) — so the golden path doesn't need to fill
// anything at all; it only needs to submit what's already there.
test('browse, add a product to the cart, and complete checkout', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-cy=home-page]')).toBeVisible({ timeout: 15_000 });

  await page.locator('[data-cy=product-card]').first().click();
  await page.locator('[data-cy=product-add-to-cart]').click();

  // Adding an item auto-navigates to /cart (confirmed in the app's own Cypress suite).
  await page.waitForURL(/\/cart$/, { timeout: 15_000 });
  await expect(page.locator('[data-cy=cart-item-count]')).toContainText('1');

  // Checkout form is pre-filled with valid sample data — submit as-is.
  await page.locator('[data-cy=checkout-place-order]').click();

  await page.waitForURL(/\/checkout/, { timeout: 15_000 });
  await expect(page.locator('[data-cy=checkout-item]')).toHaveCount(1);
});
