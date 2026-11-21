/**
 * Tool input schemas and the argv each tool hands to the CLI. Pure: no I/O except resolving and
 * checking paths, so every rule here is unit-testable without spawning anything.
 */
import {existsSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter, extname, isAbsolute, join, parse, relative, resolve, sep} from 'node:path';
import {z} from 'zod';
import {assertNoSecretLikeValue, assertSafeArgv, GuardError} from './guards.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address');

/** Network is a free string so a mainnet gets the server's own pointed refusal, not a schema error. */
const network = z
  .string()
  .optional()
  .describe('Testnet to use: base-sepolia (default), sepolia, arbitrum-sepolia, or robinhood-testnet. Mainnets are refused.');

const projectDir = z
  .string()
  .optional()
  .describe('Absolute path of the project folder the CLI runs in. Defaults to the server working directory. File inputs must be inside it.');

const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), 'must be an https:// URL')
  .refine((u) => !/^https:\/\/[^/]*@/.test(u), 'must not carry credentials');

export const projectInput = {network, projectDir};

export const addressInput = {
  address: address.describe('Contract address of the ABX project on the chosen testnet.'),
  network,
  projectDir,
};

export const planInput = {
  artifact: z
    .enum(['1of1', 'series', 'code'])
    .describe('1of1: one static work. series: a folder of distinct static works. code: a program or renderer whose output depends on token state.'),
  edition: z.boolean().optional().describe('true for ERC-1155 copies of each work (--copies) instead of unique ERC-721 tokens.'),
};

export const DEPLOY_COMMANDS = ['deploy', 'deploy-series', 'deploy-code'] as const;
export type DeployCommand = (typeof DEPLOY_COMMANDS)[number];

export const deployInput = {
  command: z.enum(DEPLOY_COMMANDS).describe('deploy (1/1 or 1/1 edition), deploy-series (folder of works), deploy-code (generative/code project).'),
  network,
  projectDir: z
    .string()
    .describe('Absolute path of the project folder. Required for deploys: file inputs must be inside it, and the CLI writes its local content store there.'),
  for: address.describe('Address that will own the collection and sign the transactions. Required: the server holds no key.'),
  name: z.string().min(1).max(200).optional(),
  symbol: z.string().min(1).max(32).optional(),
  description: z.string().max(5000).optional(),
  externalUrl: httpsUrl.optional(),
  publicBaseUrl: httpsUrl.optional().describe('Public resolver base URL baked on chain (off-chain metadata).'),
  onchainUri: z.boolean().optional().describe('Resolve tokenURI/contractURI fully on chain.'),
  royaltyBps: z.number().int().min(0).max(10_000).optional(),
  burnable: z.boolean().optional(),
  noMint: z.boolean().optional(),
  copies: z.union([z.number().int().min(1), z.literal('open')]).optional().describe('ERC-1155 copies per work, or "open" for an open edition.'),
  salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex').optional(),
  // deploy
  image: z.string().optional().describe('deploy: path to the image, relative to projectDir.'),
  onchainImage: z.boolean().optional().describe('deploy/deploy-series: store image bytes on chain (not available on the unsigned lane).'),
  compress: z.enum(['fastlz']).optional(),
  // deploy-series
  dir: z.string().optional().describe('deploy-series: folder of media, relative to projectDir.'),
  count: z.number().int().min(1).optional(),
  // deploy-series + deploy-code
  mintAll: z.boolean().optional(),
  mintCount: z.number().int().min(0).optional(),
  // deploy-code
  script: z.string().optional().describe('deploy-code: path to the script, relative to projectDir.'),
  codeDir: z.string().optional().describe('deploy-code: build directory, relative to projectDir.'),
  max: z.number().int().min(1).optional(),
  dep: z.array(z.string().min(1).max(200)).max(16).optional().describe('deploy-code: ordered dependencies, name@version or 0x address.'),
  schema: z.array(z.string().min(1).max(500)).max(64).optional().describe('deploy-code: PostParam schema entries, key:Type:Auth.'),
  noSeed: z.boolean().optional(),
};

const deployObject = z.object(deployInput);
export type DeployArgs = z.infer<typeof deployObject>;

