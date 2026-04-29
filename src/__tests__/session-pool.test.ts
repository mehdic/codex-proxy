import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionKey,
  CodexSessionPool,
  validateSessionId,
  type SessionWorker,
} from "../subprocess/session-pool.js";
import type { CodexSubprocessOptions, DeltaCallback, TurnResult } from "../subprocess/manager.js";

class FakeSessionWorker implements SessionWorker {
  starts = 0;
  kills = 0;
  isDead = false;
  startedThreads: string[] = [];
  turns: Array<{ threadId: string; text: string }> = [];
  failNextTurn = false;
  turnGate: Promise<void> | null = null;

  async start(): Promise<void> {
    this.starts++;
  }

  async startThread(): Promise<string> {
    const threadId = `thread-${this.startedThreads.length + 1}`;
    this.startedThreads.push(threadId);
    return threadId;
  }

  async submitTurnOnThread(threadId: string, userText: string, _options: CodexSubprocessOptions, delta?: DeltaCallback): Promise<TurnResult> {
    this.turns.push({ threadId, text: userText });
    if (this.turnGate) await this.turnGate;
    if (this.failNextTurn) {
      this.failNextTurn = false;
      throw new Error("turn failed");
    }
    delta?.(`delta:${userText}`);
    return {
      text: `reply:${userText}`,
      turnId: `turn-${this.turns.length}`,
      threadId,
      usage: null,
      durationMs: 1,
      finishReason: "stop",
    };
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

test("session ids are bounded to a safe explicit ascii alphabet", () => {
  assert.equal(validateSessionId("client-a_1:two.three"), "client-a_1:two.three");
  assert.equal(validateSessionId("client a"), null);
  assert.equal(validateSessionId("client/a"), null);
  assert.equal(validateSessionId("x".repeat(129)), null);
  assert.equal(validateSessionId(""), null);
});

test("session keys include sanitized id and option fingerprint without raw cwd or instructions", () => {
  const key = buildSessionKey("client-a", opts({
    cwd: "/private/project",
    instructions: "do not leak this instruction",
  }));

  assert.match(key, /^client-a\|gpt-5\.5\|cwd:[a-f0-9]{16}\|inst:[a-f0-9]{16}$/);
  assert.doesNotMatch(key, /private\/project/);
  assert.doesNotMatch(key, /do not leak/);
});

test("session pool reuses one worker and thread for sequential turns", async () => {
  const created: FakeSessionWorker[] = [];
  const pool = new CodexSessionPool({
    max: 2,
    ttlMs: 60_000,
    now: () => 1000,
    createWorker: () => {
      const worker = new FakeSessionWorker();
      created.push(worker);
      return worker;
    },
  });

  const first = await pool.runTurn("client-a", "first", opts());
  const second = await pool.runTurn("client-a", "second", opts());

  assert.equal(first.threadId, "thread-1");
  assert.equal(second.threadId, "thread-1");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].turns.map((turn) => turn.text), ["first", "second"]);
  assert.deepEqual(pool.stats(), { active: 1, max: 2 });
});

test("session pool serializes concurrent turns for the same session", async () => {
  let releaseFirst!: () => void;
  const created: FakeSessionWorker[] = [];
  const pool = new CodexSessionPool({
    max: 2,
    ttlMs: 60_000,
    now: () => 1000,
    createWorker: () => {
      const worker = new FakeSessionWorker();
      worker.turnGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      created.push(worker);
      return worker;
    },
  });

  const first = pool.runTurn("client-a", "first", opts());
  await new Promise((resolve) => setImmediate(resolve));
  const second = pool.runTurn("client-a", "second", opts());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(created.length, 1);
  assert.deepEqual(created[0].turns.map((turn) => turn.text), ["first"]);

  created[0].turnGate = null;
  releaseFirst();
  await first;
  await second;

  assert.deepEqual(created[0].turns.map((turn) => turn.text), ["first", "second"]);
  assert.equal(created[0].startedThreads.length, 1);
});

test("session pool creates separate sessions for different option fingerprints", async () => {
  const created: FakeSessionWorker[] = [];
  const pool = new CodexSessionPool({
    max: 3,
    ttlMs: 60_000,
    now: () => 1000,
    createWorker: () => {
      const worker = new FakeSessionWorker();
      created.push(worker);
      return worker;
    },
  });

  await pool.runTurn("client-a", "first", opts({ model: "gpt-5.5" }));
  await pool.runTurn("client-a", "second", opts({ model: "gpt-5.4-mini" }));

  assert.equal(created.length, 2);
  assert.equal(created[0].startedThreads.length, 1);
  assert.equal(created[1].startedThreads.length, 1);
});

test("session pool evicts expired and least-recently-used sessions", async () => {
  let now = 0;
  const created: FakeSessionWorker[] = [];
  const pool = new CodexSessionPool({
    max: 2,
    ttlMs: 10,
    now: () => now,
    createWorker: () => {
      const worker = new FakeSessionWorker();
      created.push(worker);
      return worker;
    },
  });

  await pool.runTurn("a", "one", opts());
  now = 1;
  await pool.runTurn("b", "two", opts());
  now = 2;
  await pool.runTurn("c", "three", opts());

  assert.equal(created[0].kills, 1);
  assert.equal(pool.stats().active, 2);

  now = 20;
  await pool.runTurn("d", "four", opts());

  assert.equal(created[1].kills, 1);
  assert.equal(created[2].kills, 1);
  assert.equal(pool.stats().active, 1);
});

test("session pool discards failed session workers", async () => {
  const created: FakeSessionWorker[] = [];
  const pool = new CodexSessionPool({
    max: 2,
    ttlMs: 60_000,
    now: () => 1000,
    createWorker: () => {
      const worker = new FakeSessionWorker();
      created.push(worker);
      return worker;
    },
  });

  await pool.runTurn("client-a", "first", opts());
  created[0].failNextTurn = true;
  await assert.rejects(pool.runTurn("client-a", "bad", opts()), /turn failed/);
  await pool.runTurn("client-a", "after", opts());

  assert.equal(created[0].kills, 1);
  assert.equal(created.length, 2);
  assert.deepEqual(created[1].turns.map((turn) => turn.text), ["after"]);
});
