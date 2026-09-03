import { getConfig } from "./config.js";
import { setupInstrumentation } from "./instrumentation.js";
import { TERMINAL_TURN_TIMEOUT_MS, waitForTerminalTurn } from "./terminal-turn.js";
import { convertRollout } from "./trace.js";
import type { HookInput } from "./types.js";
import { debugLog, readStdin, setDebug } from "./utils.js";

let failOnError = process.env.LANGFUSE_CODEX_FAIL_ON_ERROR === "true";

/**
 * Entry point for the Codex `Stop` hook.
 *
 * Codex pipes a JSON payload to stdin after every turn. We resolve config,
 * bail out unless tracing is explicitly enabled, then convert the rollout
 * transcript into Langfuse traces.
 *
 * The hook fails open: any error is logged (in debug mode) and swallowed so a
 * tracing problem never blocks the Codex session. Set
 * `LANGFUSE_CODEX_FAIL_ON_ERROR=true` while testing if you want Codex to report
 * hook failures instead.
 */
export async function runHook(): Promise<void> {
  let hookInput: HookInput;
  try {
    hookInput = await readStdin<HookInput>();
  } catch (error) {
    // No usable payload — nothing we can do.
    return;
  }

  const config = await getConfig();
  setDebug(config.debug);
  failOnError = config.fail_on_error;

  if (!config.enabled) {
    debugLog("tracing disabled (set TRACE_TO_LANGFUSE=true to enable)");
    return;
  }
  if (!config.public_key || !config.secret_key) {
    debugLog("missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY; skipping");
    return;
  }
  if (!hookInput.transcript_path) {
    debugLog("hook payload missing transcript_path; skipping");
    return;
  }

  if (hookInput.turn_id) {
    const terminal = await waitForTerminalTurn(hookInput.transcript_path, hookInput.turn_id);
    if (!terminal) {
      const message =
        `timed out after ${TERMINAL_TURN_TIMEOUT_MS}ms waiting for terminal event ` +
        `for turn ${hookInput.turn_id} in ${hookInput.transcript_path}; no trace was uploaded; ` +
        "replay the hook after the rollout is complete";
      // This must be visible even when debug logging is disabled: otherwise a
      // fail-open timeout is indistinguishable from a successful upload.
      // eslint-disable-next-line no-console
      console.error(`[langfuse-codex] ${message}`);
      if (config.fail_on_error) throw new Error(message);
      return;
    }
  }

  const instrumentation = setupInstrumentation(config);
  try {
    await convertRollout(hookInput.transcript_path, { config });
  } catch (error) {
    debugLog("failed to convert rollout:", error);
    if (config.fail_on_error) throw error;
  } finally {
    try {
      await instrumentation.shutdown();
    } catch (error) {
      debugLog("error during flush/shutdown:", error);
      if (config.fail_on_error) throw error;
    }
  }
}

runHook().catch((error) => {
  // Last-resort guard: fail open unless explicitly requested for testing.
  if (process.env.LANGFUSE_CODEX_DEBUG === "true") {
    // eslint-disable-next-line no-console
    console.error("[langfuse-codex] fatal:", error);
  }
  if (failOnError) {
    process.exitCode = 1;
  }
});
