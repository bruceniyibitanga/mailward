// Run with:  cd services/api && node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, assessMailbox, recommend, withMailbox, gibberishScore } from '../src/mailbox.js';

function check(email, domainVerdict = 'legitimate') {
  const addr = parseAddress(email);
  const mailbox = assessMailbox(addr.local, addr.domain);
  return { mailbox, ...recommend(domainVerdict, mailbox) };
}

test('parseAddress splits local part and domain, and handles a bare domain', () => {
  assert.deepEqual(parseAddress('Bruce@Mailinator.com'), { local: 'bruce', domain: 'mailinator.com' });
  assert.deepEqual(parseAddress('gmail.com'), { local: null, domain: 'gmail.com' });
  assert.equal(parseAddress('not an email'), null);
  assert.equal(parseAddress(42), null);
});

test('the cases from the bug report are no longer plain "legitimate/allow"', () => {
  for (const email of ['test@yahoo.com', 'random123@gmail.com', 'asdkjh8791qwe@gmail.com', 'xqzvbnmklpw@gmail.com']) {
    const r = check(email);
    assert.notEqual(r.recommendation, 'allow', `${email} should not be allowed outright`);
    assert.notEqual(r.mailbox.status, 'unverifiable', `${email} should be flagged`);
  }
});

test('placeholder and role names', () => {
  assert.equal(check('test@yahoo.com').mailbox.status, 'placeholder');
  assert.equal(check('random123@gmail.com').mailbox.status, 'placeholder');
  assert.equal(check('test1@company.com').mailbox.status, 'placeholder');
  assert.equal(check('admin@company.com').mailbox.status, 'role_account');
  assert.equal(check('noreply@company.com').recommendation, 'review');
  assert.equal(check('qwerty123@company.com').mailbox.status, 'placeholder');
});

test('hard syntax failures are certain and blocked', () => {
  for (const email of ['bad..dots@gmail.com', '.leading@company.com', 'trailing.@company.com', 'sp ace@company.com', 'a(b)@company.com']) {
    const addr = parseAddress(email);
    if (!addr) continue; // the domain parser may already reject some of these
    const r = check(email);
    assert.equal(r.mailbox.status, 'invalid_format', email);
    assert.equal(r.mailbox.certain, true, email);
    assert.equal(r.recommendation, 'block', email);
  }
  assert.equal(check(`${'a'.repeat(65)}@company.com`).recommendation, 'block');
});

test('Gmail: documented character rule is hard; length is soft (legacy accounts)', () => {
  const underscore = check('john_smith@gmail.com');
  assert.equal(underscore.mailbox.certain, true);
  assert.equal(underscore.recommendation, 'block');

  const short = check('ab12@gmail.com');
  assert.equal(short.mailbox.status, 'invalid_format');
  assert.equal(short.mailbox.certain, false);
  assert.equal(short.recommendation, 'review');

  assert.equal(check('a@gmail.com').recommendation, 'review');
  // plus tags and dots do not count against the username
  assert.equal(check('john.smith+news@gmail.com').recommendation, 'allow');
});

test('Yahoo and Outlook rules are soft (unofficial)', () => {
  assert.equal(check('ab@yahoo.com').recommendation, 'review');
  assert.equal(check('john_smith92@yahoo.com').recommendation, 'allow');
  assert.equal(check('weird!name@outlook.com').recommendation, 'review');
});

test('disposable and undeliverable domains always block', () => {
  assert.equal(check('x@mailinator.com', 'disposable').recommendation, 'block');
  assert.equal(check('someone@nomx.example', 'undeliverable').recommendation, 'block');
});

test('unverified or pending domains need review even with a clean mailbox', () => {
  assert.equal(check('john.smith@37xiao.com', 'unverified').recommendation, 'review');
  assert.equal(check('john.smith@brandnew.org', 'unknown').recommendation, 'review');
});

test('normal-looking addresses are allowed, with the honest "unverifiable" caveat', () => {
  const names = [
    'john.smith@gmail.com', 'mary_jane1985@yahoo.com', 'christopher.nguyen@outlook.com', 'sarah.oconnor@gmail.com',
    'wang.xiaoming@gmail.com', 'krzysztof.kowalski@gmail.com', 'szczepanski.anna@gmail.com', 'przybylski.jan@gmail.com',
    'bruce.niyibitanga@gmail.com', 'xzhang@gmail.com', 'alex.o.brien@gmail.com', 'priya.sharma92@hotmail.com',
    'jordan.lee2000@gmail.com', 'maria.garcia@company.com.au', 'n12236632@qut.edu.au', 'david.thompson@gmail.com',
  ];
  for (const email of names) {
    const r = check(email);
    assert.equal(r.mailbox.status, 'unverifiable', `${email} -> ${r.mailbox.status}: ${r.mailbox.reasons}`);
    assert.equal(r.recommendation, 'allow', email);
    assert.match(r.mailbox.note, /cannot be confirmed/);
  }
});

test('keyboard-row mashing is caught even when it contains vowels', () => {
  assert.equal(check('ewrtyuhgfd@gmail.com').mailbox.status, 'suspicious');
  assert.equal(check('sdfsdfsdf@gmail.com').mailbox.status, 'suspicious');
  assert.equal(check('poiuytrewq@gmail.com').recommendation, 'review');
});

test('gibberish score is only strong when several signals combine', () => {
  assert.ok(gibberishScore('asdkjh8791qwe').score >= 0.5);
  assert.ok(gibberishScore('bcdfghjklm').score >= 0.5);
  assert.ok(gibberishScore('johnsmith').score < 0.5);
  assert.equal(gibberishScore('abc').score, 0); // too short to judge
});

test('withMailbox keeps the domain fields and adds the new ones; bare domains get no mailbox', () => {
  const body = { domain: 'gmail.com', verdict: 'legitimate', confidence: 0.99, source: 'store' };
  const out = withMailbox(body, parseAddress('john.smith@gmail.com'));
  assert.equal(out.verdict, 'legitimate');
  assert.equal(out.confidence, 0.99);
  assert.equal(out.mailbox.status, 'unverifiable');
  assert.equal(out.recommendation, 'allow');

  const bare = withMailbox(body, parseAddress('gmail.com'));
  assert.equal('mailbox' in bare, false);
  assert.equal(bare.recommendation, 'allow');
});

test('privacy: the assessment output never repeats the local part', () => {
  const out = JSON.stringify(withMailbox({ domain: 'gmail.com', verdict: 'legitimate' }, parseAddress('zebrafinch73@gmail.com')));
  assert.equal(out.includes('zebrafinch'), false);
});
