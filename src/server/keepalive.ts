export const SSE_KEEPALIVE_COMMENT = ":ok\n\n";

export interface KeepaliveWriteOptions {
  now: number;
  lastWriteMs: number;
  intervalMs: number;
  write: (chunk: string) => void;
}

export function maybeWriteSseKeepalive(options: KeepaliveWriteOptions): number {
  if (options.intervalMs <= 0) return options.lastWriteMs;
  if (options.now - options.lastWriteMs < options.intervalMs) return options.lastWriteMs;
  options.write(SSE_KEEPALIVE_COMMENT);
  return options.now;
}

export function startSseKeepalive(
  intervalMs: number,
  write: (chunk: string) => void,
  getLastWriteMs: () => number,
  setLastWriteMs: (value: number) => void,
): NodeJS.Timeout | null {
  if (intervalMs <= 0) return null;
  const timer = setInterval(() => {
    const next = maybeWriteSseKeepalive({
      now: Date.now(),
      lastWriteMs: getLastWriteMs(),
      intervalMs,
      write,
    });
    setLastWriteMs(next);
  }, Math.max(1000, Math.min(intervalMs, 10_000)));
  timer.unref?.();
  return timer;
}
