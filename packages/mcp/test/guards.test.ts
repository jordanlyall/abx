import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  ALLOWED_COMMANDS,
  assertNoSecretLikeValue,
  assertSafeArgv,
  assertTestnet,
  DEFAULT_NETWORK,
  EXCLUDED_COMMANDS,
  GuardError,
  MAINNET_ALIASES,
  TESTNET_KEYS,
} from '../src/guards.ts';

const registry = JSON.parse(readFileSync(new URL('../../sdk/src/chain-support.json', import.meta.url), 'utf8')) as {
  chains: Array<{key: string; chainId: number; environment: string}>;
};

test('testnet list matches the SDK chain-support registry exactly', () => {
  const testnets = registry.chains.filter((c) => c.environment === 'testnet').map((c) => c.key).sort();
  assert.deepEqual([...TESTNET_KEYS].sort(), testnets);
});

test('every production chain key and chain id is refused as a mainnet', () => {
  for (const chain of registry.chains.filter((c) => c.environment !== 'testnet')) {
    assert.ok(MAINNET_ALIASES.has(chain.key), `${chain.key} missing from MAINNET_ALIASES`);
    assert.ok(MAINNET_ALIASES.has(String(chain.chainId)), `${chain.chainId} missing from MAINNET_ALIASES`);
    assert.throws(() => assertTestnet(chain.key), (e: Error) => e instanceof GuardError && /is a mainnet/.test(e.message));
  }
});

test('assertTestnet accepts testnets, defaults, and normalizes case', () => {
  assert.equal(assertTestnet(undefined), DEFAULT_NETWORK);
  assert.equal(assertTestnet(''), DEFAULT_NETWORK);
  assert.equal(assertTestnet('Sepolia'), 'sepolia');
  for (const key of TESTNET_KEYS) assert.equal(assertTestnet(key), key);
});

test('mainnet spellings get a clear refusal, unknown networks a different one', () => {
  for (const name of ['mainnet', 'ETH', 'ethereum', 'base', 'arbitrum-one', '1']) {
    assert.throws(() => assertTestnet(name), /is a mainnet\. The ABX MCP server only runs on testnets/);
  }
  assert.throws(() => assertTestnet('goerli'), /unknown network "goerli"/);
});

test('signing and sending flags are refused on every command', () => {
  for (const flag of ['send', 'sign', 'sponsor', 'embedded', 'sign-url-file', 'yes', 'confirm', 'port', 'rpc', 'private-key', 'mnemonic', 'backend']) {
    assert.throws(() => assertSafeArgv(['deploy', `--${flag}=true`, '--dry-run=true', '--json=true'], 'dry-run'), /never passed/);
    assert.throws(() => assertSafeArgv(['capabilities', `--${flag}=x`, '--json=true']), /never passed/);
  }
  // Case does not help.
  assert.throws(() => assertSafeArgv(['capabilities', '--SEND=true']), /never passed/);
});

test('bare flags are refused: a value can never be read as a second flag', () => {
  assert.throws(() => assertSafeArgv(['capabilities', '--json']), /--key=value/);
});

test('value-moving, locking, and key commands are never runnable', () => {
  for (const cmd of ['mint', 'minter', 'transfer', 'lock-script', 'lock-uri', 'lock-field', 'lock-dependencies', 'lock-param-hooks', 'storage', 'auth', 'demo', 'set-admin', 'deploy-contract']) {
    assert.equal(ALLOWED_COMMANDS.has(cmd), false, `${cmd} must not be allowed`);
    assert.throws(() => assertSafeArgv([cmd, '--json=true']), /not available/);
  }
  for (const cmd of EXCLUDED_COMMANDS) assert.equal(ALLOWED_COMMANDS.has(cmd), false);
});

test('deploy commands must name exactly one lane and --json', () => {
  assert.throws(() => assertSafeArgv(['deploy', '--json=true']), /explicit lane/);
  assert.throws(() => assertSafeArgv(['deploy', '--dry-run=true'], 'dry-run'), /--json/);
  assert.throws(() => assertSafeArgv(['deploy', '--unsigned=true', '--json=true'], 'dry-run'), /dry run must pass --dry-run/);
  assert.throws(() => assertSafeArgv(['deploy', '--dry-run=true', '--unsigned=true', '--json=true'], 'unsigned'), /unsigned run/);
  assertSafeArgv(['deploy', '--dry-run=true', '--json=true'], 'dry-run');
  assertSafeArgv(['deploy-code', '--unsigned=true', '--json=true'], 'unsigned');
});

test('positionals must be a contract address', () => {
  assertSafeArgv(['state', '0x000000000000000000000000000000000000dEaD', '--json=true']);
  assert.throws(() => assertSafeArgv(['state', 'rm -rf /', '--json=true']), /unexpected positional/);
});

test('secret-looking values are refused', () => {
  assert.throws(() => assertNoSecretLikeValue('name', '0x' + 'ab'.repeat(32)), /private key/);
  assert.throws(() => assertNoSecretLikeValue('description', 'ab'.repeat(32)), /private key/);
  assert.throws(
    () => assertNoSecretLikeValue('description', 'abandon ability able about above absent absorb abstract absurd abuse access accident'),
    /mnemonic/,
  );
  assert.throws(() => assertNoSecretLikeValue('externalUrl', 'https://base-sepolia.g.alchemy.com/v2/abc'), /RPC URL/);
  assertNoSecretLikeValue('name', 'Donuts and cake');
  assertNoSecretLikeValue('externalUrl', 'https://example.com/work');
});
