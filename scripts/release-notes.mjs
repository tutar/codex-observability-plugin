import { verifyRelease } from "./verify-release.mjs";

const release = verifyRelease();
const commit = process.env.GITHUB_SHA ?? process.argv[2];
if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error("release notes require GITHUB_SHA or a full 40-character Commit argument");
}
const changes = release.changesFromUpstream.map((change) => `- ${change}`).join("\n");

process.stdout.write(`# Tracing plugin ${release.version}

Immutable release of the maintained Langfuse tracing plugin fork.

## Release identity

- Commit: \`${commit}\`
- Bundle SHA-256: \`${release.bundleSha256}\`
- Hook identity: \`${release.hookIdentity}\`
- Codex compatibility: \`${release.codexCompatibility}\`

## Changes from upstream

${changes}

Upstream remains ${release.upstreamRepository}; this fork owns the build, packaging, verification, and release lifecycle for this artifact.

## Verified installation

CI installed and checked this plugin through the standard Codex Marketplace flow using both the \`${release.version}\` tag and the full commit above. The installed Manifest version, bundle digest, and Hook identity matched this record.
`);
