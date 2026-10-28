import { describe, expect, test } from 'bun:test';
import { checkDmarc, parseDmarc, treeWalk } from '../src/dmarc.ts';
import { fakeResolver, type Zone } from './zone.ts';

const status = (checks: { id: string; status: string }[], id: string) =>
    checks.find((c) => c.id === id)?.status;
const title = (checks: { id: string; title: string }[], id: string) => checks.find((c) => c.id === id)?.title;

const zoneWith = (record: string, extra: Zone = {}): Zone => ({
    'example.com': { A: ['192.0.2.1'] },
    '_dmarc.example.com': { TXT: [record] },
    ...extra,
});

describe('treeWalk (RFC 9989 §4.10)', () => {
    test('walks up one label at a time to the TLD', () => {
        expect(treeWalk('mail.example.com')).toEqual(['mail.example.com', 'example.com', 'com']);
    });
    test('jumps to seven labels for long names, and stops at eight queries', () => {
        const walk = treeWalk('a.b.c.d.e.f.g.h.i.j.mail.example.com');
        expect(walk[1]).toBe('g.h.i.j.mail.example.com');
        expect(walk).toHaveLength(8);
        expect(walk.at(-1)).toBe('com');
    });
});

describe('parseDmarc', () => {
    test('a clean record has no errors or warnings', () => {
        const p = parseDmarc(
            'v=DMARC1; p=reject; np=reject; rua=mailto:d@example.com; adkim=s; t=n; psd=n; fo=1',
        );
        expect(p.errors).toEqual([]);
        expect(p.warnings).toEqual([]);
    });
    test('v must be first and exactly DMARC1', () => {
        expect(parseDmarc('p=none; v=DMARC1').errors.length).toBeGreaterThan(0);
        expect(parseDmarc('v=dmarc1; p=none').errors.length).toBeGreaterThan(0);
    });
    test.each([
        ['p=block', 'policy'],
        ['adkim=x', 'adkim'],
        ['t=maybe', 't='],
        ['psd=true', 'psd'],
        ['fo=0:1', 'mutually exclusive'],
        ['rua=dmarc@example.com', 'not a valid URI'],
    ])('rejects %s', (tag, expected) => {
        expect(parseDmarc(`v=DMARC1; ${tag}`).errors.join(' ')).toContain(expected);
    });
    test('pct, rf and ri are obsolete, not unknown', () => {
        const w = parseDmarc('v=DMARC1; p=none; pct=50; rf=afrf; ri=86400').warnings.join(' ');
        expect(w).toContain('pct');
        expect(w).toContain('rf');
        expect(w).toContain('ri');
        expect(w).not.toContain('Unknown');
    });
    test('the size suffix is accepted but flagged obsolete', () => {
        const p = parseDmarc('v=DMARC1; p=none; rua=mailto:d@example.com!10m');
        expect(p.errors).toEqual([]);
        expect(p.warnings.join(' ')).toContain('obsolete');
    });
});

