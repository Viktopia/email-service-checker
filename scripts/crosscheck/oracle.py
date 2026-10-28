"""Second half of `bun run crosscheck`: recompute every fact the checkers
report, independently, from `dig`, and diff against .crosscheck/facts.json.

Nothing here is shared with the TypeScript implementation: DNS comes from
`dig @8.8.8.8`, the SPF lookup and void counts and the DMARC tree walk are
reimplemented from the RFCs, DKIM key lengths come from `openssl`, and
address classification from Python's ipaddress module. Only the list of
common DKIM selectors is read from src/dkim.ts, since that is a choice, not
a fact.

Needs dig and openssl on the PATH. Standard library only.
Exits non-zero when any domain differs.
"""
import base64, functools, ipaddress, json, os, random, re, string, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')

RESOLVER = '@8.8.8.8'


@functools.lru_cache(maxsize=None)
def dig(name, rtype):
    """Returns (rcode, ad_flag, [rdata of rtype]). Retries once on timeout."""
    for _ in range(3):
        # Fully qualified: dig reads a bare "ch" or "in" as a DNS class, not a TLD.
        fqdn = name if name.endswith('.') else f'{name}.'
        out = subprocess.run(['dig', RESOLVER, fqdn, rtype, '+noall', '+answer', '+comments', '+tries=2', '+time=4'],
                             capture_output=True, text=True).stdout
        m = re.search(r'status: (\w+)', out)
        if m:
            break
    else:
        return ('TIMEOUT', False, [])
    flags = re.search(r'flags: ([a-z ]+);', out)
    ad = bool(flags and ' ad' in f' {flags.group(1)}')
    rdata = []
    for line in out.splitlines():
        if not line or line.startswith(';'):
            continue
        parts = line.split(None, 4)
        if len(parts) == 5 and parts[3] == rtype:
            rdata.append(parts[4])
    return (m.group(1), ad, rdata)


def txt_strings(rdata):
    """Join a TXT rdata's quoted character-strings, undoing escapes."""
    out, i, s = '', 0, rdata
    while i < len(s):
        if s[i] != '"':
            i += 1
            continue
        i += 1
        while i < len(s) and s[i] != '"':
            if s[i] == '\\':
                if re.match(r'\d{3}', s[i + 1:i + 4]):
                    out += chr(int(s[i + 1:i + 4])); i += 4; continue
                out += s[i + 1]; i += 2; continue
            out += s[i]; i += 1
        i += 1
    return out


def txt(name):
    rc, ad, rd = dig(name, 'TXT')
    return rc, [txt_strings(r) for r in rd]


def has_addr(name):
    return bool(dig(name, 'A')[2]), bool(dig(name, 'AAAA')[2])


def is_cname(name):
    rc, ad, rd = dig(name, 'CNAME')
    return bool(rd)


# ---- SPF, per RFC 7208 ------------------------------------------------------

LOOKUP = {'include', 'a', 'mx', 'ptr', 'exists'}


def spf_records(domain):
    rc, recs = txt(domain)
    return rc, [r for r in recs if re.match(r'(?i)^v=spf1(\s|$)', r)]


