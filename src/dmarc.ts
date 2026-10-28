/**
 * DMARC record discovery, parsing and checking, in the browser, against
 * RFC 9989 (May 2026), which obsoletes RFC 7489.
 *
 * What changed, and what this checks for:
 *
 *   - Discovery is the DNS Tree Walk (§4.10): query _dmarc.<domain>, then step
 *     up the tree. It replaces the Public Suffix List, which is also why this
 *     can run in a browser without shipping the PSL.
 *   - pct, rf and ri are gone (Appendix C.5.2). Updated receivers ignore them,
 *     so a record still relying on pct for a staged rollout is not getting one.
 *   - np, psd and t are new. t=y asks receivers to apply the policy one level
 *     down, which is what pct=0 used to mean.
 *   - A record with no valid p= is treated as p=none if rua= is valid, and
 *     ignored entirely otherwise.
 *
 * Aggregate and failure reporting moved to RFC 9990 and RFC 9991; the
 * external destination check below is RFC 9990 §4.
 */

import type { Check } from './checks.ts';
import { parseTxtData, RCODE_NXDOMAIN, type Resolve } from './dns.ts';

export interface DmarcTag {
    name: string;
    value: string;
}

export interface ParsedDmarc {
    tags: DmarcTag[];
    errors: string[];
    warnings: string[];
}

export interface DmarcReport {
    domain: string;
    /** Where the governing record was found: the domain itself, or a parent. */
    policyDomain: string | null;
    records: string[];
    parsed: ParsedDmarc | null;
    checks: Check[];
}

/** Discovery is deliberately lenient so a near-miss record is reported, not silently missed. */
export function isDmarcRecord(txt: string): boolean {
    return /^v\s*=\s*DMARC1\s*(;|$)/i.test(txt);
}

const POLICIES = ['none', 'quarantine', 'reject'] as const;
type Policy = (typeof POLICIES)[number];
const STRENGTH: Record<Policy, number> = { none: 0, quarantine: 1, reject: 2 };

/** The tags RFC 9989 §4.7 defines. */
export const KNOWN_TAGS: Record<string, string> = {
    v: 'Version. Must be DMARC1, and must come first.',
    p: 'Policy for mail from this domain that fails DMARC.',
    sp: 'Policy for subdomains that exist. Defaults to p.',
    np: 'Policy for subdomains that do not exist. Defaults to sp, then p.',
    psd: 'Whether this domain is a public suffix: y, n or u (default).',
    t: 'Testing mode: y asks receivers to apply the policy one level lower.',
    rua: 'Where aggregate (daily summary) reports are sent.',
    ruf: 'Where failure (per-message) reports are sent.',
    adkim: 'DKIM alignment: r (relaxed, default) or s (strict).',
    aspf: 'SPF alignment: r (relaxed, default) or s (strict).',
    fo: 'When failure reports are generated: 0, 1, d or s.',
};

/** RFC 7489 tags that RFC 9989 removed. */
export const OBSOLETE_TAGS: Record<string, string> = {
    pct: 'pct (percentage of mail the policy applies to) was removed in RFC 9989. Use t=y for a softer rollout.',
    rf: 'rf (failure report format) was removed in RFC 9989; the format is fixed.',
    ri: 'ri (report interval) was removed in RFC 9989; aggregate reports are daily.',
};

function describePolicy(p: string): string {
    switch (p) {
        case 'none':
            return 'take no action, only report';
        case 'quarantine':
            return 'treat as suspicious, usually the spam folder';
        case 'reject':
            return 'refuse the message';
        default:
            return `"${p}" is not a valid policy`;
    }
}

