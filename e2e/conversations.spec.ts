import { expect, test, type Page } from '@playwright/test';
import {
  expectEveryLinkGoesSomewhere,
  expectNoSidewaysScroll,
  expectStatus,
  serveApi,
  signedIn,
  type Captured,
  type Role,
} from './helpers.js';

/**
 * ARB-140: the conversations page. The API is an in-memory copy, at the network edge,
 * of routes/threads.ts (GET /v1/threads, GET /v1/threads/:id), routes/messages.ts
 * (POST /v1/threads/:id/messages), routes/discovery.ts and routes/briefs.ts, in the
 * shapes those routes return (each tested against real Postgres in its own test file).
 */
const ACME = 'aaaaaaaa-0000-4000-8000-000000000041';
const QUIET = 'aaaaaaaa-0000-4000-8000-000000000042';
const BRIEF_V1 = 'aaaaaaaa-0000-4000-8000-000000000051';
const BRIEF_V2 = 'aaaaaaaa-0000-4000-8000-000000000052';

const QUESTIONS = [
  ['outcome', 'What is the end result you need, in one sentence?'],
  ['users', 'Who uses it (you, your staff, your customers)?'],
  ['day_one', 'What must it do on day one? What can wait?'],
  ['references', 'Do you have examples you like (links, screenshots)?'],
  ['assets', 'Existing assets: domain, hosting, logins, brand files, content, data?'],
  ['tech', 'Technology constraints or preferences?'],
  ['deadline', 'Deadline, and is it fixed?'],
  ['budget', 'Budget range, and fixed or hourly?'],
  ['acceptance', 'How will you judge that it is finished (acceptance)?'],
  ['sign_off', 'Who signs off, and how fast can they respond?'],
] as const;

function thread(partial: Record<string, unknown>) {
  return {
    id: ACME,
    platform: 'freelancer',
    externalThreadId: '5001',
    jobId: 'j1',
    jobTitle: 'Shopify store rebuild',
    clientHandle: 'acme-shop',
    status: 'awaiting_operator',
    lastMessageAt: '2026-09-23T09:58:00Z',
    messageCount: 3,
    pendingReplies: 1,
    lastMessage: { direction: 'out', body: 'Yes, Monday works.', sentAt: null },
    discovery: { completeness: 30 },
    brief: { id: BRIEF_V1, version: 1, locked: false },
    createdAt: '2026-09-22T08:00:00Z',
    updatedAt: '2026-09-23T09:59:00Z',
    ...partial,
  };
}

const ACME_THREAD = thread({});
const QUIET_THREAD = thread({
  id: QUIET,
  externalThreadId: '5002',
  jobId: null,
  jobTitle: null,
  clientHandle: 'quiet-client',
  status: 'open',
  lastMessageAt: null,
  messageCount: 0,
  pendingReplies: 0,
  lastMessage: null,
  discovery: null,
  brief: null,
});

const MESSAGES = [
  {
    id: 'm1',
    direction: 'out',
    origin: 'platform',
    body: 'Hello, here is our bid.',
    state: 'observed',
    sentAt: '2026-09-22T08:00:00Z',
    approvedByName: null,
    approvedVia: null,
    rejectedAt: null,
    failureReason: null,
    externalMessageId: 'x1',
    createdAt: '2026-09-22T08:00:00Z',
  },
  {
    id: 'm2',
    direction: 'in',
    origin: 'platform',
    body: 'Hi, can you start on Monday?',
    state: 'received',
    sentAt: '2026-09-23T09:58:00Z',
    approvedByName: null,
    approvedVia: null,
    rejectedAt: null,
    failureReason: null,
    externalMessageId: 'x2',
    createdAt: '2026-09-23T09:58:30Z',
  },
  {
    id: 'm3',
    direction: 'out',
    origin: 'app',
    body: 'Yes, Monday works.',
    state: 'queued',
    sentAt: null,
    approvedByName: null,
    approvedVia: null,
    rejectedAt: null,
    failureReason: null,
    externalMessageId: null,
    createdAt: '2026-09-23T09:59:00Z',
  },
];

