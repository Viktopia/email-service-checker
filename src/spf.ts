/**
 * SPF record parsing and checking, entirely in the browser.
 *
 * The site is static, so there is no server to run a check from: every query
 * goes over DNS over HTTPS (see dns.ts), and everything else here is pure.
 * The checker takes its resolver as an argument so the tests can hand it a
 * fake zone.
 *
 * What it cannot do is evaluate SPF for a real message. That needs the
 * sending IP, and with it the macros, `exists` and `ptr`. So it checks what
 * can be checked from the record alone — syntax, the 10-lookup and 2-void
 * limits, the final policy — and says so where something depends on the
 * sender.
 *
 * References are to RFC 7208.
 */

import type { Check } from './checks.ts';
import { parseTxtData, RCODE_NXDOMAIN, type Resolve } from './dns.ts';

export type Qualifier = '+' | '-' | '~' | '?';

export const MECHANISMS = ['all', 'include', 'a', 'mx', 'ptr', 'ip4', 'ip6', 'exists'] as const;
export type MechanismName = (typeof MECHANISMS)[number];

export interface SpfTerm {
    raw: string;
    kind: 'mechanism' | 'modifier';
    /** Mechanism or modifier name, lowercased. */
    name: string;
    /** Mechanisms only. Defaults to '+' when the record leaves it implicit. */
    qualifier: Qualifier;
    /** The domain-spec or address after ':' or '='. Empty when absent. */
    value: string;
    /** CIDR suffix for a, mx, ip4 and ip6, e.g. "/24" or "/24//64". */
    cidr: string;
    error?: string;
}

export interface ParsedSpf {
    terms: SpfTerm[];
    errors: string[];
}

/** Mechanisms and modifiers that cost one of the 10 DNS lookups (§4.6.4). */
const LOOKUP_TERMS = new Set(['include', 'a', 'mx', 'ptr', 'exists', 'redirect']);

export const MAX_LOOKUPS = 10;
export const MAX_VOID_LOOKUPS = 2;
/** §3.4: keep the whole answer within 512 bytes; 450 leaves room for the rest of the packet. */
export const MAX_RECORD_LENGTH = 450;

export function isSpfRecord(txt: string): boolean {
    return /^v=spf1(\s|$)/i.test(txt);
}

// ---- Address and domain-spec validation ---------------------------------

