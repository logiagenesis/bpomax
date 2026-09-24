import type { EmailMessage, EmailSender } from './index.js';

/**
 * A stand-in for an email provider, for tests: it keeps what it was asked to send, and
 * can be told to fail the next send, as a provider's outage would.
 */
export interface FakeEmail extends EmailSender {
  readonly sent: EmailMessage[];
  failNext(message?: string): void;
}

export function createFakeEmail(): FakeEmail {
  const sent: EmailMessage[] = [];
  let failure: string | null = null;
  return {
    sent,
    failNext(message = 'the stand-in email provider refused the message') {
      failure = message;
    },
    async send(message) {
      if (failure !== null) {
        const reason = failure;
        failure = null;
        throw new Error(reason);
      }
      sent.push(message);
    },
  };
}
