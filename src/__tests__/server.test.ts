import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { invalidRequestError } from "../server/errors.js";
import { buildHealthPayload, buildVersionPayload } from "../server/routes.js";
import { VERSION } from "../server/version.js";

test("health and version payloads expose version and safe runtime metadata", () => {
  const health = buildHealthPayload();
  assert.equal(health.status, "ok");
  assert.equal(health.version, VERSION);
  assert.equal(typeof health.uptime, "number");

  assert.deepEqual(buildVersionPayload(), {
    name: "codex-proxy",
    version: VERSION,
  });
});

test("validation errors use OpenAI-style error shape", () => {
  assert.deepEqual(invalidRequestError("input is required", "input"), {
    error: {
      message: "input is required",
      type: "invalid_request_error",
      param: "input",
      code: "missing_required_parameter",
    },
  });
});

test("runtime version matches package version", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf-8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});
