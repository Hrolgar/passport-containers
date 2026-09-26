import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { keywordChanges, keyUrl, mergeRules } = createRequire(import.meta.url)("../src/matcher.js");

const GSC = "https://search.google.com/search-console?resource_id=sc-domain%3Aexample.com";
const base = { kgcr: { url: GSC, container: "Work" }, gh: { url: "https://github.com/", container: "Personal" } };

test("unchanged list changes no bookmark", () => {
  assert.deepEqual(keywordChanges(base, { ...base }), []);
});
test("rename puts the new keyword on the same bookmark", () => {
  const { kgcr, ...rest } = base;
  assert.deepEqual(keywordChanges(base, { ...rest, kgsc: kgcr }), [{ url: keyUrl(GSC), keyword: "kgsc", expect: null }]);
});
test("delete clears the bookmark only if it still has that keyword", () => {
  const { kgcr, ...rest } = base;
  assert.deepEqual(keywordChanges(base, rest), [{ url: keyUrl(GSC), keyword: null, expect: ["kgcr"] }]);
});
test("URL change clears the old bookmark and sets the new one", () => {
  const after = { ...base, gh: { url: "https://gitlab.com/", container: "Personal" } };
  assert.deepEqual(keywordChanges(base, after), [
    { url: "https://github.com/", keyword: null, expect: ["gh"] },
    { url: "https://gitlab.com/", keyword: "gh", expect: null },
  ]);
});
test("container change alone leaves the bookmark keyword alone", () => {
  assert.deepEqual(keywordChanges(base, { ...base, gh: { url: "https://github.com/", container: "Work" } }), []);
});
test("container hint does not make a different URL", () => {
  assert.equal(keyUrl("https://github.com/?passport=Work"), keyUrl("https://github.com/"));
  const after = { ...base, gh: { url: "https://github.com/?passport=Personal", container: "Personal" } };
  assert.deepEqual(keywordChanges(base, after), []);
});
test("fresh install restore sets every keyword", () => {
  assert.equal(keywordChanges({}, base).length, 2);
});
test("merge restore keeps one copy of each rule", () => {
  const a = "github.com , Personal\nnordnet.no , Personal\n";
  assert.equal(mergeRules(a, a), a);
  assert.equal(mergeRules(a, "x.com , Work\n"), a + "x.com , Work\n");
  assert.equal(mergeRules("", a), a);
});