/** A plain-English reading of one tag's value, for the breakdown table. */
export function describeTag(tag: DmarcTag): string {
    const v = tag.value.toLowerCase();
    if (tag.name in OBSOLETE_TAGS) return `Obsolete. ${OBSOLETE_TAGS[tag.name]}`;
    switch (tag.name) {
        case 'v':
            return 'DMARC version 1.';
        case 'p':
            return `Failing mail: ${describePolicy(v)}.`;
        case 'sp':
            return `Failing mail from subdomains: ${describePolicy(v)}.`;
        case 'np':
            return `Mail from non-existent subdomains: ${describePolicy(v)}.`;
        case 'psd':
            return v === 'y'
                ? 'This is a public suffix domain, such as a TLD operator.'
                : v === 'n'
                  ? 'This is an organisational domain, not a public suffix.'
                  : 'Unspecified whether this is a public suffix.';
        case 't':
            return v === 'y'
                ? 'Testing: receivers apply the policy one level lower.'
                : 'Not testing: the policy applies as written.';
        case 'rua':
            return `Send aggregate reports to ${reportUris(tag.value).join(', ')}.`;
        case 'ruf':
            return `Send failure reports to ${reportUris(tag.value).join(', ')}.`;
        case 'adkim':
            return v === 's'
                ? 'DKIM must match the From domain exactly.'
                : 'DKIM may sign with any domain in the From domain’s organisation.';
        case 'aspf':
            return v === 's'
                ? 'SPF must match the From domain exactly.'
                : 'SPF may pass for any domain in the From domain’s organisation.';
        case 'fo':
            return 'Failure reporting options: 0 = all fail, 1 = any fails, d = DKIM fails, s = SPF fails.';
        default:
            return 'Unknown tag; receivers ignore it.';
    }
}

