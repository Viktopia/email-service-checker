/**
 * First half of `bun run crosscheck`: runs every checker against real
 * domains and writes the raw DNS facts each one reports to
 * .crosscheck/facts.json. oracle.py then recomputes the same facts with
 * `dig` and an independent implementation, and diffs the two.
 *
 * The facts are what a check is decided from (records, lookup counts, key
 * lengths, flags), not the verdicts, so a disagreement points at the exact
 * thing that was read or counted wrong.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkBimi } from '../../src/bimi.ts';
import type { Check } from '../../src/checks.ts';
import { checkDane } from '../../src/dane.ts';
import { checkDkim } from '../../src/dkim.ts';
import { checkDmarc } from '../../src/dmarc.ts';
import { resolve } from '../../src/dns.ts';
import { checkDnsHealth } from '../../src/dns-health.ts';
import { lookupMx } from '../../src/lookup.ts';
import { checkMtaSts } from '../../src/mta-sts.ts';
import { checkMx, isReservedIPv4, isReservedIPv6 } from '../../src/mx-health.ts';
import { checkSpf, type SpfNode } from '../../src/spf.ts';
import { checkTlsRpt } from '../../src/tls-rpt.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const OUT = join(ROOT, '.crosscheck');
const domains = [
    ...new Set(
        readFileSync(join(ROOT, 'scripts/crosscheck/domains.txt'), 'utf8')
            .split(/\s+/)
            .filter((d) => d && !d.startsWith('#')),
    ),
];

const statuses = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));
const tree = (n: SpfNode): unknown => ({
    domain: n.domain,
    via: n.via,
    lookups: n.totalLookups,
    children: n.children.map(tree),
});

async function facts(domain: string) {
    const mx = await lookupMx(domain);
    // The policy file is not compared: it is HTTPS, not DNS.
    const noFetch = async () => ({ kind: 'opaque' as const });
    const [mxHealth, spf, dmarc, dkim, mtaSts, tlsRpt, dane, bimi, dns] = await Promise.all([
        checkMx(mx, resolve),
        checkSpf(domain, resolve),
        checkDmarc(domain, resolve),
        checkDkim(domain, null, resolve),
        checkMtaSts(domain, resolve, noFetch),
        checkTlsRpt(domain, resolve),
        checkDane(domain, mx, resolve),
        checkBimi(domain, resolve),
        checkDnsHealth(domain, resolve),
    ]);
    return {
        mx: mx.map((r) => [r.priority, r.host]),
        mxHosts: mxHealth.hosts.map((h) => ({
            host: h.host,
            has4: h.ipv4.length > 0,
            has6: h.ipv6.length > 0,
            reserved: h.ipv4.some(isReservedIPv4) || h.ipv6.some(isReservedIPv6),
            cname: h.aliased,
        })),
        spf: {
            records: spf.records,
            lookups: spf.lookups,
            voids: spf.voidLookups,
            tree: spf.tree ? tree(spf.tree) : null,
            checks: statuses(spf.checks),
        },
        dmarc: { at: dmarc.policyDomain, records: dmarc.records, tags: dmarc.parsed?.tags ?? null },
        dkim: {
            keys: dkim.keys.map((k) => ({
                sel: k.selector,
                type: k.keyType,
                bits: k.bits,
                revoked: k.revoked,
                record: k.record,
            })),
        },
        mtaSts: { record: mtaSts.record, checks: statuses(mtaSts.checks) },
        tlsRpt: { record: tlsRpt.record },
        dane: {
            signed: dane.signed,
            ds: dane.hasDs,
            hosts: dane.hosts.map((h) => ({
                host: h.host,
                secure: h.secure,
                tlsa: h.tlsa.map((t) => `${t.usage} ${t.selector} ${t.matching} ${t.data}`),
                tlsaSecure: h.tlsaSecure,
            })),
        },
        bimi: { record: bimi.record },
        dns: {
            zone: dns.zone,
            ns: dns.nameservers.map((n) => ({
                host: n.host,
                has4: n.ipv4.length > 0,
                has6: n.ipv6.length > 0,
            })),
            soa: dns.soa,
            signed: dns.signed,
            checks: statuses(dns.checks),
        },
    };
}

const out: Record<string, unknown> = {};
const queue = [...domains];
await Promise.all(
    Array.from({ length: 6 }, async () => {
        while (queue.length > 0) {
            const d = queue.shift()!;
            try {
                out[d] = await facts(d);
            } catch (err) {
                out[d] = { error: String(err) };
            }
        }
    }),
);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'facts.json'), JSON.stringify(out));
console.log(`Collected checker facts for ${Object.keys(out).length} domains`);
