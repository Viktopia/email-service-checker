/**
 * MTA-STS (RFC 8461): a domain's promise that its MX hosts speak TLS with a
 * valid certificate, so senders refuse to deliver in the clear.
 *
 * Two halves. The TXT record at _mta-sts.<domain> is plain DNS and fully
 * checkable. The policy itself is a text file at
 * https://mta-sts.<domain>/.well-known/mta-sts.txt, and a browser can only read
 * it if the server sends CORS headers, which most do not — Google's does not.
 * When it cannot, the checker says so instead of guessing: it can still tell
 * from an opaque request whether the host answers over HTTPS with a
 * certificate the browser trusts, which is most of what goes wrong.
 */

import type { Check } from './checks.ts';
import type { Resolve } from './dns.ts';
import { parseMx } from './lookup.ts';
import { parseTagList, tagValue, txtRecords } from './tags.ts';

export type PolicyFetch =
    | { kind: 'text'; status: number; body: string; contentType: string }
    /** The server answered over valid HTTPS, but without CORS the body is unreadable. */
    | { kind: 'opaque' }
    /** No HTTPS answer at all: DNS, connection or certificate failure. */
    | { kind: 'error' };

export type FetchPolicy = (url: string) => Promise<PolicyFetch>;

/** The browser implementation: a CORS read, falling back to an opaque probe. */
export const browserFetchPolicy: FetchPolicy = async (url) => {
    try {
        const res = await fetch(url, { redirect: 'error', cache: 'no-store' });
        return {
            kind: 'text',
            status: res.status,
            body: await res.text(),
            contentType: res.headers.get('content-type') ?? '',
        };
    } catch {
        try {
            // no-cors requests must follow redirects (Fetch spec); 'error' makes
            // every one of them throw, which read as an unreachable host.
            await fetch(url, { mode: 'no-cors', cache: 'no-store' });
            return { kind: 'opaque' };
        } catch {
            return { kind: 'error' };
        }
    }
};

export interface StsPolicy {
    version?: string;
    mode?: string;
    mx: string[];
    maxAge?: number;
    errors: string[];
}

/** RFC 8461 §3.2: one year is the most a policy may be cached. */
export const MAX_AGE_LIMIT = 31_557_600;

export function parseStsPolicy(body: string): StsPolicy {
    const policy: StsPolicy = { mx: [], errors: [] };
    for (const raw of body.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const colon = line.indexOf(':');
        if (colon < 0) {
            policy.errors.push(`"${line}" is not a key: value line.`);
            continue;
        }
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        switch (key) {
            case 'version':
                policy.version = value;
                break;
            case 'mode':
                policy.mode = value;
                break;
            case 'mx':
                policy.mx.push(value.toLowerCase());
                break;
            case 'max_age':
                policy.maxAge = /^\d{1,10}$/.test(value) ? Number(value) : Number.NaN;
                break;
            default:
                // Unknown keys are allowed and ignored (§3.2).
                break;
        }
    }
    if (policy.version !== 'STSv1') policy.errors.push('version must be "STSv1".');
    if (!policy.mode || !['enforce', 'testing', 'none'].includes(policy.mode)) {
        policy.errors.push('mode must be enforce, testing or none.');
    }
    if (policy.maxAge === undefined) policy.errors.push('max_age is required.');
    else if (Number.isNaN(policy.maxAge) || policy.maxAge > MAX_AGE_LIMIT) {
        policy.errors.push(`max_age must be a whole number of seconds up to ${MAX_AGE_LIMIT}.`);
    }
    if (policy.mode !== 'none' && policy.mx.length === 0)
        policy.errors.push('At least one mx: line is required.');
    return policy;
}

/** §4.1: "*.example.com" matches exactly one extra leftmost label. */
export function mxMatches(pattern: string, host: string): boolean {
    const p = pattern.replace(/\.$/, '');
    const h = host.replace(/\.$/, '');
    if (p.startsWith('*.')) {
        const suffix = p.slice(1);
        return h.endsWith(suffix) && !h.slice(0, -suffix.length).includes('.') && h.length > suffix.length;
    }
    return p === h;
}

export interface MtaStsReport {
    domain: string;
    record: string | null;
    policyUrl: string;
    policy: StsPolicy | null;
    policyText: string | null;
    checks: Check[];
}

