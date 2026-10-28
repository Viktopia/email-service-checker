import { describe, expect, test } from 'bun:test';
import { checkBimi } from '../src/bimi.ts';
import { type Check, verdict } from '../src/checks.ts';
import { checkDane, parseTlsa } from '../src/dane.ts';
import { checkMtaSts, type FetchPolicy, mxMatches, parseStsPolicy } from '../src/mta-sts.ts';
import { checkMx, isReservedIPv4 } from '../src/mx-health.ts';
import { checkTlsRpt } from '../src/tls-rpt.ts';
import { fakeResolver, type Zone } from './zone.ts';

const status = (checks: Check[], id: string) => checks.find((c) => c.id === id)?.status;

describe('verdict', () => {
    test('never reads as a pass when something could not be verified', () => {
        const checks: Check[] = [
            { id: 'a', status: 'pass', title: '', detail: '' },
            { id: 'b', status: 'manual', title: '', detail: '' },
        ];
        expect(verdict(checks)).toBe('manual');
    });
    test('only notes is info, not a pass', () => {
        expect(verdict([{ id: 'a', status: 'info', title: '', detail: '' }])).toBe('info');
    });
});

describe('MX checks', () => {
    const zone: Zone = {
        'mx1.example.com': { A: ['192.0.2.10'], AAAA: ['2001:db8::10'] },
        'mx2.example.com': { A: ['10.0.0.5'] },
        'alias.example.com': { A: ['192.0.2.11'], cname: true },
        'dead.example.com': {},
    };

    test('flags private addresses, CNAMEs, dead hosts and IP literals', async () => {
        const h = await checkMx(
            [
                { priority: 10, host: 'mx1.example.com' },
                { priority: 20, host: 'mx2.example.com' },
                { priority: 30, host: 'alias.example.com' },
                { priority: 40, host: 'dead.example.com' },
                { priority: 50, host: '192.0.2.99' },
            ],
            fakeResolver(zone),
        );
        expect(status(h.checks, 'mx-public-ip')).toBe('fail');
        expect(status(h.checks, 'mx-cname')).toBe('warn');
        expect(status(h.checks, 'mx-resolves')).toBe('fail');
        expect(status(h.checks, 'mx-ip-literal')).toBe('fail');
        expect(h.hosts.find((x) => x.host === 'mx1.example.com')?.ipv6).toEqual(['2001:db8::10']);
    });

    test('recognises a null MX', async () => {
        const h = await checkMx([{ priority: 0, host: '' }], fakeResolver({}));
        expect(status(h.checks, 'mx-null')).toBe('info');
        expect(h.checks.some((c) => c.status === 'fail')).toBe(false);
    });

    test('no MX records fails', async () => {
        expect(status((await checkMx([], fakeResolver({}))).checks, 'mx-published')).toBe('fail');
    });

    test.each([
        ['10.1.2.3', true],
        ['172.16.0.1', true],
        ['192.168.1.1', true],
        ['100.64.0.1', true],
        ['127.0.0.1', true],
        ['8.8.8.8', false],
        ['172.32.0.1', false],
        ['192.0.2.1', true],
        ['203.0.113.9', true],
        // Real, routable addresses in 192.0.0.0/16: ICANN's MX and Automattic's.
        ['192.0.33.73', false],
        ['192.0.78.24', false],
    ])('isReservedIPv4(%s) is %s', (ip, expected) => {
        expect(isReservedIPv4(ip)).toBe(expected);
    });
});

