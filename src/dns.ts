/**
 * DNS over HTTPS, shared by every tool on the site.
 *
 * The MX lookup used to own its resolver loop. The SPF and DMARC checkers need
 * the same thing for TXT, A and AAAA, and they need more of the answer than
 * MX parsing did: whether the name exists at all (an SPF void lookup is
 * NXDOMAIN or an empty answer, and those are counted), and the TXT strings with
 * their quoting undone.
 */

export interface DnsAnswer {
    name: string;
    type: number;
    TTL: number;
    data: string;
}

interface DnsJson {
    Status: number;
    AD?: boolean;
    Answer?: DnsAnswer[];
}

export interface DnsResult {
    /** DNS RCODE: 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN. */
    status: number;
    /** Answers of the requested type only; CNAME hops are dropped. */
    answers: DnsAnswer[];
    /** True when the name was reached through a CNAME. */
    aliased: boolean;
    /**
     * The AD bit: the resolver validated the answer with DNSSEC. Both
     * resolvers validate, so false means unsigned (or the chain is broken,
     * which they report as SERVFAIL instead).
     */
    authenticated: boolean;
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

export const RCODE_NXDOMAIN = 3;

export const DNS_TYPE = {
    A: 1,
    CNAME: 5,
    MX: 15,
    TXT: 16,
    AAAA: 28,
    DS: 43,
    TLSA: 52,
    // The retired SPF record type (RFC 7208 §14.1). Queried only to warn when
    // a domain still publishes it, because nothing reads it any more.
    SPF: 99,
} as const;

export type DnsTypeName = keyof typeof DNS_TYPE;

/**
 * DoH resolvers, tried in order.
 *
 * There used to be only dns.google, so any network that blocks it — a fair
 * number of corporate and national ones — got a bare "DNS lookup failed" with
 * no recourse, even though the tool would have worked fine against another
 * resolver. Both speak the same JSON protocol.
 *
 * index.html preconnects to the first one.
 */
const RESOLVERS = [
    { name: 'Google', url: 'https://dns.google/resolve' },
    { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
] as const;

async function queryResolver(base: string, name: string, type: DnsTypeName): Promise<DnsResult> {
    const url = `${base}?name=${encodeURIComponent(name)}&type=${type}`;
    const res = await fetch(url, { headers: { Accept: 'application/dns-json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as DnsJson;
    const wanted = DNS_TYPE[type];
    const all = data.Answer ?? [];
    return {
        status: data.Status,
        answers: all.filter((a) => a.type === wanted),
        aliased: wanted !== DNS_TYPE.CNAME && all.some((a) => a.type === DNS_TYPE.CNAME),
        authenticated: data.AD === true,
    };
}

/** Resolves one name and type, falling back across resolvers. Throws LookupError if none answer. */
export async function resolve(name: string, type: DnsTypeName): Promise<DnsResult> {
    const failures: string[] = [];

    for (const resolver of RESOLVERS) {
        try {
            return await queryResolver(resolver.url, name, type);
        } catch (err) {
            // Try the next resolver. A blocked or unreachable resolver looks
            // the same from here as one returning an error, and either way the
            // next one is worth attempting.
            failures.push(`${resolver.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    throw new LookupError(`No DNS resolver could be reached (${failures.join('; ')})`);
}

/**
 * Turns a TXT answer's `data` into the record text.
 *
 * The two resolvers disagree here. Google returns the character-strings already
 * joined and unquoted; Cloudflare returns them in zone-file form, quoted and
 * space-separated, as in `"v=spf1 include:a" " -all"`. RFC 7208 §3.3 says the
 * strings are concatenated with no separator, so that is what both become.
 */
export function parseTxtData(data: string): string {
    const s = data.trim();
    if (!s.startsWith('"')) return s;

    let out = '';
    let i = 0;
    while (i < s.length) {
        if (s[i] !== '"') {
            i++;
            continue;
        }
        i++;
        while (i < s.length && s[i] !== '"') {
            if (s[i] === '\\' && i + 1 < s.length) {
                const digits = s.slice(i + 1, i + 4);
                if (/^\d{3}$/.test(digits)) {
                    out += String.fromCharCode(Number.parseInt(digits, 10));
                    i += 4;
                } else {
                    out += s[i + 1];
                    i += 2;
                }
            } else {
                out += s[i];
                i++;
            }
        }
        i++;
    }
    return out;
}

/** The function the checkers depend on, so tests can hand them a fake zone. */
export type Resolve = (name: string, type: DnsTypeName) => Promise<DnsResult>;
