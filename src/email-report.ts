/**
 * Every check at once, for /tools/email-security-report/.
 *
 * Deliberately not a score. Each standard keeps its own verdict, and the
 * "not verifiable" ones stay visible, so a domain that publishes a few TXT
 * records does not come out looking secure. The per-tool pages hold the
 * detail; this links to them.
 */

import { checkBimi } from './bimi.ts';
import { type Check, type CheckStatus, sortChecks, verdict } from './checks.ts';
import { checkDane } from './dane.ts';
import { checkDkim } from './dkim.ts';
import { checkDmarc } from './dmarc.ts';
import type { Resolve } from './dns.ts';
import { checkDnsHealth } from './dns-health.ts';
import { parseMx } from './lookup.ts';
import { checkMtaSts, type FetchPolicy } from './mta-sts.ts';
import { checkMx } from './mx-health.ts';
import { checkSpf } from './spf.ts';
import { checkTlsRpt } from './tls-rpt.ts';

export interface ReportLine {
    key: string;
    label: string;
    /** What the standard is for, in a few words. */
    role: string;
    href: string;
    status: CheckStatus;
    /** The most important finding: the first error, warning or unverifiable check, else a pass. */
    headline: string;
    checks: Check[];
}

export interface EmailReport {
    domain: string;
    lines: ReportLine[];
}

/**
 * Info-level findings that are the story of a line rather than a footnote:
 * the standard is simply not in use, by choice. Without this, a domain with
 * no BIMI record read "Pass — all checks passed" on the strength of its DMARC.
 */
const ABSENCE = new Set(['bimi-record', 'mx-null', 'dkim-wildcard']);

function summarise(checks: Check[]): { status: CheckStatus; headline: string } {
    const status = verdict(checks);
    const absent = checks.find((c) => c.status === 'info' && ABSENCE.has(c.id));
    if (status === 'pass' && absent) return { status: 'info', headline: absent.title };
    const top = sortChecks(checks)[0];
    if (!top) return { status, headline: 'No result' };
    return { status, headline: top.status === 'pass' && checks.length > 1 ? 'All checks passed' : top.title };
}

function line(key: string, label: string, role: string, slug: string, checks: Check[]): ReportLine {
    return { key, label, role, href: slug, checks, ...summarise(checks) };
}

/** Runs everything in parallel. A checker that throws becomes a failed line rather than sinking the report. */
export async function buildEmailReport(
    domain: string,
    resolve: Resolve,
    fetchPolicy?: FetchPolicy,
): Promise<EmailReport> {
    const failed = (err: unknown): Check[] => [
        {
            id: 'error',
            status: 'manual',
            title: 'Check could not run',
            detail: err instanceof Error ? err.message : String(err),
        },
    ];
    const safe = (p: Promise<Check[]>) => p.catch(failed);

    // Shared by the MX and DANE lines. Left to reject, so a resolver failure
    // reads as "could not run" on both rather than as "no MX records".
    const mx = resolve(domain, 'MX').then((r) =>
        r.answers.map(parseMx).sort((a, b) => a.priority - b.priority),
    );

    const [mxChecks, spf, dmarc, dkim, mtaSts, tlsRpt, dane, bimi, dns] = await Promise.all([
        safe(mx.then((m) => checkMx(m, resolve)).then((r) => r.checks)),
        safe(checkSpf(domain, resolve).then((r) => r.checks)),
        safe(checkDmarc(domain, resolve).then((r) => r.checks)),
        safe(checkDkim(domain, null, resolve).then((r) => r.checks)),
        safe(checkMtaSts(domain, resolve, fetchPolicy).then((r) => r.checks)),
        safe(checkTlsRpt(domain, resolve).then((r) => r.checks)),
        safe(mx.then((m) => checkDane(domain, m, resolve)).then((r) => r.checks)),
        safe(checkBimi(domain, resolve).then((r) => r.checks)),
        safe(checkDnsHealth(domain, resolve).then((r) => r.checks)),
    ]);

    return {
        domain,
        lines: [
            line('mx', 'MX', 'Receiving mail', '/mx-lookup/', mxChecks),
            line('spf', 'SPF', 'Who may send', '/tools/spf-checker/', spf),
            line('dkim', 'DKIM', 'Message signing', '/tools/dkim-checker/', dkim),
            line('dmarc', 'DMARC', 'Spoofing policy', '/tools/dmarc-checker/', dmarc),
            line('mta-sts', 'MTA-STS', 'Encryption in transit', '/tools/mta-sts-checker/', mtaSts),
            line('tls-rpt', 'TLS-RPT', 'TLS failure reports', '/tools/tls-rpt-checker/', tlsRpt),
            line('dane', 'DNSSEC & DANE', 'Signed DNS, pinned certificates', '/tools/dane-checker/', dane),
            line('bimi', 'BIMI', 'Brand logo', '/tools/bimi-checker/', bimi),
            line('dns', 'DNS', 'Nameserver health', '/tools/dns-checker/', dns),
        ],
    };
}
