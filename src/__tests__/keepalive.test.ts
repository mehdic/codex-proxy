import assert from "node:assert/strict";
import test from "node:test";
import { SSE_KEEPALIVE_COMMENT, createSseKeepaliveComment, maybeWriteSseKeepalive, guardedWrite, startSseKeepalive } from "../server/keepalive.js";

test("keepalive uses SSE comments that do not create data events", () => {
  assert.equal(SSE_KEEPALIVE_COMMENT, ":ok\n\n");
  assert.equal(createSseKeepaliveComment("req123", 2), ":keepalive req_id=req123 count=2\n\n");
});

test("keepalive writes only after the configured idle interval", () => {
  const writes = new Array<string>();
  let lastWrite = 1000;
  const write = (chunk: string) => {
    writes.push(chunk);
    return true;
  };

  lastWrite = maybeWriteSseKeepalive({
    now: 10_999,
    lastWriteMs: lastWrite,
    intervalMs: 10_000,
    write,
  });
  assert.deepEqual(writes, []);
  assert.equal(lastWrite, 1000);

  lastWrite = maybeWriteSseKeepalive({
    now: 11_000,
    lastWriteMs: lastWrite,
    intervalMs: 10_000,
    write,
    chunk: createSseKeepaliveComment("req123", 1),
  });
  assert.deepEqual(writes, [":keepalive req_id=req123 count=1\n\n"]);
  assert.equal(lastWrite, 11_000);
});

test("guardedWrite suppresses writes when stream is not writable", () => {
  const writes = new Array<string>();
  let writable = true;
  const guarded = guardedWrite(
    (chunk) => { writes.push(chunk); return true; },
    () => writable,
  );

  assert.equal(guarded("hello"), true);
  assert.deepEqual(writes, ["hello"]);

  writable = false;
  assert.equal(guarded("dropped"), false);
  assert.deepEqual(writes, ["hello"]);
});

test("guardedWrite passes through when stream remains writable", () => {
  const writes = new Array<string>();
  const guarded = guardedWrite(
    (chunk) => { writes.push(chunk); return true; },
    () => true,
  );

  guarded("a");
  guarded("b");
  guarded("c");
  assert.deepEqual(writes, ["a", "b", "c"]);
});

test("startSseKeepalive returns null when intervalMs is 0", () => {
  const timer = startSseKeepalive(0, () => true, () => 0, () => {});
  assert.equal(timer, null);
});

test("startSseKeepalive returns a timer that can be cleared", () => {
  const timer = startSseKeepalive(5000, () => true, () => 0, () => {});
  assert.notEqual(timer, null);
  clearInterval(timer!);
});
