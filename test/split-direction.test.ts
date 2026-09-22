import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createHerdrClient,
  pickSplitDirection,
  resolveSplitDirection,
  type ExecFn,
} from "../src/herdr/client.ts";

function layoutEnvelope(panes: Array<{ pane_id: string; width: number; height: number; focused?: boolean }>) {
  return JSON.stringify({
    id: "cli:pane:layout",
    result: {
      layout: {
        panes: panes.map((p) => ({
          pane_id: p.pane_id,
          focused: p.focused ?? false,
          rect: { x: 0, y: 0, width: p.width, height: p.height },
        })),
        focused_pane_id: panes.find((p) => p.focused)?.pane_id,
      },
      type: "pane_layout",
    },
  });
}

describe("split direction", () => {
  it("splits along the long axis", () => {
    assert.equal(pickSplitDirection(162, 45), "right");
    assert.equal(pickSplitDirection(40, 45), "down");
    assert.equal(pickSplitDirection(50, 50), "down");
  });

  it("resolves from the target pane geometry", async () => {
    const exec: ExecFn = async () => ({
      stdout: layoutEnvelope([{ pane_id: "w1:p1", width: 40, height: 45 }]),
      stderr: "",
      code: 0,
    });
    const client = createHerdrClient({ exec });
    assert.equal(await resolveSplitDirection(client, "w1:p1"), "down");
  });

  it("falls back to right without geometry", async () => {
    assert.equal(await resolveSplitDirection({}, "w1:p1"), "right");
    const failing: ExecFn = async () => ({ stdout: "", stderr: "boom", code: 1 });
    assert.equal(
      await resolveSplitDirection(createHerdrClient({ exec: failing }), "w1:p1"),
      "right",
    );
  });
});
