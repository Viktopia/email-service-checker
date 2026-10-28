import { describe, expect, test } from 'bun:test';
import type { Check } from '../src/checks.ts';
import { checkDkim, parseDkimKey, rsaKeyBits } from '../src/dkim.ts';
import { checkDnsHealth, parseSoa } from '../src/dns-health.ts';
import { buildEmailReport } from '../src/email-report.ts';
import { isValidSelector } from '../src/identify.ts';
import { fakeResolver, type Zone } from './zone.ts';

const status = (checks: Check[], id: string) => checks.find((c) => c.id === id)?.status;

// Freshly generated test keys (openssl), not anyone's real DKIM key.
const RSA_1024_SPKI =
    'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCo8fLmG+UJ3+L9t3IIYotyypo5Wd3yXhsb7c/I/Ty7hHSisnW3OZyC4FwIoB7DeS9oaWSpupvH7YHBD/LAdQFSMcqyRfOGvHa/EPCqqj1/XArZFFUzpRg3K6gLCqcubvnwIz6bRkkMXCL8Wv8crQq1PMk/QS6TWEljPfzz8WTT3wIDAQAB';
const RSA_2048_SPKI =
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxaQF3pajvKmc9RR8+e5YGcAK9E1nVrUcFo9Nb3sMLK4b+Ns84VTNM+E3y7MDlQF8ZuFD8fJjpN9gbyonz2Z2E8HNDGeCvbF7OQ5sd66biY0tle8p55cQzbo59GpeXqKEW09CiTzodpDpKnQf2suuZoo3c2K5X0T7Ei13opXSmG2t0Tr8j7eNyH5hU7hJaLJXfNOuAYbuDLICnqKpK2e1dwkg/FaRgpdStIvJTNmsn6cWrP11SJmRcCBIP51D4Zoe8xOmYW9/QgjoNpDva9k1FV45vI6uMXUouEY3tGrbEjJipQuRUGfXyNhMO9E6YcJJGSdulzp20aEYkNVww8bTJwIDAQAB';
const RSA_1024_PKCS1 =
    'MIGJAoGBAKjx8uYb5Qnf4v23cghii3LKmjlZ3fJeGxvtz8j9PLuEdKKydbc5nILgXAigHsN5L2hpZKm6m8ftgcEP8sB1AVIxyrJF84a8dr8Q8KqqPX9cCtkUVTOlGDcrqAsKpy5u+fAjPptGSQxcIvxa/xytCrU8yT9BLpNYSWM9/PPxZNPfAgMBAAE=';
const ED25519 = 'AsRp6KlCEVSOz+UtJ1tkuNUXflCquZ2JAvm+r4Ge+hA=';

describe('rsaKeyBits', () => {
    test('reads the modulus length from a SubjectPublicKeyInfo', () => {
        expect(rsaKeyBits(RSA_1024_SPKI)).toBe(1024);
        expect(rsaKeyBits(RSA_2048_SPKI)).toBe(2048);
    });
    test('reads a bare PKCS#1 key too', () => {
        expect(rsaKeyBits(RSA_1024_PKCS1)).toBe(1024);
    });
    test('returns null for garbage rather than throwing', () => {
        expect(rsaKeyBits('not base64!')).toBeNull();
        expect(rsaKeyBits('AAAA')).toBeNull();
        expect(rsaKeyBits(RSA_2048_SPKI.slice(0, 80))).toBeNull();
    });
});

describe('isValidSelector', () => {
    test.each(['google', 'selector1', 's1', 'k1', '20230601', 'sel.sub', 'my_sel'])('accepts %s', (s) => {
        expect(isValidSelector(s)).toBe(true);
    });
    test.each(['', '-bad', 'a..b', 'has space', 'x/y'])('rejects %p', (s) => {
        expect(isValidSelector(s)).toBe(false);
    });
});

