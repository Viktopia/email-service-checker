/**
 * DOM rendering for the diagnostic tools: every checker under /tools/, the
 * MX health card, and the all-in-one email security report.
 *
 * Shares the element helper and card treatment with render.ts, so a checker
 * report sits in the same visual family as the provider report.
 */

import type { BimiReport } from './bimi.ts';
import { type Check, type CheckStatus, STATUS_LABEL, sortChecks, tally, verdict } from './checks.ts';
import { type DaneReport, describeTlsa } from './dane.ts';
import type { DkimReport } from './dkim.ts';
import { type DmarcReport, describeTag } from './dmarc.ts';
import type { DnsHealthReport } from './dns-health.ts';
import type { EmailReport } from './email-report.ts';
import type { MtaStsReport } from './mta-sts.ts';
import type { MxHealth, MxHost } from './mx-health.ts';
import { CARD, el, reportNumber, shareButton } from './render.ts';
import { describeTerm, qualifierResult, type SpfNode, type SpfReport } from './spf.ts';
import type { TlsRptReport } from './tls-rpt.ts';

export function statusBadge(status: CheckStatus): HTMLElement {
    return el('span', { class: `cat-badge st-${status}` }, STATUS_LABEL[status]);
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "2 errors, 1 warning" — or "All 6 checks passed". `noun` names what is being counted. */
export function tallyText(checks: readonly Check[], noun = 'check'): string {
    const t = tally(checks);
    const parts: string[] = [];
    if (t.fail) parts.push(plural(t.fail, 'error'));
    if (t.warn) parts.push(plural(t.warn, 'warning'));
    if (t.manual) parts.push(`${t.manual} not verifiable from a browser`);
    if (parts.length === 0 && t.pass === 0)
        return t.info === 1 ? 'One note, nothing to grade' : `${t.info} notes, nothing to grade`;
    if (parts.length === 0) return t.pass === 1 ? `The ${noun} passed` : `All ${t.pass} ${noun}s passed`;
    if (t.pass) parts.push(`${t.pass} passed`);
    return parts.join(', ');
}

export function checksSummary(
    tool: string,
    domain: string,
    checks: readonly Check[],
    noun = 'check',
): string {
    return `${tool} result for ${domain}: ${tallyText(checks, noun)}.`;
}

function subjectRow(domain: string): HTMLElement {
    return el(
        'div',
        { class: 'report-row flex items-center justify-between gap-3' },
        el(
            'div',
            { class: 'flex flex-col min-w-0' },
            el('span', { class: 'eyebrow mb-1' }, 'Subject'),
            el('span', { class: 'font-mono text-[0.95rem] text-ink break-all' }, domain),
        ),
        el('span', { class: 'eyebrow text-ink-muted' }, `N° ${reportNumber(domain)}`),
    );
}

function verdictRow(title: string, checks: readonly Check[]): HTMLElement {
    return el(
        'div',
        { class: 'report-row finding' },
        el('h3', { class: 'display-name finding-title' }, title),
        el('div', { class: 'finding-badge' }, statusBadge(verdict(checks))),
        el('p', { class: 'finding-note' }, tallyText(checks)),
    );
}

export function checkList(checks: readonly Check[], caption = 'Checks'): HTMLElement {
    const list = el('ul', { class: 'check-list' });
    for (const c of sortChecks(checks)) {
        list.append(
            el(
                'li',
                { class: 'check', 'data-check': c.id },
                el('div', { class: 'check-badge' }, statusBadge(c.status)),
                el(
                    'div',
                    { class: 'flex flex-col gap-1 min-w-0' },
                    el('p', { class: 'check-title' }, c.title),
                    el('p', { class: 'check-detail' }, c.detail),
                ),
            ),
        );
    }
    return el(
        'div',
        { class: 'report-row flex flex-col gap-3' },
        el('p', { class: 'eyebrow' }, caption),
        list,
    );
}

function recordBlock(label: string, record: string): HTMLElement {
    return el(
        'div',
        { class: 'report-row flex flex-col gap-3' },
        el('p', { class: 'eyebrow' }, label),
        el('pre', { class: 'record' }, record),
    );
}

function table(caption: string, headers: string[], rows: Array<Array<string | Node>>): HTMLElement {
    const t = el('table', { class: 'mx-table' });
    t.append(el('caption', { class: 'eyebrow' }, caption));
    t.append(el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { scope: 'col' }, h)))));
    const body = el('tbody');
    for (const row of rows) body.append(el('tr', {}, ...row.map((cell) => el('td', {}, cell))));
    t.append(body);
    return el('div', { class: 'report-row flex flex-col overflow-x-auto' }, t);
}

