/**
 * Spawning the ABX CLI. One function, `runCli`, is the only place a process starts. It takes an
 * argv array (never a shell string), forces the chain and the safety-relevant environment, and
 * returns redacted output.
 */
import {spawn} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertSafeArgv, type TestnetKey} from './guards.js';
import {dotEnvValues, redact, redactJson, secretValues} from './redact.js';

/** How to start the CLI: node plus the arguments that precede the CLI's own argv. */
export interface CliLauncher {
  command: string;
  prefix: string[];
}

/**
 * Locate the installed `@artblocks/abx-cli` binary without importing it (importing its main module
 * runs the CLI). Published: `dist/main.js` → `dist/bin.js`. In this workspace the package points at
 * TypeScript source, so `src/bin.ts` runs under tsx.
 */
export function resolveCliLauncher(): CliLauncher {
  const mainPath = fileURLToPath(import.meta.resolve('@artblocks/abx-cli'));
  const isTs = mainPath.endsWith('.ts');
  const bin = join(dirname(mainPath), isTs ? 'bin.ts' : 'bin.js');
  if (!isTs) return {command: process.execPath, prefix: [bin]};
  return {command: process.execPath, prefix: ['--import', import.meta.resolve('tsx'), bin]};
}

/**
 * Environment variables blanked for every child. An empty value counts as "set", so the CLI's
 * `.env` loader cannot fill them in from a project file either. Signing keys and storage keys:
 * with these empty, no tool can sign a transaction or a paid upload even if a future CLI change
 * reached for a key on these code paths.
 */
export const BLANKED_ENV = ['ABX_DEPLOYER_PK', 'ARWEAVE_JWK', 'ABX_ARWEAVE_ETH_SIGNER_KEY'] as const;

/** Build the child environment. Pure, so the guarantees are unit-tested. */
export function buildChildEnv(parent: NodeJS.ProcessEnv, network: TestnetKey): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...parent};
  for (const name of BLANKED_ENV) env[name] = '';
  // Always explicit: an inherited ABX_CHAIN=ethereum (or one in .env) must never reach the CLI.
  env.ABX_CHAIN = network;
  // Local content store only: the server never uploads to IPFS, Arweave, or a bucket.
  env.ABX_STORAGE_BACKEND = 'fs';
  env.ABX_NO_UPDATE_CHECK = '1';
  env.NO_COLOR = '1';
  return env;
}

export interface CliResult {
  exitCode: number | null;
  /** Parsed stdout when it was JSON, else undefined. */
  json?: unknown;
  /** Redacted stdout when it was not JSON. */
  stdout: string;
  /** Redacted stderr (the CLI's human narration and warnings). */
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  network: TestnetKey;
  cwd: string;
  lane?: 'dry-run' | 'unsigned';
  timeoutMs?: number;
  launcher?: CliLauncher;
  /** Max characters of narration returned, so a chatty command can't flood the agent. */
  maxStderr?: number;
}

/** Parse the CLI's JSON output: the whole stdout, or the last top-level JSON object in it. */
export function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf('\n{');
    if (start !== -1) {
      try {
        return JSON.parse(text.slice(start + 1));
      } catch {
        /* fall through */
      }
    }
    return undefined;
  }
}

export async function runCli(argv: string[], options: RunOptions): Promise<CliResult> {
  assertSafeArgv(argv, options.lane);
  const launcher = options.launcher ?? resolveCliLauncher();
  const env = buildChildEnv(process.env, options.network);
  const secrets = secretValues(process.env, dotEnvValues(options.cwd));

  return new Promise((resolvePromise, reject) => {
    const child = spawn(launcher.command, [...launcher.prefix, ...argv], {
      cwd: options.cwd,
      env,
      shell: false,
      // No stdin: a prompt can never block, and nothing can be typed into the CLI.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 180_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const max = options.maxStderr ?? 8_000;
      let narration = redact(stderr, secrets).trim();
      if (narration.length > max) narration = `${narration.slice(0, max)}\n… [truncated]`;
      const parsed = parseJsonOutput(stdout);
      resolvePromise({
        exitCode: code,
        json: parsed === undefined ? undefined : redactJson(parsed, secrets),
        stdout: parsed === undefined ? redact(stdout, secrets).trim() : '',
        stderr: narration,
        timedOut,
      });
    });
  });
}
