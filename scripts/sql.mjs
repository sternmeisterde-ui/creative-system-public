// SQL в Supabase проекта Creative System через Management API.
// node scripts/sql.mjs "select ..."   |   node scripts/sql.mjs --file supabase/migrations/038_x.sql
// Токен: SUPABASE_ACCESS_TOKEN или keychain «Supabase CLI» (после `supabase login`).
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const env = Object.fromEntries(fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')
  .filter(l => /^[A-Z_0-9]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const ref = /https?:\/\/([a-z0-9]{15,25})\.supabase\.co/.exec(env.NEXT_PUBLIC_SUPABASE_URL)?.[1];
function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  let raw = execSync('security find-generic-password -s "Supabase CLI" -w', { encoding: 'utf8' }).trim();
  if (raw.startsWith('go-keyring-base64:')) raw = Buffer.from(raw.split(':')[1], 'base64').toString('utf8').trim();
  if (!raw.startsWith('sbp_')) throw new Error('no Supabase access token; run `supabase login`');
  return raw;
}
const sql = process.argv[2] === '--file' ? fs.readFileSync(process.argv[3], 'utf8') : process.argv[2];
const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }),
});
const body = await res.text();
if (!res.ok) { console.error('HTTP', res.status, body.slice(0, 1500)); process.exit(1); }
const rows = JSON.parse(body);
if (Array.isArray(rows) && rows.length && process.argv.includes('--table')) console.table(rows); else console.log(JSON.stringify(rows, null, 1).slice(0, 20000));
