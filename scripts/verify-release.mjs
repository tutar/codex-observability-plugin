import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const paths = {
  workspace: "package.json",
  package: "plugins/tracing/package.json",
  manifest: "plugins/tracing/.codex-plugin/plugin.json",
  marketplace: ".agents/plugins/marketplace.json",
  hooks: "plugins/tracing/hooks/hooks.json",
  bundle: "plugins/tracing/dist/index.mjs",
  release: "release/metadata.json",
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const repository = "https://github.com/tutar/codex-observability-plugin";

export function verifyRelease() {
  const workspace = readJson(paths.workspace);
  const pluginPackage = readJson(paths.package);
  const manifest = readJson(paths.manifest);
  const marketplace = readJson(paths.marketplace);
  const hooks = readJson(paths.hooks);
  const release = readJson(paths.release);
  const bundle = readFileSync(paths.bundle);
  const hookIdentity = hooks.hooks?.Stop?.[0]?.hooks?.[0]?.command;
  const marketplacePlugin = marketplace.plugins?.find(({ name }) => name === manifest.name);
  const failures = [];
  const requireEqual = (label, actual, expected) => {
    if (actual !== expected) failures.push(`${label}: expected ${expected}, received ${actual}`);
  };

  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    failures.push(`manifest version is not strict semver: ${manifest.version}`);
  }
  requireEqual("workspace version", workspace.version, manifest.version);
  requireEqual("plugin package version", pluginPackage.version, manifest.version);
  requireEqual("workspace repository", workspace.repository?.url, `${repository}.git`);
  requireEqual("workspace homepage", workspace.homepage, `${repository}#readme`);
  requireEqual("workspace bugs", workspace.bugs?.url, `${repository}/issues`);
  requireEqual("plugin package repository", pluginPackage.repository?.url, `git+${repository}.git`);
  requireEqual("plugin package homepage", pluginPackage.homepage, `${repository}#readme`);
  requireEqual("plugin package bugs", pluginPackage.bugs?.url, `${repository}/issues`);
  requireEqual("manifest repository", manifest.repository, repository);
  requireEqual("manifest homepage", manifest.homepage, `${repository}#readme`);
  requireEqual("manifest author", manifest.author?.name, "Langfuse");
  requireEqual("marketplace source", marketplacePlugin?.source?.source, "local");
  requireEqual("marketplace path", marketplacePlugin?.source?.path, "./plugins/tracing");
  requireEqual("hook identity", hookIdentity, 'node "${PLUGIN_ROOT}/dist/index.mjs"');

  if (bundle.length === 0) failures.push("bundle is empty");
  if (failures.length > 0) {
    throw new Error(`Release contract failed:\n- ${failures.join("\n- ")}`);
  }

  return {
    version: manifest.version,
    bundleSha256: createHash("sha256").update(bundle).digest("hex"),
    hookIdentity,
    codexCompatibility: release.codexCompatibility,
    repository,
    upstreamRepository: release.upstreamRepository,
    changesFromUpstream: release.changesFromUpstream,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyRelease();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      [
        `release ${result.version} verified`,
        `bundle sha256: ${result.bundleSha256}`,
        `hook: ${result.hookIdentity}`,
        `Codex: ${result.codexCompatibility}`,
      ].join("\n") + "\n",
    );
  }
}
