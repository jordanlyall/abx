# ABX plugin for Cursor and Grok Build

Runs `@artblocks/abx-mcp`, a local stdio MCP server that wraps the `abx` CLI. Tools: capabilities,
doctor, plan, testnet deploy dry runs, unsigned deploy transactions, status, and verify. It never
signs, sends, or broadcasts, and only runs on testnets. See the root README's
[MCP server](../../README.md#mcp-server-artblocksabx-mcp) section for the tool list and safety model.

- Cursor reads `.cursor-plugin/plugin.json` and discovers `mcp.json`.
- Grok Build reads `.grok-plugin/plugin.json`, whose `mcpServers` points at the same `mcp.json`.

Network endpoints: the server itself calls none. The CLI it runs reads the chain through your
configured RPC (or its public fallbacks) and checks npm for updates unless `ABX_NO_UPDATE_CHECK` is
set (the server sets it). Credentials: none required. Signing keys in your environment are hidden
from the CLI process.

This is a different product from the hosted Art Blocks MCP (`io.github.ArtBlocks/mcp`,
mcp.artblocks.io).
