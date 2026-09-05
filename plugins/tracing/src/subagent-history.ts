/** Codex rollout ordinal where a subagent's projected local history begins. */
export function isValidHistoryBoundary(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
