/** How a provider's refusal is reported. A key never appears in a message. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class BillingError extends Error {
  constructor(
    message: string,
    readonly provider: 'paystack' | 'stripe',
    /** 0 when the provider could not be reached. */
    readonly status: number,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

export async function call(
  provider: 'paystack' | 'stripe',
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
  what: string,
): Promise<Record<string, unknown>> {
  const name = provider === 'paystack' ? 'Paystack' : 'Stripe';
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new BillingError(
      `Could not reach ${name} to ${what}: ${error instanceof Error ? error.message : String(error)}`,
      provider,
      0,
    );
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    body =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (!response.ok || !body) {
    // Paystack answers `{ status: false, message }`; Stripe `{ error: { message } }`.
    const detail =
      provider === 'paystack'
        ? typeof body?.message === 'string'
          ? body.message
          : ''
        : typeof (body?.error as { message?: unknown } | undefined)?.message === 'string'
          ? String((body?.error as { message: string }).message)
          : '';
    throw new BillingError(
      `${name} refused to ${what} (HTTP ${String(response.status)}${detail ? `: ${detail}` : ''}).`,
      provider,
      response.status,
    );
  }
  return body;
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
