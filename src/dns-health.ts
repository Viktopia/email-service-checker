/**
 * Nameserver and zone health, as far as a browser can see it.
 *
 * Every mail check on this site depends on the domain's DNS answering
 * reliably, so this looks at the delegation itself: enough nameservers, each
 * resolvable and on a public address, not all in one network, sensible SOA
 * timers, and DNSSEC.
 *
 * DNS over HTTPS only reaches recursive resolvers, never the nameservers
 * themselves. So the checks that need to ask each server directly — whether
 * they all answer authoritatively, agree on the SOA serial, or allow zone
 * transfers — are out of reach, and are named as such rather than skipped
 * silently.
 */

import type { Check } from './checks.ts';
import type { Resolve } from './dns.ts';
import { isReservedIPv4, isReservedIPv6 } from './mx-health.ts';

export interface NameServer {
    host: string;
    ipv4: string[];
    ipv6: string[];
}

export interface Soa {
    mname: string;
    rname: string;
    serial: number;
    refresh: number;
    retry: number;
    expire: number;
    minimum: number;
}

export interface DnsHealthReport {
    domain: string;
    /** The zone the NS and SOA were read from: the domain, or a parent. */
    zone: string;
    nameservers: NameServer[];
    soa: Soa | null;
    signed: boolean;
    checks: Check[];
}

export function parseSoa(data: string): Soa | null {
    const p = data.trim().split(/\s+/);
    if (p.length < 7) return null;
    const [mname, rname, ...nums] = p;
    const n = nums.slice(0, 5).map(Number);
    if (n.some((x) => !Number.isFinite(x))) return null;
    return {
        mname: mname!.replace(/\.$/, '').toLowerCase(),
        rname: rname!.replace(/\.$/, '').toLowerCase(),
        serial: n[0]!,
        refresh: n[1]!,
        retry: n[2]!,
        expire: n[3]!,
        minimum: n[4]!,
    };
}

/**
 * Ranges RFC 1912 §2.2 and common operational guidance (RIPE-203) consider
 * sane. Outside them nothing breaks outright, but secondaries go stale or
 * negative answers are cached for too long or too short a time.
 */
export const SOA_RANGES = {
    refresh: { min: 1200, max: 86_400, why: 'how often secondaries check for changes' },
    retry: { min: 120, max: 7200, why: 'how soon a secondary retries after a failed refresh' },
    expire: {
        min: 604_800,
        max: 2_419_200,
        why: 'how long secondaries keep serving the zone without reaching the primary',
    },
    minimum: { min: 300, max: 86_400, why: 'how long resolvers cache "no such name" answers (RFC 2308)' },
} as const;

function human(seconds: number): string {
    if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
    if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
    if (seconds % 60 === 0) return `${seconds / 60} min`;
    return `${seconds} s`;
}

/** The parent of a name, or null at the top level. */
function parent(name: string): string | null {
    const i = name.indexOf('.');
    return i < 0 || name.indexOf('.', i + 1) < 0 ? null : name.slice(i + 1);
}

function slash24(ip: string): string {
    return ip.split('.').slice(0, 3).join('.');
}

