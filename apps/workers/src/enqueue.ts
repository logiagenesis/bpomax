import { enqueueDraft } from './draft-bid.js';
import type { QueueSet } from './queues.js';
import { enqueueReprice } from './reprice.js';
import { enqueueScore } from './score.js';
import { enqueueSendMessage } from './send-message.js';
import { enqueueSourcingCollect, enqueueSourcingPost } from './sourcing.js';
import { enqueueSubmit } from './submit.js';

/**
 * What the API hands the queues (ARB-510, the owner's audit E-02): the `Enqueue` of
 * `apps/api/src/context.ts`, bound to real queues. Before this, the API ran with none,
 * so an approval was saved and no job was ever created. The API's `main.ts` builds it
 * from REDIS_URL, and does not start without one.
 */
export function apiEnqueue(queues: QueueSet) {
  return {
    submit: (data: { proposalId: string; requestId?: string }) =>
      enqueueSubmit(queues.submit, data),
    draft: (data: { jobId: string; marginEvaluationId?: string; requestId?: string }) =>
      enqueueDraft(queues['draft-bid'], data),
    score: (data: { jobId: string; requestId?: string }) => enqueueScore(queues.score, data),
    sendMessage: (data: { messageId: string; requestId?: string }) =>
      enqueueSendMessage(queues['send-message'], data),
    sourcingPost: (data: { postId: string; requestId?: string }) =>
      enqueueSourcingPost(queues.sourcing, data),
    sourcingCollect: (data: { postId: string; requestId?: string }) =>
      enqueueSourcingCollect(queues.sourcing, data),
    reprice: (data: { candidateId: string; quoteMinor: string; requestId?: string }) =>
      enqueueReprice(queues.reprice, data),
  };
}
