/**
 * Builds the static site into ./dist/
 *
 *   bun run build          – one-shot production build
 *   bun run dev / --serve  – serve dist with live reload via Bun's dev server
 */

import { existsSync, rmSync, cpSync, statSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT  = new URL('..', import.meta.url).pathname;
const DIST  = join(ROOT, 'dist');
const PUBL  = join(ROOT, 'public');
const HTML  = join(ROOT, 'index.html');
const CSS   = join(ROOT, 'src/styles.css');
const NM    = join(ROOT, 'node_modules');

const FONT_FILES = [
    '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2',
    '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2',
    '@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2',
    '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
] as const;

const serve = process.argv.includes('--serve');

if (!existsSync(join(ROOT, 'src/data/consumer-domains.ts'))) {
    console.error('src/data/consumer-domains.ts is missing — run `bun run datasets` first.');
    process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });

console.log('Bundling TypeScript…');
const build = await Bun.build({
    entrypoints: [join(ROOT, 'src/main.ts')],
    outdir: DIST,
    minify: !serve,
    sourcemap: serve ? 'inline' : 'none',
    target: 'browser',
    naming: '[name].js',
});

if (!build.success) {
    console.error('Build failed:');
    for (const log of build.logs) console.error(log);
    process.exit(1);
}

const html = readFileSync(HTML, 'utf8').replaceAll('{{YEAR}}', String(new Date().getFullYear()));
writeFileSync(join(DIST, 'index.html'), html);
if (existsSync(PUBL)) cpSync(PUBL, DIST, { recursive: true });

console.log('Compiling Tailwind…');
const tw = Bun.spawnSync({
    cmd: ['bun', 'x', 'tailwindcss', '-i', CSS, '-o', join(DIST, 'styles.css'), ...(serve ? [] : ['--minify'])],
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
});
if (tw.exitCode !== 0) {
    console.error('Tailwind build failed');
    process.exit(1);
}

mkdirSync(join(DIST, 'fonts'), { recursive: true });
for (const rel of FONT_FILES) {
    const src = join(NM, rel);
    if (!existsSync(src)) {
        console.error(`Missing font file: ${rel} — did you run \`bun install\`?`);
        process.exit(1);
    }
    cpSync(src, join(DIST, 'fonts', rel.split('/').pop()!));
}

const total = readdirSync(DIST, { recursive: true })
    .map(f => {
        try { return statSync(join(DIST, f as string)).size; } catch { return 0; }
    })
    .reduce((a, b) => a + b, 0);

console.log(`Built ${(total / 1024).toFixed(1)} kB → ${DIST}`);

if (serve) {
    const port = Number(process.env.PORT ?? 3000);
    Bun.serve({
        port,
        async fetch(req) {
            const url = new URL(req.url);
            const path = url.pathname === '/' ? '/index.html' : url.pathname;
            const file = Bun.file(join(DIST, path));
            if (await file.exists()) return new Response(file);
            return new Response('Not found', { status: 404 });
        },
    });
    console.log(`Serving at http://localhost:${port}`);
}
