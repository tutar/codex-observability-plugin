import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const [installedRoot, expectedVersion, expectedDigest, expectedHookIdentity] =
  process.argv.slice(2);
if (!installedRoot || !expectedVersion || !expectedDigest || !expectedHookIdentity) {
  throw new Error(
    "usage: verify-installed-plugin.mjs <installed-root> <version> <sha256> <hook-identity>",
  );
}

const readJson = (relativePath) =>
  JSON.parse(readFileSync(path.join(installedRoot, relativePath), "utf8"));
const manifest = readJson(".codex-plugin/plugin.json");
if (manifest.hooks !== "./hooks/hooks.json") {
  throw new Error(`unexpected installed Manifest hooks path: ${manifest.hooks}`);
}
const hooks = readJson(manifest.hooks);
const bundle = readFileSync(path.join(installedRoot, "dist/index.mjs"));
const actualDigest = createHash("sha256").update(bundle).digest("hex");
const hookIdentity = hooks.hooks?.Stop?.[0]?.hooks?.[0]?.command;

if (manifest.version !== expectedVersion) {
  throw new Error(`installed version ${manifest.version} does not match ${expectedVersion}`);
}
if (actualDigest !== expectedDigest) {
  throw new Error(`installed bundle digest ${actualDigest} does not match ${expectedDigest}`);
}
if (hookIdentity !== expectedHookIdentity) {
  throw new Error(`installed hook identity ${hookIdentity} does not match ${expectedHookIdentity}`);
}

process.stdout.write(
  `${JSON.stringify({ version: manifest.version, bundleSha256: actualDigest, hookIdentity })}\n`,
);
