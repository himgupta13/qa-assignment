import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PROTO_PATH = path.resolve(__dirname, '../../opentelemetry-demo/pb/demo.proto');

/**
 * product-catalog's gRPC port isn't fixed on the host — compose.yaml publishes it with
 * short-syntax `ports: ["${PRODUCT_CATALOG_PORT}"]`, which Docker maps to a random host
 * port each `docker compose up`. Resolve it once via:
 *   docker compose port product-catalog 3550
 * and pass the result as PRODUCT_CATALOG_GRPC_ADDR, or run tests from inside the compose
 * network where the fixed internal address (product-catalog:3550) works directly.
 */
const PRODUCT_CATALOG_ADDR = process.env.PRODUCT_CATALOG_GRPC_ADDR || 'localhost:3550';

export function productCatalogClient() {
  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDef) as any;
  return new proto.oteldemo.ProductCatalogService(PRODUCT_CATALOG_ADDR, grpc.credentials.createInsecure());
}
