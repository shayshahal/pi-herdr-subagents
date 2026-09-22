import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createHerdrWorkReporter,
  HERDR_WORK_METADATA_SOURCE,
  HERDR_WORK_METADATA_TOKEN,
} from "../src/herdr/work.ts";

interface ReportCall {
  token?: string;
  clearToken?: string;
  ttlMs: number;
}

describe("Herdr work metadata", () => {
  it("publishes an ownership-bound count with the tree contract", async () => {
    const calls: ReportCall[] = [];
    const reporter = createHerdrWorkReporter({
      sessionFile: "/sessions/parent.jsonl",
      report: async (request) => calls.push(request),
      now: () => 1_000,
    });

    await reporter.publish(2);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].ttlMs, 30_000);
    assert.equal(calls[0].clearToken, undefined);
    assert.match(
      calls[0].token ?? "",
      new RegExp(`^${HERDR_WORK_METADATA_TOKEN}=[A-Za-z0-9_-]{43}:2:31000$`),
    );
    assert.equal(HERDR_WORK_METADATA_SOURCE, "pi-subagents:work-v1");
  });

  it("serializes updates and clears the token during cleanup", async () => {
    const calls: ReportCall[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const reporter = createHerdrWorkReporter({
      sessionFile: "/sessions/parent.jsonl",
      report: async (request) => {
        calls.push(request);
        if (calls.length === 1) await first;
      },
      now: () => 1_000,
    });

    const update = reporter.publish(1);
    while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const stop = reporter.stop();
    releaseFirst();
    await Promise.all([update, stop]);

    assert.equal(calls.length, 2);
    assert.match(calls[0].token ?? "", /:1:31000$/);
    assert.deepEqual(calls[1], {
      clearToken: HERDR_WORK_METADATA_TOKEN,
      ttlMs: 30_000,
    });
    await reporter.stop();
    assert.equal(calls.length, 2);
  });
});