function shareRow(domain: string, links: Array<{ href: string; label: string }> = []): HTMLElement {
    return el(
        'div',
        { class: 'report-row flex flex-wrap items-center justify-between gap-3' },
        el(
            'div',
            { class: 'flex flex-wrap gap-2' },
            ...links.map((l) =>
                el(
                    'a',
                    { class: 'btn-ghost', href: `${l.href}?domain=${encodeURIComponent(domain)}` },
                    l.label,
                ),
            ),
        ),
        shareButton(domain),
    );
}

// ---- SPF ------------------------------------------------------------------

function spfTree(node: SpfNode): HTMLElement {
    const label = el(
        'span',
        { class: 'tree-label' },
        el('span', { class: 'font-mono text-ink break-all' }, node.domain),
        el(
            'span',
            { class: 'text-ink-muted' },
            node.via === 'root' ? '' : ` · ${node.via}`,
            node.record ? ` · ${plural(node.totalLookups, 'lookup')}` : '',
        ),
    );
    const item = el('li', {}, label);
    if (node.problem) item.append(el('p', { class: 'tree-problem' }, node.problem));
    if (node.children.length > 0) {
        const ul = el('ul', { class: 'spf-tree' });
        for (const c of node.children) ul.append(spfTree(c));
        item.append(ul);
    }
    return item;
}

export function renderSpfReport(target: HTMLElement, report: SpfReport): void {
    const card = el('section', { class: CARD });
    card.append(subjectRow(report.domain));
    card.append(verdictRow(report.records.length ? 'SPF record' : 'No SPF record', report.checks));

    for (const [i, record] of report.records.entries()) {
        card.append(recordBlock(report.records.length > 1 ? `Record ${i + 1}` : 'Published record', record));
    }

    card.append(checkList(report.checks));

    const root = report.tree;
    if (root?.parsed && root.parsed.terms.length > 0) {
        card.append(
            table(
                `Breakdown — ${plural(root.parsed.terms.length, 'term')}`,
                ['Result', 'Term', 'Meaning'],
                root.parsed.terms.map((t) => [
                    t.kind === 'modifier' ? 'modifier' : qualifierResult(t.qualifier),
                    el('code', { class: 'break-all' }, t.raw),
                    describeTerm(t, report.domain),
                ]),
            ),
        );
    }

    if (root && root.children.length > 0) {
        card.append(
            el(
                'div',
                { class: 'report-row flex flex-col gap-3' },
                el('p', { class: 'eyebrow' }, `Lookup tree — ${report.lookups} of 10 used`),
                el('ul', { class: 'spf-tree spf-tree-root' }, spfTree(root)),
            ),
        );
    }

    card.append(
        shareRow(report.domain, [
            { href: '/tools/dmarc-checker/', label: 'Check DMARC' },
            { href: '/mx-lookup/', label: 'MX lookup' },
        ]),
    );
    target.replaceChildren(card);
}

// ---- DMARC ----------------------------------------------------------------

export function renderDmarcReport(target: HTMLElement, report: DmarcReport): void {
    const card = el('section', { class: CARD });
    card.append(subjectRow(report.domain));
    card.append(verdictRow(report.records.length ? 'DMARC record' : 'No DMARC record', report.checks));

    for (const [i, record] of report.records.entries()) {
        const where = `_dmarc.${report.policyDomain}`;
        card.append(recordBlock(report.records.length > 1 ? `${where} — record ${i + 1}` : where, record));
    }

    card.append(checkList(report.checks));

    if (report.parsed && report.parsed.tags.length > 0) {
        card.append(
            table(
                `Breakdown — ${plural(report.parsed.tags.length, 'tag')}`,
                ['Tag', 'Value', 'Meaning'],
                report.parsed.tags.map((t) => [
                    el('code', {}, t.name),
                    el('code', { class: 'break-all' }, t.value),
                    describeTag(t),
                ]),
            ),
        );
    }

    card.append(
        shareRow(report.domain, [
            { href: '/tools/spf-checker/', label: 'Check SPF' },
            { href: '/mx-lookup/', label: 'MX lookup' },
        ]),
    );
    target.replaceChildren(card);
}

// ---- MX health ------------------------------------------------------------

function addresses(h: MxHost): string {
    if (h.unresolved) return 'lookup failed';
    const all = [...h.ipv4, ...h.ipv6];
    return all.length > 0 ? all.join('\n') : 'no address';
}

