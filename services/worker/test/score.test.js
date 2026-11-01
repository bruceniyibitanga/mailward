// Tests for the verdict rules. Most of them check properties that must hold for ANY input
// (run over a grid of every signal combination), not just the domains that exposed a bug.
// A rule that only passes because it was fitted to known examples would fail these.
import test from 'node:test';
import assert from 'node:assert/strict';
import { score, isSharedProviderMx, isTrustedMailProvider, parseMxRecords, DEDICATED_MAIL_SERVER_MIN } from '../src/score.js';

const base = {
  mxLookup: 'ok',
  mxHosts: ['mx.some-host.net'],
  mxSharedWithDisposable: 0,
  domainAgeDays: 1000,
  homepageReachable: true,
  keywords: [],
  redirectsToDisposable: false,
};

// Every combination of the inputs the scorer looks at.
function* grid() {
  for (const mxLookup of ['ok', 'failed'])
    for (const mxHosts of [[], ['mx.some-host.net'], ['aspmx.l.google.com']])
      for (const mxSharedWithDisposable of [0, 1, 2, 5, 9, 10, 50])
        for (const redirectsToDisposable of [false, true])
          for (const kw of [0, 1, 2, 3])
            for (const domainAgeDays of [null, 5, 100, 400, 800, 5000])
              for (const homepageReachable of [true, false])
                yield {
                  mxLookup, mxHosts, mxSharedWithDisposable, redirectsToDisposable, domainAgeDays,
                  homepageReachable, keywords: Array.from({ length: kw }, (_, i) => `k${i}`),
                };
}
const isDisposable = (s) => score(s).verdict === 'disposable';

test('a DNS failure is never a definite verdict', () => {
  for (const s of grid()) {
    if (s.mxLookup !== 'failed') continue;
    assert.equal(score(s).verdict, 'unverified');
  }
});

test('only an empty (authoritative) answer means undeliverable', () => {
  for (const s of grid()) {
    if (s.mxLookup === 'failed') continue;
    assert.equal(score(s).verdict === 'undeliverable', s.mxHosts.length === 0);
  }
});

test('an unknown domain age is not evidence: it never changes whether a domain is disposable', () => {
  for (const s of grid()) {
    assert.equal(isDisposable({ ...s, domainAgeDays: null }), isDisposable({ ...s, domainAgeDays: 5000 }));
  }
});

test('weak evidence alone is never enough; strong evidence alone is', () => {
  const fewShared = { ...base, mxSharedWithDisposable: DEDICATED_MAIL_SERVER_MIN - 1 };
  const onlyKeywords = { ...base, keywords: ['a', 'b', 'c', 'd', 'e'] };
  const onlyYoung = { ...base, domainAgeDays: 1 };
  for (const s of [fewShared, onlyKeywords, onlyYoung]) assert.notEqual(score(s).verdict, 'disposable');
  // strong: the site redirects to a known disposable domain, or its mail server is a disposable service's own
  assert.equal(score({ ...base, redirectsToDisposable: true }).verdict, 'disposable');
  assert.equal(score({ ...base, mxSharedWithDisposable: DEDICATED_MAIL_SERVER_MIN }).verdict, 'disposable');
});

test('multi-tenant mail services are recognised, and look-alikes are not', () => {
  for (const h of ['route1.mx.cloudflare.net', 'mx.yandex.net', 'mxbiz1.qq.com', 'mx1.privateemail.com', 'mx1.emailsrvr.com']) {
    assert.ok(isSharedProviderMx(h), h);
  }
  for (const h of ['mail.generator.email', 'cloudflare.net.example.org', 'notyandex.net']) assert.ok(!isSharedProviderMx(h), h);
});

test('two independent kinds of evidence can reach disposable', () => {
  assert.equal(score({ ...base, mxSharedWithDisposable: 3, keywords: ['temp mail'] }).verdict, 'disposable');
  assert.equal(score({ ...base, mxSharedWithDisposable: 3, domainAgeDays: 10 }).verdict, 'disposable');
});

