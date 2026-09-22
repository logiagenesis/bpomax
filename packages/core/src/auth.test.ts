import { describe, expect, it } from 'vitest';
import {
  ROLES,
  canApprove,
  canChangeSettings,
  canManageBilling,
  canManageMembers,
  canRead,
  canWrite,
  isRole,
} from './auth.js';

describe('roles', () => {
  it('are the three the spec names, and nothing else', () => {
    expect([...ROLES]).toEqual(['owner', 'operator', 'viewer']);
    expect(isRole('owner')).toBe(true);
    expect(isRole('admin')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });

  it('let everyone read', () => {
    for (const role of ROLES) expect(canRead(role)).toBe(true);
  });

  it('keep a viewer out of every write', () => {
    expect(canWrite('viewer')).toBe(false);
    expect(canApprove('viewer')).toBe(false);
    expect(canChangeSettings('viewer')).toBe(false);
    expect(canManageMembers('viewer')).toBe(false);
    expect(canManageBilling('viewer')).toBe(false);
  });

  it('let an operator work but not govern', () => {
    expect(canWrite('operator')).toBe(true);
    expect(canApprove('operator')).toBe(true);
    expect(canChangeSettings('operator')).toBe(false);
    expect(canManageMembers('operator')).toBe(false);
    expect(canManageBilling('operator')).toBe(false);
  });

  it('let an owner do everything', () => {
    expect(canWrite('owner')).toBe(true);
    expect(canApprove('owner')).toBe(true);
    expect(canChangeSettings('owner')).toBe(true);
    expect(canManageMembers('owner')).toBe(true);
    expect(canManageBilling('owner')).toBe(true);
  });
});
