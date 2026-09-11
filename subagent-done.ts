/**
 * Extension loaded into every subagent child pi (via `-e <this file>`).
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Alt+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 * - Provides a `caller_ping` tool to ask the parent orchestrator for help
 *
 * Ported from pi-interactive-subagents (MIT, HazAT)
 * pi-extension/subagents/subagent-done.ts @ fix/launch-verify-retry, with the
 * activity recorder stripped (stall detection is discarded in this design —
 * herdr's pane.exited gives truthful lifecycle instead).
 *
 * The `.exit` sidecar written here is a cross-extension contract: the
 * orchestrator's watcher (src/watcher.ts) classifies completion from exactly
 * these shapes — {"type":"done"} and {"type":"ping","name":...,"message":...}.
 * Keep this file dependency-light: it loads into EVERY child.
 */
import type { ContextUsage, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";

import { writeContextUsageSidecar } from "./src/context-usage.ts";
import { getActiveSubagentCount } from "./src/runtime-state.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
  activeSubagentCount = 0,
): boolean {
  // A subagent can itself act as an orchestrator. Exiting its pi process here
  // would abort the nested watchers, so their eventual results would have no
  // live session to steer. Keep it open until every nested child has settled.
  if (activeSubagentCount > 0) return false;

  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  if (messages) {
    // A turn that ends at a user message produced no assistant reply — the
    // request errored / is retrying. This happens on resumed sessions whose
    // first request times out (verified live, pi 0.80.3): agent_end fires
    // while pi is "Retrying (1/3)"; walking backwards would find the
    // PREVIOUS conversation's assistant and shut pi down mid-retry.
    const last = messages[messages.length - 1];
    if (last?.role === "user") return false;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        // Don't auto-exit on errors (timeouts, connection failures) — let pi retry.
        // Only exit on clean completions (stop, toolUse) or explicit abort.
        return msg.stopReason !== "aborted" && msg.stopReason !== "error";
      }
    }
  }

  return true;
}

/**
 * Failure budget: consecutive failed tool executions before the child is told to
 * stop and report instead of retrying. Measured 2026-09-09: a day's 57 worker
 * invocations carried 28-failure loops and 61 test-runs in one session, each
 * retry re-billing the whole context. 0 disables the budget.
 */
export const DEFAULT_FAILURE_BUDGET = 5;

export function parseFailureBudget(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_FAILURE_BUDGET;
}

/** A failed tool execution, across the shapes pi reports: `isError`, or a non-zero shell exit. */
export function isFailedToolExecution(event: { isError?: boolean; result?: any }): boolean {
  if (event.isError) return true;
  const code = event.result?.exitCode ?? event.result?.details?.exitCode;
  return typeof code === "number" && code !== 0;
}

/** The steer text for a run of failures, or null when it is not a checkpoint. */
export function failureBudgetNotice(consecutive: number, budget: number): string | null {
  if (budget <= 0 || consecutive < budget || consecutive % budget !== 0) return null;
  return [
    `⛔ BUDGET: ${consecutive} consecutive tool failures.`,
    "Do not retry the same command again. Stop and make the failure visible:",
    "write what you tried, what failed, and the exact command output you have,",
    "then call subagent_done. A session that keeps failing is billed for every retry.",
  ].join(" ");
}

/**
 * What to say after a compaction, when the child's own task is at risk.
 *
 * Measured 2026-09-09: six dispatched workers compacted and stopped, each with
 * `firstKeptEntryId: ""` and `retainedTokens: 0` — a wake with no task. The cause is in
 * pi-blackhole's compaction policy, not here: its `minimal` tail behaviour cuts at the last user
 * message, and a dispatched worker has exactly ONE user turn (the task), so the cut lands at index
 * 0 and it compacts everything, keeping no tail. The summary does not carry the task.
 *
 * The task text is on disk, in the artifact the launcher wrote, so the cheap fix is to point back
 * at it instead of hoping the summary kept it.
 */
