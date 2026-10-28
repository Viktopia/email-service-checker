/**
 * Email security guides, rendered at build time to /guides/<slug>/.
 *
 * Plain HTML strings rather than Markdown: there are only a handful, they need
 * the same few elements, and it keeps a Markdown dependency out of a build
 * that has none. Styling comes from `.guide-body` in src/styles.css.
 *
 * Each guide names the tool it pairs with, so the page can hand the reader
 * straight to a check of their own domain.
 */

export interface Guide {
    slug: string;
    /** <title> and H1. */
    title: string;
    /** Meta description and the summary on the guides index. */
    description: string;
    /** The checker this guide leads into. */
    tool: { href: string; label: string };
    body: string;
}

export const GUIDES: readonly Guide[] = [
    {
        slug: 'spf-dkim-dmarc-explained',
        title: 'SPF, DKIM and DMARC explained',
        description:
            'How the three email authentication standards fit together, what each one proves, and which you need to stop people sending email as your domain.',
        tool: { href: '/tools/dmarc-checker/', label: 'Check your DMARC record' },
        body: `
<p>Email was designed without any way to prove who sent a message. The <code>From:</code> address is just text, and anyone can type yours. Three DNS-based standards close that gap, and they only work properly together.</p>

<h2>SPF: which servers may send</h2>
<p>An SPF record is a TXT record at your domain listing the servers allowed to send mail for it: your mailbox provider, your newsletter tool, your helpdesk. A receiving server checks the connecting IP address against that list.</p>
<pre><code>example.com.  TXT  "v=spf1 include:_spf.google.com include:sendgrid.net -all"</code></pre>
<p>SPF has a blind spot: it checks the <em>envelope</em> sender (the bounce address), not the <code>From:</code> address people see. A spoofer can pass SPF for their own domain while showing yours.</p>

<h2>DKIM: a signature on every message</h2>
<p>DKIM has your sending service sign each message with a private key. The matching public key is published in DNS under a <em>selector</em>, at <code>&lt;selector&gt;._domainkey.example.com</code>. A receiver fetches the key and verifies the signature, which proves the message came from someone holding the key and was not altered on the way.</p>
<p>DKIM survives forwarding, which SPF does not. But like SPF, on its own it says nothing about the visible <code>From:</code> address: a message can carry a valid signature from any domain.</p>

<h2>DMARC: tying it to the From address</h2>
<p>DMARC is what makes the other two useful against spoofing. It requires that SPF or DKIM not only pass, but pass for a domain that <strong>aligns</strong> with the <code>From:</code> address. It then tells receivers what to do when neither does, and where to send reports.</p>
<pre><code>_dmarc.example.com.  TXT  "v=DMARC1; p=reject; rua=mailto:dmarc@example.com"</code></pre>
<ul>
<li><code>p=none</code> — monitor only. Failing mail is delivered as normal.</li>
<li><code>p=quarantine</code> — failing mail goes to spam.</li>
<li><code>p=reject</code> — failing mail is refused.</li>
</ul>

<h2>What you actually need</h2>
<ol>
<li>An SPF record that lists every service that sends as you, and ends in <code>~all</code> or <code>-all</code>.</li>
<li>DKIM signing switched on at each of those services. Most have a setting that gives you the DNS records to add.</li>
<li>A DMARC record, starting at <code>p=none</code> with <code>rua=</code> reporting, moved to <code>p=reject</code> once the reports show only legitimate mail.</li>
</ol>
<p>Since 2024 Gmail and Yahoo require all three from anyone sending them bulk mail, so this is no longer optional for most organisations.</p>`,
    },
    {
        slug: 'how-to-create-an-spf-record',
        title: 'How to create an SPF record',
        description:
            'Build a correct SPF record step by step: find every service that sends as you, add the right includes, pick between -all and ~all, and avoid the common mistakes.',
        tool: { href: '/tools/spf-checker/', label: 'Check your SPF record' },
        body: `
<p>An SPF record is a single TXT record at the root of your domain. Getting it right is mostly a matter of not forgetting anything that sends mail on your behalf.</p>

<h2>1. List everything that sends as you</h2>
<p>Go wider than your mailbox provider. Common senders people forget:</p>
<ul>
<li>Marketing and newsletter tools (Mailchimp, HubSpot, Brevo)</li>
<li>Transactional email from your app (SendGrid, Postmark, Amazon SES, Mailgun)</li>
<li>Helpdesk, CRM and invoicing systems that send "from" your domain</li>
<li>Your own servers, printers or scanners that relay mail</li>
</ul>
<p>Each service documents the SPF entry to add, usually an <code>include:</code>.</p>

<h2>2. Write the record</h2>
<p>Start with <code>v=spf1</code>, add one term per sender, and finish with an <code>all</code>:</p>
<pre><code>v=spf1 include:_spf.google.com include:mailgun.org ip4:203.0.113.10 -all</code></pre>
<ul>
<li><code>include:domain</code> — authorise whatever that domain's SPF record authorises.</li>
<li><code>ip4:</code> / <code>ip6:</code> — authorise an address or range directly. Costs no DNS lookups.</li>
<li><code>a</code> / <code>mx</code> — authorise the addresses of your own web or mail hosts.</li>
</ul>

<h2>3. Choose -all or ~all</h2>
<p><code>-all</code> (fail) says anything not listed is unauthorised. <code>~all</code> (soft fail) says it is probably unauthorised. With a DMARC policy enforcing, receivers act on either, so <code>~all</code> is a reasonable choice while you are confident but not certain the list is complete. Never use <code>+all</code>, which authorises the entire internet, and avoid <code>?all</code>, which says nothing.</p>

<h2>4. Publish exactly one record</h2>
<p>A domain must have <strong>one</strong> TXT record starting with <code>v=spf1</code>. Two records is a permanent error and SPF fails for everyone. When adding a new service, edit the existing record rather than adding another.</p>

<h2>Common mistakes</h2>
<ul>
<li><strong>More than 10 DNS lookups.</strong> Every <code>include</code>, <code>a</code>, <code>mx</code>, <code>exists</code> and <code>redirect</code> counts, including the ones nested inside the includes. See <a href="/guides/spf-too-many-dns-lookups/">fixing too many DNS lookups</a>.</li>
<li><strong>Using <code>ptr</code>.</strong> It is deprecated, slow, and some receivers ignore it.</li>
<li><strong>Terms after <code>all</code>.</strong> Evaluation stops at <code>all</code>, so anything after it never runs.</li>
<li><strong>Typos in an include.</strong> An include that points at a domain with no SPF record is a permanent error, not a harmless no-op.</li>
</ul>`,
    },
    {
        slug: 'spf-too-many-dns-lookups',
        title: 'Fixing "SPF PermError: too many DNS lookups"',
        description:
            'Why SPF stops at 10 DNS lookups, how the count is worked out across nested includes, and four ways to bring a record back under the limit.',
        tool: { href: '/tools/spf-checker/', label: 'Count your SPF lookups' },
        body: `
<p>SPF caps the number of DNS queries a receiver will make while evaluating your record at <strong>10</strong> (RFC 7208 §4.6.4). Go over and the result is <code>permerror</code>: SPF fails for every message, legitimate or not, and DMARC has to rely on DKIM alone.</p>

<h2>What counts</h2>
<p>These terms each cost one lookup: <code>include</code>, <code>a</code>, <code>mx</code>, <code>ptr</code>, <code>exists</code>, and the <code>redirect</code> modifier. <code>ip4</code>, <code>ip6</code> and <code>all</code> are free.</p>
<p>The count is for the whole tree. <code>include:_spf.google.com</code> costs one lookup itself, and the record it points at contains further includes that are counted too. A record that looks like it has four terms can easily cost twelve.</p>
<p>There is a second limit people meet less often: no more than <strong>2 void lookups</strong>, meaning queries that return nothing. An include for a service you cancelled, whose SPF record is gone, counts against it.</p>

<h2>How to get back under the limit</h2>
<ol>
<li><strong>Remove what you no longer use.</strong> Old marketing tools and abandoned trials are the usual culprits. This is the only fix with no downside.</li>
<li><strong>Replace <code>a</code> and <code>mx</code> with addresses.</strong> If your web server sends mail from a fixed IP, <code>ip4:203.0.113.10</code> does the same job as <code>a</code> for free.</li>
<li><strong>Move senders to a subdomain.</strong> Marketing mail sent from <code>news.example.com</code> is checked against that subdomain's own SPF record, with its own budget of 10. Most bulk-mail tools support a custom sending domain.</li>
<li><strong>Flatten, carefully.</strong> Replacing an include with the IP ranges it resolves to removes lookups, but the provider can change those ranges at any time without telling you. Only flatten with a tool that keeps the record updated automatically.</li>
</ol>

<h2>Checking the count</h2>
<p>The <a href="/tools/spf-checker/">SPF checker</a> walks every include and redirect, counts the lookups and void lookups across the tree, and shows how much each include costs, so you can see which ones to cut.</p>`,
    },
    {
        slug: 'dmarc-from-none-to-reject',
        title: 'Moving DMARC from p=none to p=reject',
        description:
            'A safe rollout plan for DMARC: start monitoring, read the aggregate reports, fix legitimate senders, and step up to quarantine and reject without losing mail.',
        tool: { href: '/tools/dmarc-checker/', label: 'Check your DMARC policy' },
        body: `
<p>A DMARC record at <code>p=none</code> protects nothing: it asks receivers to deliver spoofed mail as normal. Its value is the reports, which tell you what you need to know to enforce safely. The goal is <code>p=reject</code>.</p>

<h2>Step 1: monitor</h2>
<p>Publish a record at <code>_dmarc.</code> your domain with a reporting address:</p>
<pre><code>v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com</code></pre>
<p>Large receivers such as Google, Microsoft and Yahoo will send a daily XML <em>aggregate report</em> listing every IP address that sent mail claiming to be you, and whether SPF and DKIM passed and aligned. The raw XML is hard to read; a DMARC reporting service will summarise it. If the reporting address is at another domain, that domain has to publish an authorisation record, which those services set up for you.</p>

<h2>Step 2: fix your legitimate senders</h2>
<p>Give it two to four weeks so monthly mailings and rarely used systems show up. For each source in the reports that is really you:</p>
<ul>
<li>Turn on DKIM signing with your own domain. This is the most robust fix, because DKIM survives forwarding.</li>
<li>Add the service to your SPF record, and if possible set its bounce (envelope) domain to yours, so SPF aligns too.</li>
</ul>
<p>Sources you do not recognise are either something you forgot, or someone spoofing you. The second is what enforcement will stop.</p>

<h2>Step 3: quarantine</h2>
<pre><code>v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@example.com</code></pre>
<p>Failing mail now goes to spam rather than disappearing, so a missed sender is noticed and recoverable. Older guides suggest ramping up with <code>pct=25</code>, then 50, then 100. RFC 9989 removed <code>pct</code> in 2026 and updated receivers ignore it; the replacement is <code>t=y</code>, which asks receivers to apply the policy one level lower while you test. See <a href="/guides/dmarcbis/">what changed in DMARC</a>.</p>

<h2>Step 4: reject</h2>
<pre><code>v=DMARC1; p=reject; rua=mailto:dmarc-reports@example.com</code></pre>
<p>Once a few weeks of reports at quarantine show nothing legitimate failing, switch to reject. Keep reading the reports: a new tool someone signs up for next year will fail until it is set up properly, and the reports are how you will find out.</p>

<h2>Subdomains</h2>
<p>A subdomain without its own record inherits the parent's policy, or <code>sp=</code> if set, or <code>np=</code> if the subdomain does not exist at all. Avoid <code>sp=none</code> and <code>np=none</code> once the parent is enforcing: a spoofer will simply invent a subdomain.</p>

<h2>Before p=reject</h2>
<p>RFC 9989 says a domain publishing <code>p=reject</code> must sign its mail with DKIM rather than relying on SPF alone, because SPF breaks when mail is forwarded. Make sure every source in the reports passes DKIM, not just SPF.</p>`,
    },
    {
        slug: 'what-is-dkim',
        title: 'What DKIM is and how to set it up',
        description:
            'How DKIM signatures work, where the public key lives in DNS, what a selector is, and how to turn DKIM on for the services that send your mail.',
        tool: { href: '/tools/dkim-checker/', label: 'Check your DKIM keys' },
        body: `
<p>DKIM (DomainKeys Identified Mail, RFC 6376) lets a receiver verify that a message was sent by someone authorised by a domain and was not modified in transit. It is the most reliable way to pass DMARC.</p>

<h2>How it works</h2>
<ol>
<li>Your sending service holds a private key. When it sends a message, it hashes selected headers and the body and signs the result, adding a <code>DKIM-Signature:</code> header.</li>
<li>The header names the signing domain (<code>d=</code>) and a <em>selector</em> (<code>s=</code>).</li>
<li>The receiver looks up the public key at <code>&lt;selector&gt;._domainkey.&lt;domain&gt;</code> and checks the signature.</li>
</ol>
<pre><code>google._domainkey.example.com.  TXT  "v=DKIM1; k=rsa; p=MIIBIjANBgkqh..."</code></pre>

<h2>Selectors</h2>
<p>A selector is just a name that lets a domain publish several keys at once: one per sending service, or an old and a new key during rotation. That is also why DKIM cannot be checked from a domain name alone, the way SPF and DMARC can: you need the selector, which appears in the <code>DKIM-Signature:</code> header of a message you received.</p>

<h2>Setting it up</h2>
<p>For each service that sends as your domain:</p>
<ol>
<li>Find its DKIM or "domain authentication" setting. Google Workspace, Microsoft 365 and every serious bulk-mail tool have one.</li>
<li>Add the DNS records it gives you, usually a TXT or CNAME at a <code>_domainkey</code> name.</li>
<li>Switch signing on, then send a test message and check its headers for <code>dkim=pass</code> with <code>header.d=</code> your domain.</li>
</ol>
<p>Use 2048-bit RSA keys where the service offers them; 1024-bit keys are considered weak. Rotate keys occasionally by publishing a new selector before retiring the old one.</p>

<h2>DKIM and DMARC</h2>
<p>DMARC passes when DKIM passes for a domain aligned with the <code>From:</code> address. If a service signs with its own domain (<code>d=sendgrid.net</code>) rather than yours, the signature is valid but does not help your DMARC. Setting up DKIM "for your domain" in the service is what fixes that.</p>`,
    },
    {
        slug: 'secure-a-domain-that-sends-no-email',
        title: 'How to secure a domain that sends no email',
        description:
            'Parked and website-only domains are easy targets for spoofing. Three DNS records — null MX, a deny-all SPF record and DMARC reject — lock them down.',
        tool: { href: '/tools/spf-checker/', label: 'Check a domain' },
        body: `
<p>Domains you own but never send mail from are attractive to spoofers precisely because nobody watches them. With no SPF or DMARC records, receivers have nothing to reject forged mail with. Locking one down takes three DNS records and no maintenance.</p>

<h2>1. Null MX: receive nothing</h2>
<pre><code>example.com.  MX  0 .</code></pre>
<p>A single MX record pointing at "." (RFC 7505) tells senders the domain accepts no mail, so they fail immediately instead of queueing and retrying for days. Remove any other MX records.</p>

<h2>2. SPF: nobody may send</h2>
<pre><code>example.com.  TXT  "v=spf1 -all"</code></pre>
<p>No server is authorised, so every message claiming the domain fails SPF.</p>

<h2>3. DMARC: reject everything that fails</h2>
<pre><code>_dmarc.example.com.  TXT  "v=DMARC1; p=reject;"</code></pre>
<p>Because nothing legitimate is ever sent, there is no rollout: go straight to <code>p=reject</code>. Add a <code>rua=</code> address if you want to see how often someone tries. The policy also covers subdomains, unless you set <code>sp=</code> otherwise.</p>

<h2>Optionally: revoke every DKIM selector</h2>
<pre><code>*._domainkey.example.com.  TXT  "v=DKIM1; p="</code></pre>
<p>An empty key revokes it, and the wildcard covers every selector, so no DKIM signature claiming the domain can ever verify. The reserved <code>example.com</code> domain is set up exactly this way.</p>

<h2>Optionally: wildcard SPF</h2>
<p>Subdomains are covered by the parent's DMARC record, but SPF is not inherited. A spoofer using <code>billing.example.com</code> gets no SPF result, which DMARC <code>p=reject</code> still rejects. If you want SPF to say so explicitly, a wildcard <code>*.example.com TXT "v=spf1 -all"</code> does it, as long as no other TXT records exist under that wildcard.</p>

<p>Check all of it at once with the <a href="/tools/email-security-report/">email security report</a>, which recognises a null MX and a revoked DKIM wildcard.</p>`,
    },
    {
        slug: 'dmarcbis',
        title: 'DMARCbis: what changed in DMARC in 2026 (RFC 9989)',
        description:
            'DMARC was revised in May 2026 as RFC 9989, 9990 and 9991. What is new, what was removed — pct, rf and ri — and what to change in your record.',
        tool: { href: '/tools/dmarc-checker/', label: 'Check your record against RFC 9989' },
        body: `
<p>In May 2026 the IETF published the revised DMARC standard, long known as <em>DMARCbis</em>. It moves DMARC from an informational RFC to the Standards Track and splits it into three documents:</p>
<ul>
<li><strong>RFC 9989</strong> — the policy record and how receivers find and apply it. Obsoletes RFC 7489 and RFC 9091.</li>
<li><strong>RFC 9990</strong> — aggregate (<code>rua</code>) reporting.</li>
<li><strong>RFC 9991</strong> — failure (<code>ruf</code>) reporting.</li>
</ul>
<p>Most existing records keep working. A few things in them now mean something different, or nothing at all.</p>

<h2>Removed: pct, rf and ri</h2>
<p><code>pct</code> let a domain apply its policy to a percentage of failing mail. It is gone. A record with <code>p=quarantine; pct=10</code> is now read by updated receivers as plain <code>p=quarantine</code>: the whole of your failing mail is quarantined, not a tenth of it. <code>rf</code> (report format) and <code>ri</code> (report interval) were removed too; reports have one format and are daily.</p>

<h2>New: t, np and psd</h2>
<ul>
<li><code>t=y</code> is the replacement for staged rollouts. It asks receivers to apply the policy one level lower — <code>reject</code> as <code>quarantine</code>, <code>quarantine</code> as <code>none</code> — while reports are generated as normal. It corresponds to the old <code>pct=0</code>; <code>t=n</code>, the default, to <code>pct=100</code>.</li>
<li><code>np=</code> sets the policy for subdomains that <em>do not exist</em>. Spoofers like invented subdomains because nothing legitimate ever sends from them, so <code>np=reject</code> is close to free protection.</li>
<li><code>psd=</code> marks a record as belonging to a public suffix (<code>y</code>), an organisational domain (<code>n</code>), or unspecified (<code>u</code>, the default). Most domain owners never need it.</li>
</ul>

<h2>Changed: how the policy is found</h2>
<p>RFC 7489 used the Public Suffix List to work out a domain's organisational domain. RFC 9989 replaces that with a <strong>DNS tree walk</strong>: query <code>_dmarc.</code> the domain, then its parent, and so on towards the top-level domain, at most eight queries. The first valid record found is the one that applies. For a subdomain, the parent's <code>sp=</code> applies if the subdomain exists, and <code>np=</code> if it does not.</p>

<h2>Clarified: what policies mean</h2>
<ul>
<li>A record with no valid <code>p=</code> is treated as <code>p=none</code> if it has a valid <code>rua=</code>, and ignored otherwise.</li>
<li>If more than one DMARC record is published at the same name, receivers discard all of them.</li>
<li>Domains that publish <code>p=reject</code> must sign with DKIM rather than rely on SPF alone, and domains whose users post to mailing lists should not publish <code>p=reject</code>.</li>
<li>The <code>!10m</code> size suffix on report addresses is obsolete and ignored.</li>
</ul>

<h2>What to change</h2>
<ol>
<li>Remove <code>pct</code>, <code>rf</code> and <code>ri</code>. If <code>pct</code> was below 100, decide whether you really want the full policy, or <code>t=y</code> while you finish testing.</li>
<li>Add <code>np=reject</code> if your main policy is enforcing and you do not already set <code>sp=reject</code>.</li>
<li>Check there is exactly one record at <code>_dmarc.</code> your domain.</li>
<li>If you are at <code>p=reject</code>, confirm every sender signs with DKIM.</li>
</ol>
<p>The <a href="/tools/dmarc-checker/">DMARC checker</a> validates against RFC 9989 and flags each of these.</p>`,
    },
    {
        slug: 'dkim2',
        title: 'DKIM2: the next version of DKIM, explained',
        description:
            'DKIM2 is an IETF draft that chains signatures across every hop, records how intermediaries change a message, and stops DKIM replay. What it does and where it stands.',
        tool: { href: '/tools/dmarc-checker/', label: 'Check your DMARC record' },
        body: `
<p><strong>DKIM2 is not a standard yet.</strong> It is an IETF Internet-Draft, <code>draft-ietf-dkim-dkim2-spec</code>, being developed in the DKIM working group by authors from Yahoo, Google and Fastmail. The latest revision at the time of writing is -08, dated 27 October 2026. Details will change, and there is nothing to deploy or check today. This is what it sets out to do.</p>

<h2>What is wrong with DKIM today</h2>
<ul>
<li><strong>Replay.</strong> A DKIM signature covers the message, not who it was sent to. A spammer who gets one signed message from a reputable domain can resend it to millions of recipients, and every copy verifies.</li>
<li><strong>Intermediaries break signatures.</strong> Mailing lists add footers and subject tags; forwarders rewrite headers. The original signature fails and nothing records why. ARC was an experimental attempt to carry results across hops, and is being reclassified as historic.</li>
<li><strong>Backscatter.</strong> Bounces go to whatever address the message claims, so forged mail generates bounces to innocent parties.</li>
</ul>

<h2>How DKIM2 works</h2>
<ul>
<li><strong>Every hop signs.</strong> Each system that handles the message adds a <code>DKIM2-Signature</code> header, numbered in sequence, forming a chain of custody from the originator to the final recipient.</li>
<li><strong>Signatures bind the envelope.</strong> Each signature includes the SMTP <code>MAIL FROM</code> and <code>RCPT TO</code> it was sent with. A replayed copy sent to different recipients no longer matches, which is what defeats replay.</li>
<li><strong>Changes are recorded.</strong> A <code>Message-Instance</code> header carries hashes of the message at each revision, and an intermediary that modifies it can include a "recipe" describing how to reconstruct the previous version, so a verifier can check the original signature too.</li>
<li><strong>Bounces follow the chain.</strong> Delivery status notifications are sent back only to systems that actually handled the message.</li>
<li><strong>Modern algorithms.</strong> Ed25519 and a post-quantum algorithm (ML-DSA) alongside RSA. Keys are published at the same <code>_domainkey</code> names as today.</li>
</ul>

<h2>How it relates to DKIM and DMARC</h2>
<p>DKIM2 is a new protocol rather than an update to DKIM: messages can carry both <code>DKIM-Signature</code> and <code>DKIM2-Signature</code> headers during a transition. How DMARC will use DKIM2 results is not yet specified. For now, DMARC (<a href="/guides/dmarcbis/">RFC 9989</a>) is built on DKIM as it exists today.</p>

<h2>What to do now</h2>
<p>Nothing changes in your DNS. The best preparation is getting today's authentication right: DKIM signing for every sender, an SPF record within its limits, and DMARC at enforcement. Those are what DKIM2 is designed to build on.</p>`,
    },
    {
        slug: 'mta-sts-and-tls-rpt',
        title: 'How to set up MTA-STS and TLS-RPT',
        description:
            'Stop attackers stripping TLS from email sent to your domain. Publish an MTA-STS policy in testing mode, collect TLS-RPT reports, then enforce.',
        tool: { href: '/tools/mta-sts-checker/', label: 'Check your MTA-STS policy' },
        body: `
<p>Mail servers encrypt with STARTTLS when they can, and fall back to plaintext when they cannot. An attacker who can interfere with the connection can make it "cannot". MTA-STS (RFC 8461) closes that gap, and TLS-RPT (RFC 8460) tells you when it bites.</p>

<h2>1. Publish TLS-RPT first</h2>
<pre><code>_smtp._tls.example.com.  TXT  "v=TLSRPTv1; rua=mailto:tls-reports@example.com"</code></pre>
<p>From now on, senders such as Google and Microsoft send a daily report of TLS successes and failures delivering to you. It costs nothing and is the only way you will learn that a policy is blocking mail.</p>

<h2>2. Host the policy file</h2>
<p>Serve this as <code>text/plain</code> at <code>https://mta-sts.example.com/.well-known/mta-sts.txt</code>, with a valid certificate for <code>mta-sts.example.com</code>:</p>
<pre><code>version: STSv1
mode: testing
mx: mx1.example.com
mx: *.mail.example.net
max_age: 604800</code></pre>
<ul>
<li>One <code>mx:</code> line per MX host, or a wildcard covering one label. If your mail is hosted, use the names your provider gives you.</li>
<li><code>max_age</code> is how long senders cache the policy, in seconds, up to a year. A week is a sensible start.</li>
<li>The server must not redirect: senders do not follow redirects.</li>
</ul>

<h2>3. Publish the DNS record</h2>
<pre><code>_mta-sts.example.com.  TXT  "v=STSv1; id=20261028T000000"</code></pre>
<p>The <code>id</code> is how senders know the policy changed. Change it every time you edit the policy file.</p>

<h2>4. Read the reports, then enforce</h2>
<p>After a couple of weeks of clean TLS-RPT reports in testing mode, change <code>mode: testing</code> to <code>mode: enforce</code> and update the <code>id</code>. Senders that support MTA-STS will now refuse to deliver over a connection without valid TLS.</p>

<h2>Keeping it working</h2>
<ul>
<li>When you change mail provider or add an MX host, update the policy <em>before</em> the MX records.</li>
<li>Certificate expiry on <code>mta-sts.</code> stops senders refreshing the policy; on an MX host, it stops delivery. Monitor both.</li>
<li>If your DNS is DNSSEC-signed, <a href="/tools/dane-checker/">DANE</a> offers the same protection without depending on certificate authorities.</li>
</ul>`,
    },
];

export function guideUrl(slug: string): string {
    return `/guides/${slug}/`;
}
