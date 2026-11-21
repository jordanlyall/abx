# ABX

ABX is an open protocol and toolkit for programmable, durable digital objects on the blockchain.
An ABX project can be artwork, a shared resource, a record, or a financial or community mechanism:
anything whose data, state, permissions, and behavior matter as much as how it looks. ABX objects can
also act: a mint, transfer, or setting change can launch a token, trade, or call any other contract.
The X is for anything; see [what you can build](https://docs.abx.io/docs/using-abx/what-you-can-build).

ABX is built for coding agents. Describe what you want to make, and the ABX skill teaches your agent
to plan, deploy, host, and operate it with the `abx` CLI, showing each plan and waiting for your
approval before anything is written onchain. The CLI and SDK work without an agent too.

Under the hood, ABX projects are standard ERC-721 and ERC-1155 contracts, so they work with existing
wallets, marketplaces, and indexers. ABX adds what those standards leave out: content stored onchain
or offchain, metadata computed by Solidity renderers or locked in place, typed parameters that can
change after mint, hooks that run contract actions, shared sale contracts, and an event log that
anyone can replay to rebuild a project.

This monorepo contains the Solidity contracts, TypeScript SDK, command-line interface, reference
services, agent skill, and public documentation.

ABX is adding EVM networks. See the current
[network table](https://docs.abx.io/docs/reference/deployments) before deploying.

## Quickstart

Give this prompt to your coding agent:

> Read https://docs.abx.io/docs/using-abx/quickstart, install the ABX skill, and help me launch ⟨describe your project⟩.

Or install the CLI directly:

```bash
npm install -g @artblocks/abx-cli
abx doctor
```

The complete user guide, protocol reference, deployment addresses, and API documentation are at
[docs.abx.io](https://docs.abx.io).

## MCP server (`@artblocks/abx-mcp`)

`@artblocks/abx-mcp` is a local stdio MCP server, named `abx`, that wraps the `abx` CLI for agents
in MCP hosts. It is separate from the hosted Art Blocks MCP (`io.github.ArtBlocks/mcp` at
mcp.artblocks.io), which covers the Art Blocks platform rather than the ABX CLI.

### Install

Any MCP host that runs stdio servers:

```json
{
  "mcpServers": {
    "abx": {"command": "npx", "args": ["-y", "@artblocks/abx-mcp"]}
  }
}
```

Plugin manifests for Cursor (`.cursor-plugin/plugin.json`) and Grok Build (`.grok-plugin/plugin.json`)
live in [`plugins/abx/`](plugins/abx). To try the Cursor plugin locally, link that folder into
`~/.cursor/plugins/local/abx` and reload Cursor. Run the server from a working tree with
`node --import tsx packages/mcp/src/bin.ts`.

### Tools

| Tool | Runs | Returns |
| --- | --- | --- |
| `abx_capabilities` | `abx capabilities --json` | Networks, signing lanes, deployment lanes, extension routes, unsupported cases |
| `abx_doctor` | `abx doctor` | The environment checklist as text (doctor has no JSON mode) |
| `abx_plan` | `abx capabilities --json` | The deployment lane for a 1/1, series, or code project, and the dry-run call to make next |
| `abx_deploy_dry_run` | `abx deploy`, `deploy-series`, or `deploy-code` with `--dry-run --json` | The structured deploy plan; nothing is sent or stored |
| `abx_deploy_unsigned` | The same commands with `--unsigned --json` | Unsigned transactions (`to`, `data`, `value`, `chainId`) for the user to sign in their own wallet |
| `abx_status` | `abx state <address> --json` | The project's on-chain state: owner, supply, paused, minter, payee, royalty, renderer |
| `abx_verify` | `abx verify <address> --json` | Served bytes checked against the on-chain commitment (the project must be added to the node first) |

Each tool takes an optional `network` (testnet key, default `base-sepolia`) and an absolute
`projectDir` the CLI runs in. The deploy tools require `projectDir`, and it cannot be `/` or your home
folder; the others default to the server's working directory.

### Safety model

- **Nothing signs, sends, or broadcasts.** The server never passes `--send`, `--sign`,
  `--sponsor`/`--embedded`, `--yes`, or `--confirm`. Deploy tools always pass exactly one of
  `--dry-run` or `--unsigned`, plus `--json`, and a final check refuses any argv that breaks this.
- **No secrets as arguments.** No tool accepts a private key, mnemonic, or RPC URL. Free-text fields
  that look like one are refused. RPC endpoints come from your environment, as with the CLI.
- **Keys are hidden from the CLI.** `ABX_DEPLOYER_PK`, `ARWEAVE_JWK`, and `ABX_ARWEAVE_ETH_SIGNER_KEY`
  are set to empty in the child process, which also stops the CLI's `.env` loader from filling them.
  Storage is forced to the local `fs` backend, so nothing is uploaded.
- **Testnets only.** The server sets `ABX_CHAIN` on every run, overriding any inherited value or
  `.env` entry. Mainnet names and chain IDs are refused with an explanation.
- **Excluded commands.** Mint, buy, transfer, lock, storage top-up, backup-key, and every other
  owner write are not reachable: the server only spawns `capabilities`, `doctor`, `deploy`,
  `deploy-series`, `deploy-code`, `state`, and `verify`.
- **No injection.** The CLI is started with `spawn` and an argv array, never a shell. Every flag is
  passed as `--key=value`, so a value such as `--send` stays a value. File inputs must resolve
  inside `projectDir`, symlinks included.
- **Nothing secret is echoed.** Output is scrubbed of the values of secret-named environment
  variables (from the process and the project's `.env`) and of URL credentials before it is
  returned. The server logs nothing.

## Repository

| Path | Contents |
| --- | --- |
| [`contracts/`](contracts) | Foundry project: token implementations, factories, renderers, minters, scripts, and tests |
| [`packages/sdk/`](packages/sdk) | Provider-neutral TypeScript SDK |
| [`packages/cli/`](packages/cli) | `abx` CLI and the bundled end-user agent skill |
| [`packages/mcp/`](packages/mcp) | `@artblocks/abx-mcp`, a local stdio MCP server over the CLI (testnet, never signs) |
| [`plugins/abx/`](plugins/abx) | Cursor and Grok Build plugin manifests for the MCP server |
| [`packages/indexer/`](packages/indexer) | Event-based reference indexer |
| [`packages/token-api/`](packages/token-api) | Reference metadata and control-plane service |
| [`packages/storage/`](packages/storage) | Filesystem, S3-compatible, and IPFS storage adapters, plus the Arweave backend's config/identity logic |
| [`packages/storage-arweave/`](packages/storage-arweave) | Optional ArDrive Turbo uploader for Arweave |
| [`packages/effects/`](packages/effects) | Reference rendering/effects runner |
| [`site/`](site) | Source for the public documentation site |
| [`contributor/`](contributor) | Contributor-only distribution tests and cold-agent regression suite |
| [`fixtures/`](fixtures) | Shared media and code inputs for CLI and cold-agent regression tests |

The public docs site is the authoritative prose reference. Contract behavior is ultimately defined by
the deployed bytecode and source; package behavior is defined by source and tests. The repository does
not maintain a second set of narrative specifications.

## Development

Requirements:

- Node.js 22.13 or newer
- pnpm 10 (pinned by `packageManager`)
- Foundry 1.4.3 for contract development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test

cd contracts
forge soldeer install
forge test
```

Run the working-tree CLI with `pnpm abx …`; a bare `abx` may resolve to a globally installed
release. See [CONTRIBUTING.md](CONTRIBUTING.md) before changing contracts, generated ABIs,
documentation, or published packages.

## Packages and releases

The `@artblocks/abx-*` packages are published independently to npm. Changesets describe user-visible
package changes, and GitHub Actions creates version PRs and publishes through npm trusted publishing.
Package changelogs begin with the public source release.

## Security

See [Third-party audits](site/content/docs/reference/audits/index.mdx) for a summary of reports,
their scope and quality, and the maintainer response.

Do not report vulnerabilities or credentials in a public issue. See [SECURITY.md](SECURITY.md) for the
private reporting path and supported-version policy.

## License

Original TypeScript packages, documentation, tooling, and code fixtures are MIT licensed. Four
OpenMoji media fixtures are CC BY-SA 4.0. Solidity contracts are LGPL-3.0-only unless a file's SPDX
header says otherwise. See
[LICENSES.md](LICENSES.md) for the exact scope and third-party notice guidance.