describe('parseDkimKey', () => {
    test('defaults to RSA and reads the length', () => {
        const k = parseDkimKey('s', 's._domainkey.example.com', `v=DKIM1; p=${RSA_2048_SPKI}`);
        expect(k.keyType).toBe('rsa');
        expect(k.bits).toBe(2048);
        expect(k.revoked).toBe(false);
    });
    test('an empty p= is a revoked key', () => {
        expect(parseDkimKey('s', 'n', 'v=DKIM1; p=').revoked).toBe(true);
    });
});

const key = (record: string): Zone => ({ 'sel._domainkey.example.com': { TXT: [record] } });

describe('checkDkim', () => {
    test('a 2048-bit key passes, signing stays unverifiable', async () => {
        const r = await checkDkim(
            'example.com',
            'sel',
            fakeResolver(key(`v=DKIM1; k=rsa; p=${RSA_2048_SPKI}`)),
        );
        expect(status(r.checks, 'dkim-published')).toBe('pass');
        expect(status(r.checks, 'dkim-syntax')).toBe('pass');
        expect(status(r.checks, 'dkim-key-strength')).toBe('pass');
        expect(status(r.checks, 'dkim-signing')).toBe('manual');
    });
    test('a 1024-bit key is a warning', async () => {
        const r = await checkDkim('example.com', 'sel', fakeResolver(key(`v=DKIM1; p=${RSA_1024_SPKI}`)));
        expect(status(r.checks, 'dkim-key-strength')).toBe('warn');
    });
    test('Ed25519 keys are recognised', async () => {
        const r = await checkDkim(
            'example.com',
            'sel',
            fakeResolver(key(`v=DKIM1; k=ed25519; p=${ED25519}`)),
        );
        expect(status(r.checks, 'dkim-syntax')).toBe('pass');
        expect(status(r.checks, 'dkim-key-strength')).toBe('pass');
    });
    test('revoked, testing and SHA-1-only keys are flagged', async () => {
        expect(
            status(
                (await checkDkim('example.com', 'sel', fakeResolver(key('v=DKIM1; p=')))).checks,
                'dkim-revoked',
            ),
        ).toBe('warn');
        const t = await checkDkim(
            'example.com',
            'sel',
            fakeResolver(key(`v=DKIM1; t=y; h=sha1; p=${RSA_2048_SPKI}`)),
        );
        expect(status(t.checks, 'dkim-testing')).toBe('warn');
        expect(status(t.checks, 'dkim-hash')).toBe('fail');
    });
    test('a key that is not RSA is invalid', async () => {
        const r = await checkDkim('example.com', 'sel', fakeResolver(key('v=DKIM1; p=AAAAAAAA')));
        expect(status(r.checks, 'dkim-syntax')).toBe('fail');
    });
    test('v= out of place is invalid', async () => {
        const r = await checkDkim('example.com', 'sel', fakeResolver(key(`p=${RSA_2048_SPKI}; v=DKIM1`)));
        expect(status(r.checks, 'dkim-syntax')).toBe('fail');
    });
    test('a missing key at a given selector fails', async () => {
        const r = await checkDkim('example.com', 'nope', fakeResolver({}));
        expect(status(r.checks, 'dkim-published')).toBe('fail');
    });
    test('without a selector, finds keys at common selectors', async () => {
        const zone: Zone = {
            'google._domainkey.example.com': { TXT: [`v=DKIM1; k=rsa; p=${RSA_2048_SPKI}`] },
            'selector1._domainkey.example.com': { TXT: [`v=DKIM1; k=rsa; p=${RSA_1024_SPKI}`] },
        };
        const r = await checkDkim('example.com', null, fakeResolver(zone));
        expect(r.keys.map((k) => k.selector).sort()).toEqual(['google', 'selector1']);
        expect(r.checks.find((c) => c.id === 'dkim-key-strength' && c.status === 'warn')?.title).toContain(
            'selector1',
        );
    });
    test('without a selector, finding nothing is not verifiable rather than a failure', async () => {
        const r = await checkDkim('example.com', null, fakeResolver({}));
        expect(status(r.checks, 'dkim-published')).toBe('manual');
    });
    test('a wildcard SPF or DMARC record is not mistaken for keys', async () => {
        const wild = fakeResolver({});
        const resolver = Object.assign(
            async (name: string, type: Parameters<typeof wild>[1]) =>
                name.endsWith('._domainkey.example.com') && type === 'TXT'
                    ? {
                          status: 0,
                          answers: [
                              { name, type: 16, TTL: 300, data: 'v=spf1 include:_spf.example.net -all' },
                          ],
                          aliased: false,
                          authenticated: false,
                      }
                    : wild(name, type),
            { queries: [] },
        );
        const r = await checkDkim('example.com', null, resolver);
        expect(r.keys).toEqual([]);
        expect(status(r.checks, 'dkim-published')).toBe('manual');
    });

    test('a wildcard DKIM key is reported once, not as every selector', async () => {
        const wild = fakeResolver({});
        const record = `v=DKIM1; p=${RSA_2048_SPKI}`;
        const resolver = Object.assign(
            async (name: string, type: Parameters<typeof wild>[1]) =>
                name.endsWith('._domainkey.example.com') && type === 'TXT'
                    ? {
                          status: 0,
                          answers: [{ name, type: 16, TTL: 300, data: record }],
                          aliased: false,
                          authenticated: false,
                      }
                    : wild(name, type),
            { queries: [] },
        );
        const r = await checkDkim('example.com', null, resolver);
        expect(r.keys).toEqual([]);
        expect(status(r.checks, 'dkim-wildcard')).toBe('warn');
    });

    test('a wildcard of revoked keys is the deliberate no-mail setup', async () => {
        const wild = fakeResolver({});
        const resolver = Object.assign(
            async (name: string, type: Parameters<typeof wild>[1]) =>
                name.endsWith('._domainkey.example.com') && type === 'TXT'
                    ? {
                          status: 0,
                          answers: [{ name, type: 16, TTL: 300, data: 'v=DKIM1; p=' }],
                          aliased: false,
                          authenticated: false,
                      }
                    : wild(name, type),
            { queries: [] },
        );
        expect(status((await checkDkim('example.com', null, resolver)).checks, 'dkim-wildcard')).toBe('info');
    });

    test('ignores TXT records at the name that are not DKIM keys', async () => {
        const r = await checkDkim('example.com', 'sel', fakeResolver(key('google-site-verification=abc')));
        expect(status(r.checks, 'dkim-published')).toBe('fail');
    });
});

