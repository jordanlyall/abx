/**
 * Output scrubbing. CLI output is returned to an agent and may be shown to people or logged by the
 * host, so nothing that came from a secret-bearing environment variable may pass through. The CLI
 * already avoids printing secrets; this is the second line, applied to every byte we return.
 */
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

/** Env var names whose values are treated as secret (keys, tokens, RPC URLs, credentials). */
export const SENSITIVE_NAME = /(PK|KEY|SECRET|TOKEN|JWT|MNEMONIC|PASSWORD|PASSWD|PRIVATE|SEED|CREDENTIAL|AUTH|RPC|COOKIE|SESSION)/i;

/** Values too short to redact safely (would mangle ordinary words). */
const MIN_SECRET_LENGTH = 8;

/** Read `KEY=VALUE` pairs from the `.env` the CLI would load (same walk-up as the SDK's loader). */
export function dotEnvValues(startDir: string): Record<string, string> {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      const out: Record<string, string> = {};
      for (const raw of readFileSync(candidate, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        out[line.slice(0, eq).trim()] = value;
      }
      return out;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

/** Every secret value to scrub, from the process env and the project's `.env`. */
export function secretValues(...sources: Array<Record<string, string | undefined>>): string[] {
  const values = new Set<string>();
  for (const env of sources) {
    for (const [name, value] of Object.entries(env)) {
      if (!value || !SENSITIVE_NAME.test(name)) continue;
      // RPC lists are comma-separated; scrub each endpoint as well as the whole value.
      for (const part of [value, ...value.split(',')]) {
        const v = part.trim();
        if (v.length < MIN_SECRET_LENGTH) continue;
        values.add(v);
        // A hex key is accepted with or without 0x, so scrub both spellings.
        if (/^0x[0-9a-fA-F]+$/.test(v)) values.add(v.slice(2));
        else if (/^[0-9a-fA-F]{16,}$/.test(v)) values.add(`0x${v}`);
      }
    }
  }
  // Longest first, so a full value is replaced before any of its parts.
  return [...values].sort((a, b) => b.length - a.length);
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Strip terminal colour codes and scrub secret values and URL credentials from text. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text.replace(ANSI, '');
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  // user:pass@ in any URL, and common key-bearing query parameters.
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@');
  out = out.replace(/([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|auth)=)[^&\s"']+/gi, '$1[redacted]');
  return out;
}

/** Apply {@link redact} to every string inside a parsed JSON value. */
export function redactJson<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactJson(v, secrets)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactJson(v, secrets);
    return out as T;
  }
  return value;
}
