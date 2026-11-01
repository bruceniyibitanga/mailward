// Pure scoring rules: no network, no AWS clients, so they can be tested on their own.
// analyse.js gathers the signals; this file turns them into a verdict.

// Multi-tenant mail services host mail for huge numbers of unrelated customers. A disposable
// domain using one of them says nothing about the other customers, so these hosts are never
// used for the "shares a mail server" signal. The test for being on a list is what the service
// is (does it sell or give mail to the general public?), never which domains we have labelled.
// Matched on whole labels, so "notgoogle.com" does not count as "google.com".
//
// TRUSTED: paid mailbox hosting and security gateways. Setting one up needs an account, billing
// and proof of owning the domain, so using one is (weak) positive evidence of a real business.
const TRUSTED_MAIL_PROVIDERS = [
  'google.com', 'googlemail.com', 'outlook.com', 'icloud.com', 'yahoodns.net',
  'messagingengine.com', 'fastmail.com', 'protonmail.ch', 'proton.me',
  'secureserver.net', 'privateemail.com', 'emailsrvr.com', 'netnames.net', 'ovh.net', 'gandi.net',
  'one.com', 'migadu.com', 'titan.email', 'hostinger.com', 'kundenserver.de', 'timeweb.ru',
  'mimecast.com', 'pphosted.com', 'ppe-hosted.com', 'barracudanetworks.com', 'messagelabs.com',
];
// OPEN: free mailbox plans and free or pay-as-you-go routing, forwarding and inbound mail.
// Anyone can point any domain at these in minutes, so they are ignored for the shared-server
// signal but are NOT evidence that a domain is legitimate.
const OPEN_MAIL_SERVICES = [
  'zoho.com', 'zoho.eu', 'zoho.com.au', 'zoho.in', 'yandex.net', 'yandex.ru', 'mail.ru',
  'qq.com', '163.com', 'mxhichina.com', 'feishu.cn', 'mgovcloud.in',
  'cloudflare.net', 'improvmx.com', 'forwardemail.net', 'mailgun.org', 'sendgrid.net',
  'amazonaws.com', 'registrar-servers.com',
];
const onList = (list, host) => list.some((d) => host === d || host.endsWith(`.${d}`));
export const isTrustedMailProvider = (host) => onList(TRUSTED_MAIL_PROVIDERS, host);
export const isSharedProviderMx = (host) => isTrustedMailProvider(host) || onList(OPEN_MAIL_SERVICES, host);

// A mail server used by this many known disposable domains is, in practice, a disposable
// service's own infrastructure: ordinary businesses do not host their mail there. Below this
// the overlap can be coincidence (one hosting company serving a few unlucky customers).
export const DEDICATED_MAIL_SERVER_MIN = 10;

export function score(signals) {
  // We could not look up the mail servers (DNS timed out). That tells us nothing either way.
  if (signals.mxLookup === 'failed') {
    return { verdict: 'unverified', confidence: 0.3 };
  }
  if (signals.mxHosts.length === 0) {
    return { verdict: 'undeliverable', confidence: 0.9 };
  }

  // One entry per KIND of evidence. A signal we could not measure (unknown domain age,
  // for example when RDAP is rate limited) is no evidence at all, not slightly suspicious.
  const evidence = {
    sharedMailServer: signals.mxSharedWithDisposable >= 2 ? 0.5 : signals.mxSharedWithDisposable === 1 ? 0.3 : 0,
    redirectsToDisposable: signals.redirectsToDisposable ? 0.5 : 0,
    pageKeywords: Math.min(signals.keywords.length * 0.2, 0.4),
    recentlyRegistered: signals.domainAgeDays === null ? 0 : signals.domainAgeDays < 30 ? 0.2 : signals.domainAgeDays < 365 ? 0.1 : 0,
  };
  const s = Math.min(Object.values(evidence).reduce((a, b) => a + b, 0), 1);
  const kinds = Object.values(evidence).filter((v) => v > 0).length;

  // "Disposable" is a strong claim, so the score alone is not enough. It needs strong evidence
  // on its own (the site redirects to a known disposable domain, or its mail server is a
  // disposable service's own) or two independent kinds of weaker evidence. Sharing a mail
  // server with just a few disposable domains can be coincidence, so on its own it is a hint.
  const strong = evidence.redirectsToDisposable > 0 || signals.mxSharedWithDisposable >= DEDICATED_MAIL_SERVER_MIN;
  if (s >= 0.5 && (strong || kinds >= 2)) {
    // Cap at 0.95: a rules score should never claim to be certain.
    return { verdict: 'disposable', confidence: Number(Math.min(s, 0.95).toFixed(2)) };
  }

  // "Legitimate" needs positive evidence. Finding no red flags is not proof that a
  // domain is clean, so everything else is honestly reported as "unverified".
  const bigProviderMx = signals.mxHosts.some(isTrustedMailProvider);
  const established = signals.domainAgeDays !== null && signals.domainAgeDays > 730 && signals.homepageReachable;
  if (bigProviderMx || established) {
    return { verdict: 'legitimate', confidence: bigProviderMx && established ? 0.9 : 0.8 };
  }
  return { verdict: 'unverified', confidence: 0.5 };
}

// Turns DNS mail-server records into a list of host names, best first.
// A "null MX" (RFC 7505) is a single record with an empty host name, and it is how a domain says
// it accepts no mail at all. It is not a mail server, so it gives an empty list (undeliverable).
export function parseMxRecords(records) {
  return records
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .map((r) => String(r.exchange ?? '').toLowerCase().replace(/\.$/, ''))
    .filter((host) => host !== '');
}
