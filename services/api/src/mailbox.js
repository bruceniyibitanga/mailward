// Mailbox-level assessment: what we can honestly say about the part BEFORE the "@".
//
// A domain check can say "gmail.com is a real provider". It can never say "this mailbox exists":
// big providers do not reveal that. What we CAN do is spot addresses that are impossible
// (a provider would never issue them) or that look like placeholders, role accounts or random keyboard mashing.
//
// Privacy: the local part is read in memory for this one request and then forgotten.
// Nothing in this file logs, stores or caches it. Keep it that way.
//
// Rules are split into two strengths:
//   hard = certain (RFC syntax, or a rule the provider documents officially): recommendation "block"
//   soft = probable (unofficial rules, heuristics):                          recommendation "review"
import { extractDomain } from './domain.js';

export const MAILBOX_NOTE =
  'Existence of this mailbox cannot be confirmed from outside. Send a confirmation email to prove ownership.';

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

// "Bruce@Mailinator.com" -> { local: "bruce", domain: "mailinator.com" }
// A bare domain ("gmail.com") has no local part -> { local: null, domain }.
export function parseAddress(input) {
  const domain = extractDomain(input);
  if (!domain) return null;
  const value = String(input).trim();
  const at = value.lastIndexOf('@');
  if (at === -1) return { local: null, domain };
  return { local: value.slice(0, at).toLowerCase(), domain };
}

// ---------------------------------------------------------------------------------------------
// Rule data
// ---------------------------------------------------------------------------------------------

const ROLE_ACCOUNTS = new Set([
  'admin', 'administrator', 'info', 'support', 'help', 'contact', 'sales', 'billing', 'accounts',
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'postmaster', 'abuse', 'webmaster', 'hostmaster',
  'root', 'security', 'office', 'hello', 'team', 'mail', 'marketing', 'hr', 'jobs', 'enquiries', 'inquiries',
]);

const PLACEHOLDER_WORDS = new Set([
  'test', 'testing', 'tester', 'testuser', 'random', 'asdf', 'asdfg', 'asdfgh', 'asdfghjkl', 'qwerty', 'qwert', 'qwe',
  'abc', 'abcd', 'abcde', 'demo', 'fake', 'dummy', 'example', 'sample', 'temp', 'tmp', 'foo', 'bar', 'foobar',
  'user', 'username', 'name', 'email', 'myemail', 'me', 'nobody', 'noone', 'none', 'null', 'someone', 'anyone',
  'zxcv', 'zxcvbn', 'xxx', 'aaa', 'abc123', 'hello', 'hi',
]);

const KEYBOARD_RUNS = ['1234', 'qwer', 'asdf', 'zxcv', 'abcd', '0000', '1111'];

// Gmail: Google's help page (support.google.com/mail/answer/9211434) documents 6-30 characters,
// letters, numbers and periods only. Length limits are "soft" because very old accounts may predate them.
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

// Yahoo and Outlook family: only unofficial sources describe these rules, so violations are "soft".
const YAHOO_DOMAINS = new Set(['yahoo.com', 'yahoo.com.au', 'yahoo.co.uk', 'yahoo.ca', 'ymail.com', 'rocketmail.com']);
const MICROSOFT_DOMAINS = new Set([
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'hotmail.co.uk', 'outlook.com.au', 'hotmail.com.au', 'live.com.au',
]);

const SYNTAX_CHARS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;

// ---------------------------------------------------------------------------------------------
// Checks. Each pushes { text, hard } findings into the list it is given.
// ---------------------------------------------------------------------------------------------

function checkSyntax(local, domain, found) {
  if (local.length === 0) return found.push({ text: 'The part before the @ is empty.', hard: true });
  if (local.length > 64) found.push({ text: 'The part before the @ is longer than 64 characters (RFC 5321).', hard: true });
  if (local.length + 1 + domain.length > 254) found.push({ text: 'The address is longer than 254 characters (RFC 5321).', hard: true });
  if (local.startsWith('"')) {
    found.push({ text: 'Quoted local parts are technically legal but no mainstream provider issues them.', hard: false });
    return;
  }
  if (/[^\x00-\x7f]/.test(local)) {
    found.push({ text: 'Contains non-ASCII characters, which most providers do not accept.', hard: false });
    return;
  }
  if (!SYNTAX_CHARS.test(local)) found.push({ text: 'Contains characters that are not allowed in an email address.', hard: true });
  if (local.startsWith('.') || local.endsWith('.')) found.push({ text: 'Starts or ends with a period.', hard: true });
  if (local.includes('..')) found.push({ text: 'Contains two periods in a row.', hard: true });
}