/** Which optional inputs each deploy command accepts. Anything else is refused with a clear message. */
const COMMAND_FIELDS: Record<DeployCommand, ReadonlySet<keyof DeployArgs>> = {
  deploy: new Set(['image', 'onchainImage', 'compress']),
  'deploy-series': new Set(['dir', 'count', 'mintAll', 'mintCount', 'onchainImage', 'compress']),
  'deploy-code': new Set(['script', 'codeDir', 'max', 'dep', 'schema', 'noSeed', 'mintAll', 'mintCount']),
};
const COMMON_FIELDS: ReadonlySet<keyof DeployArgs> = new Set([
  'command', 'network', 'projectDir', 'for', 'name', 'symbol', 'description', 'externalUrl', 'publicBaseUrl',
  'onchainUri', 'royaltyBps', 'burnable', 'noMint', 'copies', 'salt',
]);

/** Map a tool field to its CLI flag. */
const FLAG_FOR: Partial<Record<keyof DeployArgs, string>> = {
  for: 'for', name: 'name', symbol: 'symbol', description: 'description', externalUrl: 'external-url',
  publicBaseUrl: 'public-base-url', onchainUri: 'onchain-uri', royaltyBps: 'royalty-bps', burnable: 'burnable',
  noMint: 'no-mint', copies: 'copies', salt: 'salt', image: 'image', onchainImage: 'onchain-image',
  compress: 'compress', dir: 'dir', count: 'count', mintAll: 'mint-all', mintCount: 'mint-count',
  script: 'script', codeDir: 'code-dir', max: 'max', dep: 'dep', schema: 'schema', noSeed: 'no-seed',
};

const PATH_FIELDS: ReadonlySet<keyof DeployArgs> = new Set(['image', 'dir', 'script', 'codeDir']);
const TEXT_FIELDS: ReadonlySet<keyof DeployArgs> = new Set(['name', 'symbol', 'description', 'externalUrl', 'publicBaseUrl']);

/** `child` relative to `parent` when it is inside it (or equal), else undefined. Both real paths. */
function inside(parent: string, child: string): string | undefined {
  const rel = relative(parent, child);
  if (isAbsolute(rel) || rel.split(sep)[0] === '..') return undefined;
  return rel;
}

/** True when any segment of a relative path is a dot-folder or dot-file (`.ssh`, `.env`, `.git`, …). */
function hasDotSegment(rel: string): boolean {
  return rel !== '' && rel.split(sep).some((segment) => segment.startsWith('.'));
}

/**
 * The directories a tool call may work in, pinned when the server starts and never taken from a
 * tool argument: the server's working directory, plus any absolute paths in `ABX_MCP_ROOTS`
 * (path-delimiter separated) that the user sets in their MCP host config. A filesystem root is never
 * a valid root.
 */
export function startupRoots(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  home: string = homedir(),
): string[] {
  const realHome = existsSync(home) ? realpathSync(home) : home;
  const explicit = (env.ABX_MCP_ROOTS ?? '').split(delimiter).map((p) => p.trim()).filter(Boolean);
  const roots: string[] = [];
  const add = (candidate: string, implicit: boolean) => {
    if (!isAbsolute(candidate) || !existsSync(candidate) || !statSync(candidate).isDirectory()) return;
    const real = realpathSync(candidate);
    if (real === parse(real).root) return;
    // Fail closed: a working directory that IS the home folder, or contains it, is not a project.
    // Hosts often start servers there. Only an explicit ABX_MCP_ROOTS entry can grant that much.
    if (implicit && inside(real, realHome) !== undefined) return;
    if (!roots.includes(real)) roots.push(real);
  };
  add(cwd, true);
  for (const candidate of explicit) add(candidate, false);
  return roots;
}

/** Folders directly under the home folder that hold app data and credentials, never a project. */
const SENSITIVE_HOME_FOLDERS: ReadonlySet<string> = new Set(['library', 'appdata', 'application data']);

function isSensitiveHomePath(real: string, home: string = homedir()): boolean {
  if (!existsSync(home)) return false;
  const rel = inside(realpathSync(home), real);
  if (rel === undefined || rel === '') return false;
  const first = rel.split(sep)[0].toLowerCase();
  return first.startsWith('.') || SENSITIVE_HOME_FOLDERS.has(first);
}

