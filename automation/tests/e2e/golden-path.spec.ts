import { test, expect } from '@playwright/test';

// One deliberately small UI E2E test: browse -> add to cart -> checkout. This exists to
// verify the layers are actually wired together through the browser (routing, client-side
// state, real DOM). It does NOT re-verify business logic already covered at the API layer
// in tests/api/ — see automation-strategy.md for why E2E stays intentionally thin here.
//
// Complementary to (not a replacement for) the demo repo's own src/frontend/cypress/e2e/
// suite, which already covers this golden path in Cypress; this is our Playwright
// equivalent so the whole suite runs from one tool/one command.

test('browse, add a product to the cart, and complete checkout', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });

  // Open the first product card from the homepage grid.
  const firstProduct = page.locator('[data-cy=product-card], a[href^="/product/"]').first();
  await firstProduct.click();

  await page.getByRole('button', { name: /add to cart/i }).click();

  await page.goto('/cart');
  await expect(page.getByRole('button', { name: /checkout|place order/i })).toBeVisible();

  await page.getByLabel(/email/i).fill('qa-automation@example.com');
  await page.getByLabel(/street address/i).fill('1600 Amphitheatre Parkway');
  await page.getByLabel(/city/i).fill('Mountain View');
  await page.getByLabel(/state/i).fill('CA');
  await page.getByLabel(/country/i).fill('USA');
  await page.getByLabel(/zip/i).fill('94043');
  await page.getByLabel(/credit card number/i).fill('4432801561520454');
  await page.getByLabel(/expiration year/i).fill(String(new Date().getFullYear() + 1));
  await page.getByLabel(/expiration month/i).fill('1');
  await page.getByLabel(/cvv/i).fill('123');

  await page.getByRole('button', { name: /place order/i }).click();

  await expect(page.getByText(/your order is complete|order confirmation|thank you/i)).toBeVisible({
    timeout: 15_000,
  });
});
