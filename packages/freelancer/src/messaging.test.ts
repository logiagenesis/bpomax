import { describe, expect, it } from 'vitest';
import {
  messagesSearchParams,
  parseMessage,
  parseThread,
  parseUsers,
  threadsSearchParams,
} from './messaging.js';

/**
 * ARB-120: the two inbox requests held to the documented parameters, and the documented
 * shapes read back (developers.freelancer.com, "List Threads", "List Messages", and the
 * messaging walkthrough). The calls over HTTP are exercised by apps/workers' inbox test.
 */
describe('the requests', () => {
  it('threads: context type, the inclusive from time in seconds, both projections, limit capped', () => {
    const params = threadsSearchParams({
      contextType: 'project',
      fromUpdatedTime: new Date('2026-09-23T08:00:00.500Z'),
      limit: 1000,
      offset: 100,
    });
    expect(params.toString()).toBe(
      'context_type=project&from_updated_time=1790150400&user_details=true&context_details=true&limit=100&offset=100',
    );
  });

  it('messages: one threads[] per id, the from time, limit', () => {
    expect(
      messagesSearchParams({
        threads: ['5001', '5002'],
        fromUpdatedTime: new Date(1790150400000),
      }).toString(),
    ).toBe('threads%5B%5D=5001&threads%5B%5D=5002&from_updated_time=1790150400&limit=100');
  });
});

describe('the documented shapes', () => {
  it('reads the walkthrough’s thread and message', () => {
    const thread = parseThread({
      message_count: null,
      time_updated: 1444952623,
      thread: {
        context: { type: 'project', id: 12345678 },
        thread_type: 'private_chat',
        time_created: 1444952623,
        members: [1234567, 1234568],
        owner: 1234567,
        id: 12345678,
      },
      is_read: true,
      folder: 'archived',
      id: 12345678,
    });
    expect(thread).toMatchObject({
      id: '12345678',
      contextType: 'project',
      contextId: '12345678',
      members: ['1234567', '1234568'],
      owner: '1234567',
      threadType: 'private_chat',
      isRead: true,
      folder: 'archived',
    });
    expect(thread?.timeUpdated?.toISOString()).toBe('2015-10-15T23:43:43.000Z');

    const message = parseMessage({
      message_source: 'default_msg',
      attachments: [],
      client_message_id: null,
      parent_id: 80005785,
      time_created: 1418600746,
      thread_id: 80000449,
      remove_reason: null,
      from_user: 1234567,
      message: 'Hey',
      id: 80005796,
    });
    expect(message).toMatchObject({
      id: '80005796',
      threadId: '80000449',
      fromUser: '1234567',
      message: 'Hey',
      attachmentCount: 0,
      parentId: '80005785',
    });
    expect(message?.timeCreated?.toISOString()).toBe('2014-12-14T23:45:46.000Z');
  });

  it('leaves out what has no id, and reads members leniently', () => {
    expect(parseThread({ thread: {} })).toBeNull();
    expect(parseMessage({ id: 1 })).toBeNull();
    expect(parseUsers({ '7': { id: 7, username: 'acme', display_name: 'Acme' }, '8': {} })).toEqual(
      {
        '7': { id: '7', username: 'acme', displayName: 'Acme' },
        '8': { id: '8', username: null, displayName: null },
      },
    );
    expect(parseUsers(null)).toEqual({});
  });
});
