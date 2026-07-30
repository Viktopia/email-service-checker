import { describe, expect, test } from 'bun:test';

const CSS = await Bun.file('src/styles.css').text();
const MARKUP_SOURCES = ['index.html', 'scripts/build.ts', 'src/render.ts'];

/** Semantic tokens every readable colour is expected to route through. */
const TEXT_TOKENS = ['--color-ink', '--color-ink-muted', '--color-accent-text'];

/**
 * Palette entries that are chrome, not text. Using them for text is what put
 * nine styles below WCAG AA: subtext-0 measured 4.22:1 and overlay-1 2.73:1.
 */
const CHROME_UTILITIES = [
    'text-subtext-0',
    'text-subtext-1',
    'text-overlay-0',
    'text-overlay-1',
    'text-overlay-2',
    'text-base',
    'text-mantle',
    'text-crust',
];

describe('the token layer', () => {
    test.each(TEXT_TOKENS)('%s is defined', (token) => {
        expect(CSS).toContain(`${token}:`);
    });

    test('both schemes are defined', () => {
        expect(CSS).toContain('@media (prefers-color-scheme: dark)');
        expect(CSS).toContain('color-scheme: light dark');
    });

    test('every semantic token that dark remaps is defined in light first', () => {
        const darkBlock = CSS.slice(CSS.indexOf('@media (prefers-color-scheme: dark)'));
        const lightBlock = CSS.slice(0, CSS.indexOf('@media (prefers-color-scheme: dark)'));
        const remapped = [...darkBlock.matchAll(/(--(?:color|wash|badge)-[a-z-]+):/g)].map((m) => m[1]!);
        const missing = [...new Set(remapped)].filter((t) => !lightBlock.includes(`${t}:`));
        expect(missing).toEqual([]);
    });

    test('surfaces are named, not mixed toward a literal white', () => {
        // A surface computed as color-mix(..., white) cannot invert for dark.
        const surfaceRules = [...CSS.matchAll(/^\s*background:\s*([^;]+);/gm)].map((m) => m[1]!);
        const literalWhite = surfaceRules.filter((v) => /\b(white|#fff\b|#ffffff)\b/i.test(v));
        expect(literalWhite).toEqual([]);
    });
});

describe('markup colour discipline', () => {
    test.each(MARKUP_SOURCES)('%s uses semantic text utilities, not palette chrome', async (path) => {
        const source = await Bun.file(path).text();
        const used = CHROME_UTILITIES.filter((u) => new RegExp(`\\b${u}\\b`).test(source));
        expect(used).toEqual([]);
    });

    test.each(MARKUP_SOURCES)('%s does not hardcode a hex colour', async (path) => {
        const source = await Bun.file(path).text();
        // Hex colours belong in the token block, where both schemes can see
        // them. The two theme-color meta tags are the deliberate exception:
        // they must be literal values because they are read by the browser
        // chrome before any CSS loads.
        const hexes = [...source.matchAll(/#[0-9a-fA-F]{6}\b/g)]
            .map((m) => m[0]!)
            .filter((hex) => !source.includes(`content="${hex}" media="(prefers-color-scheme:`));
        expect(hexes).toEqual([]);
    });
});
