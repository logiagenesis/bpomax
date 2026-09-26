import type { Job, Queue } from 'bullmq';
import type { InboundAlert } from './inbox-sync.js';
import type { RepriceAlert } from './reprice.js';

/**
 * Telegram notices from the workers (ARB-510, D-075).
 *
 * The inbox card, the reprice breach card, a new bid's approval card and the usage alert
 * are sent by the bot
 * process, which holds the bot token; the workers put each on the `notify` queue and the
 * bot's `notify` worker (apps/telegram) sends it. A notice is data only: the ids to load
 * the card from, or the text for a chat.
 */
export type NotifyJobData =
  | { readonly kind: 'inbound'; readonly alert: InboundAlert }
  | { readonly kind: 'reprice'; readonly alert: RepriceAlert }
  | { readonly kind: 'queued'; readonly proposalId: string }
  | { readonly kind: 'text'; readonly chatId: string; readonly text: string };

/** Each puts one notice on the queue and answers the queued job. */
export interface Notifier {
  readonly inbound: (alert: InboundAlert) => Promise<Job<NotifyJobData>>;
  readonly reprice: (alert: RepriceAlert) => Promise<Job<NotifyJobData>>;
  /** A bid drafted for approval: its card, with Approve, Edit and Reject. */
  readonly queued: (proposalId: string) => Promise<Job<NotifyJobData>>;
  readonly text: (chatId: string, text: string) => Promise<Job<NotifyJobData>>;
}

export function queueNotifier(queue: Queue): Notifier {
  return {
    inbound: (alert) => queue.add('inbound', { kind: 'inbound', alert } satisfies NotifyJobData),
    reprice: (alert) =>
      queue.add('reprice', { kind: 'reprice', alert } satisfies NotifyJobData, {
        // One card per evaluation, however often the reprice is retried.
        jobId: `reprice__${alert.evaluationId}`,
      }),
    queued: (proposalId) =>
      queue.add('queued', { kind: 'queued', proposalId } satisfies NotifyJobData, {
        jobId: `queued__${proposalId}`,
      }),
    text: (chatId, text) =>
      queue.add('text', { kind: 'text', chatId, text } satisfies NotifyJobData),
  };
}
