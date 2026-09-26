// @ts-check
/** The demo's service categories (D-043), split out of demo.js (ARB-531). */
import { DEMO_CATEGORIES, categoryName } from '../shared.js';

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function categoryRoutes(ctx) {
  const { key, respond } = ctx;
  if (key === 'GET /v1/service-categories') {
    return respond(200, {
      categories: DEMO_CATEGORIES.map((slug) => ({
        slug,
        name: categoryName(slug),
        inHouse: false,
      })),
    });
  }
  return undefined;
}
