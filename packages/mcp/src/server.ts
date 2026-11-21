/**
 * The ABX MCP server: tool definitions. Each tool validates its input with zod, builds an argv
 * through `args.ts` (which runs the guards), spawns the CLI through `runCli`, and returns the
 * parsed, redacted output.
 */
import {readFileSync} from 'node:fs';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {
  addressInput,
  buildCapabilitiesArgv,
  buildDeployArgv,
  buildDoctorArgv,
  buildStateArgv,
  buildVerifyArgv,
  deployInput,
  planInput,
  projectInput,
  resolveDeployProjectDir,
  resolveProjectDir,
  type DeployArgs,
} from './args.js';
import {runCli, type CliLauncher, type CliResult} from './cli.js';
import {assertTestnet, DEFAULT_NETWORK, GuardError} from './guards.js';

export const SERVER_NAME = 'abx';
/** The package version, read at runtime (src/ and dist/ both sit one level below package.json). */
export const SERVER_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const TOOL_NAMES = [
  'abx_capabilities',
  'abx_doctor',
  'abx_plan',
  'abx_deploy_dry_run',
  'abx_deploy_unsigned',
  'abx_status',
  'abx_verify',
] as const;

export interface ServerOptions {
  /** Override how the CLI is started (tests). */
  launcher?: CliLauncher;
}

const READ_ONLY = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true} as const;

function errorResult(message: string): CallToolResult {
  return {isError: true, content: [{type: 'text', text: message}]};
}

/** Shape a CLI run into a tool result. JSON output goes in structuredContent and as text. */
function cliResult(result: CliResult, extra: Record<string, unknown> = {}): CallToolResult {
  if (result.timedOut) return errorResult(`the abx CLI timed out.\n${result.stderr}`);
  if (result.json === undefined) {
    const text = [result.stdout, result.stderr].filter(Boolean).join('\n\n');
    return {isError: result.exitCode !== 0, content: [{type: 'text', text: text || `abx exited with code ${result.exitCode}`}]};
  }
  const payload = {...extra, exitCode: result.exitCode, result: result.json, notes: result.stderr || undefined};
  return {
    // A verify mismatch exits non-zero with valid JSON: that is a finding, reported as data.
    isError: false,
    structuredContent: payload,
    content: [{type: 'text', text: JSON.stringify(payload, null, 2)}],
  };
}

/** Run a tool body, turning guard refusals and spawn failures into clear tool errors. */
async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GuardError) return errorResult(`refused: ${err.message}`);
    // zod errors from a positional address parse, or a spawn failure. No env, keys, or paths of secrets here.
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

const SAFETY_NOTE =
  'Testnet only. Never signs, sends, or broadcasts; never accepts keys, mnemonics, or RPC URLs.';

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer({name: SERVER_NAME, version: SERVER_VERSION});
  const launcher = options.launcher;

  server.registerTool(
    'abx_capabilities',
    {
      title: 'ABX capabilities',
      description: `What the ABX CLI can do: networks, signing lanes, deployment lanes, extension routes, and what is unsupported (abx capabilities --json). ${SAFETY_NOTE}`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      guarded(async () =>
        cliResult(await runCli(buildCapabilitiesArgv(), {network: DEFAULT_NETWORK, cwd: process.cwd(), launcher, timeoutMs: 60_000})),
      ),
  );

  server.registerTool(
    'abx_doctor',
    {
      title: 'ABX doctor',
      description:
        `Check the local environment for ABX: CLI and skill version, RPC reachability, canonical contracts, storage (abx doctor). ` +
        `Returns the checklist as text (doctor has no --json). Signing keys are hidden from the child process, so it reports no hot key. ${SAFETY_NOTE}`,
      inputSchema: projectInput,
      annotations: READ_ONLY,
    },
    async ({network, projectDir}) =>
      guarded(async () =>
        cliResult(
          await runCli(buildDoctorArgv(), {network: assertTestnet(network), cwd: resolveProjectDir(projectDir), launcher, timeoutMs: 90_000}),
        ),
      ),
  );

  server.registerTool(
    'abx_plan',
    {
      title: 'ABX plan',
      description:
        'Plan an ABX project before deploying: given the kind of artifact, returns the matching deployment lane from the capability contract ' +
        '(contract type, required inputs, supported and unsupported options), the CLI command, and the abx_deploy_dry_run call to make next. ' +
        `Reads abx capabilities --json; sends nothing. ${SAFETY_NOTE}`,
      inputSchema: planInput,
      annotations: READ_ONLY,
    },
    async ({artifact, edition}) =>
      guarded(async () => {
        const run = await runCli(buildCapabilitiesArgv(), {network: DEFAULT_NETWORK, cwd: process.cwd(), launcher, timeoutMs: 60_000});
        if (run.json === undefined) return cliResult(run);
        return planFromCapabilities(run.json, artifact, edition ?? false);
      }),
  );

  const deployDescription = (lane: string) =>
    `Runs abx deploy, deploy-series, or deploy-code with ${lane} --json on a testnet. ` +
    'File inputs are paths inside projectDir. "for" is the owner and signer address. ' +
    'Storage is forced to the local fs backend (nothing is uploaded).';

  server.registerTool(
    'abx_deploy_dry_run',
    {
      title: 'ABX deploy dry run',
      description:
        `${deployDescription('--dry-run')} Returns the structured deploy plan (roles, custody, mint plan, transaction count, warnings). ` +
        `Nothing is sent or stored. ${SAFETY_NOTE}`,
      inputSchema: deployInput,
      annotations: {...READ_ONLY, idempotentHint: false},
    },
    async (input) => guarded(async () => runDeploy(input as DeployArgs, 'dry-run', launcher)),
  );

  server.registerTool(
    'abx_deploy_unsigned',
    {
      title: 'ABX deploy, unsigned transactions',
      description:
        `${deployDescription('--unsigned')} Returns unsigned transactions (to, data, value, chainId) for the user to review and sign in their own wallet. ` +
        `The server never signs or broadcasts them. Content bytes are written to the project's local .abx-self-host store. ${SAFETY_NOTE}`,
      inputSchema: deployInput,
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
    },
    async (input) => guarded(async () => runDeploy(input as DeployArgs, 'unsigned', launcher)),
  );

  server.registerTool(
    'abx_status',
    {
      title: 'ABX project status',
      description: `On-chain snapshot of a deployed project: owner, supply, paused, minter, payee, royalty, renderer (abx state <address> --json). ${SAFETY_NOTE}`,
      inputSchema: addressInput,
      annotations: READ_ONLY,
    },
    async ({address, network, projectDir}) =>
      guarded(async () =>
        cliResult(
          await runCli(buildStateArgv(address), {network: assertTestnet(network), cwd: resolveProjectDir(projectDir), launcher, timeoutMs: 90_000}),
        ),
      ),
  );

  server.registerTool(
    'abx_verify',
    {
      title: 'ABX verify',
      description:
        'Re-hash the served bytes of a project against its on-chain commitment (abx verify <address> --json). ' +
        `The project must be registered in projectDir first (abx add). A mismatch is returned as data with ok=false. ${SAFETY_NOTE}`,
      inputSchema: addressInput,
      annotations: READ_ONLY,
    },
    async ({address, network, projectDir}) =>
      guarded(async () =>
        cliResult(
          await runCli(buildVerifyArgv(address), {network: assertTestnet(network), cwd: resolveProjectDir(projectDir), launcher, timeoutMs: 120_000}),
        ),
      ),
  );

  return server;
}

