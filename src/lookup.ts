import type { MxRecord } from './types.ts';

interface DnsAnswer {
    name: string;
    type: number;
    TTL: number;
    data: string;
}

interface DnsResponse {
    Status: number;
    Answer?: DnsAnswer[];
}

export class LookupError extends Error {
    constructor(
        message: string,
        public cause?: unknown,
    ) {
        super(message);
        this.name = 'LookupError';
    }
}

/**
 * DoH resolvers, tried in order.
 *
 * There used to be only dns.google, so any network that blocks it — a fair
 * number of corporate and national ones — got a bare "DNS lookup failed" with
 * no recourse, even though the tool would have worked fine against another
 * resolver. Both speak the same JSON protocol and return MX data in the same
 * "10 mx.example.com." shape, so parseMx handles either.
 *
 * index.html preconnects to the first one.
 */
const RESOLVERS = [
    { name: 'Google', url: 'https://dns.google/resolve' },
    { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
] as const;

/** DNS record type for MX. */
const TYPE_MX = 15;

function parseMx(answer: DnsAnswer): MxRecord {
    // Cloudflare and Google both return "10 mx.example.com." in `data`
    const parts = answer.data.trim().split(/\s+/);
    const priority = parts.length > 1 ? Number.parseInt(parts[0]!, 10) : 0;
    const host = (parts.length > 1 ? parts[1]! : parts[0]!).replace(/\.$/, '').toLowerCase();
    return { priority, host };
}

async function queryResolver(base: string, domain: string): Promise<MxRecord[]> {
    const url = `${base}?name=${encodeURIComponent(domain)}&type=MX`;
    const res = await fetch(url, { headers: { Accept: 'application/dns-json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as DnsResponse;
    if (!data.Answer) return [];
    return data.Answer.filter((a) => a.type === TYPE_MX)
        .map(parseMx)
        .sort((a, b) => a.priority - b.priority);
}

export async function lookupMx(domain: string): Promise<MxRecord[]> {
    const failures: string[] = [];

    for (const resolver of RESOLVERS) {
        try {
            return await queryResolver(resolver.url, domain);
        } catch (err) {
            // Try the next resolver. A blocked or unreachable resolver looks
            // the same from here as one returning an error, and either way the
            // next one is worth attempting.
            failures.push(`${resolver.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    throw new LookupError(`No DNS resolver could be reached (${failures.join('; ')})`);
}
