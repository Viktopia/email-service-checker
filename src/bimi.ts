/**
 * BIMI: the record that lets supporting mailbox providers show a brand's logo
 * next to authenticated mail.
 *
 * The DNS half is checkable: the record at default._bimi.<domain>, and the
 * DMARC policy BIMI insists on, since a logo on spoofable mail would be worse
 * than none. The logo (an SVG Tiny PS file) and the mark certificate are on
 * third-party hosts that rarely send CORS headers, so their contents are left
 * to the reader rather than reported as fine.
 */

import type { Check } from './checks.ts';
import { checkDmarc, type DmarcReport } from './dmarc.ts';
import type { Resolve } from './dns.ts';
import { parseTagList, type TagList, tagValue, txtRecords } from './tags.ts';

export interface BimiReport {
    domain: string;
    record: string | null;
    parsed: TagList | null;
    dmarc: DmarcReport;
    checks: Check[];
}

export async function checkBimi(domain: string, resolve: Resolve, selector = 'default'): Promise<BimiReport> {
    const checks: Check[] = [];
    const name = `${selector}._bimi.${domain}`;
    const [{ records }, dmarc] = await Promise.all([
        txtRecords(resolve, name, /^v=BIMI1/i),
        checkDmarc(domain, resolve),
    ]);
    const report: BimiReport = { domain, record: null, parsed: null, dmarc, checks };

    // DMARC first: it decides whether a BIMI record can do anything at all.
    const tags = dmarc.parsed?.tags ?? [];
    const get = (n: string) => tags.find((t) => t.name === n)?.value.toLowerCase();
    const inherited = dmarc.policyDomain !== null && dmarc.policyDomain !== domain;
    const policy = inherited ? (get('sp') ?? get('p')) : get('p');
    const pct = get('pct');
    const enforcing = policy === 'quarantine' || policy === 'reject';
    const problems: string[] = [];
    if (!dmarc.policyDomain) problems.push('there is no DMARC record');
    else if (!enforcing) problems.push(`the DMARC policy is ${policy ? `p=${policy}` : 'missing'}`);
    if (pct !== undefined && pct !== '100') problems.push(`pct=${pct} (it must be 100, or absent)`);
    if (!inherited && get('sp') === 'none') problems.push('sp=none leaves subdomains unprotected');
    checks.push(
        problems.length > 0
            ? {
                  id: 'bimi-dmarc',
                  status: 'fail',
                  title: 'DMARC does not meet BIMI requirements',
                  detail: `BIMI needs DMARC at quarantine or reject, applied to all mail. Here ${problems.join(', ')}. No provider will show the logo until that is fixed.`,
              }
            : {
                  id: 'bimi-dmarc',
                  status: 'pass',
                  title: `DMARC enforced (${policy})`,
                  detail: 'The domain’s DMARC policy is strong enough for BIMI.',
              },
    );

    if (records.length === 0) {
        checks.push({
            id: 'bimi-record',
            status: 'info',
            title: 'No BIMI record',
            detail: `Nothing is published at ${name}. BIMI is optional; it only affects whether a logo appears in supporting inboxes.`,
        });
        return report;
    }
    if (records.length > 1) {
        checks.push({
            id: 'bimi-record',
            status: 'fail',
            title: 'Multiple BIMI records',
            detail: `${name} has ${records.length} records starting with v=BIMI1. Providers ignore all of them.`,
        });
        return report;
    }

    report.record = records[0]!;
    const parsed = parseTagList(report.record);
    report.parsed = parsed;
    const errors = [...parsed.errors];
    if (parsed.tags[0]?.name !== 'v' || parsed.tags[0].value !== 'BIMI1')
        errors.push('The record must start with "v=BIMI1".');
    const l = tagValue(parsed, 'l');
    const a = tagValue(parsed, 'a');
    if (l === undefined) errors.push('l= (the logo URL) is required; leave it empty only to opt out.');
    else if (l !== '' && !/^https:\/\/\S+$/i.test(l)) errors.push(`l=${l} must be an https:// URL.`);
    if (a && !/^https:\/\/\S+$/i.test(a)) errors.push(`a=${a} must be an https:// URL.`);

    checks.push(
        errors.length > 0
            ? { id: 'bimi-record', status: 'fail', title: 'BIMI record is invalid', detail: errors.join(' ') }
            : l === ''
              ? {
                    id: 'bimi-record',
                    status: 'info',
                    title: 'BIMI opt-out record',
                    detail: 'The record has an empty l=, which declares that this domain has no logo.',
                }
              : {
                    id: 'bimi-record',
                    status: 'pass',
                    title: 'BIMI record published',
                    detail: `The logo is at ${l}.`,
                },
    );

    if (l && /^https:/i.test(l) && !/\.svg(\?|$)/i.test(l)) {
        checks.push({
            id: 'bimi-svg',
            status: 'warn',
            title: 'Logo URL is not an .svg',
            detail: 'BIMI logos must be SVG files in the SVG Tiny Portable/Secure profile.',
        });
    }

    if (l) {
        checks.push(
            a
                ? {
                      id: 'bimi-vmc',
                      status: 'manual',
                      title: 'Mark certificate not inspected',
                      detail: `The record points at a mark certificate (${a}). Gmail and Apple Mail only show logos backed by a valid VMC or CMC; its contents and the SVG’s profile cannot be read from a browser.`,
                  }
                : {
                      id: 'bimi-vmc',
                      status: 'warn',
                      title: 'No mark certificate (a=)',
                      detail: 'Without a Verified Mark Certificate or Common Mark Certificate, Gmail and Apple Mail will not show the logo. Some smaller providers do.',
                  },
        );
    }

    return report;
}