export function isIPv4(s: string): boolean {
    const parts = s.split('.');
    return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

export function isIPv6(s: string): boolean {
    if (!/^[0-9a-f:.]+$/i.test(s)) return false;
    const halves = s.split('::');
    if (halves.length > 2) return false;

    const groups = (part: string): string[] | null => {
        if (part === '') return [];
        const g = part.split(':');
        return g.some((x) => x === '') ? null : g;
    };
    const left = groups(halves[0]!);
    const right = halves.length === 2 ? groups(halves[1]!) : [];
    if (!left || !right) return false;

    const all = [...left, ...right];
    let count = 0;
    for (const [i, g] of all.entries()) {
        if (i === all.length - 1 && g.includes('.')) {
            if (!isIPv4(g)) return false;
            count += 2;
        } else if (/^[0-9a-f]{1,4}$/i.test(g)) {
            count += 1;
        } else {
            return false;
        }
    }
    return halves.length === 2 ? count < 8 : count === 8;
}

function cidrOk(digits: string, max: number): boolean {
    return /^(0|[1-9]\d?\d?)$/.test(digits) && Number(digits) <= max;
}

/**
 * Validates a domain-spec (§7.1): a macro-string ending in a real top label or
 * a macro. Returns an error message, or null when it is fine.
 */
export function validateDomainSpec(spec: string, { explanation = false } = {}): string | null {
    if (!spec) return 'is missing its domain';
    const letters = explanation ? 'slodiphvcrt' : 'slodiphv';
    let i = 0;
    let endsInMacro = false;
    while (i < spec.length) {
        const ch = spec[i]!;
        if (ch === '%') {
            const next = spec[i + 1];
            if (next === '%' || next === '_' || next === '-') {
                i += 2;
                endsInMacro = false;
                continue;
            }
            const m = /^%\{([a-z])(\d*)(r?)([.\-+,/_=]*)\}/i.exec(spec.slice(i));
            if (!m) return `has a malformed macro at "${spec.slice(i, i + 8)}"`;
            if (!letters.includes(m[1]!.toLowerCase())) return `uses an invalid macro letter "%{${m[1]}}"`;
            i += m[0].length;
            endsInMacro = true;
            continue;
        }
        const code = ch.charCodeAt(0);
        if (code < 0x21 || code > 0x7e) return `contains an invalid character "${ch}"`;
        i++;
        endsInMacro = false;
    }
    if (endsInMacro) return null;

    const trimmed = spec.replace(/\.$/, '');
    const labels = trimmed.split('.');
    const top = labels[labels.length - 1]!;
    if (labels.length < 2) return `"${spec}" is not a fully qualified domain`;
    if (labels.some((l) => l === '')) return `"${spec}" has an empty label`;
    if (!/^([a-z0-9]*[a-z][a-z0-9]*|[a-z0-9]+-[a-z0-9-]*[a-z0-9])$/i.test(top)) {
        return `"${spec}" does not end in a valid top-level label`;
    }
    return null;
}

export function hasMacro(spec: string): boolean {
    return /%\{/.test(spec);
}

// ---- Parsing ------------------------------------------------------------

function parseTerm(raw: string): SpfTerm {
    const modifier = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(raw);
    if (modifier) {
        const name = modifier[1]!.toLowerCase();
        const value = modifier[2]!;
        const term: SpfTerm = { raw, kind: 'modifier', name, qualifier: '+', value, cidr: '' };
        if (name === 'redirect' || name === 'exp') {
            const err = validateDomainSpec(value);
            if (err) term.error = `${name}= ${err}`;
        }
        return term;
    }

    let rest = raw;
    let qualifier: Qualifier = '+';
    if (/^[+\-~?]/.test(rest)) {
        qualifier = rest[0] as Qualifier;
        rest = rest.slice(1);
    }
    const m = /^([a-z0-9]+)(.*)$/i.exec(rest);
    const name = (m?.[1] ?? rest).toLowerCase();
    const tail = m?.[2] ?? '';
    const term: SpfTerm = { raw, kind: 'mechanism', name, qualifier, value: '', cidr: '' };

    if (!(MECHANISMS as readonly string[]).includes(name)) {
        term.error = `"${raw}" is not a recognised mechanism or modifier`;
        return term;
    }

    switch (name as MechanismName) {
        case 'all':
            if (tail) term.error = `"all" takes no argument, found "${tail}"`;
            break;
        case 'include':
        case 'exists': {
            if (!tail.startsWith(':')) {
                term.error = `"${name}" needs a domain, as in ${name}:example.com`;
                break;
            }
            term.value = tail.slice(1);
            const err = validateDomainSpec(term.value);
            if (err) term.error = `${name}: ${err}`;
            break;
        }
        case 'ptr': {
            if (tail === '') break;
            if (!tail.startsWith(':')) {
                term.error = `unexpected "${tail}" after ptr`;
                break;
            }
            term.value = tail.slice(1);
            const err = validateDomainSpec(term.value);
            if (err) term.error = `ptr: ${err}`;
            break;
        }
        case 'a':
        case 'mx': {
            // [ ":" domain-spec ] [ dual-cidr-length ]. The domain may itself
            // contain "/" only inside a macro, so split on the first "/" that
            // follows the last "}".
            let spec = tail;
            const lastMacro = spec.lastIndexOf('}');
            const slash = spec.indexOf('/', lastMacro + 1);
            if (slash >= 0) {
                term.cidr = spec.slice(slash);
                spec = spec.slice(0, slash);
            }
            if (spec) {
                if (!spec.startsWith(':')) {
                    term.error = `unexpected "${spec}" after ${name}`;
                    break;
                }
                term.value = spec.slice(1);
                const err = validateDomainSpec(term.value);
                if (err) {
                    term.error = `${name}: ${err}`;
                    break;
                }
            }
            if (term.cidr) {
                const dual = /^(?:\/(\d+))?(?:\/\/(\d+))?$/.exec(term.cidr);
                if (
                    !dual ||
                    term.cidr === '' ||
                    (dual[1] !== undefined && !cidrOk(dual[1], 32)) ||
                    (dual[2] !== undefined && !cidrOk(dual[2], 128))
                ) {
                    term.error = `${name} has an invalid CIDR length "${term.cidr}"`;
                }
            }
            break;
        }
        case 'ip4':
        case 'ip6': {
            if (!tail.startsWith(':')) {
                term.error = `"${name}" needs an address, as in ${name === 'ip4' ? 'ip4:192.0.2.0/24' : 'ip6:2001:db8::/32'}`;
                break;
            }
            const [addr, len, ...extra] = tail.slice(1).split('/');
            term.value = addr ?? '';
            term.cidr = len !== undefined ? `/${len}` : '';
            const max = name === 'ip4' ? 32 : 128;
            const valid = name === 'ip4' ? isIPv4(term.value) : isIPv6(term.value);
            if (!valid)
                term.error = `"${term.value}" is not a valid ${name === 'ip4' ? 'IPv4' : 'IPv6'} address`;
            else if (extra.length > 0 || (len !== undefined && !cidrOk(len, max))) {
                term.error = `${name} has an invalid CIDR length "${tail.slice(1 + term.value.length)}"`;
            }
            break;
        }
    }
    return term;
}

/** Parses one SPF record. Never throws; problems are collected in `errors` and on each term. */
export function parseSpf(record: string): ParsedSpf {
    const errors: string[] = [];
    const tokens = record.trim().split(/\s+/);
    const version = tokens.shift() ?? '';
    if (version.toLowerCase() !== 'v=spf1') errors.push('The record does not start with "v=spf1".');

    const terms = tokens.filter(Boolean).map(parseTerm);
    for (const t of terms) if (t.error) errors.push(`${t.error}.`);

    for (const name of ['redirect', 'exp']) {
        if (terms.filter((t) => t.kind === 'modifier' && t.name === name).length > 1) {
            errors.push(`The ${name}= modifier appears more than once.`);
        }
    }
    return { terms, errors };
}

// ---- Describing terms ---------------------------------------------------

const QUALIFIER_RESULT: Record<Qualifier, string> = {
    '+': 'Pass',
    '-': 'Fail',
    '~': 'SoftFail',
    '?': 'Neutral',
};

export function qualifierResult(q: Qualifier): string {
    return QUALIFIER_RESULT[q];
}

/** One plain-English line per term, for the record breakdown table. */
export function describeTerm(t: SpfTerm, domain: string): string {
    if (t.error) return t.error;
    const result = QUALIFIER_RESULT[t.qualifier];
    const target = t.value || domain;
    if (t.kind === 'modifier') {
        if (t.name === 'redirect')
            return `If nothing above matched, use the SPF record of ${t.value} instead.`;
        if (t.name === 'exp') return `Explanation text for rejected mail is published at ${t.value}.`;
        return `Unknown modifier "${t.name}", which receivers ignore.`;
    }
    switch (t.name as MechanismName) {
        case 'all':
            return `Every sender not matched earlier gets ${result}.`;
        case 'include':
            return `${result} if ${t.value}'s SPF record passes the sender.`;
        case 'a':
            return `${result} if the sender's IP is an A/AAAA address of ${target}${t.cidr ? ` (${t.cidr})` : ''}.`;
        case 'mx':
            return `${result} if the sender's IP belongs to an MX host of ${target}${t.cidr ? ` (${t.cidr})` : ''}.`;
        case 'ip4':
        case 'ip6':
            return `${result} if the sender's IP is in ${t.value}${t.cidr}.`;
        case 'exists':
            return `${result} if ${t.value} resolves to any A record.`;
        case 'ptr':
            return `${result} if the sender's reverse DNS ends in ${target}. Deprecated.`;
    }
}

// ---- Checking -----------------------------------------------------------

export interface SpfNode {
    domain: string;
    /** How this node was reached: the root, an include, or a redirect. */
    via: 'root' | 'include' | 'redirect';
    record: string | null;
    parsed: ParsedSpf | null;
    children: SpfNode[];
    /** DNS lookups this record itself spends, not counting its children. */
    lookups: number;
    /** Lookups for this node and everything beneath it. */
    totalLookups: number;
    /** Why this node could not be followed, when it could not. */
    problem?: string;
}

export interface SpfReport {
    domain: string;
    /** Every v=spf1 TXT record at the domain, normally one. */
    records: string[];
    tree: SpfNode | null;
    lookups: number;
    voidLookups: number;
    checks: Check[];
}

interface WalkState {
    resolve: Resolve;
    lookups: number;
    voidLookups: number;
    voidNames: string[];
    errors: Array<{ domain: string; message: string }>;
    usesPtr: string[];
    macroTerms: string[];
    mxOverLimit: string[];
    permissiveRanges: string[];
    /** How many times each include target is reached anywhere in the tree. */
    includes: Map<string, number>;
    queries: number;
}

/** Hard ceiling on queries one check may issue, so a hostile record cannot fan out without end. */
const QUERY_BUDGET = 60;

async function fetchSpf(resolve: Resolve, domain: string): Promise<{ records: string[]; nxdomain: boolean }> {
    const res = await resolve(domain, 'TXT');
    const records = res.answers.map((a) => parseTxtData(a.data)).filter(isSpfRecord);
    return { records, nxdomain: res.status === RCODE_NXDOMAIN };
}

/** Resolves the address lookups an a/mx term implies, counting void lookups. Never throws. */
async function probeTerm(state: WalkState, t: SpfTerm, domain: string): Promise<void> {
    const target = t.value || domain;
    if (hasMacro(target) || state.queries >= QUERY_BUDGET) return;
    try {
        if (t.name === 'a') {
            state.queries += 2;
            const [a, aaaa] = await Promise.all([state.resolve(target, 'A'), state.resolve(target, 'AAAA')]);
            if (a.answers.length === 0 && aaaa.answers.length === 0) {
                state.voidLookups++;
                state.voidNames.push(`a:${target}`);
            }
        } else if (t.name === 'mx') {
            state.queries++;
            const mx = await state.resolve(target, 'MX');
            if (mx.answers.length === 0) {
                state.voidLookups++;
                state.voidNames.push(`mx:${target}`);
            } else if (mx.answers.length > 10) {
                state.mxOverLimit.push(`${target} (${mx.answers.length} MX records)`);
            }
        }
    } catch {
        // A resolver failure is not evidence of a void lookup. Leave it uncounted.
    }
}

async function walk(
    state: WalkState,
    domain: string,
    via: SpfNode['via'],
    path: readonly string[],
): Promise<SpfNode> {
    const node: SpfNode = {
        domain,
        via,
        record: null,
        parsed: null,
        children: [],
        lookups: 0,
        totalLookups: 0,
    };

    if (path.includes(domain)) {
        node.problem = `Loop: ${domain} is already being evaluated (${[...path, domain].join(' → ')}).`;
        state.errors.push({ domain, message: node.problem });
        return node;
    }
    if (state.queries >= QUERY_BUDGET) {
        node.problem = 'Not followed: this record tree is too large to evaluate fully.';
        return node;
    }

    state.queries++;
    const { records, nxdomain } = await fetchSpf(state.resolve, domain);
    if (records.length === 0) {
        if (via !== 'root') {
            // §5.2 and §6.1: an include or redirect target without an SPF record
            // is a permanent error, and the name lookup was void as well.
            state.voidLookups++;
            state.voidNames.push(`${via}:${domain}`);
            node.problem = nxdomain
                ? `${domain} does not exist, so this ${via} is a permanent error.`
                : `${domain} publishes no SPF record, so this ${via} is a permanent error.`;
            state.errors.push({ domain, message: node.problem });
        }
        return node;
    }
    if (records.length > 1 && via !== 'root') {
        node.problem = `${domain} publishes ${records.length} SPF records, a permanent error.`;
        state.errors.push({ domain, message: node.problem });
    }

    node.record = records[0]!;
    node.parsed = parseSpf(node.record);
    for (const message of node.parsed.errors) state.errors.push({ domain, message });

    const terms = node.parsed.terms;
    const hasAll = terms.some((t) => t.kind === 'mechanism' && t.name === 'all');
    for (const t of terms) {
        if (t.error) continue;
        if (LOOKUP_TERMS.has(t.name) && !(t.name === 'redirect' && hasAll)) node.lookups++;
        if (t.name === 'ptr') state.usesPtr.push(domain);
        if (t.value && hasMacro(t.value) && t.name !== 'exp')
            state.macroTerms.push(`${t.raw} (in ${domain})`);
        if (t.name === 'ip4' && t.cidr && Number(t.cidr.slice(1)) < 8 && t.qualifier === '+') {
            state.permissiveRanges.push(`${t.raw} (in ${domain})`);
        }
        if (t.name === 'ip6' && t.cidr && Number(t.cidr.slice(1)) < 16 && t.qualifier === '+') {
            state.permissiveRanges.push(`${t.raw} (in ${domain})`);
        }
    }
    state.lookups += node.lookups;

    const nextPath = [...path, domain];
    const follow: Array<Promise<SpfNode>> = [];
    const probes: Array<Promise<void>> = [];
    for (const t of terms) {
        if (t.error) continue;
        if (t.name === 'include' && !hasMacro(t.value)) {
            const target = t.value.toLowerCase().replace(/\.$/, '');
            state.includes.set(target, (state.includes.get(target) ?? 0) + 1);
            follow.push(walk(state, target, 'include', nextPath));
        } else if (t.name === 'a' || t.name === 'mx') {
            probes.push(probeTerm(state, t, domain));
        }
    }
    // §6.1: redirect is ignored when the record has an "all".
    const redirect = terms.find((t) => t.kind === 'modifier' && t.name === 'redirect' && !t.error);
    if (redirect && !hasAll && !hasMacro(redirect.value)) {
        follow.push(walk(state, redirect.value.toLowerCase().replace(/\.$/, ''), 'redirect', nextPath));
    }

    const [children] = await Promise.all([Promise.all(follow), Promise.all(probes)]);
    node.children = children;
    node.totalLookups = node.lookups + children.reduce((n, c) => n + c.totalLookups, 0);
    return node;
}

/** The record whose "all" actually decides the outcome: the root, or wherever its redirects end. */
function effectiveAll(node: SpfNode): { term: SpfTerm | null; at: string } {
    const terms = node.parsed?.terms ?? [];
    const all = terms.find((t) => t.kind === 'mechanism' && t.name === 'all' && !t.error);
    if (all) return { term: all, at: node.domain };
    const redirected = node.children.find((c) => c.via === 'redirect');
    if (redirected) return effectiveAll(redirected);
    return { term: null, at: node.domain };
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export async function checkSpf(domain: string, resolve: Resolve): Promise<SpfReport> {
    const state: WalkState = {
        resolve,
        lookups: 0,
        voidLookups: 0,
        voidNames: [],
        errors: [],
        usesPtr: [],
        macroTerms: [],
        mxOverLimit: [],
        permissiveRanges: [],
        includes: new Map(),
        queries: 0,
    };
    const checks: Check[] = [];

    const [{ records, nxdomain }, legacy] = await Promise.all([
        fetchSpf(resolve, domain),
        resolve(domain, 'SPF').catch(() => null),
    ]);

    if (records.length === 0) {
        checks.push({
            id: 'spf-published',
            status: 'fail',
            title: 'No SPF record',
            detail: nxdomain
                ? `${domain} does not exist in DNS.`
                : `${domain} publishes no TXT record starting with "v=spf1". Receivers cannot tell which servers may send its mail, and DMARC can only pass on DKIM.`,
        });
        return { domain, records, tree: null, lookups: 0, voidLookups: 0, checks };
    }

    checks.push({
        id: 'spf-published',
        status: 'pass',
        title: 'SPF record published',
        detail: `${domain} publishes an SPF record in DNS.`,
    });

    if (records.length > 1) {
        checks.push({
            id: 'spf-multiple',
            status: 'fail',
            title: 'Multiple SPF records',
            detail: `${domain} publishes ${records.length} records starting with "v=spf1". SPF allows exactly one, and receivers return a permanent error when they find more, without evaluating either. Merge them into a single record.`,
        });
        // Receivers stop here (RFC 7208 §4.5), so lookup counts or a final
        // policy would describe an evaluation that never happens — and
        // whichever record the resolver lists first, which is not stable.
        return { domain, records, tree: null, lookups: 0, voidLookups: 0, checks };
    } else {
        checks.push({
            id: 'spf-multiple',
            status: 'pass',
            title: 'Exactly one SPF record',
            detail: 'Only one v=spf1 record is published, as SPF requires.',
        });
    }

    const tree = await walk(state, domain, 'root', []);
    const root = tree.parsed!;

    if (state.errors.length === 0) {
        checks.push({
            id: 'spf-syntax',
            status: 'pass',
            title: 'Syntax is valid',
            detail: 'Every mechanism and modifier in the record and the records it includes parses cleanly.',
        });
    } else {
        checks.push({
            id: 'spf-syntax',
            status: 'fail',
            title: `${plural(state.errors.length, 'error')} in the record tree`,
            detail: state.errors
                .map((e) => (e.domain === domain ? e.message : `${e.domain}: ${e.message}`))
                .join(' '),
        });
    }

    const lookups = state.lookups;
    checks.push(
        lookups > MAX_LOOKUPS
            ? {
                  id: 'spf-lookups',
                  status: 'fail',
                  title: `Too many DNS lookups (${lookups} of ${MAX_LOOKUPS})`,
                  detail: `Evaluating this record takes ${lookups} DNS lookups, over SPF's limit of ${MAX_LOOKUPS}. Receivers stop at the limit and return a permanent error, so SPF fails for legitimate mail. Remove includes for services you no longer use, or replace includes with ip4/ip6 ranges.`,
              }
            : {
                  id: 'spf-lookups',
                  status: lookups >= MAX_LOOKUPS - 1 ? 'warn' : 'pass',
                  title: `${lookups} of ${MAX_LOOKUPS} DNS lookups used`,
                  detail:
                      lookups >= MAX_LOOKUPS - 1
                          ? 'Within the limit, but one more include from a provider can push it over. Providers change their own records without notice.'
                          : 'include, a, mx, ptr, exists and redirect each cost a lookup, across every nested record. This record stays within the limit.',
              },
    );

    checks.push(
        state.voidLookups > MAX_VOID_LOOKUPS
            ? {
                  id: 'spf-void-lookups',
                  status: 'fail',
                  title: `Too many void lookups (${state.voidLookups})`,
                  detail: `${state.voidLookups} lookups returned no answer (${state.voidNames.join(', ')}). Receivers should return a permanent error after ${MAX_VOID_LOOKUPS}.`,
              }
            : state.voidLookups > 0
              ? {
                    id: 'spf-void-lookups',
                    status: 'warn',
                    title: `${plural(state.voidLookups, 'void lookup')}`,
                    detail: `These returned no answer: ${state.voidNames.join(', ')}. Up to ${MAX_VOID_LOOKUPS} are tolerated, but each one is a term that does nothing.`,
                }
              : {
                    id: 'spf-void-lookups',
                    status: 'pass',
                    title: 'No void lookups',
                    detail: 'Every name the record points at resolves.',
                },
    );

    if (state.mxOverLimit.length > 0) {
        checks.push({
            id: 'spf-mx-limit',
            status: 'fail',
            title: 'An mx mechanism returns more than 10 hosts',
            detail: `SPF stops evaluating mx past 10 hosts and returns a permanent error: ${state.mxOverLimit.join(', ')}.`,
        });
    }

    const { term: all, at } = effectiveAll(tree);
    const where = at === domain ? '' : ` (from ${at}, via redirect)`;
    if (!all) {
        checks.push({
            id: 'spf-all',
            status: 'warn',
            title: 'No "all" mechanism',
            detail: `The record never says what happens to everyone else, so unlisted senders get Neutral — no better than having no SPF. End it with -all or ~all.`,
        });
    } else if (all.qualifier === '+') {
        checks.push({
            id: 'spf-all',
            status: 'fail',
            title: 'Record ends in +all',
            detail: `"+all"${where} authorises every server on the internet to send as ${domain}. Replace it with -all or ~all.`,
        });
    } else if (all.qualifier === '?') {
        checks.push({
            id: 'spf-all',
            status: 'warn',
            title: 'Record ends in ?all',
            detail: `"?all"${where} gives unlisted senders Neutral, which tells receivers nothing. Use ~all while testing, and -all once every sender is listed.`,
        });
    } else if (all.qualifier === '~') {
        checks.push({
            id: 'spf-all',
            status: 'pass',
            title: 'Record ends in ~all (soft fail)',
            detail: `Unlisted senders get SoftFail${where}. With a DMARC policy enforcing, that is enough for receivers to act; -all is stricter still.`,
        });
    } else {
        checks.push({
            id: 'spf-all',
            status: 'pass',
            title: 'Record ends in -all (hard fail)',
            detail: `Unlisted senders get Fail${where}: the strictest policy SPF can state.`,
        });
    }

    const allIndex = root.terms.findIndex((t) => t.kind === 'mechanism' && t.name === 'all');
    if (allIndex >= 0) {
        const after = root.terms.slice(allIndex + 1).filter((t) => t.kind === 'mechanism');
        if (after.length > 0) {
            checks.push({
                id: 'spf-after-all',
                status: 'warn',
                title: 'Mechanisms after "all" are ignored',
                detail: `Evaluation stops at "all", so ${after.map((t) => `"${t.raw}"`).join(', ')} never run. Move them before it.`,
            });
        }
        if (root.terms.some((t) => t.kind === 'modifier' && t.name === 'redirect')) {
            checks.push({
                id: 'spf-redirect-ignored',
                status: 'warn',
                title: 'redirect= is ignored',
                detail: 'A record with an "all" mechanism never follows its redirect=. Remove one or the other.',
            });
        }
    }

    const duplicates = [...state.includes].filter(([, n]) => n > 1);
    if (duplicates.length > 0) {
        checks.push({
            id: 'spf-duplicate-include',
            status: 'warn',
            title: 'Duplicate include',
            detail: `${duplicates.map(([d, n]) => `${d} (${n} times)`).join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} included more than once across the record tree. Each copy costs its lookups again for no benefit; remove the extra include.`,
        });
    }

    if (state.usesPtr.length > 0) {
        checks.push({
            id: 'spf-ptr',
            status: 'warn',
            title: 'Uses the deprecated ptr mechanism',
            detail: `ptr is slow, unreliable, and RFC 7208 says not to use it; some receivers skip it. Found in ${[...new Set(state.usesPtr)].join(', ')}. Use ip4/ip6 or a instead.`,
        });
    }

    if (state.permissiveRanges.length > 0) {
        checks.push({
            id: 'spf-permissive',
            status: 'warn',
            title: 'Overly broad IP range',
            detail: `These authorise an enormous slice of the internet: ${state.permissiveRanges.join(', ')}.`,
        });
    }

    if (state.macroTerms.length > 0) {
        checks.push({
            id: 'spf-macros',
            status: 'info',
            title: 'Uses macros',
            detail: `${state.macroTerms.join(', ')} depend on the sending IP or address, so they cannot be followed without a real message. They are counted as one lookup each.`,
        });
    }

    const length = records[0]!.length;
    if (length > MAX_RECORD_LENGTH) {
        checks.push({
            id: 'spf-length',
            status: 'warn',
            title: `Record is ${length} characters long`,
            detail: `SPF advises keeping the answer within a 512-byte DNS packet. Past about ${MAX_RECORD_LENGTH} characters some resolvers fall back to TCP or truncate. Each TXT string must also be split at 255 characters.`,
        });
    }

    if (legacy && legacy.answers.length > 0) {
        checks.push({
            id: 'spf-legacy-type',
            status: 'info',
            title: 'Deprecated SPF record type published',
            detail: 'The domain also publishes a type 99 SPF record. RFC 7208 retired it; receivers only read TXT, so it can be removed.',
        });
    }

    return { domain, records, tree, lookups, voidLookups: state.voidLookups, checks };
}
