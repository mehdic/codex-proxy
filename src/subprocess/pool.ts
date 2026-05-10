import { createHash } from "node:crypto";
import { CodexSubprocess, type CodexSubprocessOptions } from "./manager.js";
import { CONFIG } from "../server/config.js";
import { recordPoolEvent, setPoolSize } from "../server/metrics.js";
import { trace, traceError } from "../server/trace.js";

export interface PoolWorker {
  start(options: CodexSubprocessOptions): Promise<unknown>;
  kill(signal?: NodeJS.Signals, reason?: "killed" | "timeout"): void;
  readonly isDead: boolean;
}

export interface PoolLease<T extends PoolWorker = PoolWorker> {
  key: string;
  worker: T;
  warm: boolean;
}

interface IdleSlot<T extends PoolWorker> {
  key: string;
  worker: T;
  lastUsedAt: number;
}

export interface CodexWorkerPoolOptions<T extends PoolWorker> {
  max: number;
  ttlMs: number;
  now?: () => number;
  createWorker: () => T;
}

export class CodexWorkerPool<T extends PoolWorker = CodexSubprocess> {
  private readonly idle = new Map<string, IdleSlot<T>>();
  private readonly leased = new Set<T>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly createWorker: () => T;
  private readonly waiters: Array<() => void> = [];

  constructor(options: CodexWorkerPoolOptions<T>) {
    this.max = Math.max(1, options.max);
    this.ttlMs = Math.max(1, options.ttlMs);
    this.now = options.now || Date.now;
    this.createWorker = options.createWorker;
  }

  async acquire(options: CodexSubprocessOptions): Promise<PoolLease<T>> {
    const key = buildPoolKey(options);
    trace("pool.acquire.enter", { key, options, stats: this.stats() });
    for (;;) {
      this.evictExpired();
      const cached = this.idle.get(key);
      this.idle.delete(key);

      if (cached && !cached.worker.isDead) {
        trace("pool.acquire.warm_hit", { key, cached: { lastUsedAt: cached.lastUsedAt }, stats: this.stats() });
        this.leased.add(cached.worker);
        recordPoolEvent("warm_hit");
        this.publishSize();
        return { key, worker: cached.worker, warm: true };
      }

      if (cached) {
        trace("pool.acquire.stale_cached", { key, stats: this.stats() });
        cached.worker.kill("SIGTERM", "killed");
        recordPoolEvent("stale_eviction");
      }

      if (this.liveCount() >= this.max) {
        trace("pool.acquire.capacity_wait_decision", { key, liveCount: this.liveCount(), max: this.max, idle: this.idle.size, leased: this.leased.size });
        if (this.idle.size > 0) {
          this.evictOneLru("lru_eviction");
          continue;
        }
        await this.waitForCapacity();
        continue;
      }

      const worker = this.createWorker();
      trace("pool.acquire.cold_spawn_start", { key, options });
      try {
        await worker.start(options);
      } catch (err) {
        traceError("pool.acquire.cold_spawn_error", err, { key, options });
        worker.kill("SIGTERM", "killed");
        throw err;
      }
      this.leased.add(worker);
      trace("pool.acquire.cold_spawn_ready", { key, stats: this.stats() });
      recordPoolEvent("cold_spawn");
      this.publishSize();
      return { key, worker, warm: false };
    }
  }

  release(lease: PoolLease<T>, healthy: boolean): void {
    trace("pool.release.enter", { lease: { key: lease.key, warm: lease.warm }, healthy, stats: this.stats() });
    this.leased.delete(lease.worker);
    if (!healthy || lease.worker.isDead) {
      trace("pool.release.kill_unhealthy", { lease: { key: lease.key, warm: lease.warm }, healthy, workerDead: lease.worker.isDead });
      lease.worker.kill("SIGTERM", "killed");
      this.publishSize();
      this.notifyWaiter();
      return;
    }

    trace("pool.release.idle_store", { lease: { key: lease.key, warm: lease.warm } });
    this.idle.set(lease.key, {
      key: lease.key,
      worker: lease.worker,
      lastUsedAt: this.now(),
    });
    this.enforceMaxIdle();
    this.publishSize();
    this.notifyWaiter();
  }

