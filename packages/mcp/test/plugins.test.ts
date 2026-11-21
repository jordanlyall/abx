import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SERVER_NAME, SERVER_VERSION} from '../src/server.ts';

const PLUGIN = fileURLToPath(new URL('../../../plugins/abx/', import.meta.url));
const read = (rel: string) => JSON.parse(readFileSync(join(PLUGIN, rel), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {name: string; version: string};

test('Cursor and Grok manifests agree with each other', () => {
  const cursor = read('.cursor-plugin/plugin.json');
  const grok = read('.grok-plugin/plugin.json');
  for (const manifest of [cursor, grok]) {
    assert.match(manifest.name, /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, 'kebab-case name');
    assert.equal(manifest.name, 'abx');
  }
  assert.equal(cursor.version, grok.version);
  assert.equal(cursor.description, grok.description);
  assert.equal(SERVER_VERSION, pkg.version, 'the server reports the package version');
});

test('both plugins launch the same server: npx @artblocks/abx-mcp, named abx', () => {
  // Cursor discovers mcp.json at the plugin root; Grok's manifest points at the same file.
  const grok = read('.grok-plugin/plugin.json');
  assert.equal(typeof grok.mcpServers, 'string');
  assert.ok(!isAbsolute(grok.mcpServers) && !grok.mcpServers.includes('..'), 'manifest paths stay inside the plugin');
  assert.ok(existsSync(join(PLUGIN, grok.mcpServers)));
  const mcp = read(grok.mcpServers);
  assert.deepEqual(Object.keys(mcp.mcpServers), [SERVER_NAME]);
  const server = mcp.mcpServers[SERVER_NAME];
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['-y', pkg.name]);
  assert.equal(server.env, undefined, 'the plugin ships no environment, so no secret can live in it');
  assert.equal(pkg.name, '@artblocks/abx-mcp');
});
