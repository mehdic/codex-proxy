import { buildPoolKey, type PoolWorker } from "./pool.js";
import { CodexSubprocess, type CodexSubprocessOptions, type DeltaCallback, type NotificationCallback, type TurnResult } from "./manager.js";
import { CONFIG } from "../server/config.js";
import { CodexProxyError } from "../server/errors.js";
import { recordSessionEvent, recordStickySessionBusy, recordStickySessionEviction, recordStickySessionMode, recordStickySessionStart, recordStickySessionHit, setSessionCount } from "../server/metrics.js";
import { trace, traceError } from "../server/trace.js";

export interface SessionWorker extends PoolWorker {
  startThread(options: CodexSubprocessOptions, ephemeral?: boolean): Promise<string>;
  submitTurnOnThread(
    threadId: string,
    userText: string,
    options: CodexSubprocessOptions,
    deltaCallback?: DeltaCallback,
    notificationCallback?: NotificationCallback,
    imageUrls?: string[],
  ): Promise<TurnResult>;
}

interface SessionSlot<T extends SessionWorker> {
  key: string;
  sessionKeyHash: string;
  keyHashShort: string;
  worker: T;
  threadId: string;
  createdAt: number;
  lastUsedAt: number;
  ttlMs: number;
  queue: Promise<unknown>;
  inFlight: boolean;
  turnCount: number;
}

export interface CodexSessionPoolOptions<T extends SessionWorker> {
  max: number;
  ttlMs: number;
  absoluteTtlMs?: number;
  queueTimeoutMs?: number;
  now?: () => number;
  createWorker: () => T;
}

export interface StickySessionRunOptions {
  rawKey?: string;
  keyHash: string;
  keyHashShort: string;
  ttlSeconds: number;
  reset?: boolean;
  policy?: "strict" | "compatible";
}

export interface StickyPoolStats {
  enabled: boolean;
  size: number;
  max: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  absoluteTtlSeconds: number;
  queueTimeoutMs: number;
}

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function validateSessionId(value: string): string | null {
  return SESSION_ID_RE.test(value) ? value : null;
}

export function buildSessionKey(sessionId: string, options: CodexSubprocessOptions): string {
  return `${sessionId}|${buildPoolKey(options)}`;
}

export function buildStickySessionKey(sticky: StickySessionRunOptions, options: CodexSubprocessOptions): string {
  const policy = sticky.policy || "strict";
  return `${sticky.keyHash}|${buildPoolKey(options)}|sandbox:${CONFIG.codexSandbox}|approval:${CONFIG.codexApprovalPolicy}|policy:${policy}`;
}

function legacyStickyOptions(sessionId: string): StickySessionRunOptions {
  return {
    rawKey: sessionId,
    keyHash: sessionId,
    keyHashShort: sessionId.slice(0, 12),
    ttlSeconds: Math.max(1, Math.ceil(CONFIG.sessionTtlMs / 1000)),
    policy: "strict",
  };
}

export class CodexSessionPool<T extends SessionWorker = CodexSubprocess> {
  private readonly sessions = new Map<string, SessionSlot<T>>();
  private readonly creations = new Map<string, Promise<SessionSlot<T>>>();
  private readonly max: number;
  private readonly defaultTtlMs: number;
  private readonly absoluteTtlMs: number;
  private readonly queueTimeoutMs: number;
  private readonly now: () => number;
  private readonly createWorker: () => T;

  constructor(options: CodexSessionPoolOptions<T>) {
    this.max = Math.max(1, options.max);
    this.defaultTtlMs = Math.max(1, options.ttlMs);
    this.absoluteTtlMs = Math.max(0, options.absoluteTtlMs ?? CONFIG.stickyAbsoluteTtlSeconds * 1000);
    this.queueTimeoutMs = Math.max(1, options.queueTimeoutMs ?? CONFIG.stickyQueueTimeoutMs);
    this.now = options.now || Date.now;
    this.createWorker = options.createWorker;
  }