describe('MTA-STS', () => {
    const policy =
        'version: STSv1\nmode: enforce\nmx: mx1.example.com\nmx: *.backup.example.com\nmax_age: 604800\n';
    const zone: Zone = {
        '_mta-sts.example.com': { TXT: ['v=STSv1; id=20261028T000000;'] },
        'mta-sts.example.com': { A: ['192.0.2.1'] },
        'example.com': { MX: ['10 mx1.example.com.', '20 a.backup.example.com.'] },
    };
    const serve =
        (body: string, contentType = 'text/plain'): FetchPolicy =>
        async () => ({ kind: 'text', status: 200, body, contentType });

    test('parses a policy file', () => {
        const p = parseStsPolicy(policy);
        expect(p.errors).toEqual([]);
        expect(p.mode).toBe('enforce');
        expect(p.mx).toEqual(['mx1.example.com', '*.backup.example.com']);
    });

    test('rejects max_age over a year and a missing mx', () => {
        expect(parseStsPolicy('version: STSv1\nmode: enforce\nmax_age: 99999999').errors.length).toBe(2);
    });

    test('wildcards match exactly one label', () => {
        expect(mxMatches('*.example.com', 'mx.example.com')).toBe(true);
        expect(mxMatches('*.example.com', 'a.b.example.com')).toBe(false);
        expect(mxMatches('*.example.com', 'example.com')).toBe(false);
    });

    test('a complete, enforcing setup passes', async () => {
        const r = await checkMtaSts('example.com', fakeResolver(zone), serve(policy));
        expect(r.checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    });

    test('an MX host missing from an enforcing policy fails', async () => {
        const r = await checkMtaSts(
            'example.com',
            fakeResolver(zone),
            serve('version: STSv1\nmode: enforce\nmx: mx1.example.com\nmax_age: 604800'),
        );
        expect(status(r.checks, 'sts-mx-match')).toBe('fail');
    });

    test('an unreadable policy is not verifiable, not a pass', async () => {
        const r = await checkMtaSts('example.com', fakeResolver(zone), async () => ({ kind: 'opaque' }));
        expect(status(r.checks, 'sts-policy')).toBe('manual');
        expect(verdict(r.checks)).toBe('manual');
    });

    test('an unreachable policy host fails', async () => {
        const r = await checkMtaSts('example.com', fakeResolver(zone), async () => ({ kind: 'error' }));
        expect(status(r.checks, 'sts-policy')).toBe('fail');
    });

    test('no record fails without fetching anything', async () => {
        let fetched = false;
        const r = await checkMtaSts('example.com', fakeResolver({}), async () => {
            fetched = true;
            return { kind: 'error' };
        });
        expect(status(r.checks, 'sts-record')).toBe('fail');
        expect(fetched).toBe(false);
    });
});

describe('TLS-RPT', () => {
    test('accepts mailto and https destinations', async () => {
        const zone: Zone = {
            '_smtp._tls.example.com': {
                TXT: ['v=TLSRPTv1; rua=mailto:t@example.com,https://reports.example.net/tls'],
            },
        };
        expect(status((await checkTlsRpt('example.com', fakeResolver(zone))).checks, 'tlsrpt-record')).toBe(
            'pass',
        );
    });
    test('rejects other schemes', async () => {
        const zone: Zone = { '_smtp._tls.example.com': { TXT: ['v=TLSRPTv1; rua=ftp://example.com'] } };
        expect(status((await checkTlsRpt('example.com', fakeResolver(zone))).checks, 'tlsrpt-record')).toBe(
            'fail',
        );
    });
    test('missing is a warning', async () => {
        expect(status((await checkTlsRpt('example.com', fakeResolver({}))).checks, 'tlsrpt-record')).toBe(
            'warn',
        );
    });
});

describe('DANE', () => {
    test('parses both resolvers’ TLSA formats', () => {
        const hex = '38a88126a15ae8e643ce9447c3ce9a874ea0e05255d07ee12227809edbe5c7f1';
        expect(parseTlsa(`3 1 1 ${hex}`).error).toBeUndefined();
        expect(parseTlsa(`3 1 1 ( ${hex.toUpperCase()} )`).data).toBe(hex);
        expect(parseTlsa('3 1 1 abcd').error).toContain('32 bytes');
    });

    const hex = 'a'.repeat(64);
    const signed: Zone = {
        'example.com': { MX: ['10 mx.example.com.'], DS: ['1 13 2 abc'], secure: true },
        'mx.example.com': { A: ['192.0.2.1'], secure: true },
        '_25._tcp.mx.example.com': { TLSA: [`3 1 1 ${hex}`], secure: true },
    };

    test('signed zone with valid TLSA passes, leaving the certificate match unverifiable', async () => {
        const r = await checkDane(
            'example.com',
            [{ priority: 10, host: 'mx.example.com' }],
            fakeResolver(signed),
        );
        expect(status(r.checks, 'dnssec')).toBe('pass');
        expect(status(r.checks, 'dane-coverage')).toBe('pass');
        expect(status(r.checks, 'dane-match')).toBe('manual');
    });

    test('unsigned TLSA records fail', async () => {
        const zone = { ...signed, '_25._tcp.mx.example.com': { TLSA: [`3 1 1 ${hex}`] } };
        const r = await checkDane(
            'example.com',
            [{ priority: 10, host: 'mx.example.com' }],
            fakeResolver(zone),
        );
        expect(status(r.checks, 'dane-secure')).toBe('fail');
    });

    test('PKIX usages are warned about', async () => {
        const zone = { ...signed, '_25._tcp.mx.example.com': { TLSA: [`1 1 1 ${hex}`], secure: true } };
        const r = await checkDane(
            'example.com',
            [{ priority: 10, host: 'mx.example.com' }],
            fakeResolver(zone),
        );
        expect(status(r.checks, 'dane-usage')).toBe('warn');
    });

    test('SERVFAIL means a broken chain', async () => {
        const r = await checkDane('example.com', [], fakeResolver({ 'example.com': { servfail: true } }));
        expect(status(r.checks, 'dnssec')).toBe('fail');
    });
});

describe('BIMI', () => {
    const bimi = 'v=BIMI1; l=https://example.com/logo.svg; a=https://example.com/vmc.pem';
    test('requires DMARC enforcement', async () => {
        const zone: Zone = {
            'default._bimi.example.com': { TXT: [bimi] },
            '_dmarc.example.com': { TXT: ['v=DMARC1; p=none'] },
        };
        const r = await checkBimi('example.com', fakeResolver(zone));
        expect(status(r.checks, 'bimi-dmarc')).toBe('fail');
        expect(status(r.checks, 'bimi-record')).toBe('pass');
    });
    test('a complete setup still leaves the certificate unverified', async () => {
        const zone: Zone = {
            'default._bimi.example.com': { TXT: [bimi] },
            '_dmarc.example.com': { TXT: ['v=DMARC1; p=reject'] },
        };
        const r = await checkBimi('example.com', fakeResolver(zone));
        expect(status(r.checks, 'bimi-dmarc')).toBe('pass');
        expect(status(r.checks, 'bimi-vmc')).toBe('manual');
    });
    test('without a BIMI record, weak DMARC is a note rather than an error', async () => {
        const zone: Zone = { '_dmarc.example.com': { TXT: ['v=DMARC1; p=none'] } };
        const r = await checkBimi('example.com', fakeResolver(zone));
        expect(status(r.checks, 'bimi-dmarc')).toBe('info');
        expect(verdict(r.checks)).toBe('info');
    });
    test('flags a non-https logo', async () => {
        const zone: Zone = {
            'default._bimi.example.com': { TXT: ['v=BIMI1; l=http://example.com/logo.svg'] },
            '_dmarc.example.com': { TXT: ['v=DMARC1; p=reject'] },
        };
        expect(status((await checkBimi('example.com', fakeResolver(zone))).checks, 'bimi-record')).toBe(
            'fail',
        );
    });
});
