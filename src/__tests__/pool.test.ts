import assert from "node:assert/strict";
import test from "node:test";
import { buildPoolKey, CodexWorkerPool, type PoolWorker } from "../subprocess/pool.js";
import type { CodexSubprocessOptions } from "../subprocess/manager.js";

class FakeWorker implements PoolWorker {
  starts = 0;
  kills = 0;
  isDead = false;

  async start(): Promise<void> {
    this.starts++;
  }

  kill(): void {
    this.kills++;
    this.isDead = true;
  }
}

function opts(partial: Partial<CodexSubprocessOptions> = {}): CodexSubprocessOptions {
  return {
    model: "gpt-5.5",
    cwd: "/tmp/project",
    timeoutMs: 1000,
    initTimeoutMs: 100,
    turnStartTimeoutMs: 100,
    ...partial,
  };
}

test("pool keys are stable and do not include raw instructions", () => {
  const key = buildPoolKey(opts({ instructions: "secret prompt text" }));
  assert.match(key, /^gpt-5\.5\|cwd:/);
  assert.match(key, /\|inst:[a-f0-9]{16}/);
  assert.doesNotMatch(key, /secret/);
  assert.doesNotMatch(key, /prompt/);
});

test("pool reuses a released healthy worker for the same bounded key", async () => {
  const created: FakeWorker[] = [];
  const pool = new CodexWorkerPool({
    max: 2,
    ttlMs: 60_000,
    now: () => 1000,
    createWorker: () => {
      const worker = new FakeWorker();
      created.push(worker);
      return worker;
    },
  });

  const first = await pool.acquire(opts());
  pool.release(first, true);
  const second = await pool.acquire(opts());

  assert.equal(first.worker, second.worker);
  assert.equal(created.length, 1);
  assert.equal(second.warm, true);
  assert.deepEqual(pool.stats(), { idle: 0, leased: 1, max: 2 });
});

test("pool evicts least-recently-used idle workers beyond max", async () => {
  let now = 0;
  const created: FakeWorker[] = [];
  const pool = new CodexWorkerPool({
    max: 1,
    ttlMs: 60_000,
    now: () => now,
    createWorker: () => {
      const worker = new FakeWorker();
      created.push(worker);
      return worker;
    },
  });

  const first = await pool.acquire(opts({ model: "gpt-5.5" }));
  pool.release(first, true);
  now += 1;

  const second = await pool.acquire(opts({ model: "gpt-5.4-mini" }));
  pool.release(second, true);

  assert.equal(created.length, 2);
  assert.equal(created[0].kills, 1);
  assert.equal(created[1].kills, 0);
  assert.deepEqual(pool.stats(), { idle: 1, leased: 0, max: 1 });
});

test("pool discards expired idle workers", async () => {
  let now = 0;
  const created: FakeWorker[] = [];
  const pool = new CodexWorkerPool({
    max: 2,
    ttlMs: 10,
    now: () => now,
    createWorker: () => {
      const worker = new FakeWorker();
      created.push(worker);
      return worker;
    },
  });

  const first = await pool.acquire(opts());
  pool.release(first, true);
  now = 11;

  const second = await pool.acquire(opts());

  assert.notEqual(first.worker, second.worker);
  assert.equal(created[0].kills, 1);
  assert.equal(created.length, 2);
});

test("pool max caps total live workers by waiting for a release", async () => {
  let now = 0;
  const created: FakeWorker[] = [];
  const pool = new CodexWorkerPool({
    max: 1,
    ttlMs: 60_000,
    now: () => now,
    createWorker: () => {
      const worker = new FakeWorker();
      created.push(worker);
      return worker;
    },
  });

  const first = await pool.acquire(opts({ model: "gpt-5.5" }));
  let acquiredSecond = false;
  const secondPromise = pool.acquire(opts({ model: "gpt-5.4-mini" })).then((lease) => {
    acquiredSecond = true;
    return lease;
  });

  await Promise.resolve();
  assert.equal(acquiredSecond, false);
  assert.equal(created.length, 1);

  now += 1;
  pool.release(first, true);
  const second = await secondPromise;

  assert.equal(acquiredSecond, true);
  assert.equal(created.length, 2);
  assert.equal(second.worker, created[1]);
});