  async runTurn(
    session: string | StickySessionRunOptions,
    userText: string,
    options: CodexSubprocessOptions,
    deltaCallback?: DeltaCallback,
    notificationCallback?: NotificationCallback,
    imageUrls?: string[],
  ): Promise<TurnResult> {
    trace("session_pool.run_turn.enter", { session, userText, options, streaming: Boolean(deltaCallback), imageUrls, stats: this.stats() });
    const sticky = typeof session === "string" ? this.parseLegacySession(session) : session;
    const key = typeof session === "string" ? buildSessionKey(sticky.rawKey || session, options) : buildStickySessionKey(sticky, options);
    const ttlMs = typeof session === "string"
      ? this.defaultTtlMs
      : Math.max(1, Math.trunc(sticky.ttlSeconds || this.defaultTtlMs / 1000)) * 1000;

    trace("session_pool.run_turn.resolved", { key, sticky, ttlMs });
    this.evictExpired();
    if (sticky.reset) {
      trace("session_pool.run_turn.reset_requested", { keyHash: sticky.keyHash });
      this.resetMatching(sticky.keyHash);
    }

    let slot = this.sessions.get(key);
    if (slot && slot.worker.isDead) {
      trace("session_pool.run_turn.slot_unhealthy", { key, keyHashShort: slot.keyHashShort });
      this.discard(key, slot, "unhealthy");
      slot = undefined;
    }

    if (slot) {
      trace("session_pool.run_turn.hit", { key, keyHashShort: slot.keyHashShort, turnCount: slot.turnCount });
      recordSessionEvent("hit");
      recordStickySessionHit();
    } else {
      trace("session_pool.run_turn.miss", { key, sticky });
      recordSessionEvent("miss");
      slot = await this.getOrCreateSlot(key, sticky, ttlMs, options);
    }
    slot.ttlMs = ttlMs;

    const run = async () => {
      trace("session_pool.run_turn.queue_start", { key, threadId: slot.threadId, turnCount: slot.turnCount });
      slot.inFlight = true;
      try {
        const result = await slot.worker.submitTurnOnThread(slot.threadId, userText, options, deltaCallback, notificationCallback, imageUrls);
        slot.lastUsedAt = this.now();
        slot.turnCount++;
        trace("session_pool.run_turn.queue_result", { key, threadId: slot.threadId, turnCount: slot.turnCount, result });
        return result;
      } catch (err) {
        traceError("session_pool.run_turn.queue_error", err, { key, threadId: slot.threadId, turnCount: slot.turnCount });
        this.discard(key, slot, "turn_error");
        throw err;
      } finally {
        trace("session_pool.run_turn.queue_finally", { key, threadId: slot.threadId });
        slot.inFlight = false;
      }
    };

    const previous = slot.queue.catch(() => undefined);
    const next = this.withQueueTimeout(previous.then(run));
    slot.queue = next.catch(() => undefined);
    return next;
  }

  drain(): void {
    trace("session_pool.drain", { stats: this.stats(), stickyStats: this.stickyStats() });
    for (const [key, slot] of this.sessions) this.discard(key, slot, "evicted");
    this.publishSize();
  }

  stats(): { active: number; max: number } {
    return { active: this.sessions.size, max: this.max };
  }

  stickyStats(): StickyPoolStats {
    this.evictExpired();
    return {
      enabled: CONFIG.stickySessionsEnabled,
      size: this.sessions.size,
      max: this.max,
      defaultTtlSeconds: CONFIG.stickyDefaultTtlSeconds,
      maxTtlSeconds: CONFIG.stickyMaxTtlSeconds,
      absoluteTtlSeconds: Math.floor(this.absoluteTtlMs / 1000),
      queueTimeoutMs: this.queueTimeoutMs,
    };
  }

  abortSession(session: string | StickySessionRunOptions, options: CodexSubprocessOptions): void {
    trace("session_pool.abort_session.enter", { session, options });
    const sticky = typeof session === "string" ? this.parseLegacySession(session, false) : session;
    if (!sticky) return;
    const key = typeof session === "string" ? buildSessionKey(sticky.rawKey || session, options) : buildStickySessionKey(sticky, options);
    const slot = this.sessions.get(key);
    if (slot) this.discard(key, slot, "client_disconnect");
  }

  resetSession(sticky: StickySessionRunOptions): void {
    trace("session_pool.reset_session", { sticky });
    this.resetMatching(sticky.keyHash);
  }

  private parseLegacySession(sessionId: string, throwOnInvalid = true): StickySessionRunOptions {
    const sanitized = validateSessionId(sessionId);
    if (!sanitized) {
      recordSessionEvent("rejected");
      if (throwOnInvalid) throw new CodexProxyError("codex", "invalid session id");
      return legacyStickyOptions("");
    }
    return legacyStickyOptions(sanitized);
  }

  private async getOrCreateSlot(key: string, sticky: StickySessionRunOptions, ttlMs: number, options: CodexSubprocessOptions): Promise<SessionSlot<T>> {
    trace("session_pool.get_or_create.enter", { key, sticky, ttlMs, options });
    const existing = this.sessions.get(key);
    if (existing) return existing;
    let creation = this.creations.get(key);
    if (!creation) {
      trace("session_pool.get_or_create.create_new", { key });
      creation = this.createSlot(key, sticky, ttlMs, options);
      this.creations.set(key, creation);
    }
    try {
      return await creation;
    } finally {
      if (this.creations.get(key) === creation) this.creations.delete(key);
    }
  }

