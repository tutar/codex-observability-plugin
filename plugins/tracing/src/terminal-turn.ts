import * as fs from "node:fs/promises";

import { isTerminalTurnEvent } from "./turn-lifecycle.js";

export const TERMINAL_TURN_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

type WaitOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
};

function containsTerminalEvent(contents: string, turnId: string): boolean {
  for (const rawLine of contents.split("\n")) {
    if (!rawLine) continue;
    try {
      const line = JSON.parse(rawLine) as {
        type?: string;
        payload?: { type?: string; turn_id?: string | null };
      };
      if (
        line.type === "event_msg" &&
        line.payload?.turn_id === turnId &&
        isTerminalTurnEvent(line.payload.type)
      ) {
        return true;
      }
    } catch {
      // The rollout is append-only and may end with a line still being written.
    }
  }
  return false;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForTerminalTurn(
  rolloutFile: string,
  turnId: string,
  options: WaitOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? TERMINAL_TURN_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const contents = await fs.readFile(rolloutFile, "utf-8");
    if (containsTerminalEvent(contents, turnId)) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}
