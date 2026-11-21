/**
 * The safety boundary of the ABX MCP server. Everything a tool call can influence passes through
 * here before a process is spawned, so the rules live in one place and are unit-tested directly.
 *
 * The server is deliberately narrower than the CLI it wraps:
 *  - it never signs, sends, or broadcasts (no `--send`, `--sign`, `--sponsor`/`--embedded`),
 *  - it only runs a fixed set of read-only or prepare-only commands,
 *  - it only operates on testnets,
 *  - it never takes keys, mnemonics, or RPC URLs as tool arguments.
 */

/** Selectable testnet chain keys. Kept in sync with the SDK's chain-support registry by a test. */
export const TESTNET_KEYS = ['base-sepolia', 'sepolia', 'arbitrum-sepolia', 'robinhood-testnet'] as const;
export type TestnetKey = (typeof TESTNET_KEYS)[number];

/** The default network when a tool call names none. Matches the CLI's own default. */
export const DEFAULT_NETWORK: TestnetKey = 'base-sepolia';

/** Production chain keys and common mainnet spellings, refused with a pointed message. */
export const MAINNET_ALIASES: ReadonlySet<string> = new Set([
  'base',
  'ethereum',
  'arbitrum',
  'robinhood',
  'mainnet',
  'homestead',
  'eth',
  'base-mainnet',
  'arbitrum-one',
  'arbitrum-mainnet',
  '1',
  '8453',
  '42161',
  '4663',
]);

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardError';
  }
}

/** Resolve a tool's `network` argument to a testnet key, or throw a clear refusal. */
export function assertTestnet(network: string | undefined): TestnetKey {
  if (network === undefined || network.trim() === '') return DEFAULT_NETWORK;
  const key = network.trim().toLowerCase();
  if ((TESTNET_KEYS as readonly string[]).includes(key)) return key as TestnetKey;
  if (MAINNET_ALIASES.has(key)) {
    throw new GuardError(
      `network "${network}" is a mainnet. The ABX MCP server only runs on testnets (${TESTNET_KEYS.join(', ')}). ` +
        'Prove the flow on the paired testnet here, then run the abx CLI yourself for a mainnet deploy.',
    );
  }
  throw new GuardError(`unknown network "${network}". Testnets this server accepts: ${TESTNET_KEYS.join(', ')}.`);
}

/** The only CLI commands this server will ever spawn. */
export const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  'capabilities',
  'doctor',
  'deploy',
  'deploy-series',
  'deploy-code',
  'state',
  'verify',
]);

/**
 * Commands that move value, change ownership, lock state, or touch keys. Never allowed, even if
 * someone later widens {@link ALLOWED_COMMANDS} by mistake: {@link assertSafeArgv} checks both.
 */
export const EXCLUDED_COMMANDS: ReadonlySet<string> = new Set([
  'mint',
  'minter',
  'transfer',
  'lock-script',
  'lock-uri',
  'lock-field',
  'lock-dependencies',
  'lock-param-hooks',
  'storage',
  'auth',
  'demo',
]);

/** Flags that sign, send, or select a signing lane. Never passed by any tool. */
export const FORBIDDEN_FLAGS: ReadonlySet<string> = new Set([
  'send',
  'sign',
  'sponsor',
  'embedded',
  'sign-url-file',
  'port',
  'yes',
  'confirm',
  'fix',
  'resume',
  'rpc',
  'rpc-url',
  'private-key',
  'pk',
  'mnemonic',
  'factory',
  'bootstrap-factory',
  'backend',
  'storage-signer',
  'remote',
  'remote-token',
]);

/** The flag name of one argv element (`--name=value` → `name`), or undefined for a positional. */
export function flagName(arg: string): string | undefined {
  if (!arg.startsWith('--')) return undefined;
  const eq = arg.indexOf('=');
  return (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).toLowerCase();
}

/**
 * Final check on a fully built argv, run immediately before spawn. Belt and braces: the builders
 * already only emit allowed flags, and this proves it for every call rather than trusting them.
 */
export function assertSafeArgv(argv: readonly string[], lane?: 'dry-run' | 'unsigned'): void {
  const [cmd, ...rest] = argv;
  if (!cmd || EXCLUDED_COMMANDS.has(cmd) || !ALLOWED_COMMANDS.has(cmd)) {
    throw new GuardError(`command "${cmd ?? ''}" is not available through the ABX MCP server.`);
  }
  const names: string[] = [];
  for (const arg of rest) {
    const name = flagName(arg);
    if (name === undefined) {
      // Positionals are only ever a validated contract address.
      if (!/^0x[0-9a-fA-F]{40}$/.test(arg)) throw new GuardError(`unexpected positional argument "${arg}".`);
      continue;
    }
    if (FORBIDDEN_FLAGS.has(name)) throw new GuardError(`flag --${name} is never passed by the ABX MCP server.`);
    // Every flag is emitted as `--key=value` (booleans as `--key=true`). The CLI's parser reads a
    // bare `--key` followed by a token that starts with `--` as TWO flags, so `--name --send` would
    // smuggle a signing flag in through a value. The `=` form is split once and can't be.
    if (!arg.includes('=')) throw new GuardError(`flag ${arg} must be passed as --key=value.`);
    names.push(name);
  }
  if (cmd.startsWith('deploy')) {
    const dry = names.includes('dry-run');
    const unsigned = names.includes('unsigned');
    if (lane === 'dry-run' && (!dry || unsigned)) throw new GuardError('a dry run must pass --dry-run and not --unsigned.');
    if (lane === 'unsigned' && (!unsigned || dry)) throw new GuardError('an unsigned run must pass --unsigned and not --dry-run.');
    if (lane === undefined) throw new GuardError('deploy commands need an explicit lane (dry-run or unsigned).');
    if (!names.includes('json')) throw new GuardError('deploy commands must run with --json.');
  }
}

/**
 * Argument values that look like secrets. Tool schemas never ask for a key, mnemonic, or RPC URL,
 * but a free-text field (name, description) could still carry one by accident. Refuse rather than
 * write it on chain or into a log.
 */
export function assertNoSecretLikeValue(field: string, value: string): void {
  const v = value.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(v) && field !== 'salt') {
    throw new GuardError(`${field} looks like a private key (32-byte hex). The ABX MCP server never accepts keys.`);
  }
  const words = v.split(/\s+/);
  if (words.length >= 12 && words.length <= 24 && words.every((w) => /^[a-z]{3,8}$/.test(w))) {
    throw new GuardError(`${field} looks like a mnemonic phrase. The ABX MCP server never accepts seed phrases.`);
  }
  if (/^(https?|wss?):\/\//i.test(v) && /(rpc|infura|alchemy|quicknode|ankr|drpc|llamarpc|chainstack|blastapi)/i.test(v)) {
    throw new GuardError(`${field} looks like an RPC URL. Configure RPC endpoints in your environment, never as a tool argument.`);
  }
}
