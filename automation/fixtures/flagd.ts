import { APIRequestContext } from '@playwright/test';

/**
 * The frontend proxies flagd's config at /feature/api/{read,write} (confirmed by the
 * existing src/frontend/cypress/e2e/CheckoutPaymentFailure.cy.ts in the demo repo) —
 * this is the same mechanism the flagd-ui container uses, so we reuse it rather than
 * inventing a second way to reach flagd.
 */
const READ_URL = '/feature/api/read';
const WRITE_URL = '/feature/api/write';

/**
 * REAL FINDING from running this live: without a wait here, the very next request after
 * a flag write raced flagd's file-watch + propagate-to-service cycle and observed the OLD
 * value (confirmed: an isolated test toggling paymentFailure to 100% then immediately
 * checking out got a 200, not the expected 422, ~357ms end to end). curl commands typed
 * out by hand happened to have enough incidental delay between them to never hit this;
 * a fast automated client does not. 1s is an empirical margin, not a documented flagd
 * guarantee — see automation-strategy.md "Flakiness" for why this is itself the kind of
 * shared-external-state risk that suite design has to account for, not paper over.
 */
const FLAGD_PROPAGATION_DELAY_MS = 1000;

export async function setFlag(request: APIRequestContext, flagName: string, defaultVariant: string) {
  const read = await request.get(READ_URL);
  const body = await read.json();
  if (!body.flags[flagName]) {
    throw new Error(`Unknown flag "${flagName}" — check src/flagd/demo.flagd.json in the demo repo`);
  }
  body.flags[flagName].defaultVariant = defaultVariant;
  await request.post(WRITE_URL, { data: { data: body } });
  await new Promise((r) => setTimeout(r, FLAGD_PROPAGATION_DELAY_MS));
}

/**
 * productCatalogFailure targets one product ID via a targeting rule instead of a plain
 * defaultVariant, so toggling it means flipping the rule's true-branch — matching how the
 * /feature UI itself edits this specific flag.
 */
export async function setProductCatalogFailure(request: APIRequestContext, variant: 'on' | 'off') {
  const read = await request.get(READ_URL);
  const body = await read.json();
  body.flags.productCatalogFailure.targeting.if[1] = variant;
  await request.post(WRITE_URL, { data: { data: body } });
  await new Promise((r) => setTimeout(r, FLAGD_PROPAGATION_DELAY_MS));
}

export async function resetFlag(request: APIRequestContext, flagName: string) {
  await setFlag(request, flagName, 'off');
}
