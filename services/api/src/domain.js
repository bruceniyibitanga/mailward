// Turns "Bruce@Mailinator.com" into "mailinator.com".
// Privacy by design: only the domain is ever cached, stored or logged. The part before the @
// is read separately and in memory only by mailbox.js, for one request, to judge the mailbox
// (placeholder names, impossible formats, random strings), and is then forgotten.

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function extractDomain(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at !== -1) value = value.slice(at + 1);
  value = value.replace(/\.$/, ''); // "example.com." -> "example.com"
  return DOMAIN_PATTERN.test(value) ? value : null;
}
