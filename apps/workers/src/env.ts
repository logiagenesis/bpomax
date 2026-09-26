/**
 * Reading a process's environment (ARB-510, the owner's audit E-01). Shared by the API,
 * the workers and the bot so all three fail closed the same way: every problem is named
 * at once, by variable, and no value is ever repeated back (a value may be a secret).
 */
export type Env = Readonly<Record<string, string | undefined>>;

export class EnvProblems {
  readonly problems: string[] = [];

  /** A variable the process cannot start without. */
  required(env: Env, name: string, why: string): string {
    const value = env[name]?.trim() ?? '';
    if (!value) this.problems.push(`${name} is not set: ${why}`);
    return value;
  }

  /** A URL the process cannot start without, with the schemes it accepts. */
  requiredUrl(env: Env, name: string, why: string, schemes: readonly string[]): string {
    const value = this.required(env, name, why);
    if (!value) return value;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      this.problems.push(`${name} is not a URL`);
      return value;
    }
    if (!schemes.includes(url.protocol.replace(/:$/, ''))) {
      this.problems.push(`${name} must be a ${schemes.map((s) => `${s}://`).join(' or ')} URL`);
    }
    return value;
  }

  /** LIVE_MODE: `true` or `false`, unset meaning false (D-032). Anything else is refused. */
  liveMode(env: Env): boolean {
    const value = env.LIVE_MODE?.trim() ?? '';
    if (value === '' || value === 'false') return false;
    if (value === 'true') return true;
    this.problems.push('LIVE_MODE must be true or false');
    return false;
  }

  /**
   * QUEUE_PREFIX: optional, for processes that share one Redis with another environment.
   * The API, the workers and the bot of one environment must all use the same one.
   */
  queuePrefix(env: Env): string | null {
    const value = env.QUEUE_PREFIX?.trim() ?? '';
    if (value === '') return null;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
      this.problems.push('QUEUE_PREFIX must be 1 to 64 characters of A-Z, a-z, 0-9, _ or -');
      return null;
    }
    return value;
  }

  /** PORT, the one a host injects, or the process's own default. */
  port(env: Env, fallback: number): number {
    const value = env.PORT?.trim() ?? '';
    if (value === '') return fallback;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      this.problems.push('PORT must be a whole number from 1 to 65535');
      return fallback;
    }
    return port;
  }
}

/** A problem list as one message for stderr, naming the process. */
export function describeProblems(process: string, problems: readonly string[]): string {
  return [
    `${process} did not start. Set these and start it again (README, "Running the services"):`,
    ...problems.map((problem) => `- ${problem}`),
  ].join('\n');
}

/** One line of JSON per event on stdout, for the host's log. Never pass a secret here. */
export function logLine(
  service: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, unknown> = {},
): void {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, service, message, ...fields })}\n`,
  );
}

/**
 * Stops a process cleanly on SIGTERM or SIGINT: `stop` drains its work, and if that
 * takes longer than `graceMs` the process exits anyway, with 1, so a stuck drain cannot
 * hold a deploy.
 */
export function onShutdown(
  service: string,
  stop: () => Promise<void>,
  graceMs = 25_000,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let stopping = false;
  const handle = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logLine(service, 'info', 'stopping', { signal });
    const timer = setTimeout(() => {
      logLine(service, 'error', 'did not stop in time', { graceMs });
      exit(1);
    }, graceMs);
    timer.unref();
    stop().then(
      () => {
        clearTimeout(timer);
        logLine(service, 'info', 'stopped');
        exit(0);
      },
      (error: unknown) => {
        clearTimeout(timer);
        logLine(service, 'error', 'stop failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        exit(1);
      },
    );
  };
  process.once('SIGTERM', () => handle('SIGTERM'));
  process.once('SIGINT', () => handle('SIGINT'));
}

/** Resolves to the work's answer, or rejects after `ms`; for checks that must not hang. */
export function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
