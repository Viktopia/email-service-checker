/**
 * The email security checkers under /tools/, as build-time page definitions.
 *
 * Each one is a page in the same template as the rest of the site, with the
 * form wired to a different checker in src/main.ts by `key`, and its own guide
 * and FAQ. The FAQ text also feeds FAQPage structured data, so the visible
 * answer and the markup cannot drift apart.
 */

export interface Faq {
    q: string;
    a: string;
}

export interface ToolPage {
    /** Matches the Tool union in src/main.ts; set on the form as data-tool. */
    key: 'spf' | 'dmarc' | 'mta-sts' | 'tls-rpt' | 'dane' | 'bimi' | 'dkim' | 'dns' | 'report';
    slug: string;
    /** Short name, used in navigation and breadcrumbs. */
    name: string;
    title: string;
    description: string;
    heroTitle: string;
    heroLede: string;
    placeholder: string;
    /** One line for the tools index and llms.txt. */
    summary: string;
    guideHeading: string;
    /** Trusted HTML, authored here. */
    guideHtml: string;
    faq: readonly Faq[];
    /** Slugs of guides in scripts/guides.ts to link from the page. */
    guides: readonly string[];
}

export const TOOLS: readonly ToolPage[] = [
    {
        key: 'report',
        slug: 'email-security-report',
        name: 'Email Security Report',
        title: 'Email Security Report: Check SPF, DKIM, DMARC, MTA-STS and More at Once',
        description:
            'Run every email security check on a domain at once: MX, SPF, DKIM, DMARC (RFC 9989), MTA-STS, TLS-RPT, DNSSEC and DANE, BIMI and DNS health, with one verdict per standard.',
        heroTitle: 'How secure is a domain’s <em>email</em>?',
        heroLede:
            'One check for every standard: who may send, whether mail is signed, the spoofing policy, encryption in transit, and the DNS underneath. Each gets its own verdict; there is no score to game.',
        placeholder: 'example.com',
        summary: 'Runs every check at once and gives one verdict per standard, linking to the detail.',
        guideHeading: 'How to read the report',
        guideHtml: `
<p>Each line is one standard, with the most important finding for it. Follow the link for the full breakdown.</p>
<ul>
<li><strong>Error</strong> means something is broken or missing in a way that affects delivery or lets the domain be spoofed.</li>
<li><strong>Warning</strong> means it works but is weaker than it should be, such as a DMARC policy of <code>p=none</code>.</li>
<li><strong>Not verifiable</strong> means a browser cannot see enough to judge, and says what to check by hand: DKIM selectors that cannot be listed, policy files served without CORS, certificates that need an SMTP connection.</li>
</ul>
<p>There is deliberately no overall score. SPF, DKIM and DMARC protect against spoofing; MTA-STS, TLS-RPT and DANE protect mail in transit; BIMI is branding. A domain can be excellent at one and absent at another, and an average would hide exactly that.</p>
<p>A sensible order to fix things in: <a href="/guides/how-to-create-an-spf-record/">SPF</a>, then <a href="/guides/what-is-dkim/">DKIM</a>, then <a href="/guides/dmarc-from-none-to-reject/">DMARC</a> through to <code>p=reject</code>, then <a href="/guides/mta-sts-and-tls-rpt/">TLS-RPT and MTA-STS</a>.</p>`,
        faq: [
            {
                q: 'What does an email security check cover?',
                a: 'This report checks the MX records that receive mail, SPF and DKIM which authenticate it, DMARC which tells receivers what to do with mail that fails, MTA-STS, TLS-RPT and DANE which protect mail in transit, BIMI for brand logos, and the health of the DNS everything depends on.',
            },
            {
                q: 'Why is there no overall score?',
                a: 'Because the standards protect against different things, and an average hides the gaps. A domain with perfect SPF and no DMARC is still easy to spoof. Each standard gets its own verdict instead, with the most important finding.',
            },
            {
                q: 'Is anything sent to a server?',
                a: 'No. Every check runs in your browser and queries public DNS over HTTPS. Nothing is stored, and the domain you check is not logged by this site.',
            },
        ],
        guides: ['spf-dkim-dmarc-explained', 'dmarcbis', 'mta-sts-and-tls-rpt'],
    },
    {
        key: 'spf',
        slug: 'spf-checker',
        name: 'SPF Checker',
        title: 'SPF Checker: Validate SPF Records and Count DNS Lookups',
        description:
            "Check any domain's SPF record in your browser. Validates syntax, counts DNS lookups and void lookups across every include, and explains each mechanism.",
        heroTitle: 'Check an <em>SPF record</em>',
        heroLede:
            'Validate the SPF record for any domain: syntax, the 10-lookup limit across every nested include, void lookups, and whether it ends in a policy that protects anything.',
        placeholder: 'example.com',
        summary:
            'Validates SPF syntax, counts DNS and void lookups across nested includes, and explains every term.',
        guideHeading: 'What the SPF checker tests',
        guideHtml: `
<p>SPF (RFC 7208) lists the servers allowed to send mail for a domain. The checker reads the TXT record, follows every <code>include</code> and <code>redirect</code> the way a receiving server would, and reports:</p>
<ul>
<li><strong>One record, valid syntax.</strong> Two <code>v=spf1</code> records, an unknown mechanism, or a malformed address is a permanent error: SPF fails for every message.</li>
<li><strong>The 10-lookup limit.</strong> <code>include</code>, <code>a</code>, <code>mx</code>, <code>ptr</code>, <code>exists</code> and <code>redirect</code> each cost a DNS lookup, counted across the whole tree.</li>
<li><strong>Void lookups.</strong> More than two names that resolve to nothing is also a permanent error, and usually means an include for a service you no longer use.</li>
<li><strong>The final policy.</strong> <code>-all</code> and <code>~all</code> protect the domain; <code>?all</code>, <code>+all</code> or no <code>all</code> do not.</li>
<li><strong>Deprecated and risky terms:</strong> <code>ptr</code>, terms after <code>all</code>, very wide IP ranges, and the retired SPF record type.</li>
</ul>
<p>Everything runs in your browser over DNS over HTTPS. Macros and <code>exists</code> depend on the sending IP, so they are flagged rather than evaluated.</p>`,
        faq: [
            {
                q: 'What is an SPF record?',
                a: 'An SPF record is a DNS TXT record, starting with v=spf1, that lists the mail servers allowed to send email for a domain. Receiving servers compare the IP address of the connecting server against it, and use the result in spam filtering and DMARC.',
            },
            {
                q: 'Why does SPF have a limit of 10 DNS lookups?',
                a: 'To stop a single SPF check from turning into a flood of DNS queries. RFC 7208 caps evaluation at 10 lookups, counting include, a, mx, ptr, exists and redirect across every nested record. Over the limit, the result is a permanent error and SPF fails for all mail, legitimate or not.',
            },
            {
                q: 'Should my SPF record end in -all or ~all?',
                a: 'Either protects the domain once a DMARC policy is enforcing. -all (fail) is the strictest statement; ~all (soft fail) is a common choice while you are confident but not certain every sender is listed. Never use +all, which authorises every server on the internet.',
            },
            {
                q: 'Can a domain have two SPF records?',
                a: 'No. A domain must publish exactly one TXT record starting with v=spf1. With two, receivers return a permanent error. To add a sender, add it to the existing record.',
            },
        ],
        guides: ['how-to-create-an-spf-record', 'spf-too-many-dns-lookups'],
    },
    {
        key: 'dmarc',
        slug: 'dmarc-checker',
        name: 'DMARC Checker',
        title: 'DMARC Checker: Validate DMARC Records Against RFC 9989',
        description:
            "Check any domain's DMARC record against the 2026 DMARC standard, RFC 9989. Finds the policy with the DNS tree walk, flags obsolete tags like pct, and checks report destinations.",
        heroTitle: 'Check a <em>DMARC record</em>',
        heroLede:
            'Validate a domain’s DMARC policy against RFC 9989, the 2026 revision of the standard: policy discovery, obsolete tags, enforcement level and reporting.',
        placeholder: 'example.com',
        summary:
            'Validates DMARC against RFC 9989: tree-walk discovery, obsolete pct/rf/ri tags, t= testing, np= and report authorisation.',
        guideHeading: 'What the DMARC checker tests',
        guideHtml: `
<p>DMARC tells receivers what to do with mail that fails SPF and DKIM alignment, and where to report it. In May 2026 it was revised as <strong>RFC 9989</strong>, with reporting split into RFC 9990 and RFC 9991. This checker validates against the revision:</p>
<ul>
<li><strong>Discovery by DNS tree walk.</strong> A subdomain without its own record is covered by the nearest parent that has one, using its <code>sp=</code> policy, or <code>np=</code> if the subdomain does not exist.</li>
<li><strong>Syntax.</strong> <code>v=DMARC1</code> must come first, exactly. Two records at the same name are discarded together.</li>
<li><strong>Obsolete tags.</strong> <code>pct</code>, <code>rf</code> and <code>ri</code> were removed. Updated receivers ignore them, so a staged rollout built on <code>pct</code> is not doing what it says.</li>
<li><strong>Enforcement.</strong> <code>p=none</code>, or <code>t=y</code> on top of a stronger policy, leaves the domain spoofable.</li>
<li><strong>Reporting.</strong> Whether <code>rua=</code> is set, and whether report addresses at other domains have authorised it.</li>
</ul>
<p>DKIM is the one part DNS alone cannot show, because keys sit under selectors you cannot list. The report says so rather than assuming it is fine. See <a href="/guides/dmarcbis/">what changed in DMARC in 2026</a>.</p>`,
        faq: [
            {
                q: 'What is a DMARC record?',
                a: 'A DMARC record is a TXT record at _dmarc.<your domain>, starting with v=DMARC1. It tells receiving servers what to do with mail that claims to be from your domain but fails SPF and DKIM alignment (nothing, quarantine, or reject), and where to send reports about it.',
            },
            {
                q: 'What is RFC 9989?',
                a: 'RFC 9989, published in May 2026, is the revised DMARC standard. It replaces RFC 7489, removes the pct, rf and ri tags, adds np, psd and t, and replaces the Public Suffix List with a DNS tree walk for finding the policy that applies. Aggregate and failure reporting moved to RFC 9990 and RFC 9991.',
            },
            {
                q: 'Is pct still valid in DMARC?',
                a: 'Not under RFC 9989. pct was removed, and updated receivers ignore it. If you used pct to apply quarantine or reject to part of your mail, the closest replacement is t=y, which asks receivers to apply the policy one level lower while you test.',
            },
            {
                q: 'Is p=none enough?',
                a: 'No. p=none only asks for reports; mail that fails DMARC is delivered as normal, so the domain can still be spoofed. It is the right starting point while you identify your senders, followed by quarantine and then reject.',
            },
        ],
        guides: ['dmarcbis', 'dmarc-from-none-to-reject', 'spf-dkim-dmarc-explained'],
    },
    {
        key: 'mta-sts',
        slug: 'mta-sts-checker',
        name: 'MTA-STS Checker',
        title: 'MTA-STS Checker: Validate Your SMTP TLS Policy',
        description:
            "Check a domain's MTA-STS setup: the _mta-sts TXT record, the HTTPS policy host and certificate, the policy mode, and whether every MX host is covered.",
        heroTitle: 'Check an <em>MTA-STS</em> policy',
        heroLede:
            'MTA-STS makes senders refuse to deliver your mail without a properly authenticated TLS connection. Check the DNS record, the policy host, and the policy itself.',
        placeholder: 'example.com',
        summary:
            'Checks the _mta-sts record, the HTTPS policy host and certificate, policy mode and max_age, and MX coverage.',
        guideHeading: 'What the MTA-STS checker tests',
        guideHtml: `
<p>SMTP encrypts opportunistically: if TLS fails, most senders quietly deliver in plaintext, and an attacker on the path can force exactly that. MTA-STS (RFC 8461) lets a domain say "only deliver to my MX hosts over TLS with a valid certificate".</p>
<ul>
<li><strong>The DNS record</strong> at <code>_mta-sts.</code>your domain: <code>v=STSv1; id=…;</code>, exactly one.</li>
<li><strong>The policy host</strong>, <code>mta-sts.</code>your domain, must resolve and serve HTTPS with a valid certificate.</li>
<li><strong>The policy file</strong> at <code>/.well-known/mta-sts.txt</code>: <code>mode</code> (enforce, testing or none), an <code>mx</code> line per mail server, and <code>max_age</code>.</li>
<li><strong>MX coverage.</strong> In enforce mode, a published MX host that no <code>mx</code> line matches will stop receiving mail from MTA-STS senders.</li>
</ul>
<p>A browser can only read the policy file if the server sends CORS headers, and most do not. When it cannot, the checker still confirms the host answers over valid HTTPS, and marks the file contents as <strong>not verifiable</strong> rather than passing them.</p>`,
        faq: [
            {
                q: 'What is MTA-STS?',
                a: 'MTA-STS (Mail Transfer Agent Strict Transport Security, RFC 8461) lets a domain publish a policy requiring sending servers to use TLS with a valid certificate when delivering to its MX hosts. It prevents downgrade attacks that strip encryption from email in transit.',
            },
            {
                q: 'What is the difference between testing and enforce mode?',
                a: 'In testing mode, senders report TLS failures through TLS-RPT but still deliver the mail. In enforce mode, they refuse to deliver unless TLS succeeds. Start with testing, read the reports, then switch to enforce.',
            },
            {
                q: 'Do I need TLS-RPT with MTA-STS?',
                a: 'Strongly recommended. Without TLS-RPT, nobody tells you when senders fail to deliver because of your MTA-STS policy, so a certificate problem on an MX host can silently stop mail.',
            },
            {
                q: 'Why can the checker not read my policy file?',
                a: 'Browsers only let a web page read a file from another site if that site sends CORS headers, and MTA-STS policy hosts usually do not. It does not affect senders at all. The checker still confirms the policy host is reachable over HTTPS with a valid certificate.',
            },
        ],
        guides: ['mta-sts-and-tls-rpt'],
    },
    {
        key: 'tls-rpt',
        slug: 'tls-rpt-checker',
        name: 'TLS-RPT Checker',
        title: 'TLS-RPT Checker: Validate SMTP TLS Reporting Records',
        description:
            "Check a domain's SMTP TLS Reporting (TLS-RPT) record at _smtp._tls: version, syntax, and the mailto: or https: destinations for daily TLS failure reports.",
        heroTitle: 'Check <em>TLS reporting</em>',
        heroLede:
            'TLS-RPT tells senders where to report failed TLS connections to your mail servers. Check that the record exists and its report destinations are valid.',
        placeholder: 'example.com',
        summary: 'Validates the _smtp._tls record and its mailto: and https: report destinations.',
        guideHeading: 'What the TLS-RPT checker tests',
        guideHtml: `
<p>SMTP TLS Reporting (RFC 8460) is the feedback loop for MTA-STS and DANE. Senders that support it send a daily JSON report of how many TLS connections to your MX hosts succeeded and why the others failed.</p>
<ul>
<li><strong>The record</strong> at <code>_smtp._tls.</code>your domain must start with <code>v=TLSRPTv1</code>, and there must be exactly one.</li>
<li><strong><code>rua=</code></strong> lists one or more destinations, each a <code>mailto:</code> address or an <code>https:</code> URL, comma-separated.</li>
</ul>
<pre><code>_smtp._tls.example.com.  TXT  "v=TLSRPTv1; rua=mailto:tls-reports@example.com"</code></pre>`,
        faq: [
            {
                q: 'What is TLS-RPT?',
                a: 'TLS-RPT (SMTP TLS Reporting, RFC 8460) is a DNS record that tells sending mail servers where to send daily reports about TLS connection failures when delivering to your domain. It shows when MTA-STS, DANE or certificate problems are affecting delivery.',
            },
            {
                q: 'Who sends TLS-RPT reports?',
                a: 'Large mailbox providers including Google and Microsoft send them. Reports arrive once a day per sending organisation, as JSON, usually gzipped.',
            },
            {
                q: 'Is TLS-RPT useful without MTA-STS?',
                a: 'Yes. Reports still show how often senders failed to negotiate TLS with your servers. But it is most valuable alongside MTA-STS or DANE, where a TLS failure means mail is not delivered.',
            },
        ],
        guides: ['mta-sts-and-tls-rpt'],
    },
    {
        key: 'dane',
        slug: 'dane-checker',
        name: 'DANE Checker',
        title: 'DANE Checker: DNSSEC and TLSA Records for SMTP',
        description:
            "Check whether a domain's DNS is DNSSEC-signed and its MX hosts publish valid DANE TLSA records at _25._tcp, with the certificate usages RFC 7672 recommends.",
        heroTitle: 'Check <em>DNSSEC and DANE</em> for mail',
        heroLede:
            'DANE pins your mail servers’ TLS certificates in DNSSEC-signed DNS, so senders can authenticate them without trusting any certificate authority.',
        placeholder: 'example.com',
        summary: 'Checks DNSSEC validation for the domain and TLSA records at _25._tcp for every MX host.',
        guideHeading: 'What the DANE checker tests',
        guideHtml: `
<p>DANE for SMTP (RFC 7672) publishes a fingerprint of each mail server's certificate in a TLSA record. Because the record is protected by DNSSEC, a sender can verify the certificate and refuse a connection an attacker has intercepted.</p>
<ul>
<li><strong>DNSSEC.</strong> The checker relies on validating public resolvers: answers carry the AD flag only if the signature chain checks out, and a broken chain comes back as SERVFAIL.</li>
<li><strong>TLSA records</strong> at <code>_25._tcp.</code>each MX host, validated under DNSSEC. Unsigned TLSA records are ignored by senders.</li>
<li><strong>Certificate usage.</strong> RFC 7672 recommends <code>3 1 1</code> (DANE-EE, public key, SHA-256) or <code>2 1 1</code>; usages 0 and 1 should not be used for SMTP.</li>
<li><strong>Coverage.</strong> Every MX host should be protected, or an attacker can push delivery to the one that is not.</li>
</ul>
<p>Whether the fingerprints match the certificates the servers actually present needs an SMTP connection, which a browser cannot open, so that part is reported as not verifiable.</p>`,
        faq: [
            {
                q: 'What is DANE for email?',
                a: 'DANE (DNS-based Authentication of Named Entities) for SMTP, defined in RFC 7672, lets a domain publish its mail servers’ TLS certificate fingerprints in DNSSEC-signed TLSA records. Sending servers that support DANE require TLS and verify the certificate against those records.',
            },
            {
                q: 'Does DANE require DNSSEC?',
                a: 'Yes. Without DNSSEC an attacker could forge the TLSA records along with everything else, so senders ignore TLSA records that do not validate. Both the domain and the MX hosts’ zones must be signed.',
            },
            {
                q: 'What does "3 1 1" mean in a TLSA record?',
                a: 'Certificate usage 3 (DANE-EE: match the server’s own certificate), selector 1 (match its public key, not the whole certificate), matching type 1 (SHA-256 hash). It is the form RFC 7672 recommends, and it survives certificate renewals that keep the same key.',
            },
            {
                q: 'DANE or MTA-STS?',
                a: 'They solve the same problem with different trust models: DANE relies on DNSSEC, MTA-STS on HTTPS and certificate authorities. Many domains publish both; senders use whichever they support, and DANE takes precedence where both apply.',
            },
        ],
        guides: ['mta-sts-and-tls-rpt'],
    },
    {
        key: 'bimi',
        slug: 'bimi-checker',
        name: 'BIMI Checker',
        title: 'BIMI Checker: Validate BIMI Records and DMARC Prerequisites',
        description:
            "Check a domain's BIMI record at default._bimi and whether its DMARC policy meets BIMI's requirements, so supporting inboxes can show the brand logo.",
        heroTitle: 'Check a <em>BIMI record</em>',
        heroLede:
            'BIMI lets supporting inboxes show your logo next to authenticated mail. Check the record, the logo and certificate URLs, and the DMARC policy it depends on.',
        placeholder: 'example.com',
        summary: 'Validates the default._bimi record and the DMARC enforcement BIMI requires.',
        guideHeading: 'What the BIMI checker tests',
        guideHtml: `
<p>BIMI (Brand Indicators for Message Identification) is a TXT record at <code>default._bimi.</code>your domain pointing at an SVG logo and, usually, a mark certificate proving you own it.</p>
<pre><code>default._bimi.example.com.  TXT  "v=BIMI1; l=https://example.com/logo.svg; a=https://example.com/vmc.pem"</code></pre>
<ul>
<li><strong>DMARC at enforcement.</strong> BIMI only applies when DMARC is at <code>quarantine</code> or <code>reject</code> for the whole domain, and a subdomain policy is not <code>none</code>.</li>
<li><strong>The record.</strong> <code>v=BIMI1</code> first, an <code>https://</code> logo URL in <code>l=</code>, and optionally a certificate URL in <code>a=</code>.</li>
<li><strong>The certificate.</strong> Gmail and Apple Mail only show logos backed by a Verified Mark Certificate (VMC) or Common Mark Certificate (CMC).</li>
</ul>
<p>The logo's SVG Tiny PS profile and the certificate's contents are on other hosts a browser cannot read, so they are marked not verifiable.</p>`,
        faq: [
            {
                q: 'What is BIMI?',
                a: 'BIMI (Brand Indicators for Message Identification) is a DNS record that points to a brand logo in SVG format. Mailbox providers that support it display the logo next to messages that pass DMARC, including Gmail, Apple Mail and Yahoo.',
            },
            {
                q: 'What do I need before BIMI works?',
                a: 'DMARC at enforcement (p=quarantine or p=reject) on your domain, a logo in the SVG Tiny Portable/Secure format, and for Gmail and Apple Mail a Verified Mark Certificate or Common Mark Certificate.',
            },
            {
                q: 'Is a VMC required for BIMI?',
                a: 'Not by the record format, but in practice yes for the largest inboxes: Gmail and Apple Mail only show logos backed by a VMC or CMC. Some providers, such as Yahoo, show logos without one.',
            },
        ],
        guides: ['dmarc-from-none-to-reject'],
    },
    {
        key: 'dkim',
        slug: 'dkim-checker',
        name: 'DKIM Checker',
        title: 'DKIM Checker: Look Up and Validate DKIM Keys by Selector',
        description:
            "Check a domain's DKIM public key records. Enter a selector, or let it try the selectors common mail services use. Validates the key type, RSA key length, revoked keys and testing mode.",
        heroTitle: 'Check a <em>DKIM key</em>',
        heroLede:
            'Look up the DKIM public key for a domain and selector, or try the selectors that Google, Microsoft and the main mail services use, and check the key is strong enough to be trusted.',
        placeholder: 'example.com',
        summary:
            'Looks up DKIM keys by selector, or tries common ones, and checks key type, length and revocation.',
        guideHeading: 'What the DKIM checker tests',
        guideHtml: `
<p>DKIM keys are published at <code>&lt;selector&gt;._domainkey.</code>your domain. DNS cannot list selectors, so you either give one — it is the <code>s=</code> value in the <code>DKIM-Signature</code> header of a message the domain sent — or the checker tries the ones common services use.</p>
<ul>
<li><strong>The record.</strong> Parses, has a <code>p=</code> key, and <code>v=DKIM1</code> first if present. Two key records at one name make verification fail at random.</li>
<li><strong>Key strength.</strong> RFC 8301 requires receivers to reject RSA keys under 1024 bits and asks signers for 2048. The checker reads the key length from the key itself. Ed25519 keys (RFC 8463) are recognised.</li>
<li><strong>Revoked keys.</strong> An empty <code>p=</code> revokes the key; correct for a retired selector, a problem if anything still signs with it.</li>
<li><strong>Testing and hashes.</strong> <code>t=y</code> asks receivers to ignore signatures, and a key limited to <code>h=sha1</code> cannot produce a signature receivers accept.</li>
</ul>
<p>A published key shows a domain <em>can</em> sign, not that it does; the report says so. Not finding a key at the common selectors proves nothing either.</p>`,
        faq: [
            {
                q: 'How do I find my DKIM selector?',
                a: 'Open a message the domain sent and view its original headers. The DKIM-Signature header contains s=, the selector, and d=, the signing domain. The key is published at <selector>._domainkey.<domain>. Google Workspace uses google by default and Microsoft 365 uses selector1 and selector2.',
            },
            {
                q: 'What DKIM key length should I use?',
                a: '2048-bit RSA. RFC 8301 says receivers must not accept keys under 1024 bits, and 1024-bit keys are considered weak. Most providers now generate 2048-bit keys by default; older setups may need rotating.',
            },
            {
                q: 'Why does the checker not find my DKIM key?',
                a: 'Selectors cannot be listed from DNS, so without one the checker can only try common names. Enter the selector from the s= value of a DKIM-Signature header and it will check that key directly.',
            },
        ],
        guides: ['what-is-dkim', 'dkim2', 'spf-dkim-dmarc-explained'],
    },
    {
        key: 'dns',
        slug: 'dns-checker',
        name: 'DNS Checker',
        title: 'DNS Health Checker: Nameservers, SOA and DNSSEC',
        description:
            "Check a domain's DNS health: how many nameservers it has, whether they resolve to public addresses in different networks, SOA timer values, and DNSSEC.",
        heroTitle: 'Check a domain’s <em>DNS health</em>',
        heroLede:
            'Every email check depends on DNS answering reliably. Check the nameservers, the SOA record and DNSSEC behind a domain.',
        placeholder: 'example.com',
        summary: 'Checks nameserver count, addresses and network spread, SOA timers, and DNSSEC.',
        guideHeading: 'What the DNS checker tests',
        guideHtml: `
<ul>
<li><strong>At least two nameservers</strong>, as RFC 2182 requires, each resolving to a public address.</li>
<li><strong>Network diversity.</strong> Nameservers all in one /24 can be taken out together by one routing problem. Anycast providers are the usual exception.</li>
<li><strong>SOA timers</strong> within the ranges RFC 1912 and common operational guidance recommend: refresh, retry, expire, and the negative-caching TTL.</li>
<li><strong>DNSSEC</strong>, from the validating resolvers' AD flag.</li>
</ul>
<p>A browser reaches DNS only through public resolvers, never each nameserver directly. So checks that need per-server queries — whether every server is authoritative, whether they agree on the SOA serial, whether they allow zone transfers — are marked not verifiable.</p>`,
        faq: [
            {
                q: 'How many nameservers should a domain have?',
                a: 'At least two, on different networks, as RFC 2182 requires. Most DNS providers give you two to four. With a single nameserver, any outage takes the whole domain offline, including its email.',
            },
            {
                q: 'What do the SOA timers mean?',
                a: 'Refresh is how often secondary nameservers check for changes, retry how soon they try again after a failure, expire how long they keep serving the zone without reaching the primary, and the minimum field sets how long resolvers cache "name does not exist" answers.',
            },
            {
                q: 'Why does DNS health matter for email?',
                a: 'MX, SPF, DKIM, DMARC and MTA-STS are all DNS records. If the nameservers are slow or unreachable, receivers cannot look them up, and mail can be delayed, rejected, or fail authentication.',
            },
        ],
        guides: ['secure-a-domain-that-sends-no-email'],
    },
];

export function toolUrl(slug: string): string {
    return `/tools/${slug}/`;
}
