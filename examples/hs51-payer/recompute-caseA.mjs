import { readFileSync } from 'node:fs';
import { auditFixture, jcs, sha256hex } from './vendor/pilot-fe8050a5.mjs';
const fx = JSON.parse(readFileSync(new URL('./vendor/fixture-fe8050a5.json', import.meta.url), 'utf8'));
console.log('fixture', await sha256hex(jcs(fx)));
const region = fx.region ?? null;
const a = await auditFixture(fx, region, 'https://mcp.horizonshield.dev/mcp', fetch);
const s = jcs(a);
console.log('audit_sha256', await sha256hex(s), 'chars', s.length, 'bytes', Buffer.byteLength(s));
console.log('total', a.total, 'reference_total', a.reference_total, 'findings', a.lines.map(l => l.finding).join(','), 'datasets', [...new Set(a.lines.map(l => l.dataset_sha256))].join(','));
