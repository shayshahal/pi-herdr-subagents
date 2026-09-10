import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  peekContextUsageSidecar,
  resumeContextNote,
  writeContextUsageSidecar,
} from "../src/context-usage.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("context-usage: resume note", () => {
  const snap = (tokens: number | null, percent: number | null) => ({
    version: 1 as const,
    subagentId: "child-1",
    tokens,
    contextWindow: 200_000,
    percent,
  });

  it("stays silent below the threshold and when the session published nothing", () => {
    assert.equal(resumeContextNote(null), "");
    assert.equal(resumeContextNote(snap(40_000, 20)), "");
    assert.equal(resumeContextNote(snap(118_000, 59)), "");
    assert.equal(resumeContextNote(snap(null, null)), "");
  });

  it("prices the resume once the last run sat near its window", () => {
    const note = resumeContextNote(snap(138_000, 69));
    assert.match(note, /last held 138k tokens \(69% of its window\)/);
    assert.match(note, /fresh, narrower dispatch is usually cheaper/);
  });

  it("peeks without consuming the sidecar the watcher still needs", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-usage-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const sessionFile = join(dir, "child.jsonl");
    writeContextUsageSidecar(sessionFile, "child-1", { tokens: 138_000, contextWindow: 200_000, percent: 69 });
    assert.equal(peekContextUsageSidecar(sessionFile)?.tokens, 138_000);
    assert.equal(peekContextUsageSidecar(sessionFile)?.tokens, 138_000, "still there after a peek");
  });
});