  private async createSlot(key: string, sticky: StickySessionRunOptions, ttlMs: number, options: CodexSubprocessOptions): Promise<SessionSlot<T>> {
    trace("session_pool.create_slot.enter", { key, sticky, ttlMs, options, stats: this.stats() });
    this.evictForCapacity();
    if (this.sessions.size >= this.max) {
      recordSessionEvent("rejected");
      recordStickySessionBusy("capacity");
      throw new CodexProxyError("codex", "session pool capacity exceeded");
    }
    const worker = this.createWorker();
    try {
      trace("session_pool.create_slot.worker_start", { key, options });
      await worker.start(options);
      trace("session_pool.create_slot.thread_start", { key, options });
      const threadId = await worker.startThread(options, true);
      const now = this.now();
      const slot: SessionSlot<T> = {
        key,
        sessionKeyHash: sticky.keyHash,
        keyHashShort: sticky.keyHashShort,
        worker,
        threadId,
        createdAt: now,
        lastUsedAt: now,
        ttlMs,
        queue: Promise.resolve(),
        inFlight: false,
        turnCount: 0,
      };
      this.sessions.set(key, slot);
      trace("session_pool.create_slot.created", { key, threadId, keyHashShort: sticky.keyHashShort });
      recordSessionEvent("created");
      recordStickySessionStart();
      this.publishSize();
      return slot;
    } catch (err) {
      traceError("session_pool.create_slot.error", err, { key, sticky, options });
      worker.kill("SIGTERM", "killed");
      throw err;
    }
  }

  private evictExpired(): void {
    const now = this.now();
    trace("session_pool.evict_expired.scan", { now, size: this.sessions.size });
    for (const [key, slot] of this.sessions) {
      if (slot.inFlight) continue;
      if (slot.worker.isDead) this.discard(key, slot, "unhealthy");
      else if (now - slot.lastUsedAt > slot.ttlMs) this.discard(key, slot, "idle_ttl");
      else if (this.absoluteTtlMs > 0 && now - slot.createdAt > this.absoluteTtlMs) this.discard(key, slot, "absolute_ttl");
    }
  }

  private evictForCapacity(): void {
    trace("session_pool.evict_for_capacity.enter", { size: this.sessions.size, max: this.max });
    while (this.sessions.size >= this.max) {
      const lru = this.findLruEvictable();
      if (!lru) return;
      this.discard(lru.key, lru, "lru");
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

  private resetMatching(sessionKeyHash: string): void {
    trace("session_pool.reset_matching.enter", { sessionKeyHash, size: this.sessions.size });
    for (const [key, slot] of [...this.sessions]) {
      if (slot.sessionKeyHash !== sessionKeyHash) continue;
      if (slot.inFlight) {
        recordStickySessionBusy("active");
        throw new CodexProxyError("codex", "sticky session is busy");
      }
      this.discard(key, slot, "reset");
      recordSessionEvent("reset");
    }
  }

  private discard(key: string, slot: SessionSlot<T>, reason: "evicted" | "expired" | "idle_ttl" | "absolute_ttl" | "lru" | "unhealthy" | "reset" | "client_disconnect" | "turn_error"): void {
    trace("session_pool.discard", { key, reason, slot: { keyHashShort: slot.keyHashShort, threadId: slot.threadId, createdAt: slot.createdAt, lastUsedAt: slot.lastUsedAt, inFlight: slot.inFlight, turnCount: slot.turnCount } });
    if (this.sessions.get(key) !== slot) return;
    this.sessions.delete(key);
    slot.worker.kill("SIGTERM", "killed");
    if (reason === "idle_ttl" || reason === "expired") recordSessionEvent("expired");
    else if (reason === "reset") recordSessionEvent("evicted");
    else recordSessionEvent("evicted");
    recordStickySessionEviction(reason === "expired" ? "idle_ttl" : reason);
    this.publishSize();
  }

  private publishSize(): void {
    setSessionCount(this.sessions.size);
  }

  private withQueueTimeout<TValue>(promise: Promise<TValue>): Promise<TValue> {
    trace("session_pool.with_queue_timeout.enter", { queueTimeoutMs: this.queueTimeoutMs });
    if (!this.queueTimeoutMs) return promise;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        trace("session_pool.queue_timeout", { queueTimeoutMs: this.queueTimeoutMs });
        recordStickySessionBusy("queue_timeout");
        reject(new CodexProxyError("timeout", "sticky session queue timed out"));
      }, this.queueTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}

export const GLOBAL_CODEX_SESSIONS = new CodexSessionPool<CodexSubprocess>({
  max: CONFIG.stickyMaxSessions || CONFIG.sessionMax,
  ttlMs: CONFIG.stickyDefaultTtlSeconds * 1000 || CONFIG.sessionTtlMs,
  absoluteTtlMs: CONFIG.stickyAbsoluteTtlSeconds * 1000,
  queueTimeoutMs: CONFIG.stickyQueueTimeoutMs,
  createWorker: () => new CodexSubprocess(),
});

export function stickyPoolStats(): StickyPoolStats {
  return GLOBAL_CODEX_SESSIONS.stickyStats();
}

export function drainGlobalSessions(): void {
  GLOBAL_CODEX_SESSIONS.drain();
}

export { recordStickySessionMode };
