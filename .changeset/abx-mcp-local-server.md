---
'@artblocks/abx-mcp': minor
---

New package: a local stdio MCP server (`abx-mcp`, server name `abx`) that wraps the `abx` CLI. New for MCP hosts; no change for existing CLI or SDK consumers. Tools: capabilities, doctor, plan, deploy dry runs, unsigned deploy transactions, status, and verify, all testnet-only. The server never signs, sends, or broadcasts, and never accepts keys, mnemonics, or RPC URLs.