// "john.smith+news" -> "john.smith"
function baseOf(local) {
  const plus = local.indexOf('+');
  return plus > 0 ? local.slice(0, plus) : local;
}

function checkProvider(local, domain, found) {
  const base = baseOf(local);

  if (GMAIL_DOMAINS.has(domain)) {
    if (/[^a-z0-9.]/.test(base)) {
      found.push({ text: 'Gmail usernames may only contain letters, numbers and periods.', hard: true });
    }
    if (base.length < 6) found.push({ text: `Gmail requires 6 to 30 characters for a username; this one has ${base.length}.`, hard: false });
    if (base.length > 30) found.push({ text: `Gmail allows at most 30 characters for a username; this one has ${base.length}.`, hard: false });
    return;
  }

  if (YAHOO_DOMAINS.has(domain)) {
    if (base.length < 4 || base.length > 32) found.push({ text: `Yahoo usernames are normally 4 to 32 characters; this one has ${base.length}.`, hard: false });
    if (!/^[a-z]/.test(base)) found.push({ text: 'Yahoo usernames normally start with a letter.', hard: false });
    if (!/[a-z0-9]$/.test(base)) found.push({ text: 'Yahoo usernames normally end with a letter or number.', hard: false });
    if (/[^a-z0-9_.]/.test(base)) found.push({ text: 'Yahoo usernames normally use only letters, numbers, underscores and one period.', hard: false });
    if ((base.match(/\./g) ?? []).length > 1) found.push({ text: 'Yahoo usernames normally allow at most one period.', hard: false });
    return;
  }

  if (MICROSOFT_DOMAINS.has(domain)) {
    if (/[^a-z0-9._-]/.test(base)) found.push({ text: 'Outlook and Hotmail usernames normally use only letters, numbers, periods, hyphens and underscores.', hard: false });
  }
}

function isPlaceholder(base) {
  const letters = base.replace(/[^a-z0-9]/g, '');
  if (PLACEHOLDER_WORDS.has(base) || PLACEHOLDER_WORDS.has(letters)) return true;
  // word + a few digits: test1, random123, user_2
  const m = /^([a-z]+)[._-]?(\d{1,6})$/.exec(base);
  if (m && PLACEHOLDER_WORDS.has(m[1])) return true;
  // keyboard walks and number runs
  if (letters.length <= 12 && KEYBOARD_RUNS.some((run) => letters.startsWith(run))) return true;
  if (/^(\d)\1{3,}$/.test(letters)) return true; // 1111, 000000
  return false;
}

function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

// Characters covered by runs of 4+ neighbouring keys on one keyboard row, in either direction
// ("rtyu", "hgfd", "34567"). Keyboard mashing produces these; ordinary names almost never do.
const KEYBOARD_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
function keyboardRunCoverage(s) {
  const covered = new Array(s.length).fill(false);
  for (const row of KEYBOARD_ROWS) {
    for (const r of [row, [...row].reverse().join('')]) {
      for (let i = 0; i + 4 <= s.length; i++) {
        let len = 0;
        while (i + len < s.length) {
          const at = r.indexOf(s[i + len]);
          if (at === -1 || (len > 0 && r[at - 1] !== s[i + len - 1])) break;
          len += 1;
        }
        if (len >= 4) for (let k = i; k < i + len; k++) covered[k] = true;
      }
    }
  }
  return covered.filter(Boolean).length;
}