def spf_walk(domain, path, acc):
    """Returns (record, lookups_in_subtree). acc collects voids, includes, problems."""
    rc, recs = spf_records(domain)
    if not recs:
        return None, 0
    rec = recs[0]
    terms = rec.split()[1:]
    has_all = any(re.match(r'^[+\-~?]?all$', t, re.I) for t in terms)
    total = 0
    for t in terms:
        if '=' in t.split(':')[0]:
            name, val = t.split('=', 1)
            if name.lower() == 'redirect' and not has_all:
                total += 1
                if '%{' not in val:
                    target = val.lower().rstrip('.')
                    sub_rc, sub = spf_records(target)
                    if not sub:
                        acc['problems'].append(f'redirect {target}')
                        if not dig(target, 'TXT')[2]:
                            acc['voids'] += 1
                    elif target not in path:
                        total += spf_walk(target, path + [target], acc)[1]
            continue
        mech = re.sub(r'^[+\-~?]', '', t)
        name = re.split(r'[:/]', mech, maxsplit=1)[0].lower()
        if name not in LOOKUP:
            continue
        total += 1
        val = mech.split(':', 1)[1] if ':' in mech else ''
        if name == 'include' and '%{' not in val:
            target = val.lower().rstrip('.')
            acc['includes'][target] = acc['includes'].get(target, 0) + 1
            if target in path:
                acc['problems'].append(f'loop {target}')
                continue
            sub_rc, sub = spf_records(target)
            if not sub:
                acc['problems'].append(f'include {target}')
                # RFC 7208 §4.6.4: a void lookup is one that returns no answers.
                if not dig(target, 'TXT')[2]:
                    acc['voids'] += 1
                continue
            total += spf_walk(target, path + [target], acc)[1]
        elif name in ('a', 'mx'):
            spec = val.split('/', 1)[0] if val else domain
            if '%{' in spec:
                continue
            if name == 'a':
                a4, a6 = has_addr(spec)
                if not a4 and not a6:
                    acc['voids'] += 1
            else:
                mx = dig(spec, 'MX')[2]
                if not mx:
                    acc['voids'] += 1
    return rec, total


# ---- DMARC, RFC 9989 §4.10 tree walk ------------------------------------------

def tree_walk(domain):
    labels = domain.split('.')
    names = [domain]
    n = 7 if len(labels) >= 8 else len(labels) - 1
    while n >= 1 and len(names) < 8:
        names.append('.'.join(labels[-n:]))
        n -= 1
    return names


def dmarc(domain):
    for name in tree_walk(domain):
        rc, recs = txt(f'_dmarc.{name}')
        recs = [r for r in recs if re.match(r'(?i)^v\s*=\s*DMARC1\s*(;|$)', r)]
        if recs:
            return name, recs
    return None, []


# ---- DKIM ---------------------------------------------------------------------

def selectors():
    src = open(os.path.join(ROOT, 'src', 'dkim.ts')).read()
    block = src[src.index('COMMON_SELECTORS = ['):src.index('] as const')]
    return re.findall(r"'([^']+)'", block)


def dkim_like(t):
    t = t.strip()
    if re.match(r'(?i)^v\s*=', t):
        return bool(re.match(r'(?i)^v\s*=\s*DKIM1\s*(;|$)', t))
    return bool(re.search(r'(?i)(^|;)\s*p\s*=', t))


def tag(rec, name):
    for part in rec.split(';'):
        if '=' in part and part.split('=', 1)[0].strip().lower() == name:
            return part.split('=', 1)[1].strip()
    return None


def rsa_bits(b64):
    try:
        der = base64.b64decode(re.sub(r'\s', '', b64), validate=True)
    except Exception:
        return None
    for args in (['openssl', 'pkey', '-pubin', '-inform', 'DER', '-text', '-noout'],
                 ['openssl', 'rsa', '-RSAPublicKey_in', '-inform', 'DER', '-text', '-noout']):
        p = subprocess.run(args, input=der, capture_output=True)
        m = re.search(rb'\((\d+) bit\)', p.stdout)
        if m:
            return int(m.group(1))
    return None


def dkim(domain):
    probe = 'zz-oracle-' + ''.join(random.choices(string.ascii_lowercase, k=8))
    wild = {r for r in txt(f'{probe}._domainkey.{domain}')[1] if dkim_like(r)}
    keys = []
    for sel in selectors():
        for r in txt(f'{sel}._domainkey.{domain}')[1]:
            if dkim_like(r) and r not in wild:
                ktype = (tag(r, 'k') or 'rsa').lower()
                p = tag(r, 'p')
                revoked = p is not None and re.sub(r'\s', '', p) == ''
                bits = rsa_bits(p) if ktype == 'rsa' and p and not revoked else None
                keys.append({'sel': sel, 'type': ktype, 'bits': bits, 'revoked': revoked, 'record': r})
    return keys