describe('DNS health', () => {
    test('parses an SOA record', () => {
        expect(
            parseSoa('ns1.example.com. hostmaster.example.com. 2026102801 7200 3600 1209600 3600'),
        ).toEqual({
            mname: 'ns1.example.com',
            rname: 'hostmaster.example.com',
            serial: 2026102801,
            refresh: 7200,
            retry: 3600,
            expire: 1209600,
            minimum: 3600,
        });
    });

    const healthy: Zone = {
        'example.com': {
            NS: ['ns1.example.net.', 'ns2.example.org.'],
            SOA: ['ns1.example.net. hostmaster.example.com. 1 7200 3600 1209600 3600'],
            secure: true,
        },
        'ns1.example.net': { A: ['192.0.2.1'] },
        'ns2.example.org': { A: ['198.51.100.1'], AAAA: ['2001:db8::53'] },
    };

    test('a healthy zone passes, per-server checks stay unverifiable', async () => {
        const r = await checkDnsHealth('example.com', fakeResolver(healthy));
        expect(status(r.checks, 'dns-ns-count')).toBe('pass');
        expect(status(r.checks, 'dns-ns-resolve')).toBe('pass');
        expect(status(r.checks, 'dns-ns-diversity')).toBe('pass');
        expect(status(r.checks, 'dns-soa')).toBe('pass');
        expect(status(r.checks, 'dns-dnssec')).toBe('pass');
        expect(status(r.checks, 'dns-authoritative')).toBe('manual');
    });

    test('flags one nameserver, a dead one, one /24 and bad SOA timers', async () => {
        const zone: Zone = {
            'example.com': {
                NS: ['ns1.example.net.'],
                SOA: ['ns1.example.net. h.example.com. 1 300 600 3600 604800'],
            },
            'ns1.example.net': {},
        };
        const r = await checkDnsHealth('example.com', fakeResolver(zone));
        expect(status(r.checks, 'dns-ns-count')).toBe('fail');
        expect(status(r.checks, 'dns-ns-resolve')).toBe('fail');
        expect(status(r.checks, 'dns-soa')).toBe('info');
        const two: Zone = {
            ...healthy,
            'ns1.example.net': { A: ['192.0.2.1'] },
            'ns2.example.org': { A: ['192.0.2.2'] },
        };
        expect(
            status((await checkDnsHealth('example.com', fakeResolver(two))).checks, 'dns-ns-diversity'),
        ).toBe('warn');
    });

    test('walks up from a subdomain to its zone', async () => {
        const zone: Zone = { ...healthy, 'www.example.com': { A: ['192.0.2.80'] } };
        const r = await checkDnsHealth('www.example.com', fakeResolver(zone));
        expect(r.zone).toBe('example.com');
        expect(status(r.checks, 'dns-zone')).toBe('info');
    });

    test('a domain that does not exist fails', async () => {
        expect(status((await checkDnsHealth('nope.example', fakeResolver({}))).checks, 'dns-exists')).toBe(
            'fail',
        );
    });
});

