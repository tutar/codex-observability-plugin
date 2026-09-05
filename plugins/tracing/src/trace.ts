import type { Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";

import {
  createTraceId,
  propagateAttributes,
  startObservation,
  type LangfuseGenerationAttributes,
  type LangfuseObservation,
} from "@langfuse/tracing";
import { TraceFlags, type SpanContext } from "@opentelemetry/api";

import type { Config } from "./config.js";
import { parseSession } from "./parse.js";
import { loadUploadedTurnIds } from "./sidecar.js";
import type { ModelStep, RolloutLine, SessionMeta, TokenUsage, ToolCall, Turn } from "./types.js";
import { debugLog, toText, truncate } from "./utils.js";

async function loadSession(file: string): Promise<RolloutLine[]> {
  const data = await fs.readFile(file, "utf-8");
  const lines: RolloutLine[] = [];
  for (const raw of data.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as RolloutLine);
    } catch {
      // skip malformed lines rather than aborting the whole upload
    }
  }
  const sessionPayload = lines.find((line) => line.type === "session_meta")?.payload as
    { subagent_history_start_ordinal?: unknown } | undefined;
  const boundary = sessionPayload?.subagent_history_start_ordinal;
  if (typeof boundary !== "number" || !Number.isSafeInteger(boundary)) return lines;
  return lines.filter(
    (line) =>
      line.type === "session_meta" ||
      (Number.isSafeInteger(line.ordinal) && line.ordinal! >= boundary),
  );
}

type ChildTurn = { rolloutFile: string; sessionMeta: SessionMeta; turn: Turn };

async function loadSessionMeta(file: string): Promise<SessionMeta | undefined> {
  const input = createReadStream(file);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      if (!raw.trim()) continue;
      const line = JSON.parse(raw) as RolloutLine;
      return line.type === "session_meta" ? parseSession([line]).sessionMeta : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    lines.close();
    input.destroy();
  }
}

function agentName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1);
}

function normalizedAgentPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\/+$/, "");
  return normalized || undefined;
}

function triggerName(toolCall: ToolCall): string | undefined {
  if (!toolCall.args || typeof toolCall.args !== "object") return undefined;
  const args = toolCall.args as Record<string, unknown>;
  if (toolCall.name === "spawn_agent") return normalizedAgentPath(args.task_name);
  if (toolCall.name === "followup_task") return normalizedAgentPath(args.target);
  return undefined;
}

function triggerMatchesAgent(trigger: string, candidatePath: string): boolean {
  const normalizedCandidate = normalizedAgentPath(candidatePath);
  if (!normalizedCandidate) return false;
  return trigger.includes("/")
    ? trigger === normalizedCandidate
    : agentName(normalizedCandidate) === trigger;
}

async function listRolloutFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  }
  await walk(root);
  return files;
}

