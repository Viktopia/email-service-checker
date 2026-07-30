import type { ConsumerHit, Finding, MxRecord } from './types.ts';
import { CATEGORY_LABEL, CATEGORY_NOTE, providerSlug } from './providers.ts';

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Partial<Record<string, string>> = {},
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else node.setAttribute(k, v);
    }
    for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    return node;
}

function reportNumber(domain: string): string {
    let h = 2166136261;
    for (const ch of domain) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36).toUpperCase().padStart(7, '0').slice(0, 7);
}

const CARD = 'card report-anim p-6 sm:p-8 flex flex-col';

function categoryBadge(category: Finding['provider']['category']): HTMLElement {
    return el('span', { class: `cat-badge cat-${category}` }, CATEGORY_LABEL[category]);
}

function mxTable(mxRecords: readonly MxRecord[]): HTMLElement {
    const wrap = el('div', { class: 'report-row flex flex-col gap-3' });
    wrap.append(el('p', { class: 'eyebrow' }, `Evidence — ${mxRecords.length} MX record${mxRecords.length === 1 ? '' : 's'}`));
    const table = el('table', { class: 'mx-table' });
    const tbody = el('tbody');
    for (const mx of mxRecords) {
        tbody.append(
            el('tr', {},
                el('td', { class: 'mx-prio' }, String(mx.priority)),
                el('td', { class: 'mx-host' }, mx.host),
            ),
        );
    }
    table.append(tbody);
    wrap.append(table);
    return wrap;
}

function shareButton(domain: string): HTMLButtonElement {
    const btn = el('button', { type: 'button', class: 'btn-ghost' }, 'Copy share link');
    btn.addEventListener('click', async () => {
        const url = new URL(window.location.href);
        url.searchParams.set('domain', domain);
        try {
            await navigator.clipboard.writeText(url.toString());
            btn.textContent = 'Link copied';
            setTimeout(() => { btn.textContent = 'Copy share link'; }, 1500);
        } catch {
            btn.textContent = 'Copy failed';
        }
    });
    return btn;
}

function findingBlock(finding: Finding): HTMLElement {
    const { provider } = finding;
    const cat = provider.category;
    const block = el('div', { class: 'finding' });

    const title = el('a', {
        class: 'display-name finding-title',
        href: `/provider/${providerSlug(provider)}/`,
    }, provider.name);
    block.append(title);
    block.append(el('div', { class: 'finding-badge' }, categoryBadge(cat)));

    const note = CATEGORY_NOTE[cat];
    if (note) block.append(el('p', { class: 'finding-note' }, note));

    return block;
}

function consumerCallout(hit: ConsumerHit): HTMLElement {
    const label = hit.kind === 'disposable' ? 'Disposable mailbox service' : 'Free consumer mailbox';
    const detail = hit.kind === 'disposable'
        ? 'This domain is published in the open disposable-mailbox catalogue — addresses on it are usually short-lived throwaways.'
        : 'This domain is in the open free-mailbox catalogue. Mail sent here goes to a personal account, not a business mailbox.';
    return el('div', { class: 'finding' },
        el('h3', { class: 'display-name finding-title' }, label),
        el('div', { class: 'finding-badge' }, el('span', { class: 'cat-badge cat-consumer' }, 'Open dataset')),
        el('p', { class: 'finding-note' }, detail),
    );
}

export interface RenderInput {
    domain: string;
    findings: Finding[];
    mxRecords: MxRecord[];
    consumerHit: ConsumerHit | null;
}

export function renderReport(target: HTMLElement, input: RenderInput): void {
    target.replaceChildren(buildReport(input));
}

/**
 * One line naming the outcome, for the live region in index.html.
 *
 * Derived from the same RenderInput the card is built from, so it cannot
 * describe something different from what is on screen. It exists because the
 * card itself is the wrong thing to announce: marking it atomic would read out
 * every hostname in the evidence table on every lookup.
 */