export function compactionTaskNotice(taskFile: string | undefined): string | null {
  if (!taskFile) return null;
  return (
    `Your context was just compacted and the summary may not carry your task. Re-read ${taskFile} ` +
    `before you continue. If that task is already complete, write your report and call subagent_done.`
  );
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export type ExitSidecarData =
  | { type: "done" }
  | { type: "ping"; name: string; message: string };

/**
 * Write the completion sidecar the orchestrator's watcher classifies from.
 * Byte-shape must match pi-interactive-subagents exactly (key order included):
 *   {"type":"done"}
 *   {"type":"ping","name":"...","message":"..."}
 */
export function writeExitSidecar(sessionFile: string, data: ExitSidecarData): void {
  const payload =
    data.type === "done"
      ? { type: "done" as const }
      : { type: "ping" as const, name: data.name, message: data.message };
  writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const failureBudget = parseFailureBudget(process.env.PI_SUBAGENT_FAILURE_BUDGET);
  let consecutiveFailures = 0;

  function renderWidget(ctx: { ui: { setWidget: Function } }) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Alt+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Alt+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  let contextUsageWritten = false;
  let terminalSidecarWritten = false;

  function signalTerminalSidecar(data: ExitSidecarData): void {
    if (terminalSidecarWritten) return;
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (!sessionFile) return;
    writeExitSidecar(sessionFile, data);
    terminalSidecarWritten = true;
  }

  function snapshotContextUsage(
    ctx: { getContextUsage?: () => ContextUsage | null | undefined },
    fallback = false,
  ): void {
    if (contextUsageWritten) return;

    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    const id = process.env.PI_SUBAGENT_ID;
    if (!sessionFile || !id) return;

    let usage: ContextUsage | null | undefined;
    try {
      usage = ctx.getContextUsage?.();
    } catch {
      return;
    }
    if (usage == null) return;

    try {
      contextUsageWritten = writeContextUsageSidecar(sessionFile, id, usage, {
        overwrite: !fallback,
      });
    } catch {
      // Telemetry is best-effort and must never prevent terminal signaling.
    }
  }

  // Show widget on session start
  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx);
  });

  pi.on("input", () => {
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("agent_start", () => {
    agentStarted = true;
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    const shouldExit =
      autoExit &&
      shouldAutoExitOnAgentEnd(userTookOver, messages, getActiveSubagentCount());

    if (shouldExit) {
      // Write the .exit sidecar so the watcher classifies this as a proper
      // completion, not a user close. Most models finish and stop talking
      // without explicitly calling subagent_done — a clean auto-exit IS a
      // completion.
      snapshotContextUsage(ctx);
      signalTerminalSidecar({ type: "done" });
      ctx.shutdown();
      return;
    }

    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  // The failure budget: steer a child out of a retry loop before it re-bills the
  // whole context again. Fires at the budget, then every budget after.
  pi.on("tool_execution_end", (event) => {
    consecutiveFailures = isFailedToolExecution(event) ? consecutiveFailures + 1 : 0;
    const notice = failureBudgetNotice(consecutiveFailures, failureBudget);
    if (notice) pi.sendMessage({ customType: "failure-budget", content: notice, display: true });
  });

  // User-driven exits do not pass through a terminal tool or clean agent_end.
  // Do not overwrite a snapshot already published by another terminal path.
  pi.on("session_shutdown", (_event, ctx) => {
    snapshotContextUsage(ctx, true);
  });

  // pi-blackhole compacts a worker's single user turn away entirely (see
  // compactionTaskNotice); put the task back in front of the child when it does.
  //
  // ⚠ STILL UNVERIFIED ON A REAL COMPACTION (2026-09-11). Five attempts, all measured:
  // · the default model (openai-codex) was over its usage limit, so a worker child dies instantly at
  //   0 tokens — `Codex error: The usage limit has been reached`;
  // · the free provider 429s (`FreeUsageLimitError`, then `Connection error`), which is also what
  //   stalls a child after its first two tool calls;
  // · no child session in three days sits above ~70k live context, and retained tool output is capped
  //   at 20k tokens, so reads cannot push one past blackhole's 81k threshold;
  // · lowering `compactAfterTokens` for ONE directory (`<cwd>/.pi/pi-blackhole-config.json`, created
  //   and deleted for the attempt) produced no compaction at 15k or at 5k — autoExit and interactive
  //   children alike — so the threshold is not the lever it looks like.
  // The shortest path when a provider has budget: copy a session that already re-sends ~132k tokens,
  // run `PI_SUBAGENT_TASK_FILE=<task> pi -e subagent-done.ts --session <copy> @<task>`, and let one
  // turn complete — it loads at 68% of a 200k window and only needs agent_end to compact.
  // Until then this arm rests on `compactionTaskNotice`'s tests plus two negative observations that
  // DID hold: a session with no launch-time task file gets no steer, and a non-child session that
  // compacted 11 times correctly got none either.
  pi.on("session_compact", () => {
    const notice = compactionTaskNotice(process.env.PI_SUBAGENT_TASK_FILE);
    if (notice) pi.sendMessage({ customType: "task-after-compact", content: notice, display: true }, { triggerTurn: true });
  });

  // Toggle expand/collapse with Alt+J
  pi.registerShortcut("alt+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      snapshotContextUsage(ctx);
      signalTerminalSidecar({
        type: "ping",
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      });

      ctx.shutdown();
      return {
        content: [
          { type: "text", text: "Ping sent. Session will exit and parent will be notified." },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) {
        snapshotContextUsage(ctx);
        signalTerminalSidecar({ type: "done" });
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