export async function checkMtaSts(
    domain: string,
    resolve: Resolve,
    fetchPolicy: FetchPolicy = browserFetchPolicy,
): Promise<MtaStsReport> {
    const checks: Check[] = [];
    const policyUrl = `https://mta-sts.${domain}/.well-known/mta-sts.txt`;
    const report: MtaStsReport = { domain, record: null, policyUrl, policy: null, policyText: null, checks };

    const { records } = await txtRecords(resolve, `_mta-sts.${domain}`, /^v=STSv1/i);
    if (records.length === 0) {
        checks.push({
            id: 'sts-record',
            status: 'fail',
            title: 'No MTA-STS record',
            detail: `Nothing is published at _mta-sts.${domain}. Senders deliver over TLS if they can, but fall back to plaintext without complaint, so an attacker on the path can strip encryption.`,
        });
        return report;
    }
    if (records.length > 1) {
        checks.push({
            id: 'sts-record',
            status: 'fail',
            title: 'Multiple MTA-STS records',
            detail: `_mta-sts.${domain} has ${records.length} records starting with v=STSv1. Senders treat that as no policy at all.`,
        });
        return report;
    }

    report.record = records[0]!;
    const txt = parseTagList(report.record);
    const id = tagValue(txt, 'id');
    const recordErrors = [...txt.errors];
    if (tagValue(txt, 'v') !== 'STSv1') recordErrors.push('v must be exactly "STSv1" and come first.');
    if (!id) recordErrors.push('id= is required.');
    else if (!/^[A-Za-z0-9]{1,32}$/.test(id)) recordErrors.push(`id=${id} must be 1-32 letters and digits.`);
    checks.push(
        recordErrors.length > 0
            ? {
                  id: 'sts-record',
                  status: 'fail',
                  title: 'MTA-STS record is invalid',
                  detail: recordErrors.join(' '),
              }
            : {
                  id: 'sts-record',
                  status: 'pass',
                  title: 'MTA-STS record published',
                  detail: `_mta-sts.${domain} announces a policy with id ${id}. Change the id whenever the policy file changes, or senders keep the cached copy.`,
              },
    );

    const [hostA, hostAAAA, mx] = await Promise.all([
        resolve(`mta-sts.${domain}`, 'A').catch(() => null),
        resolve(`mta-sts.${domain}`, 'AAAA').catch(() => null),
        resolve(domain, 'MX')
            .then((r) => r.answers.map(parseMx))
            .catch(() => null),
    ]);
    if (hostA && hostAAAA && hostA.answers.length === 0 && hostAAAA.answers.length === 0) {
        checks.push({
            id: 'sts-host',
            status: 'fail',
            title: `mta-sts.${domain} does not resolve`,
            detail: 'The policy has to be served from this host over HTTPS. Without it, senders cannot fetch the policy and MTA-STS does nothing.',
        });
        return report;
    }

    const fetched = await fetchPolicy(policyUrl);
    if (fetched.kind === 'error') {
        checks.push({
            id: 'sts-policy',
            status: 'fail',
            title: 'Policy host not reachable over HTTPS',
            detail: `${policyUrl} did not answer over HTTPS with a certificate this browser trusts. Senders need a valid certificate for mta-sts.${domain}, so they will ignore the policy. (A browser extension blocking the request can also cause this.)`,
        });
        return report;
    }
    if (fetched.kind === 'opaque') {
        checks.push({
            id: 'sts-policy',
            status: 'manual',
            title: 'Policy file not readable from a browser',
            detail: `mta-sts.${domain} answers over HTTPS with a valid certificate, but does not send CORS headers, so a web page cannot read the policy. That is normal and does not affect senders. Open ${policyUrl} to check mode, mx and max_age yourself.`,
        });
        return report;
    }

    if (fetched.status !== 200) {
        checks.push({
            id: 'sts-policy',
            status: 'fail',
            title: `Policy file returns HTTP ${fetched.status}`,
            detail: `${policyUrl} must return 200 with the policy. Senders treat anything else as no policy.`,
        });
        return report;
    }

    report.policyText = fetched.body;
    const policy = parseStsPolicy(fetched.body);
    report.policy = policy;
    if (!/^text\/plain\b/i.test(fetched.contentType)) {
        policy.errors.push(
            `It is served as "${fetched.contentType || 'no content type'}"; RFC 8461 requires text/plain.`,
        );
    }
    checks.push(
        policy.errors.length > 0
            ? {
                  id: 'sts-policy',
                  status: 'fail',
                  title: 'Policy file is invalid',
                  detail: policy.errors.join(' '),
              }
            : {
                  id: 'sts-policy',
                  status: 'pass',
                  title: 'Policy file is valid',
                  detail: `Served from ${policyUrl}.`,
              },
    );

    if (policy.mode === 'enforce') {
        checks.push({
            id: 'sts-mode',
            status: 'pass',
            title: 'Mode: enforce',
            detail: 'Senders that support MTA-STS refuse to deliver unless TLS succeeds with a valid certificate for a listed MX.',
        });
    } else if (policy.mode === 'testing') {
        checks.push({
            id: 'sts-mode',
            status: 'warn',
            title: 'Mode: testing',
            detail: 'Senders report failures (via TLS-RPT) but still deliver over an unprotected connection. Move to enforce once the reports are clean.',
        });
    } else if (policy.mode === 'none') {
        checks.push({
            id: 'sts-mode',
            status: 'warn',
            title: 'Mode: none',
            detail: 'The policy is switched off. This is how MTA-STS is retired; if that was not the intent, use testing or enforce.',
        });
    }

    if (policy.maxAge !== undefined && !Number.isNaN(policy.maxAge) && policy.maxAge < 86_400) {
        checks.push({
            id: 'sts-max-age',
            status: 'warn',
            title: `Short max_age (${policy.maxAge} seconds)`,
            detail: 'Senders forget the policy quickly, which gives an attacker a window to block the policy fetch. RFC 8461 suggests weeks; 604800 (one week) or more is common.',
        });
    }

    if (mx && mx.length > 0 && policy.mx.length > 0) {
        const unmatched = mx.filter((r) => !policy.mx.some((p) => mxMatches(p, r.host))).map((r) => r.host);
        checks.push(
            unmatched.length > 0
                ? {
                      id: 'sts-mx-match',
                      status: policy.mode === 'enforce' ? 'fail' : 'warn',
                      title: 'MX hosts missing from the policy',
                      detail: `${unmatched.join(', ')} ${unmatched.length === 1 ? 'is' : 'are'} not covered by any mx: line. In enforce mode, senders will refuse to deliver to ${unmatched.length === 1 ? 'it' : 'them'}.`,
                  }
                : {
                      id: 'sts-mx-match',
                      status: 'pass',
                      title: 'Every MX host is covered',
                      detail: 'Each published MX record matches an mx: line in the policy.',
                  },
        );
    }

    return report;
}