# ---- DNS health ---------------------------------------------------------------

def zone_of(domain):
    zone = domain
    while True:
        rc, ad, ns = dig(zone, 'NS')
        if ns or rc in ('NXDOMAIN', 'SERVFAIL') or zone.count('.') < 1:
            return zone, rc, ns
        zone = zone.split('.', 1)[1]
        if '.' not in zone:
            return zone, rc, dig(zone, 'NS')[2]


def global_ip(ip):
    return ipaddress.ip_address(ip).is_global


# ---- Compare ------------------------------------------------------------------

def compare(domain, f):
    diffs = []

    def eq(label, ours, theirs):
        if ours != theirs:
            diffs.append(f'{label}: checker={ours!r} dig={theirs!r}')

    # MX
    rc, ad, mxr = dig(domain, 'MX')
    dig_mx = sorted((int(r.split()[0]), r.split()[1].rstrip('.').lower()) for r in mxr)
    eq('MX records', sorted(tuple(x) for x in (f['mx'] or [])), dig_mx)
    for h in f['mxHosts'] or []:
        a4, a6 = has_addr(h['host'])
        eq(f'MX {h["host"]} has IPv4', h['has4'], a4)
        eq(f'MX {h["host"]} has IPv6', h['has6'], a6)
        eq(f'MX {h["host"]} is CNAME', h['cname'], is_cname(h['host']))
        ips = dig(h['host'], 'A')[2] + dig(h['host'], 'AAAA')[2]
        eq(f'MX {h["host"]} non-public address', h['reserved'], any(not global_ip(i) for i in ips))

    # SPF
    rc, recs = spf_records(domain)
    eq('SPF records', sorted(f['spf']['records']), sorted(recs))
    if len(recs) > 1:
        # Permerror: receivers evaluate nothing, so nothing should be counted.
        eq('SPF multiple records stop evaluation', (f['spf']['lookups'], f['spf']['tree']), (0, None))
    elif recs:
        acc = {'voids': 0, 'includes': {}, 'problems': []}
        _, lookups = spf_walk(domain, [domain], acc)
        eq('SPF DNS lookups', f['spf']['lookups'], lookups)
        eq('SPF void lookups', f['spf']['voids'], acc['voids'])
        dupes = any(n > 1 for n in acc['includes'].values())
        eq('SPF duplicate include flagged', 'spf-duplicate-include' in f['spf']['checks'], dupes)
        eq('SPF over 10 lookups flagged', f['spf']['checks'].get('spf-lookups') == 'fail', lookups > 10)

    # DMARC
    at, drecs = dmarc(domain)
    eq('DMARC policy domain', f['dmarc']['at'], at)
    eq('DMARC records', sorted(f['dmarc']['records']), sorted(drecs))
    if drecs and f['dmarc']['tags']:
        p = tag(drecs[0], 'p')
        ours = next((t['value'] for t in f['dmarc']['tags'] if t['name'] == 'p'), None)
        eq('DMARC p=', ours, p)

    # DKIM
    ours = sorted((k['sel'], k['type'], k['bits'], k['revoked'], k['record']) for k in f['dkim']['keys'])
    theirs = sorted((k['sel'], k['type'], k['bits'], k['revoked'], k['record']) for k in dkim(domain))
    eq('DKIM keys (selector, type, bits, revoked, record)', ours, theirs)

    # MTA-STS, TLS-RPT, BIMI records
    for label, name, prefix, key in (('MTA-STS', f'_mta-sts.{domain}', 'v=STSv1', 'mtaSts'),
                                     ('TLS-RPT', f'_smtp._tls.{domain}', 'v=TLSRPTv1', 'tlsRpt'),
                                     ('BIMI', f'default._bimi.{domain}', 'v=BIMI1', 'bimi')):
        recs = [r for r in txt(name)[1] if r.lower().startswith(prefix.lower())]
        eq(f'{label} record', f[key]['record'], recs[0] if len(recs) == 1 else None)
        if label == 'MTA-STS' and len(recs) == 1:
            a4, a6 = has_addr(f'mta-sts.{domain}')
            eq('MTA-STS host resolves (not flagged)', 'sts-host' not in f['mtaSts']['checks'], a4 or a6)

    # DANE / DNSSEC
    if f['dane']:
        eq('DNSSEC (AD on MX answer)', f['dane']['signed'], dig(domain, 'MX')[1])
        eq('DS record present', f['dane']['ds'], bool(dig(domain, 'DS')[2]))
        for h in f['dane']['hosts']:
            rc, ad, tl = dig(f'_25._tcp.{h["host"]}', 'TLSA')
            norm = sorted(re.sub(r'\s+', ' ', re.sub(r'[()]', ' ', t)).strip().lower() for t in tl)
            norm = sorted(' '.join(x.split()[:3]) + ' ' + ''.join(x.split()[3:]) for x in norm)
            eq(f'TLSA {h["host"]}', sorted(h['tlsa']), norm)
            eq(f'TLSA {h["host"]} validated', h['tlsaSecure'], ad)
            eq(f'MX {h["host"]} validated', h['secure'], dig(h['host'], 'A')[1])

    # DNS health
    zone, rc, ns = zone_of(domain)
    if rc == 'SERVFAIL':
        eq('Resolution failure flagged', f['dns']['checks'].get('dns-exists'), 'fail')
    elif rc != 'NXDOMAIN':
        eq('DNS zone', f['dns']['zone'], zone)
        eq('Nameservers', sorted(n['host'] for n in f['dns']['ns'] or []), sorted(x.rstrip('.').lower() for x in ns))
        for n in f['dns']['ns'] or []:
            a4, a6 = has_addr(n['host'])
            eq(f'NS {n["host"]} has IPv4', n['has4'], a4)
            eq(f'NS {n["host"]} has IPv6', n['has6'], a6)
        src, sad, soa = dig(zone, 'SOA')
        if soa and f['dns']['soa']:
            ours = f['dns']['soa']
            ours = [ours['mname'], ours['refresh'], ours['retry'], ours['expire'], ours['minimum']]
            # Zones split across two DNS providers serve a different SOA from
            # each, and serials move as zones update. So ask every nameserver
            # directly, and accept the checker's SOA if any of them serves it.
            served = []
            for n in ns:
                out = subprocess.run(['dig', f'@{n.rstrip(".")}', f'{zone}.', 'SOA', '+short', '+time=3', '+tries=1'],
                                     capture_output=True, text=True).stdout
                for line in out.splitlines():
                    m = re.match(r'^(\S+) \S+ \d+ (\d+) (\d+) (\d+) (\d+)$', line.strip())
                    if m:
                        served.append([m.group(1).rstrip('.').lower(), *(int(m.group(i)) for i in range(2, 6))])
            eq('SOA (timers and primary, against every nameserver)', ours in served or not served, True)
            eq('DNSSEC (AD on SOA)', f['dns']['signed'], sad)
    else:
        eq('Domain does not exist flagged', f['dns']['checks'].get('dns-exists'), 'fail')
    return diffs


def main():
    facts = json.load(open(os.path.join(ROOT, '.crosscheck', 'facts.json')))
    only = set(sys.argv[1:])
    domains = [d for d in facts if not only or d in only]
    with ThreadPoolExecutor(12) as ex:
        results = dict(zip(domains, ex.map(
            lambda d: compare(d, facts[d]) if 'error' not in facts[d] else [f'checker error: {facts[d]["error"]}'],
            domains)))
    bad = {d: r for d, r in results.items() if r}
    for d, r in sorted(bad.items()):
        print(d)
        for x in r:
            print('   ', x)
    print(f'\n{len(domains) - len(bad)} of {len(domains)} domains match dig exactly; {len(bad)} with differences')
    json.dump(bad, open(os.path.join(ROOT, '.crosscheck', 'diffs.json'), 'w'), indent=1)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
