/**
 * Discovery script — DEV ONLY, not run in CI.
 *
 *   bun run scripts/discover-providers.ts [--limit=10000] [--top=80]
 *
 * Pulls several public free / disposable email-domain lists, looks up the
 * MX records for each domain via DoH (dns.google), and clusters the MX
 * hostnames by their registered domain. Clusters that aren't matched by
 * any existing provider in src/providers.ts are printed, sorted by how
 * many input domains they cover. The output is meant to be eyeballed and
 * hand-curated into PROVIDERS — not auto-merged.
 *
 *   bun run scripts/discover-providers.ts > scripts/.discoveries.txt
 *
 * The MX lookups are cached in scripts/.mx-cache.json so reruns are fast.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PROVIDERS } from '../src/providers.ts';

const SOURCES = [
    'https://raw.githubusercontent.com/willwhite/freemail/master/data/free.txt',
    'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf',
    'https://raw.githubusercontent.com/martenson/disposable-email-domains/master/disposable_email_blocklist.conf',
    'https://raw.githubusercontent.com/7c/fakefilter/main/txt/data.txt',
    'https://raw.githubusercontent.com/wesbos/burner-email-providers/master/emails.txt',
    'https://raw.githubusercontent.com/FGRibreau/mailchecker/master/list.txt',
    'https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt',
];

const CACHE_PATH = new URL('./.mx-cache.json', import.meta.url).pathname;

interface Args {
    limit: number;
    top: number;
}

function parseArgs(): Args {
    const args: Args = { limit: 15_000, top: 80 };
    for (const a of process.argv.slice(2)) {
        const m = /^--(\w+)=(.+)$/.exec(a);
        if (m?.[1] && m[2]) (args as unknown as Record<string, number>)[m[1]] = Number(m[2]);
    }
    return args;
}

async function fetchDomains(url: string): Promise<string[]> {
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const text = await res.text();
        return text
            .split('\n')
            .map((l) => l.trim().toLowerCase())
            .filter((l) => l && !l.startsWith('#') && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(l));
    } catch {
        return [];
    }
}

interface DnsAnswer {
    type: number;
    data: string;
}
interface DnsResponse {
    Answer?: DnsAnswer[];
}

async function lookupMx(domain: string): Promise<string[] | null> {
    try {
        const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, {
            headers: { Accept: 'application/dns-json' },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as DnsResponse;
        if (!data.Answer) return [];
        return data.Answer.filter((a) => a.type === 15)
            .map((a) => {
                const parts = a.data.trim().split(/\s+/);
                return (parts.length > 1 ? parts[1]! : parts[0]!).replace(/\.$/, '').toLowerCase();
            })
            .filter(Boolean);
    } catch {
        return null;
    }
}

function matchedByExisting(host: string): string | null {
    let best: string | null = null;
    let bestLen = 0;
    for (const p of PROVIDERS) {
        for (const m of p.matchers) {
            if ((host === m || host.endsWith(`.${m}`)) && m.length > bestLen) {
                best = p.name;
                bestLen = m.length;
            }
        }
    }
    return best;
}

// "Registered" domain — naive last-two-labels, with a small whitelist of
// two-part TLDs we care about (.co.uk, .com.au, .co.za, .com.cn, …).
const TWO_PART_TLDS = new Set([
    'co.uk',
    'org.uk',
    'gov.uk',
    'ac.uk',
    'com.au',
    'net.au',
    'org.au',
    'co.za',
    'co.nz',
    'com.br',
    'com.cn',
    'com.mx',
    'com.ar',
    'co.jp',
    'or.jp',
    'co.kr',
    'or.kr',
]);

function registeredDomain(host: string): string {
    const labels = host.split('.');
    if (labels.length <= 2) return host;
    const last2 = labels.slice(-2).join('.');
    if (TWO_PART_TLDS.has(last2)) return labels.slice(-3).join('.');
    return last2;
}

interface Cluster {
    count: number;
    sampleDomains: string[];
    sampleHosts: string[];
    allHosts: Set<string>;
}

async function main() {
    const args = parseArgs();

    console.error('Fetching domain lists…');
    const lists = await Promise.all(SOURCES.map(fetchDomains));
    for (let i = 0; i < SOURCES.length; i++) {
        console.error(`  ${(lists[i] ?? []).length.toString().padStart(6)}  ${SOURCES[i]}`);
    }
    const allDomains = [...new Set(lists.flat())].sort();
    console.error(`Unique input domains: ${allDomains.length}`);

    const sample = allDomains.slice(0, args.limit);
    console.error(`Sampling: ${sample.length}`);

    const cache: Record<string, string[] | null> = existsSync(CACHE_PATH)
        ? JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
        : {};
    const todo = sample.filter((d) => !(d in cache));
    console.error(`Already cached: ${sample.length - todo.length}, to fetch: ${todo.length}`);

    const BATCH = 40;
    let done = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async (d) => [d, await lookupMx(d)] as const));
        for (const [d, mx] of results) cache[d] = mx;
        done += batch.length;
        if (done % 400 === 0 || done === todo.length) {
            writeFileSync(CACHE_PATH, JSON.stringify(cache));
            console.error(`  resolved ${done}/${todo.length}`);
        }
    }
    writeFileSync(CACHE_PATH, JSON.stringify(cache));

    // Cluster
    const clusters = new Map<string, Cluster>();
    for (const d of sample) {
        const mxs = cache[d];
        if (!mxs || mxs.length === 0) continue;
        for (const mxHost of mxs) {
            const reg = registeredDomain(mxHost);
            let c = clusters.get(reg);
            if (!c) {
                c = { count: 0, sampleDomains: [], sampleHosts: [], allHosts: new Set() };
                clusters.set(reg, c);
            }
            c.count++;
            c.allHosts.add(mxHost);
            if (c.sampleDomains.length < 5 && !c.sampleDomains.includes(d)) c.sampleDomains.push(d);
            if (c.sampleHosts.length < 3 && !c.sampleHosts.includes(mxHost)) c.sampleHosts.push(mxHost);
        }
    }

    // Filter out clusters already covered by any PROVIDER
    const unknown: Array<{ reg: string; c: Cluster }> = [];
    for (const [reg, c] of clusters) {
        const known = [...c.allHosts].some((h) => matchedByExisting(h));
        if (!known) unknown.push({ reg, c });
    }
    unknown.sort((a, b) => b.c.count - a.c.count);

    // Print top N
    console.log('# Top unknown MX clusters (registered-domain → input-domains-covered)');
    console.log('# count | registered_domain | sample MX hosts | sample input domains');
    for (const { reg, c } of unknown.slice(0, args.top)) {
        console.log(
            `${String(c.count).padStart(6)}  ${reg.padEnd(40)}  ${c.sampleHosts.slice(0, 2).join(',')}  ⇐  ${c.sampleDomains.slice(0, 3).join(',')}`,
        );
    }
    console.error(`\nTotal clusters: ${clusters.size}, unknown: ${unknown.length}`);
}

await main();