async function discoverChildTurns(
  parentFile: string,
  parentSession: SessionMeta,
  parentTurns: Turn[],
): Promise<Map<Turn, ChildTurn[]>> {
  const hasDiscoverySignal = parentTurns.some(
    (turn) =>
      turn.subagentThreadIds.length > 0 ||
      turn.steps.some((step) => step.toolCalls.some((toolCall) => triggerName(toolCall))),
  );
  if (!hasDiscoverySignal) return new Map();

  const root = path.resolve(path.dirname(parentFile), "../../..");
  const children: Array<{
    rolloutFile: string;
    sessionMeta: SessionMeta;
    turns: Turn[];
  }> = [];
  for (const rolloutFile of await listRolloutFiles(root)) {
    if (rolloutFile === parentFile) continue;
    const candidateMeta = await loadSessionMeta(rolloutFile);
    if (
      candidateMeta?.parentThreadId === parentSession.sessionId &&
      candidateMeta.subagentHistoryStartOrdinal !== undefined
    ) {
      const { sessionMeta, turns } = parseSession(await loadSession(rolloutFile));
      children.push({ rolloutFile, sessionMeta, turns: turns.filter((turn) => turn.completed) });
    }
  }

  const result = new Map<Turn, ChildTurn[]>();
  const nextTurnByThread = new Map<string, number>();
  const assigned = new Set<string>();
  for (const parentTurn of parentTurns) {
    for (const threadId of parentTurn.subagentThreadIds) {
      const child = children.find((candidate) => candidate.sessionMeta.sessionId === threadId);
      if (!child) continue;
      const turnIndex = nextTurnByThread.get(threadId) ?? 0;
      const turn = child.turns[turnIndex];
      if (!turn) continue;
      const key = `${threadId}:${turn.turnId ?? turnIndex}`;
      if (assigned.has(key)) continue;
      assigned.add(key);
      nextTurnByThread.set(threadId, turnIndex + 1);
      const current = result.get(parentTurn) ?? [];
      current.push({ rolloutFile: child.rolloutFile, sessionMeta: child.sessionMeta, turn });
      result.set(parentTurn, current);
    }
    for (const step of parentTurn.steps) {
      for (const toolCall of step.toolCalls) {
        const name = triggerName(toolCall);
        if (!name) continue;
        const matches = children.filter(
          (child) =>
            child.sessionMeta.agentPath && triggerMatchesAgent(name, child.sessionMeta.agentPath),
        );
        if (matches.length !== 1) {
          debugLog(
            `skipping ambiguous child attribution for ${toolCall.name} target ${name}: ${matches.length} metadata match(es)`,
          );
          continue;
        }
        const child = matches[0];
        if (parentTurn.subagentThreadIds.includes(child.sessionMeta.sessionId)) continue;
        const turnIndex = nextTurnByThread.get(child.sessionMeta.sessionId) ?? 0;
        const turn = child.turns[turnIndex];
        if (!turn || turn.startTime < (toolCall.endTime ?? toolCall.startTime)) continue;
        const key = `${child.sessionMeta.sessionId}:${turn.turnId ?? turnIndex}`;
        if (assigned.has(key)) continue;
        assigned.add(key);
        nextTurnByThread.set(child.sessionMeta.sessionId, turnIndex + 1);
        const current = result.get(parentTurn) ?? [];
        current.push({ rolloutFile: child.rolloutFile, sessionMeta: child.sessionMeta, turn });
        result.set(parentTurn, current);
      }
    }
  }
  return result;
}

/**
 * Placeholder parent span id used to pin a deterministic trace id on a root
 * span (the pattern the Langfuse SDK documents for custom trace ids). The id
 * never exists as a real span, so Langfuse still renders the turn as the
 * trace root.
 */
const SEED_PARENT_SPAN_ID = "0123456789abcdef";

/**
 * Derive the deterministic trace id for a turn from `config.trace_seed`.
 *
 * Main-thread turn N (1-based, rollout order):  createTraceId(`${seed}:${N}`)
 * Subagent-thread turn N:                       createTraceId(`${seed}:${threadId}:${N}`)
 *
 * The main-thread form deliberately excludes the thread id so external systems
 * can precompute trace ids (hex(sha256(seed)).slice(0, 32)) before the Codex
 * thread exists. Returns `undefined` (auto-generated ids) when no seed is set
 * or derivation fails — the hook must never block an upload.
 */
async function seededTraceParent(
  config: Config,
  sessionMeta: SessionMeta,
  turnNumber: number,
): Promise<SpanContext | undefined> {
  if (!config.trace_seed) return undefined;
  try {
    const seed = sessionMeta.isSubagentThread
      ? `${config.trace_seed}:${sessionMeta.sessionId}:${turnNumber}`
      : `${config.trace_seed}:${turnNumber}`;
    return {
      traceId: await createTraceId(seed),
      spanId: SEED_PARENT_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
  } catch (error) {
    debugLog("failed to derive seeded trace id; falling back to auto-generated:", error);
    if (config.fail_on_error) throw error;
    return undefined;
  }
}

function isTokenCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Send Codex's inclusive counts using Langfuse's strict OpenAI usage schema. */
function toUsageDetails(
  usage: TokenUsage | undefined,
): LangfuseGenerationAttributes["usageDetails"] {
  if (!usage) return undefined;
  const {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cached_input_tokens: cached,
    reasoning_output_tokens: reasoning,
  } = usage;

  if (
    !isTokenCount(input) ||
    !isTokenCount(output) ||
    !isTokenCount(total) ||
    total !== input + output
  ) {
    debugLog("dropping usage: missing or inconsistent token counts", usage);
    return undefined;
  }
  if (
    (cached !== undefined && (!isTokenCount(cached) || cached > input)) ||
    (reasoning !== undefined && (!isTokenCount(reasoning) || reasoning > output))
  ) {
    debugLog("dropping usage: implausible cached/reasoning details", usage);
    return undefined;
  }

  // The runtime supports this documented shape, but the SDK type still
  // exposes only its legacy camelCase usage interface.
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
    ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(reasoning !== undefined
      ? { completion_tokens_details: { reasoning_tokens: reasoning } }
      : {}),
  } as unknown as LangfuseGenerationAttributes["usageDetails"];
}

