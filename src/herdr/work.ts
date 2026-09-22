// Herdr Pi Tree metadata contract and reporter lifecycle adapted from
// edxeth/pi-subagents (MIT, edxeth), src/mux/herdr-work.ts and
// src/runtime/outstanding-work.ts.
import { createHash } from "node:crypto";

/** The metadata token consumed by Herdr Pi Tree for delegated work counts. */
export const HERDR_WORK_METADATA_TOKEN = "pi_subagents_work_v1";

/** The source name shared with Herdr Pi Tree's delegated-work contract. */
export const HERDR_WORK_METADATA_SOURCE = "pi-subagents:work-v1";

const DEFAULT_WORK_METADATA_TTL_MS = 30_000;
const DEFAULT_WORK_METADATA_HEARTBEAT_MS = 10_000;

export interface HerdrWorkMetadataRequest {
  readonly token?: string;
  readonly clearToken?: string;
  readonly ttlMs: number;
}

export interface HerdrWorkReporter {
  /** Publish the number of delegated children still owed by this session. */
  publish(count: number): Promise<void>;
  /** Stop heartbeats and clear this session's metadata token. */
  stop(): Promise<void>;
}

export interface HerdrWorkReporterOptions {
  readonly sessionFile: string;
  readonly report: (request: HerdrWorkMetadataRequest) => Promise<void>;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly heartbeatMs?: number;
}

/**
 * Create the optional Herdr Pi Tree work-count reporter for one Pi session.
 * The token contains a hash of the owning session path, never the path itself.
 */
export function createHerdrWorkReporter(
  options: HerdrWorkReporterOptions,
): HerdrWorkReporter {
  const ttlMs = options.ttlMs ?? DEFAULT_WORK_METADATA_TTL_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_WORK_METADATA_HEARTBEAT_MS;
  const sessionHash = createHash("sha256")
    .update(options.sessionFile, "utf8")
    .digest("base64url");

  let stopped = false;
  let stopping: Promise<void> | undefined;
  let count = 0;
  let lastPublishedCount: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();

  const enqueue = (refresh: boolean): Promise<void> => {
    queue = queue.then(async () => {
      if (stopped || (!refresh && lastPublishedCount === count)) return;
      try {
        await options.report({
          token: `${HERDR_WORK_METADATA_TOKEN}=${sessionHash}:${count}:${(options.now ?? Date.now)() + ttlMs}`,
          ttlMs,
        });
        lastPublishedCount = count;
      } catch {
        // Work metadata is optional. A later heartbeat retries while work remains.
      }
    });
    return queue;
  };

  const scheduleHeartbeat = (): void => {
    timer = setTimeout(() => {
      timer = undefined;
      void enqueue(true).then(() => {
        if (!stopped && count > 0 && !timer) scheduleHeartbeat();
      });
    }, heartbeatMs);
    timer.unref?.();
  };

  return {
    publish(nextCount) {
      if (stopped) return queue;
      count = Math.max(0, Math.floor(nextCount));
      if (count > 0 && !timer) scheduleHeartbeat();
      if (count === 0 && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      return enqueue(false);
    },

    stop() {
      if (stopping) return stopping;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      stopping = queue.then(async () => {
        try {
          await options.report({ clearToken: HERDR_WORK_METADATA_TOKEN, ttlMs });
        } catch {
          // Cleanup is best-effort; the Herdr TTL also bounds stale metadata.
        }
      });
      return stopping;
    },
  };
}