type Answers = Record<string, { answer: string; source: string; capturedAt: string }>;
function session(answers: Answers, asked: Record<string, string>) {
  const answered = Object.keys(answers).length;
  const next = QUESTIONS.filter(([key]) => !answers[key])
    .sort((a, b) => Number(Boolean(asked[a[0]])) - Number(Boolean(asked[b[0]])))
    .slice(0, 3)
    .map(([key]) => key);
  return {
    id: 's1',
    threadId: ACME,
    version: '1',
    completeness: answered * 10,
    answers,
    asked,
    questions: QUESTIONS.map(([key, text]) => ({
      key,
      text,
      answer: answers[key] ?? null,
      askedAt: asked[key] ?? null,
    })),
    nextBatch: next,
    createdAt: '2026-09-22T08:00:00Z',
    updatedAt: '2026-09-23T09:58:00Z',
  };
}

const THREE_ANSWERED: Answers = {
  outcome: { answer: 'An online shop', source: 'client', capturedAt: '2026-09-23T09:58:00Z' },
  users: { answer: 'Their customers', source: 'operator', capturedAt: '2026-09-23T09:58:00Z' },
  day_one: { answer: 'Take orders', source: 'client', capturedAt: '2026-09-23T09:58:00Z' },
};
const ASKED_THREE = {
  outcome: '2026-09-22T08:00:00Z',
  users: '2026-09-22T08:00:00Z',
  day_one: '2026-09-22T08:00:00Z',
};

function brief(partial: Record<string, unknown>) {
  return {
    id: BRIEF_V1,
    threadId: ACME,
    version: 1,
    locked: false,
    lockedAt: null,
    title: 'Shopify store rebuild',
    outcome: 'An online shop',
    users: 'Their customers',
    mustHaves: ['Take orders'],
    later: [],
    references: [],
    assetsProvided: [],
    assetsMissing: [],
    techConstraints: [],
    deadline: null,
    deadlineFixed: null,
    budget: { minMinor: null, maxMinor: null, currency: null, type: null },
    acceptanceCriteria: [],
    signOff: { name: null, responseTime: null },
    risks: [],
    category: null,
    deliveryRoute: null,
    lockBlockers: ['a service category', 'a delivery route', 'at least one acceptance criterion'],
    createdAt: '2026-09-23T09:58:00Z',
    updatedAt: '2026-09-23T09:58:00Z',
    ...partial,
  };
}

const COMPLETE = brief({
  deadline: '2026-11-30',
  deadlineFixed: false,
  budget: { minMinor: 150000, maxMinor: 200000, currency: 'ZAR', type: 'fixed' },
  acceptanceCriteria: ['Orders go through'],
  category: 'shopify',
  deliveryRoute: 'in_house',
  lockBlockers: [],
});

interface Options {
  role?: Role;
  threads?: unknown[];
  messages?: unknown[];
  session?: unknown;
  brief?: unknown;
  versions?: unknown[];
  categories?: unknown[];
  next?: { status: number; json: unknown };
  lock?: { status: number; json: unknown };
  put?: { status: number; json: unknown };
}

const versionOf = (b: {
  id: string;
  version: number;
  locked: boolean;
  lockedAt: string | null;
  updatedAt: string;
}) => ({
  id: b.id,
  version: b.version,
  locked: b.locked,
  lockedAt: b.lockedAt,
  updatedAt: b.updatedAt,
});

