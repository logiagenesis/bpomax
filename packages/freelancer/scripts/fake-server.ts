/**
 * Runs the Freelancer.com stand-in for local development (D-036). Point .env at it:
 *
 *   FREELANCER_BASE_URL=http://127.0.0.1:4010
 *   FREELANCER_CLIENT_ID=fake-client-id
 *   FREELANCER_CLIENT_SECRET=fake-client-secret
 *
 * "Connect Freelancer.com" on the settings page then goes to the stand-in's authorise
 * page. That page consents at once and sends the browser back with a code. The settings
 * page labels the account as connected to a stand-in.
 */
import { startFakeFreelancer } from '../src/fake.js';

const port = Number(process.env.FAKE_FREELANCER_PORT ?? 4010);
const fake = await startFakeFreelancer({ port });
process.stdout.write(
  `Freelancer.com stand-in on ${fake.url} (client id ${fake.clientId}, secret ${fake.clientSecret})\n`,
);
