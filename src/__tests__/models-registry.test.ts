import assert from "node:assert/strict";
import test from "node:test";
import { AVAILABLE_MODELS } from "../adapter/openai-to-codex.js";
import { getAvailableModels, refreshAvailableModels } from "../server/models.js";

test("refreshAvailableModels reads all upstream pages and removes duplicates", async () => {
  const cursors: Array<string | null | undefined> = [];
  const refreshed = await refreshAvailableModels(() => ({
    async start() {},
    async listModels({ cursor }) {
      cursors.push(cursor);
      return cursor
        ? { data: [{ id: "gpt-5.6", model: "gpt-5.6" }] }
        : {
          data: [
            { id: "gpt-5.5", model: "gpt-5.5" },
            { id: "gpt-5.6", model: "gpt-5.6" },
          ],
          nextCursor: "page-2",
        };
    },
    kill() {},
  }));

  assert.equal(refreshed, true);
  assert.deepEqual(cursors, [undefined, "page-2"]);
  assert.deepEqual(getAvailableModels(), ["gpt-5.5", "gpt-5.6"]);
});

test("refreshAvailableModels retains fallback models when upstream discovery fails", async () => {
  const refreshed = await refreshAvailableModels(() => ({
    async start() {
      throw new Error("Codex is unavailable");
    },
    async listModels() {
      throw new Error("not reached");
    },
    kill() {},
  }));

  assert.equal(refreshed, false);
  assert.deepEqual(getAvailableModels(), ["gpt-5.5", "gpt-5.6"]);
  assert.ok(AVAILABLE_MODELS.includes("gpt-5.5"));
});