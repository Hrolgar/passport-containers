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

const { parseShortcuts, serializeShortcuts } = createRequire(import.meta.url)("../src/matcher.js");
test("shortcuts parse, normalise and round-trip", () => {
  const m = parseShortcuts("Mail , mail.google.com/mail/u/0/ , Personal\nwork , https://app.example.com , Work\n# c\nbad\n  , x , y\ndocs , docs.example.com");
  assert.deepEqual(m, {
    mail: { url: "https://mail.google.com/mail/u/0/", container: "Personal" },
    work: { url: "https://app.example.com", container: "Work" },
    docs: { url: "https://docs.example.com", container: "" },
  });
  assert.deepEqual(parseShortcuts(serializeShortcuts(m)), m);
  assert.equal(serializeShortcuts({ b: { url: "https://b", container: "" }, a: { url: "https://a", container: "X" } }), "a , https://a , X\nb , https://b");
});

const { searchQuery, keywordFromSearch } = createRequire(import.meta.url)("../src/matcher.js");
test("recognises default-engine search requests and extracts the typed text", () => {
  assert.equal(searchQuery("https://www.google.com/search?client=firefox-b-d&q=pvg"), "pvg");
  assert.equal(searchQuery("https://www.google.no/search?q=pvg&ie=utf-8"), "pvg");
  assert.equal(searchQuery("https://duckduckgo.com/?q=pvg&t=ffab"), "pvg");
  assert.equal(searchQuery("https://www.bing.com/search?q=two+words"), "two words");
  assert.equal(searchQuery("https://www.startpage.com/do/search?query=pvg"), "pvg");
  assert.equal(searchQuery("https://www.google.com/maps?q=pvg"), null);
  assert.equal(searchQuery("https://example.com/search?q=pvg"), null);
});
test("a bare keyword search maps to a shortcut, anything else does not", () => {
  const sc = { pvg: { url: "https://www.vg.no/", container: "Personal" } };
  assert.equal(keywordFromSearch("https://www.google.com/search?q=pvg", sc), "pvg");
  assert.equal(keywordFromSearch("https://www.google.com/search?q=PVG", sc), "pvg");
  assert.equal(keywordFromSearch("https://www.google.com/search?q=pvg+news", sc), null);
  assert.equal(keywordFromSearch("https://www.google.com/search?q=vg", sc), null);
  assert.equal(keywordFromSearch("https://www.vg.no/?q=pvg", sc), null);
});
