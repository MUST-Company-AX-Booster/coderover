'use strict';
/**
 * @coderover/mcp-offline
 * ──────────────────────────────────────────────────────────────────────────
 * This package exists purely for its dependency tree. It pulls in
 * `@xenova/transformers` and `@coderover/mcp`, which means installing
 * this one package is all a user needs to run `@coderover/mcp` in
 * `--embed offline` mode.
 *
 *   npm install @coderover/mcp-offline
 *
 * After install, `coderover index --embed offline` (and the MCP server
 * in local mode with `CODEROVER_EMBED_MODE=offline`) will find
 * `@xenova/transformers` on the resolution path and use the bundled
 * MiniLM-L6-v2 model for 384-dim sentence embeddings.
 *
 * Why it's a separate package: `@xenova/transformers` pulls in the ONNX
 * runtime (four wasm binaries totalling ~36 MB) plus a transitive
 * `protobufjs <7.5.5` chain with 5 critical CVEs. Remote-mode and
 * openai-embed users never exercise any of that code, so through 0.2.x
 * it shipped as an `optionalDependencies` — which STILL installed on
 * every supported platform because optional builds succeed on
 * mac/linux x64/arm64. Moving it out of the default tree eliminates
 * the CVE surface for users who don't want offline mode.
 *
 * The module exports nothing runtime-callable; the resolution side
 * effect is the point. We export a version string so integration
 * tests and doctor checks can detect presence.
 */

module.exports = {
  version: require('./package.json').version,
};
