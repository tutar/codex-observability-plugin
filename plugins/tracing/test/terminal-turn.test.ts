import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { waitForTerminalTurn } from "../src/terminal-turn.js";

const line = (type: string, turnId: string): string =>
  JSON.stringify({
    timestamp: "2026-09-03T00:00:00.000Z",
    type: "event_msg",
    payload: { type, turn_id: turnId },
  });

describe("waitForTerminalTurn", () => {
  it("waits for the matching turn to become complete", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-terminal-turn-"));
    const file = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(file, `${line("task_started", "turn-final")}\n`);

    setTimeout(() => fs.appendFileSync(file, `${line("task_complete", "turn-final")}\n`), 20);

    await expect(
      waitForTerminalTurn(file, "turn-final", { timeoutMs: 200, pollIntervalMs: 5 }),
    ).resolves.toBe(true);
  });

  it("does not accept another turn's terminal marker or a partial JSON line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-terminal-turn-"));
    const file = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      file,
      `${line("task_complete", "turn-other")}\n{\"type\":\"event_msg\",\"payload\":`,
    );

    await expect(
      waitForTerminalTurn(file, "turn-final", { timeoutMs: 20, pollIntervalMs: 5 }),
    ).resolves.toBe(false);
  });

  it("treats an abort for the matching turn as terminal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-terminal-turn-"));
    const file = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(file, `${line("turn_aborted", "turn-final")}\n`);

    await expect(
      waitForTerminalTurn(file, "turn-final", { timeoutMs: 20, pollIntervalMs: 5 }),
    ).resolves.toBe(true);
  });
});
