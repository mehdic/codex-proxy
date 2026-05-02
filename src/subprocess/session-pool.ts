import { buildPoolKey, type PoolWorker } from "./pool.js";
import { CodexSubprocess, type CodexSubprocessOptions, type DeltaCallback, type NotificationCallback, type TurnResult } from "./manager.js";
import { CONFIG } from "../server/config.js";
import { CodexProxyError } from "../server/errors.js";
import { recordSessionEvent, setSessionCount } from "../server/metrics.js";

export interface SessionWorker extends PoolWorker {
  startThread(options: CodexSubprocessOptions, ephemeral?: boolean): Promise<string>;
  submitTurnOnThread(
    threadId: string,
    userText: string,
    options: CodexSubprocessOptions,
    deltaCallback?: DeltaCallback,
    notificationCallback?: NotificationCallback,
  ): Promise<TurnResult>;
}

interface SessionSlot<T extends SessionWorker> {
  key: string;
  worker: T;
  threadId: string;
  lastUsedAt: number;
  queue: Promise<unknown>;
  inFlight: boolean;
}

export interface CodexSessionPoolOptions<T extends SessionWorker> {
  max: number;
  ttlMs: number;
  now?: () => number;
  createWorker: () => T;
}

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function validateSessionId(value: string): string | null {
  return SESSION_ID_RE.test(value) ? value : null;
}

export function buildSessionKey(sessionId: string, options: CodexSubprocessOptions): string {
  return `${sessionId}|${buildPoolKey(options)}`;
}

export class CodexSessionPool<T extends SessionWorker = CodexSubprocess> {
  private readonly sessions = new Map<string, SessionSlot<T>>();
  private readonly creations = new Map<string, Promise<SessionSlot<T>>>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly createWorker: () => T;

  constructor(options: CodexSessionPoolOptions<T>) {
    this.max = Math.max(1, options.max);
    this.ttlMs = Math.max(1, options.ttlMs);
    this.now = options.now || Date.now;
    this.createWorker = options.createWorker;
  }

  async runTurn(
    sessionId: string,
    userText: string,
    options: CodexSubprocessOptions,
    deltaCallback?: DeltaCallback,
    notificationCallback?: NotificationCallback,
  ): Promise<TurnResult> {
    const sanitized = validateSessionId(sessionId);
    if (!sanitized) {
      recordSessionEvent("rejected");
      throw new CodexProxyError("codex", "invalid session id");
    }

    const key = buildSessionKey(sanitized, options);
    this.evictExpired();
    let slot = this.sessions.get(key);
    if (slot && slot.worker.isDead) {
      this.discard(key, slot, "evicted");
      slot = undefined;
    }

    if (slot) {
      recordSessionEvent("hit");
    } else {
      recordSessionEvent("miss");
      slot = await this.getOrCreateSlot(key, options);
    }

    const run = async () => {
      slot.inFlight = true;
      try {
        const result = await slot.worker.submitTurnOnThread(slot.threadId, userText, options, deltaCallback, notificationCallback);
        slot.lastUsedAt = this.now();
        return result;
      } catch (err) {
        this.discard(key, slot, "evicted");
        throw err;
      } finally {
        slot.inFlight = false;
      }
    };

    const previous = slot.queue.catch(() => undefined);
    const next = previous.then(run);
    slot.queue = next.catch(() => undefined);
    return next;
  }

  drain(): void {
    for (const [key, slot] of this.sessions) {
      this.discard(key, slot, "evicted");
    }
    this.publishSize();
  }

  stats(): { active: number; max: number } {
    return { active: this.sessions.size, max: this.max };
  }

  abortSession(sessionId: string, options: CodexSubprocessOptions): void {
    const sanitized = validateSessionId(sessionId);
    if (!sanitized) return;
    const key = buildSessionKey(sanitized, options);
    const slot = this.sessions.get(key);
    if (slot) this.discard(key, slot, "evicted");
  }

  private async getOrCreateSlot(key: string, options: CodexSubprocessOptions): Promise<SessionSlot<T>> {
    const existing = this.sessions.get(key);
    if (existing) return existing;

    let creation = this.creations.get(key);
    if (!creation) {
      creation = this.createSlot(key, options);
      this.creations.set(key, creation);
    }

    try {
      return await creation;
    } finally {
      if (this.creations.get(key) === creation) this.creations.delete(key);
    }
  }

  private async createSlot(key: string, options: CodexSubprocessOptions): Promise<SessionSlot<T>> {
    this.evictForCapacity();
    if (this.sessions.size >= this.max) {
      recordSessionEvent("rejected");
      throw new CodexProxyError("codex", "session pool capacity exceeded");
    }

    const worker = this.createWorker();
    try {
      await worker.start(options);
      const threadId = await worker.startThread(options, true);
      const slot: SessionSlot<T> = {
        key,
        worker,
        threadId,
        lastUsedAt: this.now(),
        queue: Promise.resolve(),
        inFlight: false,
      };
      this.sessions.set(key, slot);
      recordSessionEvent("created");
      this.publishSize();
      return slot;
    } catch (err) {
      worker.kill("SIGTERM", "killed");
      throw err;
    }
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [key, slot] of this.sessions) {
      if (!slot.inFlight && (now - slot.lastUsedAt > this.ttlMs || slot.worker.isDead)) {
        this.discard(key, slot, now - slot.lastUsedAt > this.ttlMs ? "expired" : "evicted");
      }
    }
  }

  private evictForCapacity(): void {
    while (this.sessions.size >= this.max) {
      const lru = this.findLruEvictable();
      if (!lru) return;
      this.discard(lru.key, lru, "evicted");
    }
  }

  private findLruEvictable(): SessionSlot<T> | null {
    let oldest: SessionSlot<T> | null = null;
    for (const slot of this.sessions.values()) {
      if (slot.inFlight) continue;
      if (!oldest || slot.lastUsedAt < oldest.lastUsedAt) oldest = slot;
    }
    return oldest;
  }

  private discard(key: string, slot: SessionSlot<T>, event: "evicted" | "expired"): void {
    if (this.sessions.get(key) !== slot) return;
    this.sessions.delete(key);
    slot.worker.kill("SIGTERM", "killed");
    recordSessionEvent(event);
    this.publishSize();
  }

  private publishSize(): void {
    setSessionCount(this.sessions.size);
  }
}

export const GLOBAL_CODEX_SESSIONS = new CodexSessionPool<CodexSubprocess>({
  max: CONFIG.sessionMax,
  ttlMs: CONFIG.sessionTtlMs,
  createWorker: () => new CodexSubprocess(),
});

export function drainGlobalSessions(): void {
  GLOBAL_CODEX_SESSIONS.drain();
}
