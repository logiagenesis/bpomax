import type { NotifyJobData } from '@arbitron/workers';
import type { Job } from 'bullmq';
import { notifyQueued, type BotDeps } from './engine.js';
import { notifyInbound } from './inbox.js';
import { notifyReprice } from './reprice.js';

/**
 * The bot's `notify` worker (ARB-510, D-075): sends the Telegram notices the workers put
 * on the `notify` queue, so the bot token lives in this process alone. Each notice is
 * loaded from the database when it is sent, so the card shows the state of that moment.
 * Returns how many chats were sent to.
 */
export function notifyProcessor(deps: BotDeps) {
  return async (job: Job<NotifyJobData>): Promise<number> => {
    const data = job.data;
    if (data.kind === 'inbound') return notifyInbound(deps, data.alert);
    if (data.kind === 'reprice') return notifyReprice(deps, data.alert);
    if (data.kind === 'queued') return notifyQueued(deps, data.proposalId);
    await deps.api.sendMessage(data.chatId, data.text);
    return 1;
  };
}