export function reportUris(value: string): string[] {
    return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** The domain part of a mailto: report URI, without any size suffix. */
export function reportDomain(uri: string): string | null {
    const m = /^mailto:[^@\s]+@([^@\s!]+)/i.exec(uri);
    return m ? m[1]!.toLowerCase().replace(/\.$/, '') : null;
}

/** Parses one DMARC record. Never throws. */
export function parseDmarc(record: string): ParsedDmarc {
    const errors: string[] = [];
    const warnings: string[] = [];
    const tags: DmarcTag[] = [];

    for (const part of record.split(';')) {
        const p = part.trim();
        if (!p) continue;
        const eq = p.indexOf('=');
        if (eq < 0) {
            errors.push(`"${p}" is not a tag=value pair.`);
            continue;
        }
        const name = p.slice(0, eq).trim().toLowerCase();
        const value = p.slice(eq + 1).trim();
        if (tags.some((t) => t.name === name)) {
            errors.push(`The ${name} tag appears more than once.`);
            continue;
        }
        tags.push({ name, value });
    }

    // §4.7: v must be first and is case-sensitive; otherwise the whole record is ignored.
    if (tags[0]?.name !== 'v' || tags[0].value !== 'DMARC1') {
        errors.push('The record must start with exactly "v=DMARC1", or receivers ignore it entirely.');
    }

    const get = (n: string) => tags.find((t) => t.name === n)?.value;

    for (const name of ['p', 'sp', 'np']) {
        const v = get(name);
        if (v !== undefined && !(POLICIES as readonly string[]).includes(v.toLowerCase())) {
            errors.push(`${name}=${v} is not a valid policy; use none, quarantine or reject.`);
        }
    }
    for (const name of ['adkim', 'aspf']) {
        const v = get(name);
        if (v !== undefined && !/^[rs]$/i.test(v)) errors.push(`${name}=${v} must be r or s.`);
    }
    const psd = get('psd');
    if (psd !== undefined && !/^[ynu]$/i.test(psd)) errors.push(`psd=${psd} must be y, n or u.`);
    const t = get('t');
    if (t !== undefined && !/^[yn]$/i.test(t)) errors.push(`t=${t} must be y or n.`);
    const fo = get('fo');
    if (fo !== undefined) {
        const opts = fo.split(':').map((x) => x.trim().toLowerCase());
        if (!opts.every((x) => /^[01ds]$/.test(x))) {
            errors.push(`fo=${fo} must be a colon-separated list of 0, 1, d and s.`);
        } else if (opts.includes('0') && opts.includes('1')) {
            // Common in the wild, and it only affects failure reports, so it
            // is not worth failing the whole record over.
            warnings.push(
                'fo=0 and fo=1 contradict each other (RFC 9989 makes them mutually exclusive); receivers may ignore fo.',
            );
        }
    }

    for (const name of ['rua', 'ruf']) {
        const v = get(name);
        if (v === undefined) continue;
        const uris = reportUris(v);
        if (uris.length === 0) errors.push(`${name}= is empty.`);
        for (const uri of uris) {
            if (/^mailto:[^@\s]+@[^@\s!]+\.[^@\s!]+(![0-9]+[kmgt]?)?$/i.test(uri)) {
                if (uri.includes('!')) {
                    warnings.push(`The size limit on "${uri}" is obsolete in RFC 9990 and ignored.`);
                }
            } else if (/^[a-z][a-z0-9+.-]*:\S+$/i.test(uri) && !/^mailto:/i.test(uri)) {
                warnings.push(
                    `${name} entry "${uri}" is not a mailto: URI. Receivers are only required to support mailto:, and ignore schemes they do not.`,
                );
            } else {
                errors.push(`${name} entry "${uri}" is not a valid URI.`);
            }
        }
    }

    for (const tag of tags) {
        if (tag.name in OBSOLETE_TAGS) warnings.push(OBSOLETE_TAGS[tag.name]!);
        else if (!(tag.name in KNOWN_TAGS))
            warnings.push(`Unknown tag "${tag.name}" is ignored by receivers.`);
    }

    return { tags, errors, warnings };
}

/**
 * Names to query, in order, per the DNS Tree Walk (RFC 9989 §4.10): the
 * domain itself; then, for a name of eight or more labels, its last seven;
 * then one label fewer each step, down to the top-level domain. Never more
 * than eight queries.
 */
export function treeWalk(domain: string): string[] {
    const labels = domain.split('.').filter(Boolean);
    const out = [labels.join('.')];
    let n = labels.length >= 8 ? 7 : labels.length - 1;
    while (n >= 1 && out.length < 8) {
        out.push(labels.slice(-n).join('.'));
        n--;
    }
    return out;
}

/**
 * Whether a report destination needs authorising, without the PSL.
 *
 * RFC 9990 §4 compares organisational domains. A destination at the policy
 * domain, a parent of it, or a child of it shares one; anything else is
 * treated as external and must publish the authorisation record.
 */
function sameTree(a: string, b: string): boolean {
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

async function fetchDmarc(resolve: Resolve, name: string): Promise<string[]> {
    const res = await resolve(`_dmarc.${name}`, 'TXT');
    return res.answers.map((a) => parseTxtData(a.data)).filter(isDmarcRecord);
}

function lower(p: Policy): Policy {
    return p === 'reject' ? 'quarantine' : 'none';
}

export async function checkDmarc(domain: string, resolve: Resolve): Promise<DmarcReport> {
    const checks: Check[] = [];

    let records: string[] = [];
    let policyDomain: string | null = null;
    for (const name of treeWalk(domain)) {
        records = await fetchDmarc(resolve, name);
        if (records.length > 0) {
            policyDomain = name;
            break;
        }
    }

    if (!policyDomain) {
        checks.push({
            id: 'dmarc-published',
            status: 'fail',
            title: 'No DMARC record',
            detail: `Nothing is published at _dmarc.${domain}${treeWalk(domain).length > 1 ? ' or any parent domain' : ''}. Receivers have no instruction for mail that fails SPF and DKIM, and you get no reports on who is sending as you. Gmail, Yahoo and Microsoft require one from bulk senders.`,
        });
        return { domain, policyDomain, records, parsed: null, checks };
    }

    const inherited = policyDomain !== domain;
    checks.push({
        id: 'dmarc-published',
        status: 'pass',
        title: inherited ? `Covered by ${policyDomain}'s DMARC record` : 'DMARC record published',
        detail: inherited
            ? `${domain} has no record of its own. The DNS tree walk finds _dmarc.${policyDomain}, and its subdomain policy applies.`
            : `A DMARC record is published at _dmarc.${domain}.`,
    });

    if (records.length > 1) {
        checks.push({
            id: 'dmarc-multiple',
            status: 'fail',
            title: 'Multiple DMARC records',
            detail: `_dmarc.${policyDomain} has ${records.length} DMARC records. RFC 9989 says receivers discard them all, as if there were none. Keep exactly one.`,
        });
    }

    const parsed = parseDmarc(records[0]!);
    const get = (n: string) => parsed.tags.find((t) => t.name === n)?.value.toLowerCase();

    checks.push(
        parsed.errors.length > 0
            ? {
                  id: 'dmarc-syntax',
                  status: 'fail',
                  title: `${parsed.errors.length} syntax error${parsed.errors.length === 1 ? '' : 's'}`,
                  detail: parsed.errors.join(' '),
              }
            : {
                  id: 'dmarc-syntax',
                  status: 'pass',
                  title: 'Valid under RFC 9989',
                  detail: 'Every tag parses and every value is one the current DMARC specification allows.',
              },
    );
    const obsolete = parsed.tags.filter((t) => t.name in OBSOLETE_TAGS);
    if (obsolete.length > 0) {
        // Only a pct below 100 changes what the record does: under RFC 7489 it
        // softened the policy, and updated receivers now apply it in full.
        // The rest are dead weight, worth tidying but not a problem.
        const pct = obsolete.find((t) => t.name === 'pct' && t.value !== '100');
        checks.push({
            id: 'dmarc-obsolete',
            status: pct ? 'warn' : 'info',
            title: `Obsolete tag${obsolete.length === 1 ? '' : 's'}: ${obsolete.map((t) => t.name).join(', ')}`,
            detail: [
                pct
                    ? `pct=${pct.value} no longer limits the policy: receivers following RFC 9989 apply it to all failing mail. Use t=y if you still need a softer rollout.`
                    : '',
                ...obsolete.map((t) => OBSOLETE_TAGS[t.name]),
            ]
                .filter(Boolean)
                .join(' '),
        });
    }
    const otherWarnings = parsed.warnings.filter((w) => !Object.values(OBSOLETE_TAGS).includes(w));
    if (otherWarnings.length > 0) {
        checks.push({
            id: 'dmarc-unknown',
            status: 'warn',
            title: 'Unrecognised or ignored values',
            detail: otherWarnings.join(' '),
        });
    }

    // Which policy applies to the domain asked about (§4.10.1): its own p, or
    // for a subdomain the parent's sp — np instead if the subdomain does not exist.
    const valid = (v: string | undefined): Policy | undefined =>
        v && (POLICIES as readonly string[]).includes(v) ? (v as Policy) : undefined;
    const p = valid(get('p'));
    const sp = valid(get('sp'));
    const np = valid(get('np'));
    let applied: Policy | undefined = p;
    let tagName = 'p';
    if (inherited) {
        const exists = await resolve(domain, 'A')
            .then((r) => r.status !== RCODE_NXDOMAIN)
            .catch(() => true);
        if (!exists && np) {
            applied = np;
            tagName = 'np';
        } else if (sp) {
            applied = sp;
            tagName = 'sp';
        }
    }
    const rua = get('rua');

    if (!p) {
        const ruaValid = reportUris(rua ?? '').some((u) => /^mailto:\S+@\S+/i.test(u));
        checks.push(
            ruaValid
                ? {
                      id: 'dmarc-policy',
                      status: 'warn',
                      title: 'No valid p= tag, so treated as p=none',
                      detail: 'RFC 9989 treats a record without a valid policy as p=none when rua= is valid. Reports flow, but nothing is enforced. Add p= explicitly.',
                  }
                : {
                      id: 'dmarc-policy',
                      status: 'fail',
                      title: 'No valid p= tag',
                      detail: 'Without a valid policy or a valid rua=, receivers apply no DMARC processing at all.',
                  },
        );
    } else if (applied) {
        const testing = get('t') === 'y';
        const effective = testing ? lower(applied) : applied;
        const shown = `${tagName}=${applied}${testing ? ', t=y' : ''}`;
        if (effective === 'none') {
            checks.push({
                id: 'dmarc-policy',
                status: 'warn',
                title: `Policy not enforced (${shown})`,
                detail: testing
                    ? `t=y asks receivers to apply the policy one level lower, so ${applied} becomes none. Remove t=y when the reports are clean.`
                    : 'Mail that fails DMARC is delivered as normal, so anyone can still spoof this domain. p=none is right while you read reports and fix senders; then move to quarantine and reject.',
            });
        } else {
            checks.push({
                id: 'dmarc-policy',
                status: testing ? 'warn' : 'pass',
                title: testing ? `Policy softened by testing (${shown})` : `Policy enforced (${shown})`,
                detail: testing
                    ? `t=y asks receivers to apply ${effective} instead of ${applied}. Remove t=y when you are ready.`
                    : effective === 'reject'
                      ? 'Receivers are told to refuse mail that fails DMARC: the strongest protection against spoofing.'
                      : 'Receivers are told to treat failing mail as suspicious. p=reject is the final step.',
            });
        }
    }

    if (!inherited && p && sp && STRENGTH[sp] < STRENGTH[p]) {
        checks.push({
            id: 'dmarc-subdomain-policy',
            status: 'warn',
            title: `Subdomains are weaker (sp=${sp})`,
            detail: `Subdomains get ${sp} while the domain itself gets ${p}, so a spoofer can send from a subdomain instead. Unless one genuinely needs it, drop sp= or match p.`,
        });
    }
    if (!inherited && p && np && STRENGTH[np] < STRENGTH[p]) {
        checks.push({
            id: 'dmarc-np-policy',
            status: 'warn',
            title: `Non-existent subdomains are weaker (np=${np})`,
            detail: 'Mail from made-up subdomains is the easiest spoof to stop, since nothing legitimate is ever sent from them. np= should be at least as strict as p.',
        });
    }

    if (!rua) {
        checks.push({
            id: 'dmarc-rua',
            status: 'warn',
            title: 'No aggregate reports (rua)',
            detail: 'Without rua= nobody receives the daily reports that show which servers send as this domain, and moving to an enforcing policy becomes guesswork.',
        });
    } else {
        checks.push({
            id: 'dmarc-rua',
            status: 'pass',
            title: 'Aggregate reports requested',
            detail: `Reports go to ${reportUris(rua).join(', ')}.`,
        });
    }

    const ruf = get('ruf');
    if (ruf) {
        checks.push({
            id: 'dmarc-ruf',
            status: 'info',
            title: 'Failure reports requested',
            detail: 'Few large receivers send per-message failure reports (RFC 9991), for privacy reasons, so expect little from ruf=.',
        });
    }

    const policyHost = policyDomain;
    const raw = parsed.tags
        .filter((t) => t.name === 'rua' || t.name === 'ruf')
        .flatMap((t) => reportUris(t.value));
    const external = [...new Set(raw.map(reportDomain))]
        .filter((d): d is string => d !== null)
        .filter((d) => !sameTree(d, policyHost));
    if (external.length > 0) {
        const results = await Promise.all(
            external.map(async (dest) => {
                try {
                    const res = await resolve(`${policyHost}._report._dmarc.${dest}`, 'TXT');
                    return { dest, ok: res.answers.some((a) => isDmarcRecord(parseTxtData(a.data))) };
                } catch {
                    return { dest, ok: true };
                }
            }),
        );
        const missing = results.filter((r) => !r.ok).map((r) => r.dest);
        checks.push(
            missing.length > 0
                ? {
                      id: 'dmarc-external',
                      status: 'warn',
                      title: 'External report destination not authorised',
                      detail: `${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not publish ${policyHost}._report._dmarc.<destination> with v=DMARC1, so receivers will not send reports there (RFC 9990 §4). Reporting services usually set this up when you add the domain.`,
                  }
                : {
                      id: 'dmarc-external',
                      status: 'pass',
                      title: 'External report destinations authorised',
                      detail: `${external.join(', ')} ${external.length === 1 ? 'has' : 'have'} agreed to receive reports for ${policyHost}.`,
                  },
        );
    }

    const adkim = get('adkim');
    const aspf = get('aspf');
    if (adkim === 's' || aspf === 's') {
        checks.push({
            id: 'dmarc-alignment',
            status: 'info',
            title: 'Strict alignment',
            detail: `${[adkim === 's' ? 'DKIM' : '', aspf === 's' ? 'SPF' : ''].filter(Boolean).join(' and ')} must match the From domain exactly, not just share its organisational domain. Mail sent from a subdomain will fail.`,
        });
    }

    // §7.4: a p=reject domain must not rely on SPF alone. Whether it signs
    // with DKIM is invisible from DNS without a selector, so say so.
    checks.push({
        id: 'dmarc-dkim',
        status: 'manual',
        title: 'DKIM signing not checked',
        detail: 'DMARC passes on aligned SPF or DKIM, and RFC 9989 requires DKIM for p=reject. DKIM keys live under selectors that cannot be discovered from DNS, so check a message you sent: its headers should show dkim=pass with header.d= this domain. The DKIM checker can then validate the key for that selector.',
    });

    return { domain, policyDomain, records, parsed, checks };
}
