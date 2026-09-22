/**
 * Who may do what (ARB-012, docs/01 section H).
 *
 * This is the application's copy of a rule the database already enforces through RLS
 * (migrations 0008 and 0009). It exists so the interface can grey out a button rather
 * than let someone press it and collect an error — never as the thing standing between
 * a viewer and an approval. `packages/db/src/role-parity.test.ts` runs both against real
 * Postgres and fails if they ever disagree.
 */
export const ROLES = ['owner', 'operator', 'viewer'] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Everyone in an org can read it. Membership is the only thing that grants this. */
export function canRead(role: Role): boolean {
  return ROLES.includes(role);
}

/** Create and change ordinary records: jobs, threads, suppliers, proposals, templates. */
export function canWrite(role: Role): boolean {
  return role === 'owner' || role === 'operator';
}

/**
 * Approve an outbound action — a bid, a message, a sourcing post. Identical to
 * `canWrite` today and kept separate because it is the decision docs/01 section H is
 * actually about; if the two ever diverge, this is the one that must be read.
 */
export function canApprove(role: Role): boolean {
  return canWrite(role);
}

/** Margin rules, the fee table, the FX buffer and the live-mode switch. */
export function canChangeSettings(role: Role): boolean {
  return role === 'owner';
}

/** Invite, promote and remove people. */
export function canManageMembers(role: Role): boolean {
  return role === 'owner';
}

/** Plans, payment provider and usage limits. */
export function canManageBilling(role: Role): boolean {
  return role === 'owner';
}