describe('checkDmarc', () => {
    test('reports a missing record', async () => {
        const r = await checkDmarc('example.com', fakeResolver({ 'example.com': {} }));
        expect(status(r.checks, 'dmarc-published')).toBe('fail');
    });

    test('p=reject with reports passes, but DKIM is left as not verifiable', async () => {
        const r = await checkDmarc(
            'example.com',
            fakeResolver(zoneWith('v=DMARC1; p=reject; rua=mailto:d@example.com')),
        );
        expect(status(r.checks, 'dmarc-policy')).toBe('pass');
        expect(status(r.checks, 'dmarc-rua')).toBe('pass');
        expect(status(r.checks, 'dmarc-dkim')).toBe('manual');
    });

    test('p=none is a warning', async () => {
        const r = await checkDmarc(
            'example.com',
            fakeResolver(zoneWith('v=DMARC1; p=none; rua=mailto:d@example.com')),
        );
        expect(status(r.checks, 'dmarc-policy')).toBe('warn');
    });

    test('t=y lowers the effective policy one level', async () => {
        const r = await checkDmarc('example.com', fakeResolver(zoneWith('v=DMARC1; p=quarantine; t=y')));
        expect(status(r.checks, 'dmarc-policy')).toBe('warn');
        expect(title(r.checks, 'dmarc-policy')).toContain('not enforced');
    });

    test('a missing p= with a valid rua is treated as p=none', async () => {
        const r = await checkDmarc(
            'example.com',
            fakeResolver(zoneWith('v=DMARC1; rua=mailto:d@example.com')),
        );
        expect(status(r.checks, 'dmarc-policy')).toBe('warn');
        expect(title(r.checks, 'dmarc-policy')).toContain('p=none');
    });

    test('a missing p= without rua means no DMARC processing', async () => {
        const r = await checkDmarc('example.com', fakeResolver(zoneWith('v=DMARC1; adkim=s')));
        expect(status(r.checks, 'dmarc-policy')).toBe('fail');
    });

    test('flags obsolete pct, and warns when it was softening the policy', async () => {
        const r = await checkDmarc('example.com', fakeResolver(zoneWith('v=DMARC1; p=reject; pct=20')));
        expect(status(r.checks, 'dmarc-obsolete')).toBe('warn');
        const harmless = await checkDmarc(
            'example.com',
            fakeResolver(zoneWith('v=DMARC1; p=reject; pct=100; ri=86400')),
        );
        expect(status(harmless.checks, 'dmarc-obsolete')).toBe('info');
    });

    test('multiple records fail', async () => {
        const zone: Zone = { '_dmarc.example.com': { TXT: ['v=DMARC1; p=none', 'v=DMARC1; p=reject'] } };
        const r = await checkDmarc('example.com', fakeResolver(zone));
        expect(status(r.checks, 'dmarc-multiple')).toBe('fail');
    });

    test('a subdomain inherits the parent’s sp= through the tree walk', async () => {
        const zone = zoneWith('v=DMARC1; p=reject; sp=quarantine', {
            'mail.example.com': { A: ['192.0.2.1'] },
        });
        const r = await checkDmarc('mail.example.com', fakeResolver(zone));
        expect(r.policyDomain).toBe('example.com');
        expect(title(r.checks, 'dmarc-policy')).toContain('sp=quarantine');
    });

    test('a non-existent subdomain gets np=', async () => {
        const zone = zoneWith('v=DMARC1; p=reject; sp=quarantine; np=none');
        const r = await checkDmarc('ghost.example.com', fakeResolver(zone));
        expect(title(r.checks, 'dmarc-policy')).toContain('np=none');
        expect(status(r.checks, 'dmarc-policy')).toBe('warn');
    });

    test('warns when subdomains are weaker than the domain', async () => {
        const r = await checkDmarc(
            'example.com',
            fakeResolver(zoneWith('v=DMARC1; p=reject; sp=none; np=none')),
        );
        expect(status(r.checks, 'dmarc-subdomain-policy')).toBe('warn');
        expect(status(r.checks, 'dmarc-np-policy')).toBe('warn');
    });

    test('checks external report authorisation', async () => {
        const record = 'v=DMARC1; p=reject; rua=mailto:a@reports.example.net,mailto:b@other.example.org';
        const zone = zoneWith(record, {
            'example.com._report._dmarc.reports.example.net': { TXT: ['v=DMARC1'] },
            'example.com._report._dmarc.other.example.org': { TXT: [] },
        });
        const r = await checkDmarc('example.com', fakeResolver(zone));
        expect(status(r.checks, 'dmarc-external')).toBe('warn');
        expect(r.checks.find((c) => c.id === 'dmarc-external')?.detail).toContain('other.example.org');
        expect(r.checks.find((c) => c.id === 'dmarc-external')?.detail).not.toContain('reports.example.net,');
    });

    test('report addresses at the policy domain need no authorisation', async () => {
        const resolver = fakeResolver(zoneWith('v=DMARC1; p=reject; rua=mailto:d@example.com'));
        const r = await checkDmarc('example.com', resolver);
        expect(status(r.checks, 'dmarc-external')).toBeUndefined();
        expect(resolver.queries.some((q) => q.includes('_report._dmarc'))).toBe(false);
    });
});
