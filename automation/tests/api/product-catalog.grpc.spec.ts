import { test, expect } from '@playwright/test';
import { productCatalogClient, PRODUCT_CATALOG_ADDR } from '../../fixtures/grpc';
import { PRODUCT_IDS } from '../../fixtures/testData';

// TC-PC-03 (search edge cases) — the only test in this suite that talks gRPC directly,
// because SearchProducts has no REST BFF equivalent (see product-catalog.spec.ts).
// Requires PRODUCT_CATALOG_GRPC_ADDR to be set to the docker-compose-published host:port
// for product-catalog's 3550, e.g.:
//   PRODUCT_CATALOG_GRPC_ADDR=$(docker compose -f ../opentelemetry-demo/compose.yaml port product-catalog 3550 | sed 's/0.0.0.0/localhost/')
//
// The client is created inside beforeAll, not at describe time: a describe body runs during
// test discovery even when its tests are skipped, so any throw there (a missing proto, an
// unresolvable address) used to take the entire suite down with it.
test.describe('Product catalog (gRPC) — SearchProducts edge cases', () => {
  test.skip(
    !PRODUCT_CATALOG_ADDR,
    'Set PRODUCT_CATALOG_GRPC_ADDR (see file header) to run this against a live docker-compose stack.'
  );

  let client: any;
  test.beforeAll(() => {
    client = productCatalogClient(PRODUCT_CATALOG_ADDR);
  });

  function search(query: string): Promise<{ results: any[] }> {
    return new Promise((resolve, reject) => {
      client.SearchProducts({ query }, (err: Error | null, res: any) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
  }

  test('no-match query returns an empty result set, not an error', async () => {
    const res = await search('zzz-nonexistent-zzz');
    expect(res.results).toHaveLength(0);
  });

  test('empty query does not throw', async () => {
    await expect(search('')).resolves.toBeDefined();
  });

  test('injection-shaped and very long queries are treated as literal strings, not errors', async () => {
    await expect(search("' OR 1=1 --")).resolves.toBeDefined();
    await expect(search('a'.repeat(10_000))).resolves.toBeDefined();
  });

  test('a real product name substring returns that product', async () => {
    // Cross-check: search should find a product we know exists by ID via a name fragment
    // ("Solar System Color Imager" per postgresql/init.sql).
    const res = await search('Solar System');
    const ids = res.results.map((p: any) => p.id);
    expect(ids).toContain(PRODUCT_IDS.SOLAR_SYSTEM_IMAGER);
  });
});
