import assert from "node:assert/strict";
import test from "node:test";
import { PhaseTracker, TOOL_WAIT_THRESHOLD_MS } from "../server/phase-tracker.js";

function commandStarted(id = "cmd_1") {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    item: { type: "commandExecution", id, command: "sleep 12", status: "inProgress", aggregatedOutput: null, exitCode: null },
  };
}

test("reports command execution as shell progress", () => {
  const tracker = new PhaseTracker({ now: () => 1000 });
  tracker.observe("item/started", commandStarted());
  const phase = tracker.poll();
  assert.match(phase?.text ?? "", /^\[[^:\]]+: using shell…\]$/);
  assert.equal(phase?.label, "shell");
});

test("deduplicates consecutive same phase polls", () => {
  const tracker = new PhaseTracker({ now: () => 1000 });
  tracker.observe("item/started", commandStarted());
  assert.ok(tracker.poll());
  assert.equal(tracker.poll(), null);
});

test("reports long waits once", () => {
  let now = 1000;
  const tracker = new PhaseTracker({ now: () => now });
  tracker.observe("item/started", commandStarted());
  assert.ok(tracker.poll());
  now += TOOL_WAIT_THRESHOLD_MS + 4_000;
  assert.match(tracker.poll()?.text ?? "", /^\[[^:\]]+: waiting for shell, 12s…\]$/);
  assert.equal(tracker.poll(), null);
});

test("text delta clears active phase", () => {
  const tracker = new PhaseTracker({ now: () => 1000 });
  tracker.observe("item/started", commandStarted());
  assert.ok(tracker.poll());
  tracker.observe("item/agentMessage/delta", { threadId: "thread_1", turnId: "turn_1", itemId: "msg_1", delta: "done" });
  assert.equal(tracker.poll(), null);
});

test("item completion clears matching phase", () => {
  const tracker = new PhaseTracker({ now: () => 1000 });
  tracker.observe("item/started", commandStarted("cmd_2"));
  assert.ok(tracker.poll());
  tracker.observe("item/completed", { threadId: "thread_1", turnId: "turn_1", item: { type: "commandExecution", id: "cmd_2" } });
  assert.equal(tracker.poll(), null);
});

test("reports file changes as files progress", () => {
  const tracker = new PhaseTracker({ now: () => 1000 });
  tracker.observe("item/started", { threadId: "thread_1", turnId: "turn_1", item: { type: "fileChange", id: "file_1", changes: [], status: "inProgress" } });
  assert.match(tracker.poll()?.text ?? "", /^\[[^:\]]+: using files…\]$/);
});

test("detach stops future reports", () => {
  const tracker = new PhaseTracker({ now: () => 1000 });
  tracker.observe("item/started", commandStarted());
  tracker.detach();
  assert.equal(tracker.poll(), null);
});