// Explainable "does this look like keyboard mashing?" score between 0 and 1.
// Real names and usernames rarely trip several of these at once. It is probabilistic,
// so on its own it only ever leads to "review", never "block".
export function gibberishScore(base) {
  const s = base.replace(/[^a-z0-9]/g, '');
  const reasons = [];
  if (s.length < 8) return { score: 0, reasons }; // too short to judge fairly

  const letters = s.replace(/[0-9]/g, '');
  const digits = s.length - letters.length;
  let score = 0;

  const run = Math.max(0, ...(letters.match(/[bcdfghjklmnpqrstvwxz]+/g) ?? []).map((r) => r.length));
  if (run >= 6) { score += 0.5; reasons.push(`a run of ${run} consonants in a row`); }
  else if (run >= 5) { score += 0.35; reasons.push(`a run of ${run} consonants in a row`); }

  const vowels = (letters.match(/[aeiouy]/g) ?? []).length;
  if (letters.length >= 6 && vowels / letters.length < 0.2) { score += 0.3; reasons.push('very few vowels'); }

  const transitions = (s.match(/[a-z][0-9]|[0-9][a-z]/g) ?? []).length;
  if (transitions >= 3) { score += 0.3; reasons.push('letters and digits mixed together'); }
  else if (digits >= 4 && letters.length >= 4 && transitions >= 2) { score += 0.25; reasons.push('digits in the middle of letters'); }

  if (s.length >= 10 && entropy(s) >= 3.5) { score += 0.2; reasons.push('high character randomness'); }
  if (/(.)\1{3,}/.test(s)) { score += 0.3; reasons.push('the same character repeated 4+ times'); }

  const keys = keyboardRunCoverage(s);
  if (keys >= 8) { score += 0.5; reasons.push('long runs of neighbouring keyboard keys'); }
  else if (keys >= 4) { score += 0.35; reasons.push('a run of neighbouring keyboard keys'); }

  return { score: Math.min(score, 1), reasons };
}

// ---------------------------------------------------------------------------------------------
// The assessment
// ---------------------------------------------------------------------------------------------

// Returns null for a bare domain (nothing before the @ to assess).
export function assessMailbox(local, domain) {
  if (local === null || local === undefined) return null;

  const findings = [];
  checkSyntax(local, domain, findings);
  const syntaxOk = !findings.some((f) => f.hard);
  if (syntaxOk) checkProvider(local, domain, findings);

  const hardFindings = findings.filter((f) => f.hard);
  const softFindings = findings.filter((f) => !f.hard);
  const base = baseOf(local);

  if (hardFindings.length > 0) {
    return { status: 'invalid_format', certain: true, risk: 'high', reasons: findings.map((f) => f.text), note: MAILBOX_NOTE };
  }
  if (softFindings.length > 0) {
    return { status: 'invalid_format', certain: false, risk: 'medium', reasons: softFindings.map((f) => f.text), note: MAILBOX_NOTE };
  }
  if (isPlaceholder(base)) {
    return { status: 'placeholder', certain: false, risk: 'medium', reasons: ['Looks like a placeholder or test name, not a real person.'], note: MAILBOX_NOTE };
  }
  if (ROLE_ACCOUNTS.has(base)) {
    return { status: 'role_account', certain: false, risk: 'medium', reasons: ['A shared role mailbox (such as admin or info), not an individual.'], note: MAILBOX_NOTE };
  }
  const g = gibberishScore(base);
  if (g.score >= 0.5) {
    return { status: 'suspicious', certain: false, risk: 'medium', reasons: [`Looks randomly generated: ${g.reasons.join(', ')}.`], note: MAILBOX_NOTE };
  }
  return { status: 'unverifiable', certain: false, risk: 'low', reasons: [], note: MAILBOX_NOTE };
}

// ---------------------------------------------------------------------------------------------
// The recommendation: combines the DOMAIN verdict with the MAILBOX assessment.
// ---------------------------------------------------------------------------------------------
export function recommend(domainVerdict, mailbox) {
  const reasons = [];

  if (domainVerdict === 'disposable') return { recommendation: 'block', recommendationReasons: ['The domain is a disposable email service.'] };
  if (domainVerdict === 'undeliverable') return { recommendation: 'block', recommendationReasons: ['The domain has no mail servers, so it cannot receive email.'] };
  if (mailbox?.status === 'invalid_format' && mailbox.certain) {
    return { recommendation: 'block', recommendationReasons: ['The address is not valid: ' + mailbox.reasons[0]] };
  }

  if (domainVerdict === 'unverified') reasons.push('We found no evidence either way about this domain.');
  if (domainVerdict === 'suspicious') reasons.push('The domain shows some risk signals.');
  if (domainVerdict === 'unknown') reasons.push('The domain is still being analysed.');
  if (mailbox && mailbox.status !== 'unverifiable') reasons.push(...mailbox.reasons);

  if (reasons.length > 0) return { recommendation: 'review', recommendationReasons: reasons };
  return { recommendation: 'allow', recommendationReasons: [] };
}

// Adds the mailbox fields to a domain-lookup body. Never touches the domain fields.
export function withMailbox(body, address) {
  const mailbox = address.local === null ? null : assessMailbox(address.local, address.domain);
  const rec = recommend(body?.verdict, mailbox);
  return { ...body, ...(mailbox ? { mailbox } : {}), ...rec };
}
