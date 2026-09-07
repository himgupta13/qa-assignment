import { test, expect } from '@playwright/test';

// One deliberately small UI E2E test: browse -> add to cart -> checkout. This exists to
// verify the layers are actually wired together through the browser (routing, client-side
// state, real DOM). It does NOT re-verify business logic already covered at the API layer
// in tests/api/ — see automation-strategy.md for why E2E stays intentionally thin here.
//
// Complementary to (not a replacement for) the demo repo's own
// src/frontend/cypress/e2e/Checkout.cy.ts, which already covers this golden path in
// Cypress; this is our Playwright equivalent so the whole suite runs from one command.
// Selectors below are the app's own `data-cy` hooks (src/frontend/utils/enums/CypressFields.ts)
// and the CheckoutForm's real accessible labels (src/frontend/components/CheckoutForm/CheckoutForm.tsx)
// — read directly from source rather than guessed, since this test could not be run live
// without Docker installed (see automation/README.md "Notes on the UI test").

test('browse, add a product to the cart, and complete checkout', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-cy=home-page]')).toBeVisible({ timeout: 15_000 });

  await page.locator('[data-cy=product-card]').first().click();
  await page.locator('[data-cy=product-add-to-cart]').click();

  // Adding an item auto-navigates to /cart (confirmed in the app's own Cypress suite).
  await page.waitForURL(/\/cart$/, { timeout: 15_000 });
  await expect(page.locator('[data-cy=cart-item-count]')).toContainText('1');

  await page.getByLabel('E-mail Address').fill('qa-automation@example.com');
  await page.getByLabel('Street Address').fill('1600 Amphitheatre Parkway');
  await page.getByLabel('City').fill('Mountain View');
  await page.getByLabel('State').fill('CA');
  await page.getByLabel('Zip Code').fill('94043');
  await page.getByLabel('Country').fill('USA');
  await page.getByLabel('Credit Card Number').fill('4432801561520454');
  await page.getByLabel('Month').fill('1');
  await page.getByLabel('Year').fill(String(new Date().getFullYear() + 1));
  await page.getByLabel('CVV').fill('123');

  await page.locator('[data-cy=checkout-place-order]').click();

  await page.waitForURL(/\/checkout/, { timeout: 15_000 });
  await expect(page.locator('[data-cy=checkout-item]')).toHaveCount(1);
});