  prewarm(options: CodexSubprocessOptions[]): void {
    trace("pool.prewarm.enter", { options });
    for (const optionSet of options) {
      const key = buildPoolKey(optionSet);
      if (this.idle.has(key)) continue;
      void (async () => {
        trace("pool.prewarm.one_start", { key, optionSet });
        const lease = await this.acquire(optionSet);
        this.release(lease, true);
      })().catch((err) => {
        traceError("pool.prewarm.error", err, { key, optionSet });
        recordPoolEvent("prewarm_error");
        if (CONFIG.debug) {
          console.error("[codex-proxy] pool prewarm failed:", err instanceof Error ? err.message : err);
        }
      });
    }
  }

  drain(): void {
    trace("pool.drain", { stats: this.stats() });
    for (const slot of this.idle.values()) slot.worker.kill("SIGTERM", "killed");
    for (const worker of this.leased.values()) worker.kill("SIGTERM", "killed");
    this.idle.clear();
    this.leased.clear();
    this.publishSize();
    this.notifyAllWaiters();
  }

  stats(): { idle: number; leased: number; max: number } {
    return { idle: this.idle.size, leased: this.leased.size, max: this.max };
  }

  private evictExpired(): void {
    const now = this.now();
    trace("pool.evict_expired.scan", { now, idle: this.idle.size, leased: this.leased.size });
    for (const [key, slot] of this.idle) {
      if (now - slot.lastUsedAt > this.ttlMs || slot.worker.isDead) {
        trace("pool.evict_expired.evict", { key, ageMs: now - slot.lastUsedAt, ttlMs: this.ttlMs, workerDead: slot.worker.isDead });
        this.idle.delete(key);
        slot.worker.kill("SIGTERM", "killed");
        recordPoolEvent(now - slot.lastUsedAt > this.ttlMs ? "ttl_eviction" : "stale_eviction");
      }
    }
  }

  private enforceMaxIdle(): void {
    while (this.idle.size > this.max) {
      this.evictOneLru("lru_eviction");
    }
  }

  private evictOneLru(event: "lru_eviction" | "ttl_eviction" | "stale_eviction"): void {
    trace("pool.evict_one_lru.enter", { event, idle: this.idle.size });
    let oldest: IdleSlot<T> | null = null;
    for (const slot of this.idle.values()) {
      if (!oldest || slot.lastUsedAt < oldest.lastUsedAt) oldest = slot;
    }
    if (!oldest) return;
    trace("pool.evict_one_lru.evict", { event, key: oldest.key, lastUsedAt: oldest.lastUsedAt });
    this.idle.delete(oldest.key);
    oldest.worker.kill("SIGTERM", "killed");
    recordPoolEvent(event);
    this.publishSize();
  }

  private publishSize(): void {
    setPoolSize(this.idle.size + this.leased.size);
  }

  private liveCount(): number {
    return this.idle.size + this.leased.size;
  }

  private waitForCapacity(): Promise<void> {
    trace("pool.wait_for_capacity.enter", { waiters: this.waiters.length, stats: this.stats() });
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private notifyWaiter(): void {
    trace("pool.notify_waiter", { waiters: this.waiters.length });
    const waiter = this.waiters.shift();
    waiter?.();
  }

  private notifyAllWaiters(): void {
    let waiter: (() => void) | undefined;
    while ((waiter = this.waiters.shift())) waiter();
  }
}

export function buildPoolKey(options: CodexSubprocessOptions): string {
  const cwd = options.cwd || process.cwd();
  const instructions = options.instructions || "";
  const overrides = options.configOverrides
    ? Object.entries(options.configOverrides).sort(([a], [b]) => a.localeCompare(b))
    : [];
  const fingerprint = stableHash(JSON.stringify({ instructions, overrides }));
  return `${options.model}|cwd:${stableHash(cwd)}|inst:${fingerprint}`;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export const GLOBAL_CODEX_POOL = new CodexWorkerPool<CodexSubprocess>({
  max: CONFIG.poolMax,
  ttlMs: CONFIG.poolTtlMs,
  createWorker: () => new CodexSubprocess(),
});

export function prewarmGlobalPool(): void {
  if (!CONFIG.initPool || CONFIG.runtime !== "pool") return;
  GLOBAL_CODEX_POOL.prewarm(CONFIG.prewarmModels.map((model) => ({
    model,
    timeoutMs: CONFIG.defaultTimeoutMs,
    initTimeoutMs: CONFIG.initTimeoutMs,
    turnStartTimeoutMs: CONFIG.turnStartTimeoutMs,
  })));
}

export function drainGlobalPool(): void {
  GLOBAL_CODEX_POOL.drain();
}
