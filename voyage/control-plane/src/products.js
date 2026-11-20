import { config } from './config.js';

// Each product has its own image repository and its own release numbering.
// Legacy Voyage images (voyage-tenant:vN) are never renumbered or rewritten.
const REPOS = { vespera: config.vesperaImageRepo, voyage: config.tenantImageRepo };

export const PRODUCTS = Object.keys(REPOS);
export function imageRepo(product) {
  if (!REPOS[product]) throw new Error(`unknown product: ${product}`);
  return REPOS[product];
}
export const imageRef = (product, version) => `${imageRepo(product)}:${version}`;
