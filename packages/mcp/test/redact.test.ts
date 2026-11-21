import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dotEnvValues, redact, redactJson, secretValues} from '../src/redact.ts';

test('values of secret-named env vars are scrubbed, including each RPC in a list', () => {
  const secrets = secretValues({
    ABX_DEPLOYER_PK: '0x' + 'cd'.repeat(32),
    ABX_RPC_URLS_BASE_SEPOLIA: 'https://one.example/rpc/k1aaaa,https://two.example/rpc/k2bbbb',
    PINATA_JWT: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
    HOME: '/Users/someone',
  });
  const text = `key ${'cd'.repeat(32)} 0x${'cd'.repeat(32)} rpc https://two.example/rpc/k2bbbb jwt eyJhbGciOiJIUzI1NiJ9.payload.sig home /Users/someone`;
  const out = redact(text, secrets);
  assert.doesNotMatch(out, /cdcdcdcd/);
  assert.doesNotMatch(out, /k2bbbb/);
  assert.doesNotMatch(out, /payload\.sig/);
  assert.match(out, /\/Users\/someone/, 'non-secret values are left alone');
});

test('URL credentials and key query params are scrubbed, ANSI stripped', () => {
  const out = redact('\x1b[31mhttps://user:pass@host.example/x?apikey=abc123&chain=1\x1b[0m', []);
  assert.equal(out, 'https://[redacted]@host.example/x?apikey=[redacted]&chain=1');
});

test('.env values are found by the same walk-up the CLI uses, and redactJson scrubs nested strings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-mcp-env-'));
  writeFileSync(join(dir, '.env'), 'ABX_DEPLOYER_PK="0xfeedfacefeedface"\n# comment\nABX_CHAIN=base\n');
  const values = dotEnvValues(join(dir));
  assert.equal(values.ABX_DEPLOYER_PK, '0xfeedfacefeedface');
  const secrets = secretValues(values);
  assert.deepEqual(redactJson({a: ['x 0xfeedfacefeedface'], n: 1}, secrets), {a: ['x [redacted]'], n: 1});
});