const ROOTS = startupRoots();

/**
 * Resolve the working directory for a call. It must be an existing absolute directory inside one of
 * the startup roots, with no dot-folder on the way (so `~/.ssh` or `~/.config` can never be a project
 * even when the server was started in the home folder). Omitted, it is the server's cwd.
 */
export function resolveProjectDir(dir: string | undefined, roots: readonly string[] = ROOTS): string {
  if (roots.length === 0) {
    throw new GuardError('no usable project root: start the server inside a project folder, or set ABX_MCP_ROOTS in the MCP host config.');
  }
  if (dir === undefined) return roots[0];
  if (!isAbsolute(dir)) throw new GuardError('projectDir must be an absolute path.');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new GuardError(`projectDir ${dir} is not an existing directory.`);
  const real = realpathSync(dir);
  for (const root of roots) {
    const rel = inside(root, real);
    if (rel === undefined) continue;
    if (hasDotSegment(rel)) throw new GuardError(`projectDir ${dir} is inside a hidden folder. Use the project's own folder.`);
    if (isSensitiveHomePath(real)) throw new GuardError(`projectDir ${dir} is inside an app-data folder (Library, AppData). Use the project's own folder.`);
    return real;
  }
  throw new GuardError(
    `projectDir ${dir} is outside the folders this server may use (${roots.join(', ')}). ` +
      'Add a folder with ABX_MCP_ROOTS in the MCP host config; it cannot be widened from a tool call.',
  );
}

/** A project directory for a deploy: required, inside a root, and never the home folder itself. */
export function resolveDeployProjectDir(dir: string, roots: readonly string[] = ROOTS): string {
  const real = resolveProjectDir(dir, roots);
  if (real === realpathSync(homedir())) {
    throw new GuardError(`projectDir ${dir} is too broad. Point it at the project's own folder.`);
  }
  return real;
}

const IMAGE_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'];
/** Media the SDK's content-type table knows (packages/sdk/src/mime.ts), minus documents and data. */
const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, '.tif', '.tiff', '.mp4', '.webm', '.glb', '.gltf', '.mp3', '.wav', '.flac'];

/** File types each single-file input may name. */
const FILE_EXTENSIONS: Partial<Record<string, ReadonlySet<string>>> = {
  image: new Set(IMAGE_EXTENSIONS),
  script: new Set(['.js', '.mjs', '.cjs', '.html', '.htm']),
};

/** File types allowed inside each folder input, checked for every file the CLI would read. */
const FOLDER_EXTENSIONS: Record<string, ReadonlySet<string>> = {
  dir: new Set(MEDIA_EXTENSIONS),
  codeDir: new Set([
    ...MEDIA_EXTENSIONS,
    '.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.wasm', '.txt',
    '.glsl', '.frag', '.vert', '.woff', '.woff2', '.ttf', '.otf',
  ]),
};

/** A folder holds at most this many files the CLI would read; more is refused rather than scanned. */
const MAX_FOLDER_FILES = 10_000;

/**
 * Check every file the CLI will read from a folder input. The CLI reads the folder's top-level,
 * non-hidden regular files and follows symlinks (`readdirSync` + `statSync`), so a symlink named
 * `1.svg` could otherwise pull in a file from anywhere. Each one must resolve inside the folder and
 * have an allowed type. Hidden entries and subfolders are ignored, because the CLI ignores them too.
 */
export function checkFolderEntries(field: string, realDir: string): void {
  const allowed = FOLDER_EXTENSIONS[field];
  let count = 0;
  for (const name of readdirSync(realDir)) {
    if (name.startsWith('.')) continue;
    const entry = join(realDir, name);
    let target: string;
    try {
      target = realpathSync(entry);
    } catch {
      throw new GuardError(`${field}: ${name} is a broken link.`);
    }
    if (!statSync(target).isFile()) continue;
    if (++count > MAX_FOLDER_FILES) throw new GuardError(`${field}: more than ${MAX_FOLDER_FILES} files.`);
    const rel = inside(realDir, target);
    if (rel === undefined || hasDotSegment(rel)) {
      throw new GuardError(`${field}: ${name} points outside the folder (or at a hidden file). Copy the file in instead of linking it.`);
    }
    if (!allowed.has(extname(target).toLowerCase())) {
      throw new GuardError(`${field}: ${name} has a type this server does not pass to the CLI. Allowed: ${[...allowed].join(' ')}.`);
    }
  }
}

