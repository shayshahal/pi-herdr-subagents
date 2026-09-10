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

describe("context-usage: the resume gate is absolute, not just a fraction", () => {
  const snap = (tokens: number | null, percent: number | null) => ({
    version: 1 as const,
    subagentId: "child-1",
    tokens,
    contextWindow: 1_000_000,
    percent,
  });

  it("fires on a 1M-token window when the session held real tokens, not on the fraction alone", () => {
    // Measured on this machine: the window is 1,000,000, so 60% is 600k and the sessions that cost
    // money in the audit ran at 100–220k — a fraction-only gate would never have fired on one.
    assert.match(resumeContextNote(snap(219_769, 21.98))!, /last held 220k tokens \(22% of its window\)/);
    assert.match(resumeContextNote(snap(150_000, 15))!, /150k tokens/);
  });

  it("still fires on a fraction for a smaller window, and stays silent below both", () => {
    const small = { version: 1 as const, subagentId: "c", tokens: 39_000, contextWindow: 40_000, percent: 97 };
    assert.match(resumeContextNote(small as any)!, /97% of its window/);
    assert.equal(resumeContextNote(snap(40_000, 4)), "", "40k tokens on a 1M window is not a warning");
    assert.equal(resumeContextNote(snap(119_999, 12)), "");
  });
});
