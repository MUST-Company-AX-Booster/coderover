# @coderover/mcp-offline

Offline embeddings support for [`@coderover/mcp`](https://www.npmjs.com/package/@coderover/mcp). One install, nothing to configure.

```sh
npm install @coderover/mcp-offline
```

This pulls in both `@coderover/mcp` (the MCP server + CLI) and `@xenova/transformers` (the Transformers.js runtime), then enables:

```sh
coderover index ./my-repo --embed offline
CODEROVER_EMBED_MODE=offline coderover   # server picks up the env var
```

Under the hood: [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) — a 384-dim quantized ONNX model (~30 MB download on first use, cached under `~/.coderover/models/`). After the initial download the embedder runs fully offline — no network, no API keys.

## Why a separate package?

`@xenova/transformers` brings in the ONNX runtime: four `ort-wasm-*.wasm` binaries totalling ~36 MB, plus a transitive `protobufjs <7.5.5` chain flagged with 5 critical CVEs. Remote-mode and openai-embed users never touch any of that. Through 0.2.x it shipped as an `optionalDependencies` of `@coderover/mcp`, but optional installs succeed on every supported platform in practice, so it was pure unused weight on the vast majority of installs.

Splitting it out means:

- **Default `@coderover/mcp` install drops ~45 MB** and zero criticals.
- **Users who want offline mode install one package, get everything.**
- **Supply chain audits** for teams that don't use offline mode show zero CVE-tainted deps from this package.

## What this package exports

Effectively nothing runtime-callable. The purpose is the dependency graph: having `@coderover/mcp-offline` installed means `@xenova/transformers` is on the resolution path, and `@coderover/mcp`'s lazy `require('@xenova/transformers')` succeeds.

```js
// If you ever need it:
const { version } = require('@coderover/mcp-offline');
```

That's the whole surface. Everything you'd actually call lives in `@coderover/mcp`.

## Compatibility

| `@coderover/mcp-offline` | `@coderover/mcp` | Notes                                                                 |
| ------------------------ | ---------------- | --------------------------------------------------------------------- |
| `0.1.x`                  | `^0.3.0`         | First release. Before 0.3.0, transformers was bundled via optionalDep. |

## License

MIT — same as `@coderover/mcp`.
