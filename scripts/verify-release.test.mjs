import { describe, expect, it } from "vitest";
import { verifyRelease } from "./verify-release.mjs";

describe("release contract", () => {
  it("derives every release field from the plugin manifest", () => {
    const result = verifyRelease();

    expect(result.version).toBe("0.1.2");
    expect(result.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.hookIdentity).toBe('node "${PLUGIN_ROOT}/dist/index.mjs"');
    expect(result.codexCompatibility).toBe("0.153.4");
    expect(result.repository).toBe("https://github.com/tutar/codex-observability-plugin");
  });
});
