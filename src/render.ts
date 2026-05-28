import type { ConsumerHit, Finding, MxRecord } from './types.ts';
import { CATEGORY_LABEL, CATEGORY_NOTE } from './providers.ts';

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

const REPORT_CARD = 'paper-card report-card grid gap-[1.2rem] p-[clamp(1.25rem,3.5vw,2rem)]';

function mxTable(mxRecords: readonly MxRecord[]): HTMLElement {
    const wrap = el('div', { class: 'grid gap-[0.6rem] pt-[0.9rem] border-t border-dashed border-rule' });
    wrap.append(el('div', { class: 'stencil' }, 'Evidence — MX records'));
    const table = el('table', { class: 'w-full border-collapse font-mono text-[0.84rem]' });
    const tbody = el('tbody');
    for (const mx of mxRecords) {
        tbody.append(
            el('tr', {},
                el('td', { class: 'py-1 pr-4 w-[3.2rem] text-end align-top text-ink-faded border-b border-dotted border-rule-soft' }, String(mx.priority)),
                el('td', { class: 'py-1 pl-2 align-top text-ink break-all border-b border-dotted border-rule-soft' }, mx.host),
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
            setTimeout(() => { btn.textContent = 'Copy share link'; }, 1600);
        } catch {
            btn.textContent = 'Copy failed';
        }
    });
    return btn;
}

function findingBlock(finding: Finding): HTMLElement {
    const { provider } = finding;
    const cat = provider.category;
    const block = el('article', { class: 'finding' });

    block.append(el('div', { class: 'stencil' }, CATEGORY_LABEL[cat]));

    const name = provider.url
        ? el('a', { class: 'display-name', href: provider.url, target: '_blank', rel: 'noopener' }, provider.name)
        : el('h3', { class: 'display-name' }, provider.name);
    block.append(name);

    block.append(
        el('div', { class: `postmark postmark--${cat}` },
            el('span', { class: 'postmark-arc' }, CATEGORY_LABEL[cat].toUpperCase()),
        ),
    );

    const note = CATEGORY_NOTE[cat];
    if (note) block.append(el('p', { class: 'text-ink-soft text-[0.92rem] max-w-[56ch]' }, note));

    return block;
}

function consumerCallout(hit: ConsumerHit): HTMLElement {
    const label = hit.kind === 'disposable' ? 'Disposable address service' : 'Free consumer mailbox';
    const detail = hit.kind === 'disposable'
        ? 'This domain is published as a temporary / throwaway mailbox provider — addresses on it are usually short-lived.'
        : 'This domain is a free consumer email service. Mail sent here lands in a personal account, not a business mailbox.';
    return el('article', { class: 'finding' },
        el('div', { class: 'stencil' }, 'Catalogued in open dataset'),
        el('h3', { class: 'display-name' }, label),
        el('p', { class: 'text-ink-soft text-[0.92rem] max-w-[56ch]' }, detail),
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

function buildReport({ domain, findings, mxRecords, consumerHit }: RenderInput): HTMLElement {
    const report = el('section', { class: REPORT_CARD, 'aria-live': 'polite' });

    report.append(
        el('header', { class: 'flex justify-between gap-4 pb-[0.7rem] border-b border-rule stencil' },
            el('span', {}, 'INSPECTION REPORT'),
            el('span', { class: 'text-ink-soft' }, `N° ${reportNumber(domain)}`),
        ),
    );

    report.append(
        el('div', { class: 'grid gap-1' },
            el('span', { class: 'stencil' }, 'Subject'),
            el('span', { class: 'font-mono text-[clamp(1rem,2.6vw,1.15rem)] text-ink break-all' }, domain),
        ),
    );

    const findingsWrap = el('div', { class: 'findings-list' });

    if (findings.length === 0 && mxRecords.length > 0) {
        findingsWrap.append(
            el('article', { class: 'finding' },
                el('div', { class: 'stencil' }, 'Inconclusive'),
                el('h3', { class: 'display-name' }, 'Unrecognised provider'),
                el('p', { class: 'text-ink-soft text-[0.92rem] max-w-[56ch]' },
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
            el('article', { class: 'finding' },
                el('div', { class: 'stencil' }, 'No mail exchange'),
                el('h3', { class: 'display-name' }, 'No MX records'),
                el('p', { class: 'text-ink-soft text-[0.92rem] max-w-[56ch]' },
                    `${domain} publishes no MX records, so it almost certainly does not receive email at this domain.`),
            ),
        );
    } else {
        for (const f of findings) findingsWrap.append(findingBlock(f));
    }

    if (consumerHit) findingsWrap.append(consumerCallout(consumerHit));

    report.append(findingsWrap);
    if (mxRecords.length > 0) report.append(mxTable(mxRecords));

    report.append(
        el('footer', { class: 'pt-[0.7rem] border-t border-rule flex flex-wrap justify-end gap-2' },
            shareButton(domain),
        ),
    );
    return report;
}

export function renderError(target: HTMLElement, message: string): void {
    target.replaceChildren(
        el('section', { class: `${REPORT_CARD} border-stamp-red`, 'aria-live': 'polite' },
            el('div', { class: 'stencil text-stamp-red' }, 'Lookup failed'),
            el('h3', { class: 'display-name' }, message),
        ),
    );
}

export function renderLoading(target: HTMLElement, domain: string): void {
    target.replaceChildren(
        el('section', { class: REPORT_CARD, 'aria-live': 'polite' },
            el('div', { class: 'stencil' }, 'Querying DNS'),
            el('h3', { class: 'display-name text-ink-faded' },
                'Resolving ',
                el('span', { class: 'font-mono' }, domain),
                el('span', { class: 'cursor' }, '_'),
            ),
        ),
    );
}

export function clearReport(target: HTMLElement): void {
    target.replaceChildren();
}
