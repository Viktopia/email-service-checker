/**
 * DNSSEC and DANE for SMTP (RFC 7672).
 *
 * DANE publishes the fingerprint of each MX host's TLS certificate in a TLSA
 * record at _25._tcp.<mx host>, and DNSSEC is what makes that record
 * trustworthy. Both public resolvers validate DNSSEC and set the AD bit on
 * answers whose chain of signatures checks out, so the browser can rely on it
 * without validating anything itself.
 *
 * What a browser cannot do is open an SMTP connection, so whether the TLSA
 * records match the certificates the servers actually present is reported as
 * not verifiable rather than assumed.
 */

import type { Check } from './checks.ts';
import type { Resolve } from './dns.ts';
import { isNullMx } from './mx-health.ts';
import type { MxRecord } from './types.ts';

export interface Tlsa {
    usage: number;
    selector: number;
    matching: number;
    data: string;
    error?: string;
}

export interface DaneHost {
    host: string;
    priority: number;
    /** The host's own address records validated under DNSSEC. */
    secure: boolean;
    tlsa: Tlsa[];
    /** The TLSA answer itself validated. */
    tlsaSecure: boolean;
    failed: boolean;
}

export interface DaneReport {
    domain: string;
    signed: boolean;
    hasDs: boolean;
    hosts: DaneHost[];
    checks: Check[];
}

export const TLSA_USAGE: Record<number, string> = {
    0: 'PKIX-TA',
    1: 'PKIX-EE',
    2: 'DANE-TA',
    3: 'DANE-EE',
};

const DIGEST_HEX: Record<number, number> = { 1: 64, 2: 128 };

/** Parses TLSA rdata as either resolver formats it: "3 1 1 abcd…" or "3 1 1 ( ABCD… )". */
export function parseTlsa(data: string): Tlsa {
    const parts = data.replace(/[()]/g, ' ').trim().split(/\s+/);
    const [u, s, m, ...rest] = parts;
    const t: Tlsa = {
        usage: Number(u),
        selector: Number(s),
        matching: Number(m),
        data: rest.join('').toLowerCase(),
    };
    if (![0, 1, 2, 3].includes(t.usage)) t.error = `unknown certificate usage ${u}`;
    else if (![0, 1].includes(t.selector)) t.error = `unknown selector ${s}`;
    else if (![0, 1, 2].includes(t.matching)) t.error = `unknown matching type ${m}`;
    else if (!/^[0-9a-f]+$/.test(t.data)) t.error = 'association data is not hex';
    else if (DIGEST_HEX[t.matching] && t.data.length !== DIGEST_HEX[t.matching]) {
        t.error = `a ${t.matching === 1 ? 'SHA-256' : 'SHA-512'} digest should be ${DIGEST_HEX[t.matching]! / 2} bytes, found ${t.data.length / 2}`;
    }
    return t;
}

export function describeTlsa(t: Tlsa): string {
    return `${t.usage} ${t.selector} ${t.matching} — ${TLSA_USAGE[t.usage] ?? '?'}, ${t.selector === 1 ? 'public key' : 'full certificate'}, ${['exact match', 'SHA-256', 'SHA-512'][t.matching] ?? '?'}`;
}

async function probeHost(resolve: Resolve, mx: MxRecord): Promise<DaneHost> {
    const host: DaneHost = {
        host: mx.host,
        priority: mx.priority,
        secure: false,
        tlsa: [],
        tlsaSecure: false,
        failed: false,
    };
    try {
        const [a, tlsa] = await Promise.all([resolve(mx.host, 'A'), resolve(`_25._tcp.${mx.host}`, 'TLSA')]);
        host.secure = a.authenticated;
        host.tlsa = tlsa.answers.map((x) => parseTlsa(x.data));
        host.tlsaSecure = tlsa.authenticated;
        // SERVFAIL from a validating resolver on a name that should exist is
        // what a broken signature looks like from here.
        if (a.status === 2 || tlsa.status === 2) host.failed = true;
    } catch {
        host.failed = true;
    }
    return host;
}

