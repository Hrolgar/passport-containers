import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { parseRules, matchUrl, containerNames } = createRequire(import.meta.url)("../src/matcher.js");

const rules = parseRules(`
# example rules
billing.example.com/account , Work
@app\\.example\\.com/inbox\\?account=a , Client A
@app\\.example\\.com/inbox\\?account=b , Work
github.com/acme-corp , Client A
github.com/janedoe , Personal
github.com/janedoe-dev , Client A
https://console.example.com/search?project=work , Work
dash.example.net/0123456789abcdef0123456789abcdef , Work
!*.media.example/* , Personal
mail.google.com/mail/u/1 , Work
mail.google.com/mail , Personal
`);

test("parses and lists containers", () => {
  assert.equal(rules.length, 11);
  assert.deepEqual(containerNames(rules), ["Work", "Client A", "Personal"]);
});
test("plain prefix on host+path with segment boundaries", () => {
  assert.equal(matchUrl("https://billing.example.com/account/settings", rules), "Work");
  assert.equal(matchUrl("https://github.com/acme-corp/some-repo", rules), "Client A");
  assert.equal(matchUrl("https://github.com/janedoe-dev/x", rules), "Client A"); // janedoe must not swallow janedoe-dev
  assert.equal(matchUrl("https://github.com/janedoe", rules), "Personal");
  assert.equal(matchUrl("https://github.com/janedoe/", rules), "Personal");
  assert.equal(matchUrl("https://github.com/someone/else", rules), null);
});
test("most specific rule wins regardless of order", () => {
  const r = parseRules("mail.google.com , Personal\nmail.google.com/mail/u/1 , Work");
  assert.equal(matchUrl("https://mail.google.com/mail/u/1/#inbox", r), "Work");
  assert.equal(matchUrl("https://mail.google.com/mail/u/0/#inbox", r), "Personal");
});
test("regex sees the query string", () => {
  assert.equal(matchUrl("https://app.example.com/inbox?account=a", rules), "Client A");
  assert.equal(matchUrl("https://app.example.com/inbox?account=b", rules), "Work");
  assert.equal(matchUrl("https://app.example.com/inbox", rules), null);
});
test("plain rule with a query never matches (use @ for that)", () => {
  assert.equal(matchUrl("https://console.example.com/search?project=work", rules), null);
});
test("glob on host+path", () => {
  assert.equal(matchUrl("https://tv.media.example/web/index.html", rules), "Personal");
});
test("account-id style paths", () => {
  assert.equal(matchUrl("https://dash.example.net/0123456789abcdef0123456789abcdef/overview", rules), "Work");
  assert.equal(matchUrl("https://mail.google.com/mail/u/1/#inbox", rules), "Work");
  assert.equal(matchUrl("https://mail.google.com/mail/u/0/#inbox", rules), "Personal");
});
test("ignores non-http and garbage", () => {
  assert.equal(matchUrl("about:blank", rules), null);
  assert.equal(matchUrl("not a url", rules), null);
  assert.equal(matchUrl("https://x.example/", parseRules("@[unclosed , X")), null);
});
