/**
 * Every checker the /tools/ pages and the MX lookup run, behind one module.
 *
 * main.ts loads this with a dynamic import(), so the homepage and the 162
 * provider pages — which only ever run the provider lookup — do not download
 * the checkers and their report text. Bun splits it into its own chunk.
 */

import { checkBimi } from './bimi.ts';
import { type Check, verdict } from './checks.ts';
import { checkDane } from './dane.ts';
import { checkDmarc } from './dmarc.ts';
import { resolve } from './dns.ts';
import { lookupMx } from './lookup.ts';
import { checkMtaSts } from './mta-sts.ts';
import { checkMx } from './mx-health.ts';
import {
    checksSummary,
    renderBimiReport,
    renderDaneReport,
    renderDmarcReport,
    renderMtaStsReport,
    renderMxHealth,
    renderSpfReport,
    renderTlsRptReport,
} from './render-checks.ts';
import { checkSpf } from './spf.ts';
import { checkTlsRpt } from './tls-rpt.ts';
import type { MxRecord } from './types.ts';

export { checksSummary, verdict };

export type CheckerKey = 'spf' | 'dmarc' | 'mta-sts' | 'tls-rpt' | 'dane' | 'bimi';

/**
 * The checkers that share one shape: run, render, announce. Each returns the
 * checks so the caller can summarise and track them the same way.
 */
export const CHECKERS: Record<
    CheckerKey,
    { label: string; run: (domain: string, target: HTMLElement) => Promise<Check[]> }
> = {
    spf: {
        label: 'SPF',
        run: async (domain, target) => {
            const r = await checkSpf(domain, resolve);
            renderSpfReport(target, r);
            return r.checks;
        },
    },
    dmarc: {
        label: 'DMARC',
        run: async (domain, target) => {
            const r = await checkDmarc(domain, resolve);
            renderDmarcReport(target, r);
            return r.checks;
        },
    },
    'mta-sts': {
        label: 'MTA-STS',
        run: async (domain, target) => {
            const r = await checkMtaSts(domain, resolve);
            renderMtaStsReport(target, r);
            return r.checks;
        },
    },
    'tls-rpt': {
        label: 'TLS-RPT',
        run: async (domain, target) => {
            const r = await checkTlsRpt(domain, resolve);
            renderTlsRptReport(target, r);
            return r.checks;
        },
    },
    dane: {
        label: 'DANE',
        run: async (domain, target) => {
            const r = await checkDane(domain, await lookupMx(domain), resolve);
            renderDaneReport(target, r);
            return r.checks;
        },
    },
    bimi: {
        label: 'BIMI',
        run: async (domain, target) => {
            const r = await checkBimi(domain, resolve);
            renderBimiReport(target, r);
            return r.checks;
        },
    },
};

/** The MX lookup page's second card: checks on each mail server. Returns the live-region line. */
export async function runMxHealth(target: HTMLElement, domain: string, mx: MxRecord[]): Promise<string> {
    const health = await checkMx(mx, resolve);
    renderMxHealth(target, domain, health);
    return checksSummary('Mail server checks', domain, health.checks);
}
