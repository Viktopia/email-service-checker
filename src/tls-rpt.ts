/**
 * SMTP TLS Reporting (RFC 8460): where senders send daily reports of TLS
 * failures delivering to this domain. It is the feedback loop for MTA-STS and
 * DANE, and the only way to learn that either is breaking delivery.
 */

import type { Check } from './checks.ts';
import type { Resolve } from './dns.ts';
import { parseTagList, type TagList, tagValue, txtRecords } from './tags.ts';

export interface TlsRptReport {
    domain: string;
    record: string | null;
    parsed: TagList | null;
    checks: Check[];
}

export function validateRua(value: string): { uris: string[]; errors: string[] } {
    const uris = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const errors: string[] = [];
    if (uris.length === 0) errors.push('rua= lists no destinations.');
    for (const uri of uris) {
        if (/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(uri)) continue;
        if (/^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/i.test(uri)) continue;
        errors.push(`"${uri}" is not a mailto: or https: URI.`);
    }
    return { uris, errors };
}

export async function checkTlsRpt(domain: string, resolve: Resolve): Promise<TlsRptReport> {
    const checks: Check[] = [];
    const report: TlsRptReport = { domain, record: null, parsed: null, checks };
    const name = `_smtp._tls.${domain}`;

    const { records } = await txtRecords(resolve, name, /^v=TLSRPTv1/i);
    if (records.length === 0) {
        checks.push({
            id: 'tlsrpt-record',
            status: 'warn',
            title: 'No TLS-RPT record',
            detail: `Nothing is published at ${name}. If MTA-STS or DANE starts blocking delivery, nobody will be told why. Add one before enforcing either.`,
        });
        return report;
    }
    if (records.length > 1) {
        checks.push({
            id: 'tlsrpt-record',
            status: 'fail',
            title: 'Multiple TLS-RPT records',
            detail: `${name} has ${records.length} records starting with v=TLSRPTv1. Senders treat that as no record and send no reports.`,
        });
        return report;
    }

    report.record = records[0]!;
    const parsed = parseTagList(report.record);
    report.parsed = parsed;
    const errors = [...parsed.errors];
    if (parsed.tags[0]?.name !== 'v' || parsed.tags[0].value !== 'TLSRPTv1') {
        errors.push('The record must start with "v=TLSRPTv1".');
    }
    const rua = tagValue(parsed, 'rua');
    let uris: string[] = [];
    if (rua === undefined) errors.push('rua= is required.');
    else {
        const v = validateRua(rua);
        uris = v.uris;
        errors.push(...v.errors);
    }

    checks.push(
        errors.length > 0
            ? {
                  id: 'tlsrpt-record',
                  status: 'fail',
                  title: 'TLS-RPT record is invalid',
                  detail: errors.join(' '),
              }
            : {
                  id: 'tlsrpt-record',
                  status: 'pass',
                  title: 'TLS-RPT record published',
                  detail: `Daily TLS reports go to ${uris.join(', ')}.`,
              },
    );

    return report;
}
