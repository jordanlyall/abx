import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {planFromCapabilities, TOOL_NAMES} from '../src/server.ts';

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', BIN],
    env: {...(process.env as Record<string, string>), ABX_NO_UPDATE_CHECK: '1'},
    stderr: 'pipe',
  });
  const client = new Client({name: 'abx-mcp-smoke', version: '0.0.0'});
  await client.connect(transport);
  return client;
}

test('smoke: the server lists exactly the ABX tools over stdio', async () => {
  const client = await connect();
  try {
    assert.equal(client.getServerVersion()?.name, 'abx');
    const {tools} = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
    for (const tool of tools) {
      assert.doesNotMatch(tool.name, /mint|buy|transfer|lock|topup|backup|_send|_sign\b|broadcast/);
      const props = Object.keys((tool.inputSchema as {properties?: object}).properties ?? {});
      for (const forbidden of ['privateKey', 'pk', 'mnemonic', 'rpc', 'rpcUrl', 'send', 'sign']) {
        assert.equal(props.includes(forbidden), false, `${tool.name} must not accept ${forbidden}`);
      }
    }

    // Real round trip through the CLI: capabilities is local and needs no network or key.
    const caps = await client.callTool({name: 'abx_capabilities', arguments: {}});
    assert.equal(caps.isError, false);
    const result = (caps.structuredContent as {result: {schemaVersion: number; signingLanes: object}}).result;
    assert.equal(typeof result.schemaVersion, 'number');
    assert.ok('unsigned' in result.signingLanes);

    // A mainnet is refused before anything is spawned.
    const refused = await client.callTool({
      name: 'abx_deploy_dry_run',
      arguments: {command: 'deploy', network: 'base', projectDir: process.cwd(), for: '0x000000000000000000000000000000000000dEaD', image: 'x.svg'},
    });
    assert.equal(refused.isError, true);
    assert.match((refused.content as Array<{text: string}>)[0].text, /refused: network "base" is a mainnet/);
  } finally {
    await client.close();
  }
});

test('abx_plan derives the lane from the capability contract', () => {
  const caps = {
    deploymentCommands: {
      deploySeries: {artifact: 'a folder', unique: {contract: 'SeriesImage (ERC-721)'}, edition: {contract: 'EditionImage (ERC-1155)'}},
    },
    unsupportedToday: ['x'],
  };
  const plan = planFromCapabilities(caps, 'series', true).structuredContent as {
    cliCommand: string;
    lane: {contract: string};
    nextStep: {arguments: Record<string, unknown>};
  };
  assert.equal(plan.cliCommand, 'abx deploy-series');
  assert.equal(plan.lane.contract, 'EditionImage (ERC-1155)');
  assert.equal(plan.nextStep.arguments.command, 'deploy-series');
  assert.ok('copies' in plan.nextStep.arguments);
  assert.equal(planFromCapabilities({}, 'code', false).isError, true);
});
