/**
 * Where each Upwork call is documented (ARB-300). Every query, field, URL and grant in
 * this package is taken from the official GraphQL API documentation, read on 23/09/2026:
 * https://www.upwork.com/developer/documentation/graphql/api/docs/index.html
 * Each constant below is the anchor of the section a call follows, so the code can name
 * its source and a reader can check it.
 */
export const UPWORK_DOCS =
  'https://www.upwork.com/developer/documentation/graphql/api/docs/index.html';

export function upworkDoc(anchor: string): string {
  return `${UPWORK_DOCS}#${anchor}`;
}

export const DOC = {
  /** The endpoint, https://api.upwork.com/graphql. */
  endpoint: upworkDoc('welcome'),
  /** OAuth 2.0 (RFC 6749); the grants on offer. */
  authentication: upworkDoc('getting-started-authentication'),
  authorize: upworkDoc('auth-authorizationCodeGrant-obtainingAuthorizationCode'),
  token: upworkDoc('auth-authorizationCodeGrant-obtainingAccessToken'),
  refresh: upworkDoc('auth-refreshTokenGrant'),
  /** `X-Upwork-API-TenantId`: which organisation of the user a call acts for. */
  tenant: upworkDoc('auth-organizationId'),
  /** Permissions ("Read marketplace Job Postings"), and 300 requests a minute per IP. */
  permissions: upworkDoc('getting-started-application-permissions'),
  /** Key review, the daily limit of 40,000 requests, and the terms. */
  preparation: upworkDoc('getting-started-preparation'),
  jobSearch: upworkDoc('query-marketplaceJobPostingsSearch'),
  jobFilter: upworkDoc('definition-MarketplaceJobPostingsSearchFilter'),
  jobResult: upworkDoc('definition-MarketplaceJobPostingSearchResult'),
  clientInfo: upworkDoc('definition-MarketplaceJobPostingSearchClientInfo'),
  money: upworkDoc('definition-Money'),
  pagination: upworkDoc('definition-Pagination'),
  user: upworkDoc('query-user'),
  /** "Please read Terms of use (https://www.upwork.com/legal#api) prior to using". */
  terms: 'https://www.upwork.com/legal#api',
} as const;
