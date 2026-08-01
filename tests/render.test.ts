import { describe, expect, test } from 'bun:test';
import { PROVIDERS } from '../src/providers.ts';
import { type RenderInput, reportSummary } from '../src/render.ts';
import type { ConsumerHit, Finding, MxRecord } from '../src/types.ts';

const provider = (name: string) => {
    const found = PROVIDERS.find((p) => p.name === name);
    if (!found) throw new Error(`no such provider: ${name}`);
    return found;
};

const mx = (host: string, priority = 10): MxRecord => ({ host, priority });
const finding = (name: string, hosts: string[]): Finding => ({
    provider: provider(name),
    matchedMx: hosts.map((h) => mx(h)),
});

const input = (over: Partial<RenderInput> = {}): RenderInput => ({
    domain: 'example.com',
    findings: [],
    mxRecords: [],
    consumerHit: null,
    ...over,
});

describe('reportSummary', () => {
    test('names the provider and its category', () => {
        const summary = reportSummary(
            input({
                findings: [finding('Google Workspace', ['aspmx.l.google.com'])],
                mxRecords: [mx('aspmx.l.google.com')],
            }),
        );
        expect(summary).toContain('example.com');
        expect(summary).toContain('Google Workspace');
        expect(summary).toContain('1 MX record');
    });

    test('pluralises MX records', () => {
        const summary = reportSummary(
            input({
                findings: [finding('Google Workspace', ['aspmx.l.google.com'])],
                mxRecords: [mx('a.example.com'), mx('b.example.com')],
            }),
        );
        expect(summary).toContain('2 MX records');
    });

    test('lists every finding when mail passes through more than one service', () => {
        const summary = reportSummary(
            input({
                findings: [
                    finding('Mimecast', ['mx.example.mimecast.com']),
                    finding('Google Workspace', ['aspmx.l.google.com']),
                ],
                mxRecords: [mx('mx.example.mimecast.com'), mx('aspmx.l.google.com')],
            }),
        );
        expect(summary).toContain('Mimecast');
        expect(summary).toContain('Google Workspace');
    });

    test('says so when there are no MX records', () => {
        expect(reportSummary(input())).toContain('no MX records');
    });

    test('says so when MX records matched nothing known', () => {
        const summary = reportSummary(input({ mxRecords: [mx('mx.unknown.example')] }));
        expect(summary).toContain('no known provider');
    });

    test.each([
        ['free', 'free consumer mailbox'],
        ['disposable', 'disposable mailbox service'],
        ['alias', 'alias / forwarding address'],
    ] as const)('mentions a %s consumer hit', (kind, expected) => {
        const hit: ConsumerHit = { kind, domain: 'example.com' };
        const summary = reportSummary(input({ mxRecords: [mx('mx.example.com')], consumerHit: hit }));
        expect(summary).toContain(expected);
    });

    test('stays short enough to be worth announcing', () => {
        const summary = reportSummary(
            input({
                findings: [finding('Google Workspace', ['aspmx.l.google.com'])],
                mxRecords: Array.from({ length: 5 }, (_, i) => mx(`alt${i}.aspmx.l.google.com`)),
            }),
        );
        // The point of a derived summary is that it does not grow with the
        // evidence table the way the card does.
        expect(summary.length).toBeLessThan(160);
        expect(summary).not.toContain('alt4.aspmx.l.google.com');
    });

    test('is a single sentence', () => {
        const summary = reportSummary(
            input({
                findings: [finding('Fastmail', ['in1-smtp.messagingengine.com'])],
                mxRecords: [mx('in1-smtp.messagingengine.com')],
            }),
        );
        expect(summary.endsWith('.')).toBe(true);
        expect(summary).not.toContain('\n');
    });
});
