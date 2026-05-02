export const SSE_KEEPALIVE_COMMENT = ":ok\n\n";

export function createSseKeepaliveComment(requestId: string, count: number): string {
  return `:keepalive req_id=${requestId} count=${count}\n\n`;
}

export interface KeepaliveWriteOptions {
  now: number;
  lastWriteMs: number;
  intervalMs: number;
  write: (chunk: string) => boolean;
  chunk?: string;
}

export function maybeWriteSseKeepalive(options: KeepaliveWriteOptions): number {
  if (options.intervalMs <= 0) return options.lastWriteMs;
  if (options.now - options.lastWriteMs < options.intervalMs) return options.lastWriteMs;
  options.write(options.chunk ?? SSE_KEEPALIVE_COMMENT);
  return options.now;
}

/**
 * Wrap a raw write function with a writable guard.
 * Returns false (and skips the write) when the stream is no longer writable,
 * preventing EPIPE / ERR_STREAM_WRITE_AFTER_END on client disconnect.
 */
export function guardedWrite(
  write: (chunk: string) => boolean,
  writable: () => boolean,
): (chunk: string) => boolean {
  return (chunk: string) => {
    if (!writable()) return false;
    return write(chunk);
  };
}

export function startSseKeepalive(
  intervalMs: number,
  write: (chunk: string) => boolean,
  getLastWriteMs: () => number,
  setLastWriteMs: (value: number) => void,
  createChunk?: (count: number) => string,
): NodeJS.Timeout | null {
  if (intervalMs <= 0) return null;
  let count = 0;
  const timer = setInterval(() => {
    count += 1;
    const now = Date.now();
    const next = maybeWriteSseKeepalive({
      now,
      lastWriteMs: getLastWriteMs(),
      intervalMs,
      write,
      chunk: createChunk ? createChunk(count) : undefined,
    });
    setLastWriteMs(next);
  }, Math.max(1000, Math.min(intervalMs, 10_000)));
  timer.unref?.();
  return timer;
}