describe('email security report', () => {
    test('gives every standard a line, and never an all-clear', async () => {
        const zone: Zone = {
            'example.com': {
                MX: ['10 mx.example.com.'],
                TXT: ['v=spf1 mx -all'],
                NS: ['ns1.example.net.', 'ns2.example.org.'],
                SOA: ['ns1.example.net. h.example.com. 1 7200 3600 1209600 3600'],
            },
            'mx.example.com': { A: ['192.0.2.25'] },
            '_dmarc.example.com': { TXT: ['v=DMARC1; p=reject; rua=mailto:d@example.com'] },
            'ns1.example.net': { A: ['192.0.2.1'] },
            'ns2.example.org': { A: ['198.51.100.1'] },
        };
        const r = await buildEmailReport('example.com', fakeResolver(zone), async () => ({ kind: 'error' }));
        expect(r.lines.map((l) => l.key)).toEqual([
            'mx',
            'spf',
            'dkim',
            'dmarc',
            'mta-sts',
            'tls-rpt',
            'dane',
            'bimi',
            'dns',
        ]);
        expect(r.lines.find((l) => l.key === 'spf')?.status).toBe('pass');
        expect(r.lines.find((l) => l.key === 'dkim')?.status).toBe('manual');
        expect(r.lines.find((l) => l.key === 'mta-sts')?.status).toBe('fail');
        // DMARC is enforcing, so BIMI's prerequisite passes — but there is no
        // BIMI record, and the line must say that rather than "all passed".
        const bimi = r.lines.find((l) => l.key === 'bimi');
        expect(bimi?.status).toBe('info');
        expect(bimi?.headline).toBe('No BIMI record');
    });

    test('a checker that throws becomes a line, not a crash', async () => {
        const broken = Object.assign(
            async () => {
                throw new Error('resolver down');
            },
            { queries: [] },
        );
        const r = await buildEmailReport('example.com', broken, async () => ({ kind: 'error' }));
        expect(r.lines).toHaveLength(9);
        expect(r.lines.every((l) => l.status === 'manual')).toBe(true);
    });
});
