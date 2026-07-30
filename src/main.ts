import { lookupMx, LookupError } from './lookup.ts';
import { identifyProviders, normalizeDomain, isValidDomain, consumerLookup } from './identify.ts';
import { renderReport, renderError, renderLoading, clearReport } from './render.ts';

declare global {
    interface Window {
        dataLayer?: unknown[];
        gtag?: (...args: unknown[]) => void;
    }
}

const form = document.getElementById('check-form') as HTMLFormElement;
const input = document.getElementById('domain') as HTMLInputElement;
const button = document.getElementById('check-button') as HTMLButtonElement;
const buttonLabel = document.getElementById('check-button-label') as HTMLSpanElement;
const result = document.getElementById('result') as HTMLElement;

function setBusy(busy: boolean): void {
    button.disabled = busy;
    buttonLabel.textContent = busy ? 'Checking…' : 'Check';
    form.classList.toggle('is-busy', busy);
}

function syncUrl(domain: string): void {
    const url = new URL(window.location.href);
    url.searchParams.set('domain', domain);
    history.replaceState(null, '', url);
}

async function runCheck(raw: string): Promise<void> {
    const domain = normalizeDomain(raw);
    if (!domain || !isValidDomain(domain)) {
        renderError(result, 'Please enter a valid domain or email address.');
        return;
    }
    input.value = domain;
    syncUrl(domain);
    setBusy(true);
    renderLoading(result, domain);

    try {
        // Both are network calls and neither depends on the other, so they
        // overlap — the consumer-shard fetch costs no extra wall-clock time.
        const [mxRecords, consumerHit] = await Promise.all([lookupMx(domain), consumerLookup(domain)]);
        const findings = identifyProviders(mxRecords);

        renderReport(result, { domain, findings, mxRecords, consumerHit });

        window.gtag?.('event', 'check_email_service', {
            domain,
            service:
                findings.length > 0
                    ? findings.map((f) => f.provider.name).join(' + ')
                    : consumerHit
                      ? `consumer:${consumerHit.kind}`
                      : 'Unknown',
            mx_count: mxRecords.length,
        });
    } catch (err) {
        const msg =
            err instanceof LookupError
                ? 'DNS lookup failed. Please check the domain and try again.'
                : 'Something went wrong. Please try again.';
        renderError(result, msg);
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
    if (!input.value.trim()) clearReport(result);
});

const initialDomain = new URLSearchParams(window.location.search).get('domain');
if (initialDomain) {
    input.value = initialDomain;
    void runCheck(initialDomain);
}
