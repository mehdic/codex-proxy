import assert from "node:assert/strict";
import test from "node:test";
import { SSE_KEEPALIVE_COMMENT, maybeWriteSseKeepalive } from "../server/keepalive.js";

test("keepalive uses an SSE comment that does not create a data event", () => {
  assert.equal(SSE_KEEPALIVE_COMMENT, ":ok\n\n");
});

test("keepalive writes only after the configured idle interval", () => {
  const writes = new Array<string>();
  let lastWrite = 1000;
  const write = (chunk: string) => {
    writes.push(chunk);
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
  });
  assert.deepEqual(writes, [":ok\n\n"]);
  assert.equal(lastWrite, 11_000);
});