export async function checkDane(
    domain: string,
    mx: readonly MxRecord[],
    resolve: Resolve,
): Promise<DaneReport> {
    const checks: Check[] = [];
    const [mxAnswer, ds] = await Promise.all([
        resolve(domain, 'MX'),
        resolve(domain, 'DS').catch(() => null),
    ]);
    const signed = mxAnswer.authenticated;
    const hasDs = (ds?.answers.length ?? 0) > 0;
    const report: DaneReport = { domain, signed, hasDs, hosts: [], checks };

    if (mxAnswer.status === 2) {
        checks.push({
            id: 'dnssec',
            status: 'fail',
            title: 'DNSSEC validation fails',
            detail: `The resolver returned SERVFAIL for ${domain}, which is what a broken DNSSEC chain looks like: validating resolvers will treat the whole domain as unreachable. Check the DS record at the registrar against the zone's keys.`,
        });
        return report;
    }

    checks.push(
        signed
            ? {
                  id: 'dnssec',
                  status: 'pass',
                  title: 'DNSSEC signed and validating',
                  detail: `Answers for ${domain} validate under DNSSEC${hasDs ? ', and the parent zone publishes its DS record' : ''}. That is the prerequisite for DANE.`,
              }
            : {
                  id: 'dnssec',
                  status: 'warn',
                  title: 'DNSSEC not enabled',
                  detail: `Answers for ${domain} are not DNSSEC-validated, so its records — MX included — can be forged by anyone able to spoof DNS. DANE cannot work without it.`,
              },
    );

    if (mx.length === 0 || isNullMx(mx)) {
        checks.push({
            id: 'dane-mx',
            status: 'info',
            title: 'No mail servers to check',
            detail: `${domain} publishes no usable MX records, so there is nothing for DANE to protect.`,
        });
        return report;
    }

    report.hosts = await Promise.all(mx.map((r) => probeHost(resolve, r)));
    const withTlsa = report.hosts.filter((h) => h.tlsa.length > 0);

    if (withTlsa.length === 0) {
        checks.push({
            id: 'dane-tlsa',
            status: signed ? 'warn' : 'info',
            title: 'No TLSA records',
            detail: signed
                ? 'The zone is signed but no MX host publishes a TLSA record at _25._tcp.<host>, so senders get no DANE protection. If the mail is hosted, ask the provider whether it supports inbound DANE.'
                : 'None of the MX hosts publishes a TLSA record. Enable DNSSEC first, then publish TLSA records for each MX host.',
        });
        return report;
    }

    const insecure = withTlsa.filter((h) => !h.tlsaSecure || !h.secure);
    if (insecure.length > 0) {
        checks.push({
            id: 'dane-secure',
            status: 'fail',
            title: 'TLSA records without DNSSEC',
            detail: `${insecure.map((h) => h.host).join(', ')} publish${insecure.length === 1 ? 'es' : ''} TLSA records that do not validate. Senders ignore unsigned TLSA records, so they give no protection.`,
        });
    }

    const missing = report.hosts.filter((h) => h.tlsa.length === 0 && !h.failed);
    checks.push(
        missing.length > 0
            ? {
                  id: 'dane-coverage',
                  status: 'warn',
                  title: `${missing.length} of ${report.hosts.length} MX hosts lack TLSA`,
                  detail: `${missing.map((h) => h.host).join(', ')}. An attacker who can block the protected hosts pushes delivery to these instead.`,
              }
            : {
                  id: 'dane-coverage',
                  status: 'pass',
                  title: 'Every MX host has TLSA records',
                  detail: 'Each mail exchanger publishes certificate fingerprints at _25._tcp.<host>.',
              },
    );

    const broken = withTlsa.flatMap((h) => h.tlsa.filter((t) => t.error).map((t) => `${h.host}: ${t.error}`));
    if (broken.length > 0) {
        checks.push({
            id: 'dane-syntax',
            status: 'fail',
            title: 'Malformed TLSA record',
            detail: `${broken.join('; ')}.`,
        });
    }

    const pkix = withTlsa.filter((h) => h.tlsa.some((t) => t.usage === 0 || t.usage === 1));
    if (pkix.length > 0) {
        checks.push({
            id: 'dane-usage',
            status: 'warn',
            title: 'PKIX-TA or PKIX-EE usage',
            detail: `RFC 7672 says SMTP senders treat usages 0 and 1 as unusable, because there is no agreed set of trusted CAs for SMTP. Use 3 1 1 (DANE-EE, public key, SHA-256) or 2 1 1. Found on ${pkix.map((h) => h.host).join(', ')}.`,
        });
    }

    checks.push({
        id: 'dane-match',
        status: 'manual',
        title: 'Certificate match not checked',
        detail: 'Confirming that the TLSA records match the certificates the mail servers present needs an SMTP connection on port 25, which a browser cannot make. A stale TLSA record after a certificate renewal blocks delivery from DANE-aware senders, so check it whenever certificates change.',
    });

    return report;
}
