import { DNS_TYPE, type DnsResult, type DnsTypeName, type Resolve } from '../src/dns.ts';

/**
 * A fake DNS zone for the checkers: `{ 'example.com': { TXT: ['v=spf1 -all'] } }`.
 *
 * Names absent from the zone are NXDOMAIN; names present without the
 * requested type answer NOERROR with nothing, which is how real DNS tells the
 * two apart and what the SPF void-lookup count depends on.
 */
export type Zone = Record<
    string,
    Partial<Record<DnsTypeName, string[]>> & { secure?: boolean; servfail?: boolean; cname?: boolean }
>;

export function fakeResolver(zone: Zone): Resolve & { queries: string[] } {
    const queries: string[] = [];
    const fn = async (name: string, type: DnsTypeName): Promise<DnsResult> => {
        queries.push(`${type} ${name}`);
        const node = zone[name.toLowerCase()];
        if (!node) return { status: 3, answers: [], aliased: false, authenticated: false };
        if (node.servfail) return { status: 2, answers: [], aliased: false, authenticated: false };
        const data = node[type] ?? [];
        return {
            status: 0,
            answers: data.map((d) => ({ name, type: DNS_TYPE[type], TTL: 300, data: d })),
            aliased: node.cname === true,
            authenticated: node.secure === true,
        };
    };
    return Object.assign(fn, { queries });
}