export async function checkDnsHealth(domain: string, resolve: Resolve): Promise<DnsHealthReport> {
    const checks: Check[] = [];

    // A subdomain is usually not its own zone; walk up to where NS lives.
    let zone = domain;
    let ns = await resolve(zone, 'NS');
    while (ns.answers.length === 0 && ns.status !== 3) {
        const up = parent(zone);
        if (!up) break;
        zone = up;
        ns = await resolve(zone, 'NS');
    }
    const report: DnsHealthReport = { domain, zone, nameservers: [], soa: null, signed: false, checks };

    if (ns.status === 3 && zone === domain) {
        checks.push({
            id: 'dns-exists',
            status: 'fail',
            title: 'Domain does not exist',
            detail: `${domain} returns NXDOMAIN: it is not registered, or its delegation has been removed.`,
        });
        return report;
    }
    if (ns.status === 2) {
        checks.push({
            id: 'dns-exists',
            status: 'fail',
            title: 'Resolution fails (SERVFAIL)',
            detail: `Resolvers cannot get an answer for ${zone}. The nameservers may be down or unreachable, or DNSSEC validation fails.`,
        });
        return report;
    }

    const hosts = [...new Set(ns.answers.map((a) => a.data.replace(/\.$/, '').toLowerCase()))].sort();
    const [soaRes, ...addrs] = await Promise.all([
        resolve(zone, 'SOA'),
        ...hosts.flatMap((h) => [resolve(h, 'A').catch(() => null), resolve(h, 'AAAA').catch(() => null)]),
    ]);
    report.nameservers = hosts.map((host, i) => ({
        host,
        ipv4: addrs[i * 2]?.answers.map((a) => a.data) ?? [],
        ipv6: addrs[i * 2 + 1]?.answers.map((a) => a.data) ?? [],
    }));
    report.signed = soaRes.authenticated;
    const soaAnswer = soaRes.answers[0];
    report.soa = soaAnswer ? parseSoa(soaAnswer.data) : null;

    if (zone !== domain) {
        checks.push({
            id: 'dns-zone',
            status: 'info',
            title: `Part of the ${zone} zone`,
            detail: `${domain} is not delegated separately, so these results are for ${zone}.`,
        });
    }

    checks.push(
        hosts.length >= 2
            ? {
                  id: 'dns-ns-count',
                  status: 'pass',
                  title: `${hosts.length} nameservers`,
                  detail: 'At least two, as RFC 2182 requires, so one outage does not take the domain offline.',
              }
            : {
                  id: 'dns-ns-count',
                  status: 'fail',
                  title: hosts.length === 1 ? 'Only one nameserver' : 'No nameservers found',
                  detail: 'RFC 2182 requires at least two. With one, its outage makes the whole domain — mail included — unreachable.',
              },
    );

    const dead = report.nameservers.filter((n) => n.ipv4.length + n.ipv6.length === 0);
    if (hosts.length > 0) {
        checks.push(
            dead.length > 0
                ? {
                      id: 'dns-ns-resolve',
                      status: 'fail',
                      title: `${dead.length} nameserver${dead.length === 1 ? ' does' : 's do'} not resolve`,
                      detail: `${dead.map((n) => n.host).join(', ')} ${dead.length === 1 ? 'has' : 'have'} no address. Resolvers waste time on ${dead.length === 1 ? 'it' : 'them'}, and lookups slow down or fail.`,
                  }
                : {
                      id: 'dns-ns-resolve',
                      status: 'pass',
                      title: 'Every nameserver resolves',
                      detail: 'Each nameserver has at least one address.',
                  },
        );
    }

    const privateNs = report.nameservers.filter(
        (n) => n.ipv4.some(isReservedIPv4) || n.ipv6.some(isReservedIPv6),
    );
    if (privateNs.length > 0) {
        checks.push({
            id: 'dns-ns-public',
            status: 'fail',
            title: 'Nameserver on a private address',
            detail: `${privateNs.map((n) => n.host).join(', ')} resolve${privateNs.length === 1 ? 's' : ''} to private or reserved addresses that nobody on the internet can reach.`,
        });
    }

    const v4 = report.nameservers.flatMap((n) => n.ipv4);
    const nets = new Set(v4.map(slash24));
    if (v4.length >= 2) {
        checks.push(
            nets.size > 1
                ? {
                      id: 'dns-ns-diversity',
                      status: 'pass',
                      title: `Spread across ${nets.size} networks`,
                      detail: 'The nameservers are not all in one /24, so a single network problem should not take them all down.',
                  }
                : {
                      id: 'dns-ns-diversity',
                      status: 'warn',
                      title: 'All nameservers in one /24',
                      detail: `Every IPv4 address is in ${[...nets][0]}.0/24. RFC 2182 asks for nameservers in different networks, so one routing problem cannot take them all out. (Anycast providers are an exception.)`,
                  },
        );
    }

    const soa = report.soa;
    if (!soa) {
        checks.push({
            id: 'dns-soa',
            status: 'warn',
            title: 'No SOA record returned',
            detail: `The resolver returned no SOA for ${zone}.`,
        });
    } else {
        const out: string[] = [];
        for (const [field, range] of Object.entries(SOA_RANGES) as Array<
            [keyof typeof SOA_RANGES, (typeof SOA_RANGES)[keyof typeof SOA_RANGES]]
        >) {
            const v = soa[field];
            if (v < range.min || v > range.max) {
                out.push(
                    `${field} is ${human(v)}, outside ${human(range.min)}–${human(range.max)} (${range.why}).`,
                );
            }
        }
        if (soa.retry >= soa.refresh) out.push('retry should be shorter than refresh.');
        checks.push(
            out.length > 0
                ? {
                      // Info, not a warning: large anycast providers (Google,
                      // Apple, Amazon) deliberately run short timers, and
                      // nothing breaks. Worth knowing for a self-run zone.
                      id: 'dns-soa',
                      status: 'info',
                      title: 'SOA timers outside the usual ranges',
                      detail: `${out.join(' ')} Large DNS providers often choose short timers deliberately; for a self-hosted zone, review them.`,
                  }
                : {
                      id: 'dns-soa',
                      status: 'pass',
                      title: 'SOA timers are sensible',
                      detail: `refresh ${human(soa.refresh)}, retry ${human(soa.retry)}, expire ${human(soa.expire)}, negative caching ${human(soa.minimum)}.`,
                  },
        );
    }

    checks.push(
        report.signed
            ? {
                  id: 'dns-dnssec',
                  status: 'pass',
                  title: 'DNSSEC signed and validating',
                  detail: `Answers for ${zone} validate under DNSSEC, so they cannot be forged in transit.`,
              }
            : {
                  id: 'dns-dnssec',
                  status: 'info',
                  title: 'DNSSEC not enabled',
                  detail: 'Answers are not signed. Most domains are in the same position; DNSSEC is what DANE for mail builds on.',
              },
    );

    checks.push({
        id: 'dns-authoritative',
        status: 'manual',
        title: 'Per-server checks not possible',
        detail: 'Whether every nameserver answers authoritatively, agrees on the SOA serial, and refuses zone transfers needs queries sent to each server directly. A browser can only reach public resolvers.',
    });

    return report;
}