export function reportSummary({ domain, findings, mxRecords, consumerHit }: RenderInput): string {
    const parts: string[] = [];

    if (findings.length > 0) {
        parts.push(findings.map(f => `${f.provider.name} — ${CATEGORY_LABEL[f.provider.category]}`).join('; '));
    } else if (mxRecords.length === 0) {
        parts.push(`${domain} publishes no MX records, so it does not receive email`);
    } else {
        parts.push('MX records found, but no known provider matched');
    }

    if (consumerHit) {
        parts.push(consumerHit.kind === 'disposable' ? 'a disposable mailbox service' : 'a free consumer mailbox');
    }

    if (mxRecords.length > 0) {
        parts.push(`${mxRecords.length} MX record${mxRecords.length === 1 ? '' : 's'}`);
    }

    return `Result for ${domain}: ${parts.join(', ')}.`;
}

function buildReport({ domain, findings, mxRecords, consumerHit }: RenderInput): HTMLElement {
    const report = el('section', { class: CARD });

    report.append(
        el('div', { class: 'report-row flex items-center justify-between gap-3' },
            el('div', { class: 'flex flex-col min-w-0' },
                el('span', { class: 'eyebrow mb-1' }, 'Subject'),
                el('span', { class: 'font-mono text-[0.95rem] text-text break-all' }, domain),
            ),
            el('span', { class: 'eyebrow text-overlay-1' }, `N° ${reportNumber(domain)}`),
        ),
    );

    const findingsWrap = el('div', { class: 'report-row flex flex-col gap-7' });

    if (findings.length === 0 && mxRecords.length > 0) {
        findingsWrap.append(
            el('div', { class: 'finding' },
                el('h3', { class: 'display-name finding-title' }, 'Unrecognised provider'),
                el('div', { class: 'finding-badge' }, el('span', { class: 'cat-badge cat-parking' }, 'Inconclusive')),
                el('p', { class: 'finding-note' },
                    'MX records were found, but none match a known provider in our catalogue. ',
                    el('a', {
                        href: `https://github.com/viktopia/email-service-checker/issues/new?title=${encodeURIComponent(`Add provider for ${domain}`)}`,
                        target: '_blank',
                        rel: 'noopener',
                    }, 'Suggest a provider →'),
                ),
            ),
        );
    } else if (mxRecords.length === 0) {
        findingsWrap.append(
            el('div', { class: 'finding' },
                el('h3', { class: 'display-name finding-title' }, 'No MX records'),
                el('div', { class: 'finding-badge' }, el('span', { class: 'cat-badge cat-parking' }, 'No mail exchange')),
                el('p', { class: 'finding-note' },
                    `${domain} publishes no MX records, so it almost certainly does not receive email.`),
            ),
        );
    } else {
        for (const f of findings) findingsWrap.append(findingBlock(f));
    }

    if (consumerHit) findingsWrap.append(consumerCallout(consumerHit));

    report.append(findingsWrap);
    if (mxRecords.length > 0) report.append(mxTable(mxRecords));

    report.append(
        el('div', { class: 'report-row flex justify-end' },
            shareButton(domain),
        ),
    );
    return report;
}

export function renderError(target: HTMLElement, message: string): void {
    target.replaceChildren(
        el('section', { class: `${CARD} border-red` },
            el('p', { class: 'eyebrow text-red mb-2' }, 'Lookup failed'),
            el('h3', { class: 'display-name' }, message),
        ),
    );
}

export function renderLoading(target: HTMLElement, domain: string): void {
    target.replaceChildren(
        el('section', { class: CARD },
            el('p', { class: 'eyebrow mb-2' }, 'Querying DNS'),
            el('h3', { class: 'display-name text-overlay-1' },
                'Resolving ',
                el('span', { class: 'font-mono text-text' }, domain),
                el('span', { class: 'cursor' }, '_'),
            ),
        ),
    );
}

export function clearReport(target: HTMLElement): void {
    target.replaceChildren();
}