/** Appended under the provider report on the MX lookup page. */
export function renderMxHealth(target: HTMLElement, domain: string, health: MxHealth): void {
    const card = el('section', { class: CARD });
    card.append(verdictRow('Mail server checks', health.checks));
    card.append(checkList(health.checks));
    if (health.hosts.length > 0) {
        card.append(
            table(
                `Mail servers — ${plural(health.hosts.length, 'host')}`,
                ['Priority', 'Host', 'Addresses'],
                health.hosts.map((h) => [
                    String(h.priority),
                    el('span', { class: 'mx-host' }, h.host),
                    el('span', { class: 'addr-list' }, addresses(h)),
                ]),
            ),
        );
    }
    card.append(
        shareRow(domain, [
            { href: '/tools/spf-checker/', label: 'Check SPF' },
            { href: '/tools/dmarc-checker/', label: 'Check DMARC' },
        ]),
    );
    target.replaceChildren(card);
}

// ---- MTA-STS, TLS-RPT, DANE, BIMI ------------------------------------------

interface ToolLink {
    href: string;
    label: string;
}

const TOOL_LINKS: Record<string, ToolLink> = {
    spf: { href: '/tools/spf-checker/', label: 'Check SPF' },
    dmarc: { href: '/tools/dmarc-checker/', label: 'Check DMARC' },
    mtaSts: { href: '/tools/mta-sts-checker/', label: 'Check MTA-STS' },
    tlsRpt: { href: '/tools/tls-rpt-checker/', label: 'Check TLS-RPT' },
    dane: { href: '/tools/dane-checker/', label: 'Check DANE' },
    bimi: { href: '/tools/bimi-checker/', label: 'Check BIMI' },
    dkim: { href: '/tools/dkim-checker/', label: 'Check DKIM' },
    dns: { href: '/tools/dns-checker/', label: 'Check DNS' },
    report: { href: '/tools/email-security-report/', label: 'Full report' },
};

function genericReport(
    target: HTMLElement,
    domain: string,
    title: string,
    checks: readonly Check[],
    records: Array<{ label: string; text: string }>,
    extras: HTMLElement[],
    links: ToolLink[],
): void {
    const card = el('section', { class: CARD });
    card.append(subjectRow(domain), verdictRow(title, checks));
    for (const r of records) card.append(recordBlock(r.label, r.text));
    card.append(checkList(checks), ...extras, shareRow(domain, links));
    target.replaceChildren(card);
}

export function renderMtaStsReport(target: HTMLElement, r: MtaStsReport): void {
    const records = r.record ? [{ label: `_mta-sts.${r.domain}`, text: r.record }] : [];
    if (r.policyText) records.push({ label: 'Policy file', text: r.policyText.trim() });
    genericReport(
        target,
        r.domain,
        r.record ? 'MTA-STS policy' : 'No MTA-STS policy',
        r.checks,
        records,
        [],
        [TOOL_LINKS.tlsRpt!, TOOL_LINKS.dane!],
    );
}

export function renderTlsRptReport(target: HTMLElement, r: TlsRptReport): void {
    genericReport(
        target,
        r.domain,
        r.record ? 'TLS reporting' : 'No TLS reporting',
        r.checks,
        r.record ? [{ label: `_smtp._tls.${r.domain}`, text: r.record }] : [],
        [],
        [TOOL_LINKS.mtaSts!, TOOL_LINKS.dane!],
    );
}

export function renderDaneReport(target: HTMLElement, r: DaneReport): void {
    const extras: HTMLElement[] = [];
    if (r.hosts.length > 0) {
        extras.push(
            table(
                `TLSA records — ${plural(r.hosts.length, 'MX host')}`,
                ['Host', 'DNSSEC', 'TLSA'],
                r.hosts.map((h) => [
                    el('span', { class: 'mx-host' }, h.host),
                    h.failed ? 'lookup failed' : h.secure ? 'validated' : 'unsigned',
                    el(
                        'span',
                        { class: 'addr-list' },
                        h.tlsa.length > 0 ? h.tlsa.map((t) => describeTlsa(t)).join('\n') : 'none',
                    ),
                ]),
            ),
        );
    }
    genericReport(target, r.domain, 'DNSSEC and DANE', r.checks, [], extras, [
        TOOL_LINKS.mtaSts!,
        TOOL_LINKS.tlsRpt!,
    ]);
}

export function renderBimiReport(target: HTMLElement, r: BimiReport): void {
    const records = r.record ? [{ label: `default._bimi.${r.domain}`, text: r.record }] : [];
    if (r.dmarc.records[0])
        records.push({ label: `_dmarc.${r.dmarc.policyDomain}`, text: r.dmarc.records[0] });
    genericReport(
        target,
        r.domain,
        r.record ? 'BIMI record' : 'No BIMI record',
        r.checks,
        records,
        [],
        [TOOL_LINKS.dmarc!, TOOL_LINKS.spf!],
    );
}