type Clip = {
  (value: string): string;
  (value: unknown): unknown;
};

/** Build a clip() that truncates long strings to `maxChars`. */
function makeClip(maxChars: number): Clip {
  function clip(value: string): string;
  function clip(value: unknown): unknown;
  function clip(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const { text, meta } = truncate(value, maxChars);
    return meta ? `${text}\n…[truncated ${meta.originalLength - text.length} chars]` : text;
  }
  return clip;
}

function buildGenerationOutput(step: ModelStep, clip: Clip): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  if (step.text) output.content = clip(step.text);
  if (step.reasoning) output.reasoning = clip(step.reasoning);
  if (step.toolCalls.length > 0) {
    output.tool_calls = step.toolCalls.map((tc) => ({
      id: tc.callId,
      name: tc.name,
      arguments: tc.args,
    }));
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * Observation name for a tool call. MCP calls use the clean `server.tool`
 * split from the mcp_tool_call_* events instead of the mangled function name;
 * everything else uses the plain tool name. Call arguments (shell command,
 * search query, …) stay out of the name — they belong to the observation
 * input.
 */
function toolObservationName(tc: ToolCall): string {
  if (tc.mcp) return `${tc.mcp.server}.${tc.mcp.tool}`;
  return tc.name || "tool";
}

/** Emit a single turn (and its subagents) as a Langfuse observation tree. */
async function emitTurn(
  turn: Turn,
  sessionMeta: SessionMeta,
  ctx: {
    config: Config;
    rolloutFile: string;
    parentObservation?: LangfuseObservation;
    /** Pre-derived trace id for top-level turns (see seededTraceParent). */
    seededParent?: SpanContext;
    attributedChildTurns?: Map<Turn, ChildTurn[]>;
  },
): Promise<void> {
  const clip = makeClip(ctx.config.max_chars);

  // A turn belongs to a subagent when its rollout is marked as a subagent
  // thread or when it is being nested under a spawning turn.
  const isSubagent = sessionMeta.isSubagentThread === true || ctx.parentObservation != null;

  const root = startObservation(
    isSubagent ? "Codex Subagent Turn" : "Codex Turn",
    {
      input: turn.userInput != null ? clip(turn.userInput) : undefined,
      output: turn.finalOutput != null ? clip(turn.finalOutput) : undefined,
      level: turn.aborted ? "WARNING" : undefined,
      statusMessage: turn.aborted ? "Turn interrupted by user" : undefined,
      metadata: {
        "codex.turn_id": turn.turnId,
        "codex.thread_id": sessionMeta.sessionId,
        "codex.model": turn.model,
        "codex.model_provider": sessionMeta.modelProvider,
        "codex.cli_version": sessionMeta.cliVersion,
        "codex.aborted": turn.aborted,
        "codex.tool_call_count": turn.steps.reduce((n, s) => n + s.toolCalls.length, 0),
      },
    },
    {
      asType: "agent",
      startTime: new Date(turn.startTime),
      parentSpanContext: ctx.parentObservation?.otelSpan.spanContext() ?? ctx.seededParent,
    },
  );

  let previousToolResults: unknown = undefined;

  for (let i = 0; i < turn.steps.length; i++) {
    const step = turn.steps[i];
    const generation = startObservation(
      isSubagent ? "LLM Subagent" : "LLM",
      {
        input:
          i === 0
            ? turn.userInput != null
              ? clip(turn.userInput)
              : undefined
            : previousToolResults,
        output: buildGenerationOutput(step, clip),
        model: turn.model,
        usageDetails: toUsageDetails(step.usage),
        metadata: { "codex.step_index": i },
      },
      {
        asType: "generation",
        startTime: new Date(step.startTime),
        parentSpanContext: root.otelSpan.spanContext(),
      },
    );

    for (const tc of step.toolCalls) {
      emitToolCall(tc, generation, clip, step.endTime);
    }

    generation.end(new Date(step.endTime));

    previousToolResults =
      step.toolCalls.length > 0
        ? step.toolCalls.map((tc) => ({
            name: tc.name,
            output: tc.output != null ? clip(toText(tc.output)) : undefined,
            ...(tc.error ? { error: clip(tc.error) } : {}),
          }))
        : undefined;
  }

  for (const child of ctx.attributedChildTurns?.get(turn) ?? []) {
    await emitTurn(child.turn, child.sessionMeta, {
      config: ctx.config,
      rolloutFile: child.rolloutFile,
      parentObservation: root,
    });
  }

  root.end(new Date(turn.endTime));
}

function emitToolCall(
  tc: ToolCall,
  parent: LangfuseObservation,
  clip: Clip,
  fallbackEnd: number,
): void {
  const tool = startObservation(
    toolObservationName(tc),
    {
      input: tc.args,
      output: tc.output != null ? clip(toText(tc.output)) : undefined,
      level: tc.error ? "ERROR" : undefined,
      statusMessage: tc.error ? clip(tc.error) : undefined,
      metadata: { "codex.call_id": tc.callId, "codex.tool_name": tc.name || "tool" },
    },
    {
      asType: "tool",
      startTime: new Date(tc.startTime),
      parentSpanContext: parent.otelSpan.spanContext(),
    },
  );
  tool.end(new Date(tc.endTime ?? fallbackEnd));
}

/**
 * Convert a Codex rollout file into Langfuse traces.
 *
 * Top-level turns each become their own trace (grouped into a Langfuse session
 * via the Codex thread id). Subagent rollouts are nested under the spawning
 * turn via `parentObservation`.
 */
export async function convertRollout(
  rolloutFile: string,
  options: {
    config: Config;
    parentObservation?: LangfuseObservation;
    finalizeTurnId?: string;
  },
): Promise<string[]> {
  const { sessionMeta, turns } = parseSession(await loadSession(rolloutFile));
  debugLog(`parsed ${turns.length} turn(s) from ${path.basename(rolloutFile)}`);

  // Subagent rollout: nest everything under the parent turn, no dedup/session wrapping.
  if (options.parentObservation) {
    for (const turn of turns) {
      await emitTurn(turn, sessionMeta, {
        config: options.config,
        rolloutFile,
        parentObservation: options.parentObservation,
      });
    }
    return [];
  }

  const uploaded = await loadUploadedTurnIds(rolloutFile);
  const uploadedTurnIds: string[] = [];
  const attributedChildTurns = await discoverChildTurns(rolloutFile, sessionMeta, turns);

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const parsedTurn = turns[turnIndex];
    const turn =
      !parsedTurn.completed && parsedTurn.turnId === options.finalizeTurnId
        ? { ...parsedTurn, completed: true }
        : parsedTurn;
    if (!turn.completed) {
      debugLog(`skipping in-progress turn ${turn.turnId ?? "(unknown)"} not named by Stop hook`);
      continue;
    }
    if (turn.completed && turn.turnId && uploaded.has(turn.turnId)) {
      continue; // already uploaded in a previous hook invocation
    }

    // Turn numbering stays 1-based over the full rollout (including turns
    // skipped by dedup above) so the derived id is stable across hook runs.
    const seededParent = await seededTraceParent(options.config, sessionMeta, turnIndex + 1);

    await propagateAttributes(
      {
        sessionId: sessionMeta.sessionId,
        traceName: sessionMeta.isSubagentThread ? "Codex Subagent Turn" : "Codex Turn",
        ...(options.config.user_id ? { userId: options.config.user_id } : {}),
        ...(options.config.tags ? { tags: options.config.tags } : {}),
        ...(options.config.metadata ? { metadata: options.config.metadata } : {}),
      },
      async () => {
        await emitTurn(turn, sessionMeta, {
          config: options.config,
          rolloutFile,
          seededParent,
          attributedChildTurns,
        });
      },
    );

    if (turn.turnId) {
      uploaded.add(turn.turnId);
      uploadedTurnIds.push(turn.turnId);
    }
  }

  return uploadedTurnIds;
}
