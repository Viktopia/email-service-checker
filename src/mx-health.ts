/**
 * Checks over a domain's MX records, for the MX lookup page.
 *
 * The provider match says who runs the mail; these say whether the records
 * would actually deliver it: every host resolves, none is an IP literal or a
 * CNAME, none points into private address space. Each host costs an A and an
 * AAAA query, run in parallel.
 */

import type { Check } from './checks.ts';
import type { Resolve } from './dns.ts';
import { isNullMx } from './identify.ts';
import { isIPv4, isIPv6 } from './spf.ts';
import type { MxRecord } from './types.ts';

export { isNullMx };

export interface MxHost extends MxRecord {
    ipv4: string[];
    ipv6: string[];
    aliased: boolean;
    /** True when the address lookups themselves failed, so absence proves nothing. */
    unresolved: boolean;
}

export interface MxHealth {
    hosts: MxHost[];
    checks: Check[];
}

/**
 * Private, loopback, link-local, CGNAT, documentation and other
 * non-routable IPv4 space (RFC 6890). Only the specific /24s in 192.0.0.0/16
 * are special: the rest is ordinary allocated space — ICANN's mail servers
 * and Automattic's (WordPress, Tumblr) live in it.
 */
export function isReservedIPv4(ip: string): boolean {
    const [a, b, c] = ip.split('.').map(Number) as [number, number, number];
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0 && (c === 0 || c === 2)) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224
    );
}

export function isReservedIPv6(ip: string): boolean {
    const s = ip.toLowerCase();
    return s === '::1' || s === '::' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('2001:db8:');
}

async function resolveHost(resolve: Resolve, mx: MxRecord): Promise<MxHost> {
    try {
        const [a, aaaa] = await Promise.all([resolve(mx.host, 'A'), resolve(mx.host, 'AAAA')]);
        return {
            ...mx,
            ipv4: a.answers.map((x) => x.data),
            ipv6: aaaa.answers.map((x) => x.data),
            aliased: a.aliased || aaaa.aliased,
            unresolved: false,
        };
    } catch {
        return { ...mx, ipv4: [], ipv6: [], aliased: false, unresolved: true };
    }
}

export async function checkMx(records: readonly MxRecord[], resolve: Resolve): Promise<MxHealth> {
    const checks: Check[] = [];

    if (records.length === 0) {
        checks.push({
            id: 'mx-published',
            status: 'fail',
            title: 'No MX records',
            detail: 'Senders fall back to the domain’s own A record, which is rarely a mail server, so mail will usually bounce. If the domain should never receive mail, publish a null MX instead.',
        });
        return { hosts: [], checks };
    }

    if (isNullMx(records)) {
        checks.push({
            id: 'mx-null',
            status: 'info',
            title: 'Null MX: this domain accepts no mail',
            detail: 'The single "." record (RFC 7505) tells senders not to try at all, so mail is rejected immediately instead of queueing. That is the right setup for a domain that never receives email.',
        });
        return { hosts: [], checks };
    }

    checks.push({
        id: 'mx-published',
        status: 'pass',
        title: `${records.length} MX record${records.length === 1 ? '' : 's'} published`,
        detail: 'The domain names the servers that accept its mail.',
    });

    const literals = records.filter((r) => isIPv4(r.host) || isIPv6(r.host));
    const named = records.filter((r) => !literals.includes(r));
    if (literals.length > 0) {
        checks.push({
            id: 'mx-ip-literal',
            status: 'fail',
            title: 'MX points at an IP address',
            detail: `An MX record must name a host, not an address: ${literals.map((r) => r.host).join(', ')}. Many senders reject it outright. Create an A record and point the MX at that.`,
        });
    }

    const hosts = await Promise.all(named.map((r) => resolveHost(resolve, r)));

    const dead = hosts.filter((h) => !h.unresolved && h.ipv4.length === 0 && h.ipv6.length === 0);
    checks.push(
        dead.length > 0
            ? {
                  id: 'mx-resolves',
                  status: 'fail',
                  title: `${dead.length} MX host${dead.length === 1 ? ' does' : 's do'} not resolve`,
                  detail: `${dead.map((h) => h.host).join(', ')} ${dead.length === 1 ? 'has' : 'have'} no A or AAAA record, so senders cannot connect.`,
              }
            : {
                  id: 'mx-resolves',
                  status: 'pass',
                  title: 'Every MX host resolves',
                  detail: 'Each mail exchanger has at least one address.',
              },
    );

    const aliased = hosts.filter((h) => h.aliased);
    if (aliased.length > 0) {
        checks.push({
            id: 'mx-cname',
            status: 'warn',
            title: 'MX host is a CNAME',
            detail: `${aliased.map((h) => h.host).join(', ')} ${aliased.length === 1 ? 'is an alias' : 'are aliases'}. RFC 2181 says an MX must point at a name with its own address records. Most senders cope, but not all.`,
        });
    }

    const reserved = hosts.filter((h) => h.ipv4.some(isReservedIPv4) || h.ipv6.some(isReservedIPv6));
    if (reserved.length > 0) {
        checks.push({
            id: 'mx-public-ip',
            status: 'fail',
            title: 'MX host has a private or reserved address',
            detail: `${reserved.map((h) => `${h.host} (${[...h.ipv4.filter(isReservedIPv4), ...h.ipv6.filter(isReservedIPv6)].join(', ')})`).join('; ')}. Nobody on the internet can deliver to it.`,
        });
    } else if (hosts.some((h) => h.ipv4.length + h.ipv6.length > 0)) {
        checks.push({
            id: 'mx-public-ip',
            status: 'pass',
            title: 'All addresses are public',
            detail: 'No MX host resolves into private, loopback or reserved address space.',
        });
    }

    const counts = new Map<string, number>();
    for (const r of records) counts.set(r.host, (counts.get(r.host) ?? 0) + 1);
    const dupes = [...counts].filter(([, n]) => n > 1).map(([h]) => h);
    if (dupes.length > 0) {
        checks.push({
            id: 'mx-duplicate',
            status: 'warn',
            title: 'Duplicate MX host',
            detail: `${dupes.join(', ')} ${dupes.length === 1 ? 'is' : 'are'} listed more than once. Only one entry is used.`,
        });
    }

    const distinct = counts.size;
    checks.push(
        distinct > 1
            ? {
                  id: 'mx-redundancy',
                  status: 'pass',
                  title: `${distinct} distinct mail exchangers`,
                  detail: 'If one is unreachable, senders try the next, so mail queues rather than bounces.',
              }
            : {
                  id: 'mx-redundancy',
                  status: 'info',
                  title: 'A single mail exchanger',
                  detail: 'There is no fallback host. That is normal for large providers that load-balance behind one name, such as Microsoft 365, and a risk for a single self-hosted server.',
              },
    );

    const v6 = hosts.filter((h) => h.ipv6.length > 0).length;
    checks.push({
        id: 'mx-ipv6',
        status: 'info',
        title:
            v6 > 0
                ? `IPv6 reachable (${v6} of ${hosts.length} host${hosts.length === 1 ? '' : 's'})`
                : 'No IPv6 addresses',
        detail:
            v6 > 0
                ? 'Senders on IPv6-only networks can reach this domain directly.'
                : 'None of the mail exchangers has an AAAA record. Mail still flows over IPv4.',
    });

    return { hosts, checks };
}
