/**
 * The result shape every diagnostic tool produces.
 *
 * The SPF, DMARC and MX checkers each run a list of named tests, and the page
 * renders them the same way, so a check is data rather than markup: the
 * checkers stay pure and testable, and render-checks.ts is the only place
 * that knows what a check looks like on screen.
 */

/**
 * `manual` is for what a browser cannot see: an HTTPS policy file served
 * without CORS, a DKIM key whose selector is unknown. It exists so that a
 * report never reads as all-clear just because the parts it could check were
 * fine.
 */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info' | 'manual';

export interface Check {
    /** Stable identifier, for tests and analytics. */
    id: string;
    status: CheckStatus;
    title: string;
    detail: string;
}

export const STATUS_LABEL: Record<CheckStatus, string> = {
    pass: 'Pass',
    warn: 'Warning',
    fail: 'Error',
    info: 'Info',
    manual: 'Not verifiable',
};

const RANK: Record<CheckStatus, number> = { fail: 0, warn: 1, manual: 2, pass: 3, info: 4 };

/** Errors first, then warnings, so the thing to fix is at the top; notes last. Stable within a status. */
export function sortChecks(checks: readonly Check[]): Check[] {
    return checks
        .map((c, i) => ({ c, i }))
        .sort((a, b) => RANK[a.c.status] - RANK[b.c.status] || a.i - b.i)
        .map(({ c }) => c);
}

export function tally(checks: readonly Check[]): Record<CheckStatus, number> {
    const out: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, info: 0, manual: 0 };
    for (const c of checks) out[c.status]++;
    return out;
}

/** The worst status present, used as the report's headline verdict. */
export function verdict(checks: readonly Check[]): CheckStatus {
    if (checks.some((c) => c.status === 'fail')) return 'fail';
    if (checks.some((c) => c.status === 'warn')) return 'warn';
    if (checks.some((c) => c.status === 'manual')) return 'manual';
    return 'pass';
}