test('more evidence never makes a disposable verdict go away', () => {
  const stronger = [
    (s) => ({ ...s, mxSharedWithDisposable: s.mxSharedWithDisposable + 1 }),
    (s) => ({ ...s, redirectsToDisposable: true }),
    (s) => ({ ...s, keywords: [...s.keywords, 'extra'] }),
    (s) => ({ ...s, domainAgeDays: s.domainAgeDays === null ? null : Math.max(0, s.domainAgeDays - 1) }),
  ];
  for (const s of grid()) {
    if (!isDisposable(s)) continue;
    for (const f of stronger) assert.ok(isDisposable(f(s)), 'adding evidence removed a disposable verdict');
  }
});

test('removing evidence never creates a disposable verdict', () => {
  const weaker = [
    (s) => ({ ...s, mxSharedWithDisposable: 0 }),
    (s) => ({ ...s, redirectsToDisposable: false }),
    (s) => ({ ...s, keywords: [] }),
    (s) => ({ ...s, domainAgeDays: null }),
  ];
  for (const s of grid()) {
    if (isDisposable(s)) continue;
    for (const f of weaker) assert.ok(!isDisposable(f(s)), 'removing evidence created a disposable verdict');
  }
});

test('"legitimate" always needs positive evidence', () => {
  for (const s of grid()) {
    const r = score(s);
    if (r.verdict !== 'legitimate') continue;
    const bigProvider = s.mxHosts.some(isTrustedMailProvider);
    const established = s.domainAgeDays !== null && s.domainAgeDays > 730 && s.homepageReachable;
    assert.ok(bigProvider || established);
  }
});

test('confidence is a probability and a rules score never claims certainty', () => {
  for (const s of grid()) {
    const { verdict, confidence } = score(s);
    assert.ok(confidence >= 0 && confidence <= 1);
    if (verdict === 'disposable') assert.ok(confidence <= 0.95);
  }
});

test('shared provider matching uses whole labels', () => {
  assert.ok(isSharedProviderMx('aspmx.l.google.com'));
  assert.ok(isSharedProviderMx('google.com'));
  assert.ok(!isSharedProviderMx('notgoogle.com'));
  assert.ok(!isSharedProviderMx('google.com.evil.net'));
});

// A few readable cases. They illustrate the rules above and are not the proof that they work.
test('examples', () => {
  // ordinary business whose mail host a few disposable domains also happen to use
  assert.equal(score({ ...base, mxHosts: ['mx1.some-host.net'], mxSharedWithDisposable: 3, domainAgeDays: null }).verdict, 'unverified');
  // established site with no red flags
  assert.equal(score(base).verdict, 'legitimate');
  // site we know nothing about
  assert.equal(score({ ...base, domainAgeDays: null }).verdict, 'unverified');
  // no mail server at all
  assert.equal(score({ ...base, mxHosts: [] }).verdict, 'undeliverable');
});

test('open mail services are ignored for the shared-server signal but never prove a domain is legitimate', () => {
  for (const h of ['route1.mx.cloudflare.net', 'mx.yandex.net', 'mx.improvmx.com', 'mxbiz1.qq.com']) {
    assert.ok(isSharedProviderMx(h), `${h} should be ignored for sharing`);
    assert.ok(!isTrustedMailProvider(h), `${h} should not count as evidence of legitimacy`);
    assert.equal(score({ ...base, mxHosts: [h], domainAgeDays: null }).verdict, 'unverified');
  }
});

test('every trusted provider is also ignored for the shared-server signal', () => {
  for (const h of ['aspmx.l.google.com', 'mx1.emailsrvr.com', 'mx.mimecast.com', 'mx1.privateemail.com']) {
    assert.ok(isTrustedMailProvider(h) && isSharedProviderMx(h), h);
  }
});

test('a null MX record means the domain accepts no mail; it is not a mail server', () => {
  assert.deepEqual(parseMxRecords([{ exchange: '', priority: 0 }]), []);
  assert.deepEqual(parseMxRecords([{ exchange: '.', priority: 0 }]), []);
  assert.equal(score({ ...base, mxHosts: parseMxRecords([{ exchange: '', priority: 0 }]), mxSharedWithDisposable: 50 }).verdict, 'undeliverable');
});

test('mail hosts are returned best priority first, lower case, without the trailing dot', () => {
  const hosts = parseMxRecords([{ exchange: 'MX2.Example.NET.', priority: 20 }, { exchange: 'mx1.example.net', priority: 10 }]);
  assert.deepEqual(hosts, ['mx1.example.net', 'mx2.example.net']);
});
