import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const [installedRoot, expectedVersion, expectedDigest] = process.argv.slice(2);
if (!installedRoot || !expectedVersion || !expectedDigest) {
  throw new Error("usage: verify-installed-plugin.mjs <installed-root> <version> <sha256>");
}

const readJson = (relativePath) =>
  JSON.parse(readFileSync(path.join(installedRoot, relativePath), "utf8"));
const manifest = readJson(".codex-plugin/plugin.json");
const hooks = readJson("hooks/hooks.json");
const bundle = readFileSync(path.join(installedRoot, "dist/index.mjs"));
const actualDigest = createHash("sha256").update(bundle).digest("hex");
const hookIdentity = hooks.hooks?.Stop?.[0]?.hooks?.[0]?.command;

if (manifest.version !== expectedVersion) {
  throw new Error(`installed version ${manifest.version} does not match ${expectedVersion}`);
}
if (actualDigest !== expectedDigest) {
  throw new Error(`installed bundle digest ${actualDigest} does not match ${expectedDigest}`);
}
if (hookIdentity !== 'node "${PLUGIN_ROOT}/dist/index.mjs"') {
  throw new Error(`unexpected installed hook identity: ${hookIdentity}`);
}

process.stdout.write(
  `${JSON.stringify({ version: manifest.version, bundleSha256: actualDigest, hookIdentity })}\n`,
);
