import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

/**
 * The proto is vendored into automation/protos/ (copied from opentelemetry-demo/pb/demo.proto,
 * upstream commit e297a3be) so this suite is self-contained: it does not depend on where, or
 * whether, the demo repo is cloned. Running `npm test` without the demo clone present used to
 * throw at test-collection time and abort the whole run with "0 tests in 0 files", because
 * the gRPC spec built its client while Playwright was still discovering tests.
 *
 * Refresh with: cp opentelemetry-demo/pb/demo.proto automation/protos/demo.proto
 */
const PROTO_PATH = path.resolve(__dirname, '../protos/demo.proto');

/**
 * product-catalog's gRPC port isn't fixed on the host — compose.yaml publishes it with
 * short-syntax `ports: ["${PRODUCT_CATALOG_PORT}"]`, which Docker maps to a random host
 * port each `docker compose up`. Resolve it once via:
 *   docker compose port product-catalog 3550
 * and pass the result as PRODUCT_CATALOG_GRPC_ADDR, or run tests from inside the compose
 * network where the fixed internal address (product-catalog:3550) works directly.
 */
export const PRODUCT_CATALOG_ADDR = process.env.PRODUCT_CATALOG_GRPC_ADDR;

export function productCatalogClient(address: string = PRODUCT_CATALOG_ADDR || 'localhost:3550') {
  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDef) as any;
  return new proto.oteldemo.ProductCatalogService(address, grpc.credentials.createInsecure());
}
