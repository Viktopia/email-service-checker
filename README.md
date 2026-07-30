# Email Service Checker

![logo](https://github.com/viktopia/email-service-checker/blob/master/public/logo.webp?raw=true)

A static web tool that identifies which provider, security gateway, or
forwarder handles a domain's email — derived from public MX records via
DNS over HTTPS. Live at <https://emailservicechecker.com>.

## What's detected

| Category    | Examples                                                                  |
| ----------- | ------------------------------------------------------------------------- |
| Mailbox     | Google Workspace, Microsoft 365, Zoho, Fastmail, Proton, Migadu, OVH…     |
| Consumer    | Yahoo, AOL, iCloud, GMX, Yandex, QQ, NetEase 163, Mail.ru, Comcast…       |
| Gateway     | Proofpoint, Mimecast, Cisco Secure Email, Barracuda, Forcepoint, Sophos…  |
| Forwarder   | Cloudflare Email Routing, SimpleLogin, addy.io, ForwardEmail.net, Pobox…  |
| Inbound API | Amazon SES, Postmark, Mailgun, SendGrid, Mailchimp Transactional…         |

Plus two open datasets, committed under `data/`:

- `willwhite/freemail` — 4 459 free consumer mailbox domains.
- `disposable-email-domains/disposable-email-domains` — 8 183 disposable /
  throwaway mailbox providers.

## Stack

- **Bun** — package manager, bundler, test runner, dev server.
- **TypeScript** in strict mode (`tsc --noEmit` runs in CI).
- **Tailwind CSS v4** — design tokens in an `@theme` block in
  `src/styles.css` (Catppuccin Latte), components in `@layer components`,
  animation in CSS. Bricolage Grotesque, Onest and JetBrains Mono are
  self-hosted via `@fontsource-variable` packages and copied into
  `dist/fonts/` at build time. No CDN font traffic.
- **Biome** for lint and formatting.
- **DNS over HTTPS** via `dns.google` for MX lookups.
- **GitHub Pages** for hosting, deployed by `.github/workflows/deploy.yml`.

## Develop

```sh
bun install
bun run dev        # builds + serves dist/ at http://localhost:3000
```

The full set of checks, in the order CI runs them:

```sh
bun lint           # Biome
bun run typecheck  # tsc --noEmit
bun test           # unit tests over the pure functions
bun run build      # writes dist/
bun run verify     # checks over the generated output
```

`bun run verify` covers what unit tests cannot: that every committed domain
is reachable in the shard the runtime will actually request, that no page
lost its JSON-LD or shipped an unsubstituted `{{PLACEHOLDER}}`, that every
sitemap URL has a page behind it, and that the domain lists have not crept
back into the bundle.

### The consumer datasets

`data/free-domains.txt` and `data/disposable-domains.txt` are **committed**,
so a build needs no network access and is reproducible. `bun run datasets`
refreshes them from upstream; commit the result.

They used to be fetched during every deploy, which meant a blip at
`raw.githubusercontent.com` could break the deploy of an unrelated change,
and upstream edits reached production unreviewed. A scheduled workflow
(`.github/workflows/refresh-datasets.yml`) now runs the refresh weekly and
opens a PR, so an upstream change arrives as a reviewable diff.

At build time the lists are split into 256 JSON shards under
`dist/data/consumer/`, and the browser fetches only the shard the queried
domain hashes into — about 800 bytes, in parallel with the DNS lookup.
Inlining them cost 203 kB of a 224 kB `main.js`; `main.js` is now 24 kB.
`src/consumer-shards.ts` holds the hash, imported by both the build and the
runtime so the two cannot disagree about it.

## Deploy

Push to `master`. The workflow installs Bun, lints, type-checks, tests,
builds, verifies the output, and uploads `dist/` to GitHub Pages.

It checks out with `fetch-depth: 0` because the sitemap's `<lastmod>` comes
from each page's last commit date. A shallow clone falls back to the build
date, which is the meaningless signal this replaced.

## Project layout

```
.
├── src/
│   ├── main.ts              – entry, wires form → lookup → render
│   ├── lookup.ts            – DoH MX lookup
│   ├── identify.ts          – provider matcher + consumer-domain check
│   ├── render.ts            – DOM rendering of the report
│   ├── providers.ts         – curated MX → provider mapping (161)
│   ├── consumer-shards.ts   – shard hash, shared by build and runtime
│   ├── datasets.ts          – dataset sources, paths and normalisation
│   ├── types.ts
│   └── styles.css           – Tailwind v4 entry: @theme tokens + components
├── data/                    – committed domain lists (see above)
├── scripts/
│   ├── build.ts             – bundles TS, emits pages, shards, sitemap
│   ├── refresh-datasets.ts  – refreshes data/ from upstream
│   ├── verify-build.ts      – checks over dist/
│   └── discover-providers.ts – dev helper for finding new providers
├── tests/                   – bun test
├── public/                  – static assets (logo, CNAME)
├── index.html               – template for every generated page
└── .github/workflows/
    ├── deploy.yml
    └── refresh-datasets.yml
```

## Contributing

Open an issue or PR — especially to suggest new providers or fix
mis-classifications. Each provider is one entry in `src/providers.ts`.

## License

MIT — see [LICENSE](LICENSE).
