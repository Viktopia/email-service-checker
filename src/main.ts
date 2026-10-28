import { consumerLookup, identifyProviders, isValidDomain, normalizeDomain } from './identify.ts';
import { LookupError, lookupMx } from './lookup.ts';
import { clearReport, renderError, renderLoading, renderReport, reportSummary } from './render.ts';

declare global {
    interface Window {
        dataLayer?: unknown[];
        gtag?: (...args: unknown[]) => void;
    }
}

/**
 * Which tool this page runs. Set by the build on the form as data-tool:
 *
 *   provider  the homepage and provider pages — who runs the mail
 *   mx        the MX lookup — the same, plus checks on each mail server
 *   spf, dmarc, mta-sts, tls-rpt, dane, bimi
 *             the checkers under /tools/
 *
 * Guide pages have no form, and so no tool.
 */
type Tool = 'provider' | 'mx' | import('./checkers.ts').CheckerKey;

/** Loaded on first use; see src/checkers.ts. */
const loadCheckers = () => import('./checkers.ts');

const form = document.getElementById('check-form') as HTMLFormElement | null;

if (form) {
    const tool = (form.dataset.tool ?? 'provider') as Tool;
    const input = document.getElementById('domain') as HTMLInputElement;
    const button = document.getElementById('check-button') as HTMLButtonElement;
    const buttonLabel = document.getElementById('check-button-label') as HTMLSpanElement;
    const result = document.getElementById('result') as HTMLElement;
    const extra = document.getElementById('result-extra') as HTMLElement | null;
    // Present from page load so screen readers register it as a live region before
    // anything lands in it. See the comment in scripts/build.ts.
    const status = document.getElementById('result-status') as HTMLElement;

    /** Puts one line in the live region, so a lookup is announced without the card being read out. */
    const announce = (message: string): void => {
        status.textContent = message;
    };

    const setBusy = (busy: boolean): void => {
        button.disabled = busy;
        buttonLabel.textContent = busy ? 'Checking…' : 'Check';
        form.classList.toggle('is-busy', busy);
    };

    const syncUrl = (domain: string): void => {
        const url = new URL(window.location.href);
        url.searchParams.set('domain', domain);
        history.replaceState(null, '', url);
    };

    const track = (event: string, params: Record<string, unknown>): void => {
        window.gtag?.('event', event, params);
    };

    async function runProvider(domain: string): Promise<void> {
        // Both are network calls and neither depends on the other, so they
        // overlap — the consumer-shard fetch costs no extra wall-clock time.
        const [mxRecords, consumerHit] = await Promise.all([lookupMx(domain), consumerLookup(domain)]);
        const findings = identifyProviders(mxRecords);

        const report = { domain, findings, mxRecords, consumerHit };
        renderReport(result, report);
        announce(reportSummary(report));

        track('check_email_service', {
            domain,
            tool,
            service:
                findings.length > 0
                    ? findings.map((f) => f.provider.name).join(' + ')
                    : consumerHit
                      ? `consumer:${consumerHit.kind}`
                      : 'Unknown',
            mx_count: mxRecords.length,
        });

        if (tool === 'mx' && extra) {
            const { runMxHealth } = await loadCheckers();
            announce(`${reportSummary(report)} ${await runMxHealth(extra, domain, mxRecords)}`);
        }
    }

    async function runChecker(kind: Exclude<Tool, 'provider' | 'mx'>, domain: string): Promise<void> {
        const { CHECKERS, checksSummary, verdict } = await loadCheckers();
        const checker = CHECKERS[kind];
        const checks = await checker.run(domain, result);
        announce(checksSummary(checker.label, domain, checks));
        track('check_email_security', { domain, tool, verdict: verdict(checks) });
    }

    async function runCheck(raw: string): Promise<void> {
        const domain = normalizeDomain(raw);
        if (!domain || !isValidDomain(domain)) {
            const message = 'Please enter a valid domain or email address.';
            renderError(result, message);
            extra?.replaceChildren();
            announce(message);
            return;
        }
        input.value = domain;
        syncUrl(domain);
        setBusy(true);
        renderLoading(result, domain);
        extra?.replaceChildren();
        announce(`Looking up ${domain}…`);

        try {
            if (tool === 'provider' || tool === 'mx') await runProvider(domain);
            else await runChecker(tool, domain);
        } catch (err) {
            const msg =
                err instanceof LookupError
                    ? 'DNS lookup failed. Please check the domain and try again.'
                    : 'Something went wrong. Please try again.';
            renderError(result, msg);
            announce(msg);
            console.error(err);
        } finally {
            setBusy(false);
        }
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        void runCheck(input.value);
    });

    input.addEventListener('input', () => {
        if (!input.value.trim()) {
            clearReport(result);
            extra?.replaceChildren();
            announce('');
        }
    });

    const initialDomain = new URLSearchParams(window.location.search).get('domain');
    if (initialDomain) {
        input.value = initialDomain;
        void runCheck(initialDomain);
    }
}