async function runDeploy(input: DeployArgs, lane: 'dry-run' | 'unsigned', launcher?: CliLauncher): Promise<CallToolResult> {
  const network = assertTestnet(input.network);
  const cwd = resolveDeployProjectDir(input.projectDir);
  const argv = buildDeployArgv(input, lane, cwd);
  const result = await runCli(argv, {network, cwd, lane, launcher, timeoutMs: 180_000});
  const extra =
    lane === 'unsigned'
      ? {network, lane, signWith: 'Review each transaction, then sign and broadcast it yourself in your own wallet. This server never signs or sends.'}
      : {
          network,
          lane,
          note: 'result.plan.lane is the lane a plain CLI run would default to. Through this server the next step is abx_deploy_unsigned; nothing here signs or sends.',
        };
  return cliResult(result, extra);
}

type Capabilities = {
  deploymentCommands?: Record<string, {artifact?: string; unique?: unknown; edition?: unknown}>;
  signingLanes?: Record<string, unknown>;
  unsupportedToday?: unknown;
};

const LANE_KEY = {'1of1': 'deploy', series: 'deploySeries', code: 'deployCode'} as const;
const LANE_COMMAND = {'1of1': 'deploy', series: 'deploy-series', code: 'deploy-code'} as const;
const LANE_INPUT = {'1of1': 'image', series: 'dir', code: 'script or codeDir'} as const;

/** Exported for tests: derive the plan for one artifact kind from `abx capabilities --json`. */
export function planFromCapabilities(capabilities: unknown, artifact: '1of1' | 'series' | 'code', edition: boolean): CallToolResult {
  const caps = capabilities as Capabilities;
  const lane = caps.deploymentCommands?.[LANE_KEY[artifact]];
  if (!lane) return errorResult(`the CLI's capability contract has no lane for ${artifact}; run abx_capabilities to inspect it.`);
  const shape = edition ? lane.edition : lane.unique;
  const plan = {
    artifact,
    edition,
    cliCommand: `abx ${LANE_COMMAND[artifact]}`,
    describes: lane.artifact,
    lane: shape,
    nextStep: {
      tool: 'abx_deploy_dry_run',
      arguments: {
        command: LANE_COMMAND[artifact],
        for: '<owner address>',
        name: '<collection name>',
        symbol: '<SYMBOL>',
        [LANE_INPUT[artifact].split(' ')[0]]: `<${LANE_INPUT[artifact]} inside projectDir>`,
        ...(edition ? {copies: '<n or "open">'} : {}),
      },
      then: 'abx_deploy_unsigned with the same arguments, to get transactions the user signs in their own wallet.',
    },
    signingLanesThisServerUses: ['--dry-run', '--unsigned'],
    unsupportedToday: caps.unsupportedToday,
  };
  return {structuredContent: plan, content: [{type: 'text', text: JSON.stringify(plan, null, 2)}]};
}
