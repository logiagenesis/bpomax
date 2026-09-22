import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@arbitron/core', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@arbitron/core');
  });
});