async function serve(page: Page, options: Options = {}): Promise<Captured[]> {
  await signedIn(page);
  const threads = options.threads ?? [ACME_THREAD, QUIET_THREAD];
  const current = options.brief === undefined ? brief({}) : options.brief;
  return serveApi(
    page,
    {
      'GET /v1/service-categories': (_request, route) =>
        route.fulfill({
          json: {
            categories: options.categories ?? [
              { slug: 'shopify', name: 'Shopify', inHouse: true },
              { slug: 'wordpress', name: 'WordPress', inHouse: true },
            ],
          },
        }),
      'GET /v1/threads': (request, route) => {
        const wanted = request.query.get('status');
        return route.fulfill({
          json: {
            threads: (threads as { status: string }[]).filter(
              (t) => !wanted || t.status === wanted,
            ),
            page: { limit: 50, offset: 0 },
          },
        });
      },
      'GET /v1/threads/:id/discovery': (request, route) =>
        route.fulfill({
          json: {
            session: request.path.includes(ACME)
              ? options.session === undefined
                ? session(THREE_ANSWERED, ASKED_THREE)
                : options.session
              : null,
          },
        }),
      'POST /v1/threads/:id/discovery': (_request, route) =>
        route.fulfill({
          status: 201,
          json: {
            session: session({}, { outcome: 'now', users: 'now', day_one: 'now' }),
            draft: { messageId: 'm9', keys: ['outcome', 'users', 'day_one'], body: '…' },
          },
        }),
      'PATCH /v1/threads/:id/discovery/answers': (request, route) => {
        const body = request.body as { answers: Record<string, string> };
        const merged: Answers = { ...THREE_ANSWERED };
        for (const [key, answer] of Object.entries(body.answers)) {
          merged[key] = { answer, source: 'operator', capturedAt: '2026-09-23T10:00:00Z' };
        }
        return route.fulfill({ json: { session: session(merged, ASKED_THREE) } });
      },
      'POST /v1/threads/:id/discovery/next': (_request, route) =>
        route.fulfill(
          options.next ?? {
            status: 201,
            json: {
              session: session(THREE_ANSWERED, {
                ...ASKED_THREE,
                references: 'now',
                assets: 'now',
                tech: 'now',
              }),
              draft: { messageId: 'm10', keys: ['references', 'assets', 'tech'], body: '…' },
            },
          },
        ),
      'GET /v1/threads/:id/brief': (request, route) =>
        route.fulfill({
          json: request.path.includes(ACME)
            ? {
                brief: current,
                versions: options.versions ?? (current ? [versionOf(current as never)] : []),
              }
            : { brief: null, versions: [] },
        }),
      'POST /v1/threads/:id/brief': (_request, route) =>
        route.fulfill({ status: 201, json: { brief: brief({ threadId: QUIET }) } }),
      'GET /v1/briefs/:id': (request, route) =>
        route.fulfill({
          json: {
            brief: request.path.endsWith(BRIEF_V1)
              ? brief({ locked: true, lockedAt: '2026-09-22T10:00:00Z' })
              : brief({ id: BRIEF_V2, version: 2 }),
          },
        }),
      'PUT /v1/briefs/:id': (request, route) =>
        route.fulfill(
          options.put ?? {
            status: 200,
            json: { brief: { ...COMPLETE, ...(request.body as object), lockBlockers: [] } },
          },
        ),
      'POST /v1/briefs/:id/lock': (_request, route) =>
        route.fulfill(
          options.lock ?? {
            status: 200,
            json: { brief: { ...COMPLETE, locked: true, lockedAt: '2026-09-23T10:05:00Z' } },
          },
        ),
      'POST /v1/briefs/:id/versions': (_request, route) =>
        route.fulfill({
          status: 201,
          json: { brief: { ...COMPLETE, id: BRIEF_V2, version: 2, locked: false, lockedAt: null } },
        }),
      'POST /v1/threads/:id/messages': (request, route) =>
        route.fulfill({
          status: 201,
          json: {
            message: {
              id: 'm11',
              threadId: ACME,
              body: (request.body as { body: string }).body,
              state: 'queued',
            },
          },
        }),
      'GET /v1/threads/:id': (request, route) => {
        const id = request.path.split('/').pop();
        const found = (threads as { id: string }[]).find((t) => t.id === id);
        if (!found) return route.fulfill({ status: 404, json: { error: 'no such thread' } });
        return route.fulfill({
          json: { thread: found, messages: id === ACME ? (options.messages ?? MESSAGES) : [] },
        });
      },
    },
    { role: options.role },
  );
}

