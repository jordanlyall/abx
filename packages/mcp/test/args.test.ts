import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseFlags} from '../../cli/src/flags.ts';
import {
  buildDeployArgv,
  buildStateArgv,
  buildVerifyArgv,
  confinePath,
  resolveDeployProjectDir,
  resolveProjectDir,
  startupRoots,
  type DeployArgs,
} from '../src/args.ts';
import {BLANKED_ENV, buildChildEnv, parseJsonOutput} from '../src/cli.ts';
import {GuardError} from '../src/guards.ts';

const OWNER = '0x000000000000000000000000000000000000dEaD';

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'abx-mcp-')));
  writeFileSync(join(dir, 'art.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  mkdirSync(join(dir, 'series'));
  writeFileSync(join(dir, 'series', '1.svg'), '<svg/>');
  writeFileSync(join(dir, 'sketch.js'), 'function draw(){}');
  return dir;
}

test('deploy dry run builds --key=value argv with the lane and --json appended', () => {
  const dir = project();
  const argv = buildDeployArgv(
    {command: 'deploy', for: OWNER, image: 'art.svg', name: 'Donuts', symbol: 'DNT', royaltyBps: 500, burnable: true, noMint: false},
    'dry-run',
    dir,
  );
  assert.deepEqual(argv, [
    'deploy',
    `--for=${OWNER}`,
    '--image=art.svg',
    '--name=Donuts',
    '--symbol=DNT',
    '--royalty-bps=500',
    '--burnable=true',
    '--dry-run=true',
    '--json=true',
  ]);
});

test('unsigned lane emits --unsigned, never --send or --sign', () => {
  const dir = project();
  const argv = buildDeployArgv({command: 'deploy-series', for: OWNER, dir: 'series', mintAll: true, copies: 'open'}, 'unsigned', dir);
  assert.ok(argv.includes('--unsigned=true'));
  assert.ok(argv.includes('--json=true'));
  for (const arg of argv) assert.doesNotMatch(arg, /^--(send|sign|sponsor|embedded|dry-run)\b/);
  const flags = parseFlags(argv.slice(1));
  assert.equal(flags.copies, 'open');
  assert.equal(flags['mint-all'], 'true');
});

test('a value that looks like a flag cannot smuggle --send into the real CLI parser', () => {
  const dir = project();
  const argv = buildDeployArgv(
    {command: 'deploy', for: OWNER, image: 'art.svg', name: '--send', symbol: '--sign', description: '--sponsor --embedded'},
    'dry-run',
    dir,
  );
  const flags = parseFlags(argv.slice(1));
  assert.equal(flags.name, '--send');
  assert.equal(flags.symbol, '--sign');
  assert.equal(flags.description, '--sponsor --embedded');
  for (const key of ['send', 'sign', 'sponsor', 'embedded']) assert.equal(flags[key], undefined, `--${key} leaked`);
  assert.equal(flags['dry-run'], 'true');
});

test('deploy-code passes ordered repeatable deps through the CLI parser', () => {
  const dir = project();
  const argv = buildDeployArgv(
    {command: 'deploy-code', for: OWNER, script: 'sketch.js', dep: ['p5@1.9.0', 'tone@14.7.77'], schema: ['hue:Uint8:Owner'], max: 100},
    'dry-run',
    dir,
  );
  const flags = parseFlags(argv.slice(1));
  assert.equal(flags.dep, 'p5@1.9.0,tone@14.7.77');
  assert.equal(flags.schema, 'hue:Uint8:Owner');
  assert.equal(flags.max, '100');
});

test('inputs that do not apply to the command are refused', () => {
  const dir = project();
  assert.throws(() => buildDeployArgv({command: 'deploy', for: OWNER, image: 'art.svg', script: 'sketch.js'} as DeployArgs, 'dry-run', dir), /script does not apply to deploy/);
  assert.throws(() => buildDeployArgv({command: 'deploy-code', for: OWNER, script: 'sketch.js', image: 'art.svg'} as DeployArgs, 'dry-run', dir), /image does not apply/);
});

test('each deploy command requires its content input', () => {
  const dir = project();
  assert.throws(() => buildDeployArgv({command: 'deploy', for: OWNER}, 'dry-run', dir), /deploy needs image/);
  assert.throws(() => buildDeployArgv({command: 'deploy-series', for: OWNER}, 'dry-run', dir), /needs dir/);
  assert.throws(() => buildDeployArgv({command: 'deploy-code', for: OWNER}, 'dry-run', dir), /needs script or codeDir/);
});

test('onchainImage is refused on the unsigned lane, as the CLI would', () => {
  const dir = project();
  assert.throws(() => buildDeployArgv({command: 'deploy', for: OWNER, image: 'art.svg', onchainImage: true}, 'unsigned', dir), /not supported on the unsigned lane/);
  buildDeployArgv({command: 'deploy', for: OWNER, image: 'art.svg', onchainImage: true}, 'dry-run', dir);
});

test('file inputs are confined to the project directory, symlinks included', () => {
  const dir = project();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'abx-mcp-outside-')));
  writeFileSync(join(outside, 'id_rsa'), 'not really');
  symlinkSync(join(outside, 'id_rsa'), join(dir, 'link.svg'));
  assert.equal(confinePath('image', 'art.svg', dir), 'art.svg');
  assert.throws(() => confinePath('image', '../' + outside.split('/').pop() + '/id_rsa', dir), /outside the project directory/);
  assert.throws(() => confinePath('image', join(outside, 'id_rsa'), dir), /outside the project directory/);
  assert.throws(() => confinePath('image', 'link.svg', dir), /outside the project directory/);
  assert.throws(() => confinePath('image', 'missing.svg', dir), /does not exist/);
});