export function renderDkimReport(target: HTMLElement, r: DkimReport): void {
    const extras: HTMLElement[] = [];
    if (r.keys.length > 0) {
        extras.push(
            table(
                `Keys — ${plural(r.keys.length, 'record')}`,
                ['Selector', 'Type', 'Key'],
                r.keys.map((k) => [
                    el('code', {}, k.selector),
                    k.keyType,
                    k.revoked
                        ? 'revoked (empty p=)'
                        : k.bits
                          ? `${k.bits}-bit`
                          : k.keyType === 'ed25519'
                            ? '256-bit'
                            : '—',
                ]),
            ),
        );
    }
    if (r.keys.length > 1) {
        const details = el(
            'details',
            { class: 'report-row flex flex-col gap-3' },
            el('summary', { class: 'eyebrow cursor-pointer' }, `Show the ${r.keys.length} records`),
        );
        for (const k of r.keys) details.append(recordBlock(k.name, k.record));
        extras.push(details);
    }
    if (!r.selector) {
        extras.push(
            el(
                'div',
                { class: 'report-row flex flex-col gap-2' },
                el('p', { class: 'eyebrow' }, `Selectors tried — ${r.tried.length}`),
                el(
                    'p',
                    { class: 'text-ink-muted text-[0.85rem] font-mono break-words' },
                    r.tried.join(' · '),
                ),
            ),
        );
    }
    genericReport(
        target,
        r.domain,
        r.keys.length > 0 ? 'DKIM keys' : 'No DKIM key found',
        r.checks,
        // One key reads best in full; several would bury the checks under
        // base64, so they move into a collapsed block after the key table.
        r.keys.length === 1 ? [{ label: r.keys[0]!.name, text: r.keys[0]!.record }] : [],
        extras,
        [TOOL_LINKS.dmarc!, TOOL_LINKS.spf!],
    );
}

export function renderDnsHealthReport(target: HTMLElement, r: DnsHealthReport): void {
    const extras: HTMLElement[] = [];
    if (r.nameservers.length > 0) {
        extras.push(
            table(
                `Nameservers — ${plural(r.nameservers.length, 'host')}`,
                ['Host', 'Addresses'],
                r.nameservers.map((n) => [
                    el('span', { class: 'mx-host' }, n.host),
                    el('span', { class: 'addr-list' }, [...n.ipv4, ...n.ipv6].join('\n') || 'no address'),
                ]),
            ),
        );
    }
    if (r.soa) {
        const s = r.soa;
        extras.push(
            table(
                'SOA record',
                ['Field', 'Value'],
                [
                    ['Primary', el('span', { class: 'mx-host' }, s.mname)],
                    ['Contact', el('span', { class: 'mx-host' }, s.rname)],
                    ['Serial', String(s.serial)],
                    ['Refresh', `${s.refresh} s`],
                    ['Retry', `${s.retry} s`],
                    ['Expire', `${s.expire} s`],
                    ['Negative TTL', `${s.minimum} s`],
                ],
            ),
        );
    }
    genericReport(target, r.domain, `DNS for ${r.zone}`, r.checks, [], extras, [
        TOOL_LINKS.dane!,
        TOOL_LINKS.report!,
    ]);
}

/** One pseudo-check per standard, so summaries count standards rather than every test inside them. */
export function reportLineChecks(r: EmailReport): Check[] {
    return r.lines.map((l) => ({ id: l.key, status: l.status, title: l.label, detail: l.headline }));
}

export function renderEmailReport(target: HTMLElement, r: EmailReport): void {
    const card = el('section', { class: CARD });
    const perStandard = reportLineChecks(r);
    card.append(subjectRow(r.domain));
    card.append(
        el(
            'div',
            { class: 'report-row flex flex-col gap-2' },
            el('h3', { class: 'display-name' }, 'Email security report'),
            el(
                'p',
                { class: 'text-ink-muted text-[0.92rem]' },
                `${tallyText(perStandard, 'standard')} across ${r.lines.length} standards. There is no overall score: each standard protects against something different, and what a browser cannot verify is shown as such.`,
            ),
        ),
    );
    const list = el('ul', { class: 'check-list' });
    for (const l of r.lines) {
        list.append(
            el(
                'li',
                { class: 'check', 'data-check': l.key },
                el('div', { class: 'check-badge' }, statusBadge(l.status)),
                el(
                    'div',
                    { class: 'flex flex-col gap-1 min-w-0' },
                    el(
                        'p',
                        { class: 'check-title' },
                        el('a', { href: `${l.href}?domain=${encodeURIComponent(r.domain)}` }, l.label),
                        el('span', { class: 'text-ink-muted font-normal' }, ` — ${l.role}`),
                    ),
                    el('p', { class: 'check-detail' }, l.headline),
                ),
            ),
        );
    }
    card.append(
        el(
            'div',
            { class: 'report-row flex flex-col gap-3' },
            el('p', { class: 'eyebrow' }, 'By standard'),
            list,
        ),
    );
    card.append(shareRow(r.domain));
    target.replaceChildren(card);
}
