// Real product IDs + names seeded by the demo's postgresql/init.sql — not synthetic values.
export const PRODUCT_IDS = {
  EXPLORASCOPE: 'OLJCESPC7Z', // the one productCatalogFailure targets
  SOLAR_SYSTEM_IMAGER: '0PUK6V6EV0',
  TRAVEL_TELESCOPE: '1YMWWN1N4O',
  BINOCULARS: '2ZYFJ3GM2N',
  REFRACTOR_TELESCOPE: '66VCHSJNUP',
};

export const NONEXISTENT_PRODUCT_ID = 'ZZZZZZZZZZ';

export function uniqueUserId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

export const VALID_ADDRESS = {
  streetAddress: '1600 Amphitheatre Parkway',
  city: 'Mountain View',
  state: 'CA',
  country: 'USA',
  zipCode: '94043',
};

export const VALID_CREDIT_CARD = {
  creditCardNumber: '4432801561520454',
  creditCardCvv: 123,
  creditCardExpirationYear: new Date().getFullYear() + 1,
  creditCardExpirationMonth: 1,
};

export function checkoutPayload(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    userCurrency: 'USD',
    address: VALID_ADDRESS,
    email: 'qa-automation@example.com',
    creditCard: VALID_CREDIT_CARD,
    ...overrides,
  };
}
