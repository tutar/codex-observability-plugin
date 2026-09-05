import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { markTurnUploaded } from "../src/sidecar.js";
import { convertRollout } from "../src/trace.js";

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

const baseConfig: Config = {
  enabled: true,
  public_key: "pk-lf-test",
  secret_key: "sk-lf-test",
  base_url: "https://cloud.langfuse.com",
  max_chars: 20_000,
  debug: false,
  fail_on_error: false,
};

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/sessions");

/** Copy the fixture session tree to a fresh temp dir (isolates sidecar writes). */
function stageFixtures(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-trace-"));
  fs.cpSync(fixturesRoot, path.join(dir, "sessions"), { recursive: true });
  return path.join(dir, "sessions", "2026", "06", "03");
}

function writeRollout(file: string, lines: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function childRolloutLines(options: {
  threadId: string;
  parentThreadId: string;
  agentPath: string;
  turnId: string;
  start: string;
  ordinal?: number;
  completed?: boolean;
}): Array<Record<string, unknown>> {
  const ordinal = options.ordinal ?? 40;
  const start = Date.parse(options.start);
  return [
    {
      timestamp: new Date(start - 100).toISOString(),
      type: "session_meta",
      payload: {
        id: options.threadId,
        parent_thread_id: options.parentThreadId,
        thread_source: "subagent",
        agent_path: options.agentPath,
        subagent_history_start_ordinal: ordinal,
      },
    },
    {
      ordinal,
      timestamp: options.start,
      type: "event_msg",
      payload: { type: "task_started", turn_id: options.turnId },
    },
    {
      ordinal: ordinal + 1,
      timestamp: new Date(start + 100).toISOString(),
      type: "event_msg",
      payload: { type: "user_message", message: options.turnId },
    },
    ...(options.completed === false
      ? []
      : [
          {
            ordinal: ordinal + 2,
            timestamp: new Date(start + 200).toISOString(),
            type: "event_msg",
            payload: { type: "task_complete", turn_id: options.turnId },
          },
        ]),
  ];
}

/**
 * The derivation external systems use to precompute a seeded trace id —
 * intentionally independent of the Langfuse SDK helper the plugin calls.
 */
const seededTraceId = (seed: string): string =>
  createHash("sha256").update(seed).digest("hex").slice(0, 32);

const attr = (span: ReadableSpan, key: string): string =>
  span.attributes[key] == null ? "" : String(span.attributes[key]);
const obsType = (span: ReadableSpan): string => attr(span, "langfuse.observation.type");
const startMs = (span: ReadableSpan): number => span.startTime[0] * 1000 + span.startTime[1] / 1e6;
const endMs = (span: ReadableSpan): number => span.endTime[0] * 1000 + span.endTime[1] / 1e6;
const parentId = (span: ReadableSpan): string | undefined =>
  (span as unknown as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId ??
  (span as unknown as { parentSpanId?: string }).parentSpanId;

beforeAll(() => {
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

describe("convertRollout", () => {
  it("does not emit an incomplete top-level turn", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");
    const lines = fs.readFileSync(file, "utf-8").trimEnd().split("\n");
    fs.writeFileSync(file, `${lines.slice(0, -1).join("\n")}\n`);

    await convertRollout(file, { config: baseConfig });

    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(false);
  });

  it("finalizes the incomplete turn identified by the Stop hook", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");
    const lines = fs.readFileSync(file, "utf-8").trimEnd().split("\n");
    const preTerminalLines = lines.slice(0, -1);
    const lastPersisted = JSON.parse(preTerminalLines.at(-1)!) as { timestamp: string };
    fs.writeFileSync(file, `${preTerminalLines.join("\n")}\n`);

    const uploadedTurnIds = await convertRollout(file, {
      config: baseConfig,
      finalizeTurnId: "turn-1",
    });

    const roots = exporter.getFinishedSpans().filter((span) => span.name === "Codex Turn");
    expect(roots).toHaveLength(1);
    expect(attr(roots[0], "langfuse.observation.metadata.codex.turn_id")).toBe("turn-1");
    expect(attr(roots[0], "langfuse.observation.metadata.codex.thread_id")).toBe("sess-basic");
    expect(attr(roots[0], "langfuse.observation.output")).toContain("two files");
    expect(endMs(roots[0])).toBe(Date.parse(lastPersisted.timestamp));
    expect(uploadedTurnIds).toEqual(["turn-1"]);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(false);
  });

  it("does not finalize an incomplete turn that differs from the Stop payload", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");
    const lines = fs.readFileSync(file, "utf-8").trimEnd().split("\n");
    fs.writeFileSync(file, `${lines.slice(0, -1).join("\n")}\n`);

    const uploadedTurnIds = await convertRollout(file, {
      config: baseConfig,
      finalizeTurnId: "turn-other",
    });

    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(uploadedTurnIds).toEqual([]);
  });

  it("emits an agent → generation → tool tree with backdated timestamps", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "Codex Turn");
    expect(root, "expected a 'Codex Turn' root span").toBeDefined();
    expect(obsType(root!)).toBe("agent");
    expect(parentId(root!)).toBeUndefined(); // top-level turn = its own trace
    expect(attr(root!, "langfuse.observation.input")).toContain("List the files");
    expect(attr(root!, "langfuse.observation.output")).toContain("two files");

    // Backdated to the turn's task_started timestamp.
    expect(startMs(root!)).toBe(Date.parse("2026-06-03T10:00:01.000Z"));

    // Two generations, both children of the root, named "LLM" (the model name
    // lives in the model attribute, not the observation name).
    const generations = spans
      .filter((s) => obsType(s) === "generation")
      .sort((a, b) => startMs(a) - startMs(b));
    expect(generations).toHaveLength(2);
    for (const gen of generations) {
      expect(gen.name).toBe("LLM");
      expect(parentId(gen)).toBe(root!.spanContext().spanId);
      expect(attr(gen, "langfuse.observation.model.name")).toBe("gpt-5.4");
    }
    // Usage is sent in Langfuse's OpenAI-compatible shape. Langfuse then
    // normalizes the inclusive parent counts and nested detail counts.
    const usages = generations.map((generation) => {
      const usage = attr(generation, "langfuse.observation.usage_details");
      expect(usage, "expected generation usage details").not.toBe("");
      return JSON.parse(usage);
    });
    expect(usages).toEqual([
      {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
      {
        prompt_tokens: 150,
        completion_tokens: 30,
        total_tokens: 180,
        prompt_tokens_details: { cached_tokens: 50 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    ]);
    // One tool span, nested under a generation, with the captured command output.
    const tools = spans.filter((s) => obsType(s) === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("exec_command");
    expect(attr(tools[0], "langfuse.observation.metadata.codex.tool_name")).toBe("exec_command");
    expect(attr(tools[0], "langfuse.observation.output")).toContain("file1.txt");
    expect(generations.map((g) => g.spanContext().spanId)).toContain(parentId(tools[0]));
  });

  it("nests subagent turns under the spawning turn and marks errors/interruptions", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-parent.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "Codex Turn" && obsType(s) === "agent");
    const child = spans.find((s) => s.name === "Codex Subagent Turn" && obsType(s) === "agent");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(parentId(parent!)).toBeUndefined();
    expect(parentId(child!)).toBeDefined();

    // The subagent turn is nested somewhere under the parent's trace.
    expect(child!.spanContext().traceId).toBe(parent!.spanContext().traceId);
    expect(attr(child!, "langfuse.observation.input")).toContain("tell a joke");

    // Subagent generations are distinguishable from main-thread ones.
    const childGeneration = spans.find(
      (s) => obsType(s) === "generation" && parentId(s) === child!.spanContext().spanId,
    );
    expect(childGeneration?.name).toBe("LLM Subagent");

    // Aborted turn is flagged on the parent root.
    expect(attr(parent!, "langfuse.observation.level")).toBe("WARNING");
    expect(attr(parent!, "langfuse.observation.metadata.codex.aborted")).toBe("true");
    expect(attr(parent!, "langfuse.observation.status_message")).toBe("Turn interrupted by user");

    // The failing exec is recorded as an ERROR-level tool span.
    const failedTool = spans.find(
      (s) => obsType(s) === "tool" && attr(s, "langfuse.observation.level") === "ERROR",
    );
    expect(failedTool, "expected a failed tool span").toBeDefined();
    expect(attr(failedTool!, "langfuse.observation.status_message")).toContain("command failed");
  });

  it("nests subagent turns discovered via sub_agent_activity events", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-activity-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "Codex Turn" && obsType(s) === "agent");
    const childTurns = spans.filter(
      (s) => s.name === "Codex Subagent Turn" && obsType(s) === "agent",
    );
    expect(parent).toBeDefined();
    // Exactly one child (the kind filter itself is pinned at parse level,
    // where non-"started" activities target distinct thread ids).
    expect(childTurns).toHaveLength(1);
    const child = childTurns[0];
    expect(child.spanContext().traceId).toBe(parent!.spanContext().traceId);
    expect(attr(child, "langfuse.observation.input")).toContain("compute the answer");

    const childGeneration = spans.find(
      (s) => obsType(s) === "generation" && parentId(s) === child.spanContext().spanId,
    );
    expect(childGeneration?.name).toBe("LLM Subagent");
    expect(attr(childGeneration!, "langfuse.observation.model.name")).toBe("gpt-5.4");
  });

  it("discovers a spawned child from metadata and excludes inherited history", async () => {
    const dir = stageFixtures();
    const parentFile = path.join(dir, "rollout-metadata-parent.jsonl");
    const childFile = path.join(dir, "rollout-metadata-child-thread-meta.jsonl");
    writeRollout(parentFile, [
      {
        timestamp: "2026-06-03T14:00:00.000Z",
        type: "session_meta",
        payload: { id: "parent-meta" },
      },
      {
        timestamp: "2026-06-03T14:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-turn" },
      },
      {
        timestamp: "2026-06-03T14:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "spawn-1",
          arguments: JSON.stringify({ task_name: "researcher", message: "research it" }),
        },
      },
      {
        timestamp: "2026-06-03T14:00:02.100Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "spawn-1",
          output: JSON.stringify({ task_name: "researcher" }),
        },
      },
      {
        timestamp: "2026-06-03T14:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-turn" },
      },
    ]);
    writeRollout(childFile, [
      {
        timestamp: "2026-06-03T14:00:02.100Z",
        type: "session_meta",
        payload: {
          id: "child-thread-meta",
          parent_thread_id: "parent-meta",
          thread_source: "subagent",
          agent_path: "/root/researcher",
          subagent_history_start_ordinal: 10,
        },
      },
      {
        ordinal: 7,
        timestamp: "2026-06-03T13:59:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "inherited-turn" },
      },
      {
        ordinal: 8,
        timestamp: "2026-06-03T13:59:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "parent replay" },
      },
      {
        ordinal: 9,
        timestamp: "2026-06-03T13:59:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "inherited-turn" },
      },
      {
        ordinal: 10,
        timestamp: "2026-06-03T14:00:02.200Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "local-child-turn" },
      },
      {
        ordinal: 11,
        timestamp: "2026-06-03T14:00:02.250Z",
        type: "turn_context",
        payload: { model: "gpt-5.4" },
      },
      {
        ordinal: 12,
        timestamp: "2026-06-03T14:00:02.300Z",
        type: "event_msg",
        payload: { type: "user_message", message: "research it" },
      },
      {
        ordinal: 13,
        timestamp: "2026-06-03T14:00:02.400Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "local result" }],
        },
      },
      {
        ordinal: 14,
        timestamp: "2026-06-03T14:00:02.450Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
          },
        },
      },
      {
        ordinal: 15,
        timestamp: "2026-06-03T14:00:02.500Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "local-child-turn" },
      },
    ]);

    await convertRollout(parentFile, { config: baseConfig });

    const childTurns = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "Codex Subagent Turn" && obsType(span) === "agent");
    expect(childTurns).toHaveLength(1);
    expect(attr(childTurns[0], "langfuse.observation.metadata.codex.turn_id")).toBe(
      "local-child-turn",
    );
    expect(attr(childTurns[0], "langfuse.observation.input")).toContain("research it");
    const childGeneration = exporter
      .getFinishedSpans()
      .find(
        (span) =>
          obsType(span) === "generation" && parentId(span) === childTurns[0].spanContext().spanId,
      );
    expect(childGeneration?.name).toBe("LLM Subagent");
    expect(attr(childGeneration!, "langfuse.observation.usage_details")).toContain(
      '"total_tokens":10',
    );
  });

  it("emits a child turn once when event and metadata discovery overlap", async () => {
    const dir = stageFixtures();
    const parentFile = path.join(dir, "rollout-overlap-parent.jsonl");
    const childFile = path.join(dir, "rollout-overlap-child-thread-overlap.jsonl");
    writeRollout(parentFile, [
      {
        timestamp: "2026-06-03T15:00:00.000Z",
        type: "session_meta",
        payload: { id: "parent-overlap" },
      },
      {
        timestamp: "2026-06-03T15:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-overlap-turn" },
      },
      {
        timestamp: "2026-06-03T15:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "spawn-overlap",
          arguments: JSON.stringify({ task_name: "worker" }),
        },
      },
      {
        timestamp: "2026-06-03T15:00:02.100Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "spawn-overlap",
          output: JSON.stringify({ task_name: "worker" }),
        },
      },
      {
        timestamp: "2026-06-03T15:00:02.110Z",
        type: "event_msg",
        payload: {
          type: "collab_agent_spawn_end",
          call_id: "spawn-overlap",
          new_thread_id: "thread-overlap",
        },
      },
      {
        timestamp: "2026-06-03T15:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-overlap-turn" },
      },
    ]);
    writeRollout(childFile, [
      {
        timestamp: "2026-06-03T15:00:02.100Z",
        type: "session_meta",
        payload: {
          id: "thread-overlap",
          parent_thread_id: "parent-overlap",
          thread_source: "subagent",
          agent_path: "/root/worker",
          subagent_history_start_ordinal: 20,
        },
      },
      {
        ordinal: 20,
        timestamp: "2026-06-03T15:00:02.200Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "child-overlap-turn" },
      },
      {
        ordinal: 21,
        timestamp: "2026-06-03T15:00:02.300Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "done" },
      },
      {
        ordinal: 22,
        timestamp: "2026-06-03T15:00:02.400Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "child-overlap-turn" },
      },
    ]);

    await convertRollout(parentFile, { config: baseConfig });

    const childTurns = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "Codex Subagent Turn" && obsType(span) === "agent");
    expect(childTurns).toHaveLength(1);
  });

  it("attributes successive child turns to spawn and followup triggers in order", async () => {
    const dir = stageFixtures();
    const parentFile = path.join(dir, "rollout-followup-parent.jsonl");
    const childFile = path.join(dir, "rollout-followup-child-thread-followup.jsonl");
    writeRollout(parentFile, [
      {
        timestamp: "2026-06-03T16:00:00.000Z",
        type: "session_meta",
        payload: { id: "parent-followup" },
      },
      {
        timestamp: "2026-06-03T16:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-spawn" },
      },
      {
        timestamp: "2026-06-03T16:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "spawn-followup",
          arguments: JSON.stringify({ task_name: "worker" }),
        },
      },
      {
        timestamp: "2026-06-03T16:00:02.100Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "spawn-followup", output: "ok" },
      },
      {
        timestamp: "2026-06-03T16:00:04.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-spawn" },
      },
      {
        timestamp: "2026-06-03T16:01:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-followup" },
      },
      {
        timestamp: "2026-06-03T16:01:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "followup_task",
          call_id: "followup-1",
          arguments: JSON.stringify({ target: "/root/worker", message: "continue" }),
        },
      },
      {
        timestamp: "2026-06-03T16:01:01.100Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "followup-1", output: "ok" },
      },
      {
        timestamp: "2026-06-03T16:01:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-followup" },
      },
    ]);
    writeRollout(childFile, [
      {
        timestamp: "2026-06-03T16:00:02.100Z",
        type: "session_meta",
        payload: {
          id: "thread-followup",
          parent_thread_id: "parent-followup",
          thread_source: "subagent",
          agent_path: "/root/worker",
          subagent_history_start_ordinal: 30,
        },
      },
      {
        ordinal: 30,
        timestamp: "2026-06-03T16:00:02.200Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "child-first" },
      },
      {
        ordinal: 31,
        timestamp: "2026-06-03T16:00:02.300Z",
        type: "event_msg",
        payload: { type: "user_message", message: "first task" },
      },
      {
        ordinal: 32,
        timestamp: "2026-06-03T16:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "child-first" },
      },
      {
        ordinal: 33,
        timestamp: "2026-06-03T16:01:01.200Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "child-second" },
      },
      {
        ordinal: 34,
        timestamp: "2026-06-03T16:01:01.300Z",
        type: "event_msg",
        payload: { type: "user_message", message: "second task" },
      },
      {
        ordinal: 35,
        timestamp: "2026-06-03T16:01:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "child-second" },
      },
    ]);

    await convertRollout(parentFile, { config: baseConfig });

    const parentTurns = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "Codex Turn" && obsType(span) === "agent")
      .sort((a, b) => startMs(a) - startMs(b));
    const childTurns = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "Codex Subagent Turn" && obsType(span) === "agent")
      .sort((a, b) => startMs(a) - startMs(b));
    expect(parentTurns).toHaveLength(2);
    expect(childTurns).toHaveLength(2);
    expect(childTurns[0].spanContext().traceId).toBe(parentTurns[0].spanContext().traceId);
    expect(childTurns[1].spanContext().traceId).toBe(parentTurns[1].spanContext().traceId);
    expect(attr(childTurns[0], "langfuse.observation.input")).toContain("first task");
    expect(attr(childTurns[1], "langfuse.observation.input")).toContain("second task");
  });

  it("attributes multiple named spawns in one parent turn to their distinct children", async () => {
    const dir = stageFixtures();
    const parentFile = path.join(dir, "rollout-multiple-parent.jsonl");
    writeRollout(parentFile, [
      {
        timestamp: "2026-06-03T17:00:00.000Z",
        type: "session_meta",
        payload: { id: "parent-multiple" },
      },
      {
        timestamp: "2026-06-03T17:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-multiple-turn" },
      },
      {
        timestamp: "2026-06-03T17:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "spawn-alpha",
          arguments: JSON.stringify({ task_name: "alpha" }),
        },
      },
      {
        timestamp: "2026-06-03T17:00:02.100Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "spawn-alpha", output: "ok" },
      },
      {
        timestamp: "2026-06-03T17:00:02.200Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "spawn-beta",
          arguments: JSON.stringify({ task_name: "beta" }),
        },
      },
      {
        timestamp: "2026-06-03T17:00:02.300Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "spawn-beta", output: "ok" },
      },
      {
        timestamp: "2026-06-03T17:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-multiple-turn" },
      },
    ]);
    writeRollout(
      path.join(dir, "rollout-multiple-child-alpha.jsonl"),
      childRolloutLines({
        threadId: "thread-alpha",
        parentThreadId: "parent-multiple",
        agentPath: "/root/alpha",
        turnId: "alpha-turn",
        start: "2026-06-03T17:00:02.110Z",
      }),
    );
    writeRollout(
      path.join(dir, "rollout-multiple-child-beta.jsonl"),
      childRolloutLines({
        threadId: "thread-beta",
        parentThreadId: "parent-multiple",
        agentPath: "/root/beta",
        turnId: "beta-turn",
        start: "2026-06-03T17:00:02.310Z",
      }),
    );

    await convertRollout(parentFile, { config: baseConfig });

    const childTurnIds = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "Codex Subagent Turn" && obsType(span) === "agent")
      .map((span) => attr(span, "langfuse.observation.metadata.codex.turn_id"))
      .sort();
    expect(childTurnIds).toEqual(["alpha-turn", "beta-turn"]);
  });

  it("fails closed when a trigger matches multiple child paths", async () => {
    const dir = stageFixtures();
    const parentFile = path.join(dir, "rollout-ambiguous-parent.jsonl");
    writeRollout(parentFile, [
      {
        timestamp: "2026-06-03T18:00:00.000Z",
        type: "session_meta",
        payload: { id: "parent-ambiguous" },
      },
      {
        timestamp: "2026-06-03T18:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-ambiguous-turn" },
      },
      {
        timestamp: "2026-06-03T18:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "spawn-worker",
          arguments: JSON.stringify({ task_name: "worker" }),
        },
      },
      {
        timestamp: "2026-06-03T18:00:02.100Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "spawn-worker", output: "ok" },
      },
      {
        timestamp: "2026-06-03T18:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-ambiguous-turn" },
      },
    ]);
    writeRollout(
      path.join(dir, "rollout-ambiguous-child-a.jsonl"),
      childRolloutLines({
        threadId: "thread-worker-a",
        parentThreadId: "parent-ambiguous",
        agentPath: "/root/a/worker",
        turnId: "worker-a-turn",
        start: "2026-06-03T18:00:02.200Z",
      }),
    );
    writeRollout(
      path.join(dir, "rollout-ambiguous-child-b.jsonl"),
      childRolloutLines({
        threadId: "thread-worker-b",
        parentThreadId: "parent-ambiguous",
        agentPath: "/root/b/worker",
        turnId: "worker-b-turn",
        start: "2026-06-03T18:00:02.200Z",
      }),
    );

    await convertRollout(parentFile, { config: baseConfig });

    expect(
      exporter
        .getFinishedSpans()
        .filter((span) => span.name === "Codex Subagent Turn" && obsType(span) === "agent"),
    ).toHaveLength(0);
  });

  it("uses a canonical followup target to distinguish duplicate agent names", async () => {
    const dir = stageFixtures();
    const parentFile = path.join(dir, "rollout-canonical-parent.jsonl");
    writeRollout(parentFile, [
      {
        timestamp: "2026-06-03T18:30:00.000Z",
        type: "session_meta",
        payload: { id: "parent-canonical" },
      },
      {
        timestamp: "2026-06-03T18:30:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-canonical-turn" },
      },
      {
        timestamp: "2026-06-03T18:30:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "followup_task",
          call_id: "followup-canonical",
          arguments: JSON.stringify({ target: "/root/a/worker", message: "continue" }),
        },
      },
      {
        timestamp: "2026-06-03T18:30:02.100Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "followup-canonical", output: "ok" },
      },
      {
        timestamp: "2026-06-03T18:30:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-canonical-turn" },
      },
    ]);
    writeRollout(
      path.join(dir, "rollout-canonical-child-a.jsonl"),
      childRolloutLines({
        threadId: "thread-canonical-a",
        parentThreadId: "parent-canonical",
        agentPath: "/root/a/worker",
        turnId: "canonical-a-turn",
        start: "2026-06-03T18:30:02.200Z",
      }),
    );
    writeRollout(
      path.join(dir, "rollout-canonical-child-b.jsonl"),
      childRolloutLines({
        threadId: "thread-canonical-b",
        parentThreadId: "parent-canonical",
        agentPath: "/root/b/worker",
        turnId: "canonical-b-turn",
        start: "2026-06-03T18:30:02.200Z",
      }),
    );

    await convertRollout(parentFile, { config: baseConfig });

    const childTurnIds = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "Codex Subagent Turn" && obsType(span) === "agent")
      .map((span) => attr(span, "langfuse.observation.metadata.codex.turn_id"));
    expect(childTurnIds).toEqual(["canonical-a-turn"]);
  });

  it("does not emit replay-prone child history when the projection boundary is missing", async () => {
    const dir = stageFixtures();
    const parentFile = path.join(dir, "rollout-no-boundary-parent.jsonl");
    writeRollout(parentFile, [
      {
        timestamp: "2026-06-03T18:45:00.000Z",
        type: "session_meta",
        payload: { id: "parent-no-boundary" },
      },
      {
        timestamp: "2026-06-03T18:45:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-no-boundary-turn" },
      },
      {
        timestamp: "2026-06-03T18:45:02.000Z",
        type: "event_msg",
        payload: {
          type: "collab_agent_spawn_end",
          call_id: "spawn-no-boundary",
          new_thread_id: "thread-no-boundary",
        },
      },
      {
        timestamp: "2026-06-03T18:45:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-no-boundary-turn" },
      },
    ]);
    const childLines = childRolloutLines({
      threadId: "thread-no-boundary",
      parentThreadId: "parent-no-boundary",
      agentPath: "/root/worker",
      turnId: "no-boundary-turn",
      start: "2026-06-03T18:45:02.100Z",
    });
    delete (childLines[0].payload as Record<string, unknown>).subagent_history_start_ordinal;
    writeRollout(path.join(dir, "rollout-no-boundary-child.jsonl"), childLines);

    await convertRollout(parentFile, { config: baseConfig });

    expect(
      exporter
        .getFinishedSpans()
        .filter((span) => span.name === "Codex Subagent Turn" && obsType(span) === "agent"),
    ).toHaveLength(0);
  });

  it("treats a paginated child rollout without a projection boundary as local history", async () => {
    const dir = stageFixtures();
    const parentFile = path.join(dir, "rollout-paginated-parent.jsonl");
    writeRollout(parentFile, [
      {
        timestamp: "2026-06-03T18:47:00.000Z",
        type: "session_meta",
        payload: { id: "parent-paginated", history_mode: "paginated" },
      },
      {
        timestamp: "2026-06-03T18:47:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-paginated-turn" },
      },
      {
        timestamp: "2026-06-03T18:47:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "spawn-paginated",
          arguments: JSON.stringify({ task_name: "worker" }),
        },
      },
      {
        timestamp: "2026-06-03T18:47:02.100Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "spawn-paginated", output: "ok" },
      },
      {
        timestamp: "2026-06-03T18:47:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-paginated-turn" },
      },
    ]);
    const childLines = childRolloutLines({
      threadId: "thread-paginated",
      parentThreadId: "parent-paginated",
      agentPath: "/root/worker",
      turnId: "paginated-child-turn",
      start: "2026-06-03T18:47:02.200Z",
    });
    const childMeta = childLines[0].payload as Record<string, unknown>;
    delete childMeta.subagent_history_start_ordinal;
    childMeta.history_mode = "paginated";
    writeRollout(path.join(dir, "rollout-paginated-child.jsonl"), childLines);

    await convertRollout(parentFile, { config: baseConfig });

    const childTurnIds = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "Codex Subagent Turn" && obsType(span) === "agent")
      .map((span) => attr(span, "langfuse.observation.metadata.codex.turn_id"));
    expect(childTurnIds).toEqual(["paginated-child-turn"]);
  });

  it("fails closed when the projection boundary is not a non-negative integer", async () => {
    const dir = stageFixtures();
    const parentFile = path.join(dir, "rollout-invalid-boundary-parent.jsonl");
    writeRollout(parentFile, [
      {
        timestamp: "2026-06-03T18:50:00.000Z",
        type: "session_meta",
        payload: { id: "parent-invalid-boundary" },
      },
      {
        timestamp: "2026-06-03T18:50:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-invalid-boundary-turn" },
      },
      {
        timestamp: "2026-06-03T18:50:02.000Z",
        type: "event_msg",
        payload: {
          type: "collab_agent_spawn_end",
          call_id: "spawn-invalid-boundary",
          new_thread_id: "thread-invalid-boundary",
        },
      },
      {
        timestamp: "2026-06-03T18:50:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-invalid-boundary-turn" },
      },
    ]);
    const childLines = childRolloutLines({
      threadId: "thread-invalid-boundary",
      parentThreadId: "parent-invalid-boundary",
      agentPath: "/root/worker",
      turnId: "invalid-boundary-turn",
      start: "2026-06-03T18:50:02.100Z",
    });
    (childLines[0].payload as Record<string, unknown>).subagent_history_start_ordinal = -1;
    writeRollout(path.join(dir, "rollout-invalid-boundary-child.jsonl"), childLines);

    await convertRollout(parentFile, { config: baseConfig });

    expect(
      exporter
        .getFinishedSpans()
        .filter((span) => span.name === "Codex Subagent Turn" && obsType(span) === "agent"),
    ).toHaveLength(0);
  });

  it("discovers a metadata-linked child stored in a different date directory", async () => {
    const dir = stageFixtures();
    const parentFile = path.join(dir, "rollout-cross-date-parent.jsonl");
    writeRollout(parentFile, [
      {
        timestamp: "2026-06-03T23:59:58.000Z",
        type: "session_meta",
        payload: { id: "parent-cross-date" },
      },
      {
        timestamp: "2026-06-03T23:59:59.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-cross-date-turn" },
      },
      {
        timestamp: "2026-06-03T23:59:59.500Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "spawn-cross-date",
          arguments: JSON.stringify({ task_name: "overnight" }),
        },
      },
      {
        timestamp: "2026-06-03T23:59:59.900Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "spawn-cross-date", output: "ok" },
      },
      {
        timestamp: "2026-06-04T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-cross-date-turn" },
      },
    ]);
    const nextDayDir = path.resolve(dir, "../04");
    writeRollout(
      path.join(nextDayDir, "rollout-cross-date-child.jsonl"),
      childRolloutLines({
        threadId: "thread-cross-date",
        parentThreadId: "parent-cross-date",
        agentPath: "/root/overnight",
        turnId: "cross-date-child-turn",
        start: "2026-06-04T00:00:00.000Z",
      }),
    );

    await convertRollout(parentFile, { config: baseConfig });

    const childTurnIds = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "Codex Subagent Turn" && obsType(span) === "agent")
      .map((span) => attr(span, "langfuse.observation.metadata.codex.turn_id"));
    expect(childTurnIds).toEqual(["cross-date-child-turn"]);
  });

  it("does not attribute a child turn to wait_agent and skips incomplete children", async () => {
    const dir = stageFixtures();
    const parentFile = path.join(dir, "rollout-wait-parent.jsonl");
    writeRollout(parentFile, [
      {
        timestamp: "2026-06-03T19:00:00.000Z",
        type: "session_meta",
        payload: { id: "parent-wait" },
      },
      {
        timestamp: "2026-06-03T19:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-wait-turn" },
      },
      {
        timestamp: "2026-06-03T19:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "wait_agent",
          call_id: "wait-1",
          arguments: JSON.stringify({ timeout_ms: 1000 }),
        },
      },
      {
        timestamp: "2026-06-03T19:00:02.100Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "wait-1", output: "done" },
      },
      {
        timestamp: "2026-06-03T19:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-wait-turn" },
      },
    ]);
    writeRollout(
      path.join(dir, "rollout-wait-child.jsonl"),
      childRolloutLines({
        threadId: "thread-wait",
        parentThreadId: "parent-wait",
        agentPath: "/root/worker",
        turnId: "incomplete-child",
        start: "2026-06-03T19:00:02.200Z",
        completed: false,
      }),
    );

    await convertRollout(parentFile, { config: baseConfig });

    expect(
      exporter
        .getFinishedSpans()
        .filter((span) => span.name === "Codex Subagent Turn" && obsType(span) === "agent"),
    ).toHaveLength(0);
  });

  it("emits only the newly attributed child turn when rollouts grow", async () => {
    const dir = stageFixtures();
    const parentFile = path.join(dir, "rollout-growing-parent.jsonl");
    const childFile = path.join(dir, "rollout-growing-child.jsonl");
    const parentLines: Array<Record<string, unknown>> = [
      {
        timestamp: "2026-06-03T20:00:00.000Z",
        type: "session_meta",
        payload: { id: "parent-growing" },
      },
      {
        timestamp: "2026-06-03T20:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-growing-spawn" },
      },
      {
        timestamp: "2026-06-03T20:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "spawn-growing",
          arguments: JSON.stringify({ task_name: "worker" }),
        },
      },
      {
        timestamp: "2026-06-03T20:00:02.100Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "spawn-growing", output: "ok" },
      },
      {
        timestamp: "2026-06-03T20:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-growing-spawn" },
      },
    ];
    const childLines = childRolloutLines({
      threadId: "thread-growing",
      parentThreadId: "parent-growing",
      agentPath: "/root/worker",
      turnId: "child-growing-first",
      start: "2026-06-03T20:00:02.200Z",
    });
    writeRollout(parentFile, parentLines);
    writeRollout(childFile, childLines);

    const firstUploaded = await convertRollout(parentFile, { config: baseConfig });
    for (const turnId of firstUploaded) await markTurnUploaded(parentFile, turnId);
    exporter.reset();

    parentLines.push(
      {
        timestamp: "2026-06-03T20:01:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "parent-growing-followup" },
      },
      {
        timestamp: "2026-06-03T20:01:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "followup_task",
          call_id: "followup-growing",
          arguments: JSON.stringify({ target: "worker", message: "again" }),
        },
      },
      {
        timestamp: "2026-06-03T20:01:01.100Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "followup-growing", output: "ok" },
      },
      {
        timestamp: "2026-06-03T20:01:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "parent-growing-followup" },
      },
    );
    childLines.push(
      {
        ordinal: 43,
        timestamp: "2026-06-03T20:01:01.200Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "child-growing-second" },
      },
      {
        ordinal: 44,
        timestamp: "2026-06-03T20:01:01.300Z",
        type: "event_msg",
        payload: { type: "user_message", message: "second child task" },
      },
      {
        ordinal: 45,
        timestamp: "2026-06-03T20:01:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "child-growing-second" },
      },
    );
    writeRollout(parentFile, parentLines);
    writeRollout(childFile, childLines);

    await convertRollout(parentFile, { config: baseConfig });

    const childTurnIds = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "Codex Subagent Turn" && obsType(span) === "agent")
      .map((span) => attr(span, "langfuse.observation.metadata.codex.turn_id"));
    expect(childTurnIds).toEqual(["child-growing-second"]);
  });

  it("captures web search, local shell, and MCP tool calls with specific names", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-tools-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const toolNames = spans
      .filter((s) => obsType(s) === "tool")
      .map((s) => s.name)
      .sort();
    // Call arguments (command, query) stay out of the name — they are the input.
    expect(toolNames).toEqual(["linear.create_issue", "local_shell", "web_search"]);

    const webSearch = spans.find((s) => s.name === "web_search")!;
    expect(attr(webSearch, "langfuse.observation.input")).toContain("langfuse codex plugin");

    const shell = spans.find((s) => s.name === "local_shell")!;
    expect(attr(shell, "langfuse.observation.output")).toContain("clean");
  });

  it("skips turns already recorded in the sidecar (dedup)", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");

    const uploadedTurnIds = await convertRollout(file, { config: baseConfig });
    const firstCount = exporter.getFinishedSpans().length;
    expect(firstCount).toBeGreaterThan(0);
    for (const turnId of uploadedTurnIds) await markTurnUploaded(file, turnId);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(true);

    exporter.reset();
    await convertRollout(file, { config: baseConfig });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("deterministic trace ids (trace_seed)", () => {
  const seed = "ci-run-42";
  const seededConfig: Config = { ...baseConfig, trace_seed: seed };

  const turnRoots = () =>
    exporter
      .getFinishedSpans()
      .filter((s) => s.name === "Codex Turn" || s.name === "Codex Subagent Turn")
      .sort((a, b) => startMs(a) - startMs(b));

  it("derives the N-th main-thread turn's trace id from `${seed}:${N}`", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-two-turns-main.jsonl"), {
      config: seededConfig,
    });

    const roots = turnRoots();
    expect(roots).toHaveLength(2);
    expect(roots[0].spanContext().traceId).toBe(seededTraceId(`${seed}:1`));
    expect(roots[1].spanContext().traceId).toBe(seededTraceId(`${seed}:2`));

    // Every span (generations included) lands in one of the two seeded traces.
    const traceIds = new Set(exporter.getFinishedSpans().map((s) => s.spanContext().traceId));
    expect([...traceIds].sort()).toEqual(
      [seededTraceId(`${seed}:1`), seededTraceId(`${seed}:2`)].sort(),
    );
  });

  it("keeps generations and tool spans in the seeded trace", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), { config: seededConfig });

    const spans = exporter.getFinishedSpans();
    const expected = seededTraceId(`${seed}:1`);
    expect(spans.length).toBeGreaterThan(2); // root + generations + tool
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(expected);
    }
    // Structure is unchanged: root agent span with its generations beneath it.
    const root = spans.find((s) => s.name === "Codex Turn")!;
    expect(obsType(root)).toBe("agent");
    const generations = spans.filter((s) => obsType(s) === "generation");
    expect(generations).toHaveLength(2);
    for (const gen of generations) {
      expect(parentId(gen)).toBe(root.spanContext().spanId);
    }
  });

  it("scopes subagent-thread rollouts by thread id so they don't collide", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-child-thread-child.jsonl"), {
      config: seededConfig,
    });

    const roots = turnRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].spanContext().traceId).toBe(seededTraceId(`${seed}:thread-child:1`));
    expect(roots[0].spanContext().traceId).not.toBe(seededTraceId(`${seed}:1`));
  });

  it("nests subagent turns inside the parent's seeded trace", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-parent.jsonl"), { config: seededConfig });

    const roots = turnRoots();
    expect(roots).toHaveLength(2); // parent turn + nested subagent turn
    const expected = seededTraceId(`${seed}:1`);
    for (const root of roots) {
      expect(root.spanContext().traceId).toBe(expected);
    }
  });

  it("leaves trace ids auto-generated when the seed is unset", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-two-turns-main.jsonl"), { config: baseConfig });

    const roots = turnRoots();
    expect(roots).toHaveLength(2);
    for (const root of roots) {
      // Same shape as before the feature: true root span, random trace id.
      expect(parentId(root)).toBeUndefined();
      expect(root.spanContext().traceId).not.toBe(seededTraceId(`${seed}:1`));
      expect(root.spanContext().traceId).not.toBe(seededTraceId(`${seed}:2`));
    }
    expect(roots[0].spanContext().traceId).not.toBe(roots[1].spanContext().traceId);
  });

  it("keeps sidecar dedup working when a seed is set", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-two-turns-main.jsonl");

    const uploadedTurnIds = await convertRollout(file, { config: seededConfig });
    expect(turnRoots()).toHaveLength(2);
    for (const turnId of uploadedTurnIds) await markTurnUploaded(file, turnId);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(true);

    exporter.reset();
    await convertRollout(file, { config: seededConfig });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("numbers turns over the full rollout even when earlier turns are deduped", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-two-turns-main.jsonl");

    // Pretend turn 1 was uploaded by a previous hook invocation.
    fs.writeFileSync(`${file}.langfuse`, "turn-a\n");
    await convertRollout(file, { config: seededConfig });

    const roots = turnRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].spanContext().traceId).toBe(seededTraceId(`${seed}:2`));
  });
});
