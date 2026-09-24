// @ts-check
import { captureReferral } from './lib/referral.js';

/** The landing page (ARB-430): a referral link's click is recorded here. */
void captureReferral('index.html');