test('startup roots: cwd plus ABX_MCP_ROOTS, never a filesystem root or a relative path', () => {
  const a = project();
  const b = project();
  assert.deepEqual(startupRoots({ABX_MCP_ROOTS: [b, 'relative', '/', '/definitely/not/here'].join(':')}, a), [a, b]);
  assert.deepEqual(startupRoots({}, '/'), []);
});

test('projectDir must sit inside a startup root, outside any hidden folder', () => {
  const root = project();
  mkdirSync(join(root, 'work'));
  mkdirSync(join(root, '.ssh'));
  mkdirSync(join(root, 'work', '.git'));
  const elsewhere = project();
  assert.equal(resolveProjectDir(undefined, [root]), root);
  assert.equal(resolveProjectDir(join(root, 'work'), [root]), join(root, 'work'));
  assert.throws(() => resolveProjectDir('relative/dir', [root]), /absolute/);
  assert.throws(() => resolveProjectDir('/definitely/not/here', [root]), /not an existing directory/);
  assert.throws(() => resolveProjectDir(elsewhere, [root]), /outside the folders this server may use/);
  assert.throws(() => resolveProjectDir('/', [root]), /outside the folders/);
  assert.throws(() => resolveProjectDir(join(root, '.ssh'), [root]), /hidden folder/);
  assert.throws(() => resolveProjectDir(join(root, 'work', '.git'), [root]), /hidden folder/);
  assert.throws(() => resolveProjectDir(root, []), /no usable project root/);
  // A symlink inside the root that points out of it is resolved before the check.
  symlinkSync(elsewhere, join(root, 'escape'));
  assert.throws(() => resolveProjectDir(join(root, 'escape'), [root]), /outside the folders/);
});

test('regression: a server started in $HOME cannot read ~/.ssh through a deploy', () => {
  const home = realpathSync(homedir());
  assert.throws(() => resolveDeployProjectDir(home, [home]), /too broad/);
  assert.throws(() => resolveDeployProjectDir(join(home, '.ssh'), [home]), /hidden folder|not an existing directory/);
  // Even inside a real project folder, a hidden file or hidden folder is never a valid input.
  const dir = project();
  writeFileSync(join(dir, '.id_rsa.js'), 'x');
  mkdirSync(join(dir, '.keys'));
  writeFileSync(join(dir, '.keys', 'k.js'), 'x');
  assert.throws(() => buildDeployArgv({command: 'deploy-code', projectDir: dir, for: OWNER, script: '.id_rsa.js'}, 'unsigned', dir), /hidden/);
  assert.throws(() => buildDeployArgv({command: 'deploy-code', projectDir: dir, for: OWNER, script: '.keys/k.js'}, 'unsigned', dir), /hidden/);
});

test('file inputs must have an expected type; folder inputs must be folders', () => {
  const dir = project();
  writeFileSync(join(dir, 'notes.txt'), 'x');
  writeFileSync(join(dir, 'run.sh'), 'x');
  assert.throws(() => confinePath('image', 'notes.txt', dir), /must be one of \.svg/);
  assert.throws(() => confinePath('script', 'run.sh', dir), /must be one of \.js/);
  assert.throws(() => confinePath('image', 'series', dir), /must be a file/);
  assert.throws(() => confinePath('dir', 'art.svg', dir), /must be a folder/);
  assert.equal(confinePath('dir', 'series', dir), 'series');
  assert.equal(confinePath('codeDir', '.', dir), '.');
});

test('secret-looking free text is refused before it reaches the CLI', () => {
  const dir = project();
  assert.throws(() => buildDeployArgv({command: 'deploy', for: OWNER, image: 'art.svg', description: '0x' + '11'.repeat(32)}, 'dry-run', dir), GuardError);
});

test('state and verify take a validated address positional', () => {
  assert.deepEqual(buildStateArgv(OWNER), ['state', OWNER, '--json=true']);
  assert.deepEqual(buildVerifyArgv(OWNER), ['verify', OWNER, '--json=true']);
  assert.throws(() => buildStateArgv('--send'));
});

test('child env forces the testnet, blanks keys, and keeps storage local', () => {
  const env = buildChildEnv({ABX_CHAIN: 'ethereum', ABX_DEPLOYER_PK: '0xsecret', ARWEAVE_JWK: '{}', ABX_STORAGE_BACKEND: 'arweave', PATH: '/bin'}, 'sepolia');
  assert.equal(env.ABX_CHAIN, 'sepolia');
  for (const name of BLANKED_ENV) assert.equal(env[name], '', `${name} must be blanked (not deleted) so .env cannot refill it`);
  assert.equal(env.ABX_STORAGE_BACKEND, 'fs');
  assert.equal(env.ABX_NO_UPDATE_CHECK, '1');
  assert.equal(env.PATH, '/bin');
});

test('JSON output parses whole or as the last object', () => {
  assert.deepEqual(parseJsonOutput('{"a":1}'), {a: 1});
  assert.deepEqual(parseJsonOutput('note\n{"a":2}'), {a: 2});
  assert.equal(parseJsonOutput('plain text'), undefined);
});