/** A file input, resolved and confined to the project directory (symlinks included), never hidden. */
export function confinePath(field: string, value: string, root: string): string {
  const abs = resolve(root, value);
  if (!existsSync(abs)) throw new GuardError(`${field}: ${value} does not exist under the project directory.`);
  const real = realpathSync(abs);
  const rel = inside(root, real);
  if (rel === undefined) {
    throw new GuardError(`${field}: ${value} resolves outside the project directory. File inputs must live inside projectDir.`);
  }
  if (hasDotSegment(rel)) throw new GuardError(`${field}: ${value} is a hidden file or inside a hidden folder.`);
  const allowed = FILE_EXTENSIONS[field];
  if (allowed) {
    if (!statSync(real).isFile()) throw new GuardError(`${field}: ${value} must be a file.`);
    if (!allowed.has(extname(real).toLowerCase())) {
      throw new GuardError(`${field}: ${value} must be one of ${[...allowed].join(' ')}.`);
    }
  } else {
    if (!statSync(real).isDirectory()) throw new GuardError(`${field}: ${value} must be a folder.`);
    checkFolderEntries(field, real);
  }
  return rel === '' ? '.' : rel;
}

/**
 * Build the argv for a deploy dry run or unsigned run. Every flag is `--key=value`; booleans are
 * `--key=true`. The lane flag and `--json` are always appended by this function, never by input.
 */
export function buildDeployArgv(input: DeployArgs, lane: 'dry-run' | 'unsigned', root: string): string[] {
  const allowed = COMMAND_FIELDS[input.command];
  for (const [key, value] of Object.entries(input) as [keyof DeployArgs, unknown][]) {
    if (value === undefined) continue;
    if (!COMMON_FIELDS.has(key) && !allowed.has(key)) {
      throw new GuardError(`${key} does not apply to ${input.command}.`);
    }
  }
  if (input.command === 'deploy' && !input.image) throw new GuardError('deploy needs image (a file inside projectDir).');
  if (input.command === 'deploy-series' && !input.dir) throw new GuardError('deploy-series needs dir (a folder inside projectDir).');
  if (input.command === 'deploy-code' && !input.script && !input.codeDir) {
    throw new GuardError('deploy-code needs script or codeDir (inside projectDir).');
  }
  if (lane === 'unsigned' && input.onchainImage) {
    throw new GuardError('onchainImage is not supported on the unsigned lane (the CLI refuses it). Use publicBaseUrl or onchainUri instead.');
  }

  const argv: string[] = [input.command];
  for (const [key, value] of Object.entries(input) as [keyof DeployArgs, unknown][]) {
    const flag = FLAG_FOR[key];
    if (!flag || value === undefined || value === false) continue;
    if (TEXT_FIELDS.has(key)) assertNoSecretLikeValue(key, String(value));
    if (PATH_FIELDS.has(key)) {
      argv.push(`--${flag}=${confinePath(key, String(value), root)}`);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        assertNoSecretLikeValue(key, String(item));
        argv.push(`--${flag}=${item}`);
      }
    } else if (value === true) {
      argv.push(`--${flag}=true`);
    } else {
      argv.push(`--${flag}=${value}`);
    }
  }
  argv.push(`--${lane}=true`, '--json=true');
  assertSafeArgv(argv, lane);
  return argv;
}

export function buildStateArgv(addr: string): string[] {
  const argv = ['state', address.parse(addr), '--json=true'];
  assertSafeArgv(argv);
  return argv;
}

export function buildVerifyArgv(addr: string): string[] {
  const argv = ['verify', address.parse(addr), '--json=true'];
  assertSafeArgv(argv);
  return argv;
}

export function buildCapabilitiesArgv(): string[] {
  const argv = ['capabilities', '--json=true'];
  assertSafeArgv(argv);
  return argv;
}

export function buildDoctorArgv(): string[] {
  const argv = ['doctor'];
  assertSafeArgv(argv);
  return argv;
}