async function open(page: Page, options: Options = {}): Promise<Captured[]> {
  const requests = await serve(page, options);
  await page.goto('/conversations.html');
  await expectStatus(page, /Loaded \d+ conversations?\./);
  return requests;
}

async function openAcme(page: Page, options: Options = {}): Promise<Captured[]> {
  const requests = await open(page, options);
  await page.getByRole('button', { name: 'Open the conversation with acme-shop' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'Opened the conversation with acme-shop.',
  );
  return requests;
}

test('lists every conversation with where it stands, and every link goes somewhere', async ({
  page,
}) => {
  await open(page);
  const rows = page.locator('#rows tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('acme-shop');
  await expect(rows.nth(0)).toContainText('Shopify store rebuild');
  await expect(rows.nth(0)).toContainText('Awaiting you');
  await expect(rows.nth(0)).toContainText('You: Yes, Monday works.');
  await expect(rows.nth(0)).toContainText('30 %');
  await expect(rows.nth(0)).toContainText('Version 1, open');
  await expect(rows.nth(0)).toContainText('1 reply');
  await expect(rows.nth(1)).toContainText('No linked job');
  await expect(rows.nth(1)).toContainText('No messages yet');
  await expect(rows.nth(1)).toContainText('Not started');
  await expect(rows.nth(1)).toContainText('None');
  await expect(page.locator('#thread')).toBeHidden();
  await expect(page.getByRole('link', { name: 'Conversations' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectEveryLinkGoesSomewhere(page);
});

test('the status filter sends exactly that status and lands in the address bar; refresh asks again', async ({
  page,
}) => {
  const requests = await open(page);
  await page.getByLabel('Status').selectOption('open');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expectStatus(page, 'Loaded 1 conversation.');
  expect(
    requests
      .filter((r) => r.path === '/v1/threads')
      .at(-1)
      ?.query.get('status'),
  ).toBe('open');
  await expect(page).toHaveURL(/status=open/);
  await page.getByLabel('Status').selectOption('closed');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expectStatus(page, 'No conversations match this filter.');
  await expect(page.locator('#empty')).toBeVisible();
  const before = requests.filter((r) => r.path === '/v1/threads').length;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expectStatus(page, 'No conversations match this filter.');
  expect(requests.filter((r) => r.path === '/v1/threads').length).toBe(before + 1);
});

test('Open shows the messages in order with the state of each, the discovery answers and the brief', async ({
  page,
}) => {
  await openAcme(page);
  await expect(page.locator('#thread-title')).toHaveText('Conversation with acme-shop');
  await expect(page.locator('#thread-meta')).toContainText('About Shopify store rebuild');
  const messages = page.locator('#messages li');
  await expect(messages).toHaveCount(3);
  await expect(messages.nth(0)).toContainText('Sent, seen on the platform');
  await expect(messages.nth(0)).toContainText('22/09/2026 10:00');
  await expect(messages.nth(1)).toContainText('From the client');
  await expect(messages.nth(1)).toContainText('Hi, can you start on Monday?');
  await expect(messages.nth(2)).toContainText('Waiting for approval');
  await expect(page.locator('#discovery-completeness')).toHaveText('30 %');
  await expect(page.locator('#discovery-summary')).toContainText('3 of 10 questions answered');
  await expect(page.getByLabel('What is the end result you need, in one sentence?')).toHaveValue(
    'An online shop',
  );
  await expect(page.locator('#discovery-answers-users-hint')).toContainText('entered by hand');
  await expect(page.locator('#discovery-answers-references-hint')).toHaveText('Not asked yet.');
  await expect(page.getByRole('button', { name: 'Start discovery' })).toBeDisabled();
  await expect(page.locator('#brief-state')).toHaveText('Version 1, open');
  await expect(page.locator('#brief-summary')).toContainText(
    'To lock it, it still needs a service category, a delivery route and at least one acceptance criterion.',
  );
  await expect(page.getByLabel('Title')).toHaveValue('Shopify store rebuild');
  await expect(page.getByLabel('Must-haves, one per line')).toHaveValue('Take orders');
  await expect(page.getByRole('button', { name: 'Draft brief' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start a new version' })).toBeDisabled();
  await expect(page).toHaveURL(new RegExp(`thread=${ACME}`));
  await expect(page.locator('#rows tr').nth(0)).toHaveAttribute('aria-current', 'true');
});

test('a linked view opens its conversation', async ({ page }) => {
  await serve(page);
  await page.goto(`/conversations.html?thread=${ACME}`);
  await expect(page.locator('#thread-status')).toHaveText(
    'Opened the conversation with acme-shop.',
  );
  await expectStatus(page, 'Loaded 2 conversations.');
  await expect(page.locator('#messages li')).toHaveCount(3);
});

test('Queue reply drafts the reply for approval and never sends it; an empty reply is refused on the page', async ({
  page,
}) => {
  const requests = await openAcme(page);
  await page.getByRole('button', { name: 'Queue reply' }).click();
  await expect(page.locator('#reply-body-error')).toHaveText('Must not be empty.');
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  await page.getByLabel('Reply').fill('  Monday at 09:00 works for us.  ');
  await page.getByRole('button', { name: 'Queue reply' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'Your reply to acme-shop is waiting for approval in Approvals.',
  );
  const call = requests.find((r) => r.method === 'POST' && r.path.endsWith('/messages'));
  expect(call?.path).toBe(`/v1/threads/${ACME}/messages`);
  expect(call?.body).toEqual({ body: 'Monday at 09:00 works for us.' });
  await expect(page.getByLabel('Reply')).toHaveValue('');
  // The thread is read again so the draft shows; nothing else is posted.
  await expect.poll(() => requests.filter((r) => r.path === `/v1/threads/${ACME}`).length).toBe(2);
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
});

test('Start discovery drafts the first three questions for approval on a thread without a session', async ({
  page,
}) => {
  const requests = await open(page);
  await page.getByRole('button', { name: 'Open the conversation with quiet-client' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'Opened the conversation with quiet-client.',
  );
  await expect(page.locator('#discovery-completeness')).toHaveText('Not started');
  await expect(page.getByRole('button', { name: 'Ask the next questions' })).toBeDisabled();
  await expect(page.locator('#discovery-form')).toBeHidden();
  await page.getByRole('button', { name: 'Start discovery' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'Discovery started. The first 3 questions are drafted as a reply and wait for approval in Approvals.',
  );
  expect(requests.find((r) => r.method === 'POST')?.path).toBe(`/v1/threads/${QUIET}/discovery`);
});

test('Save answers sends only the answers that changed, and the completeness follows', async ({
  page,
}) => {
  const requests = await openAcme(page);
  await page.getByRole('button', { name: 'Save answers' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'Nothing changed: type or change an answer, then save.',
  );
  await page.getByLabel('Deadline, and is it fixed?').fill('End of November, flexible');
  await page.getByLabel('Budget range, and fixed or hourly?').fill(' About R20 000, fixed ');
  await page.getByRole('button', { name: 'Save answers' }).click();
  await expect(page.locator('#thread-status')).toHaveText('Saved 2 answers. Completeness is 50 %.');
  const call = requests.find((r) => r.method === 'PATCH');
  expect(call?.path).toBe(`/v1/threads/${ACME}/discovery/answers`);
  expect(call?.body).toEqual({
    answers: { deadline: 'End of November, flexible', budget: 'About R20 000, fixed' },
  });
});

test('Ask the next questions drafts a batch of three; the API’s refusal is shown as it is', async ({
  page,
}) => {
  const requests = await openAcme(page);
  await page.getByRole('button', { name: 'Ask the next questions' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'The next 3 questions are drafted as a reply and wait for approval in Approvals.',
  );
  expect(requests.find((r) => r.method === 'POST')?.path).toBe(
    `/v1/threads/${ACME}/discovery/next`,
  );
});

test('a refused batch shows the API’s words, and an answered set turns the button off', async ({
  page,
}) => {
  await openAcme(page, {
    next: {
      status: 409,
      json: { error: 'Every question has been answered; there is nothing left to ask.' },
    },
  });
  await page.getByRole('button', { name: 'Ask the next questions' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'Every question has been answered; there is nothing left to ask.',
  );
  await expect(page.locator('#thread-status')).toHaveClass(/alert--error/);
});

test('Draft brief fills version 1 from the answers on a thread without a brief', async ({
  page,
}) => {
  const requests = await open(page);
  await page.getByRole('button', { name: 'Open the conversation with quiet-client' }).click();
  await expect(page.locator('#brief-state')).toHaveText('None');
  await expect(page.locator('#brief-form')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Lock brief' })).toBeDisabled();
  await page.getByRole('button', { name: 'Draft brief' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'Drafted version 1 of the brief from the discovery answers. To lock it, it still needs a service category, a delivery route and at least one acceptance criterion.',
  );
  expect(requests.find((r) => r.method === 'POST')?.path).toBe(`/v1/threads/${QUIET}/brief`);
});

test('Save brief sends the deadline as ISO and the budget as whole cents; a bad date is refused on the page', async ({
  page,
}) => {
  const requests = await openAcme(page);
  await page.getByLabel('Deadline (DD/MM/YYYY)').fill('31/11/2026');
  await page.getByRole('button', { name: 'Save brief' }).click();
  await expect(page.locator('#brief-deadline-error')).toHaveText('Must be a date as DD/MM/YYYY.');
  expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(0);

  await page.getByLabel('Deadline (DD/MM/YYYY)').fill('30/11/2026');
  await page.getByLabel('Is the deadline fixed?').selectOption('false');
  await page.getByLabel('Category').selectOption('shopify');
  await page.getByLabel('Delivery route').selectOption('in_house');
  await page.getByLabel('Budget currency').fill('zar');
  await page.getByLabel('Budget from').fill('1 500,00');
  await page.getByLabel('Budget to').fill('2000');
  await page.getByLabel('Budget type').selectOption('fixed');
  await page
    .getByLabel('Acceptance criteria, one per line')
    .fill('Orders go through\n\n  Refunds work  ');
  await page.getByRole('button', { name: 'Save brief' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'Saved version 1 of the brief. It has everything a lock needs.',
  );
  const call = requests.find((r) => r.method === 'PUT');
  expect(call?.path).toBe(`/v1/briefs/${BRIEF_V1}`);
  expect(call?.body).toMatchObject({
    title: 'Shopify store rebuild',
    deadline: '2026-11-30',
    deadlineFixed: false,
    // Hand-worked: R1 500,00 is 150 000 cents; R2 000 is 200 000 cents.
    budget: { minMinor: 150000, maxMinor: 200000, currency: 'ZAR', type: 'fixed' },
    acceptanceCriteria: ['Orders go through', 'Refunds work'],
    category: 'shopify',
    deliveryRoute: 'in_house',
  });
});

test('the API’s field errors on a save land on the fields', async ({ page }) => {
  await openAcme(page, {
    put: {
      status: 422,
      json: {
        error: 'the request was not accepted',
        errors: [{ field: 'category', message: 'is not a service category' }],
      },
    },
  });
  await page.getByLabel('Category').selectOption('wordpress');
  await page.getByRole('button', { name: 'Save brief' }).click();
  await expect(page.locator('#brief-category-error')).toHaveText('Is not a service category.');
  await expect(page.locator('#thread-status')).toHaveClass(/alert--error/);
});

test('Lock brief asks first, is refused with the missing items named, and locks a complete brief', async ({
  page,
}) => {
  const requests = await openAcme(page, {
    lock: {
      status: 422,
      json: {
        error: 'The brief cannot lock without a service category, a delivery route.',
        errors: [
          { field: 'lock', message: 'needs a service category' },
          { field: 'lock', message: 'needs a delivery route' },
        ],
      },
    },
  });
  await page.getByRole('button', { name: 'Lock brief' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Lock version 1 of the brief?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(requests.filter((r) => r.path.endsWith('/lock'))).toHaveLength(0);

  await page.getByRole('button', { name: 'Lock brief' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Lock' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'The brief cannot lock without a service category, a delivery route.',
  );
  await expect(page.locator('#brief-lock-error')).toHaveText(
    'needs a service category; needs a delivery route.',
  );
  expect(requests.filter((r) => r.path.endsWith('/lock'))).toHaveLength(1);
});

test('a locked brief is read-only; a new version starts from it and every version stays listed', async ({
  page,
}) => {
  const locked = { ...COMPLETE, locked: true, lockedAt: '2026-09-22T10:00:00Z' };
  const requests = await openAcme(page, { brief: locked, versions: [versionOf(locked)] });
  await expect(page.locator('#brief-state')).toHaveText('Version 1, locked');
  await expect(page.locator('#brief-summary')).toContainText(
    'Version 1 was locked on 22/09/2026 12:00 and cannot be changed.',
  );
  await expect(page.locator('#brief-summary')).not.toContainText('Budget');
  await expect(page.getByLabel('Title')).toHaveAttribute('readonly', '');
  const save = page.getByRole('button', { name: 'Save brief' });
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute(
    'title',
    'Version 1 is locked. Start a new version to change it.',
  );
  await expect(page.getByRole('button', { name: 'Lock brief' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Show version 1 of the brief' })).toBeDisabled();
  await page.getByRole('button', { name: 'Start a new version' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'Started version 2 of the brief from version 1.',
  );
  expect(requests.find((r) => r.path.endsWith('/versions'))?.path).toBe(
    `/v1/briefs/${BRIEF_V1}/versions`,
  );
});

test('an older version can be shown read-only beside the current one', async ({ page }) => {
  const v2 = { ...COMPLETE, id: BRIEF_V2, version: 2 };
  await openAcme(page, {
    brief: v2,
    versions: [
      versionOf(v2),
      versionOf({ ...COMPLETE, locked: true, lockedAt: '2026-09-22T10:00:00Z' }),
    ],
  });
  await expect(page.locator('#brief-versions li')).toHaveCount(2);
  await expect(page.locator('#brief-versions li').nth(1)).toContainText('locked 22/09/2026 12:00');
  await page.getByRole('button', { name: 'Show version 1 of the brief' }).click();
  await expect(page.locator('#thread-status')).toHaveText(
    'Showing version 1 of the brief, locked.',
  );
  await expect(page.locator('#brief-state')).toHaveText('Version 1, locked');
  await expect(page.locator('#brief-summary')).toContainText('The current version is 2.');
  await expect(page.getByRole('button', { name: 'Save brief' })).toBeDisabled();
  await page.getByRole('button', { name: 'Show version 2 of the brief' }).click();
  await expect(page.locator('#brief-state')).toHaveText('Version 2, open');
  await expect(page.getByRole('button', { name: 'Save brief' })).toBeEnabled();
});

test('a viewer can read everything but every change is off, with the reason in its title', async ({
  page,
}) => {
  await openAcme(page, { role: 'viewer' });
  for (const name of [
    'Queue reply',
    'Start discovery',
    'Ask the next questions',
    'Save answers',
    'Draft brief',
    'Lock brief',
    'Start a new version',
    'Save brief',
  ]) {
    const button = page.getByRole('button', { name });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute(
      'title',
      'Your role can view conversations but not change them.',
    );
  }
  await expect(page.getByLabel('Reply')).toHaveAttribute('readonly', '');
  await expect(page.locator('#messages li')).toHaveCount(3);
});

test('a conversation the API cannot find says so', async ({ page }) => {
  await serve(page);
  await page.goto('/conversations.html?thread=aaaaaaaa-0000-4000-8000-000000000099');
  await expect(page.locator('#thread-status')).toHaveText(
    'The API refused the request: no such thread.',
  );
  await expectStatus(page, 'Loaded 2 conversations.');
});

test('at 380 px wide the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await openAcme(page);
  await expectNoSidewaysScroll(page);
});
