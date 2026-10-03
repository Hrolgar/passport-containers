import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const M = createRequire(import.meta.url)("../src/matcher.js");
const { mergeRulesIncoming, restoreDiff, renameContainer, resolveAlias, findProblems, parseRules, matchUrl } = M;

test("merge restore: the incoming rule wins for the same pattern, everything else is kept", () => {
  const cur = "# mine\nexample.com , Work\ngithub.com/acme , Client\n";
  const inc = "example.com , Personal\nnew.example , Personal\n";
  const out = mergeRulesIncoming(cur, inc);
  const r = parseRules(out);
  assert.equal(matchUrl("https://example.com/", r), "Personal");
  assert.equal(matchUrl("https://github.com/acme/x", r), "Client");
  assert.equal(matchUrl("https://new.example/", r), "Personal");
  assert.equal(out.split("\n").filter(l => l.startsWith("example.com")).length, 1);
  assert.ok(out.startsWith("# mine"));
});

test("restore preview counts what changes", () => {
  const cur = { rulesText: "a.com , A\nb.com , B\n", shortcuts: { x: { url: "https://x/", container: "A" }, y: { url: "https://y/", container: "B" } } };
  const inc = { rulesText: "a.com , C\nc.com , C\n", shortcuts: { x: { url: "https://x/", container: "C" }, z: { url: "https://z/", container: "C" } } };
  assert.deepEqual(restoreDiff(cur, inc, "replace"), { rulesAdded: 1, rulesChanged: 1, rulesRemoved: 1, keywordsAdded: 1, keywordsChanged: 1, keywordsRemoved: 1 });
  assert.deepEqual(restoreDiff(cur, inc, "merge"), { rulesAdded: 1, rulesChanged: 1, rulesRemoved: 0, keywordsAdded: 1, keywordsChanged: 1, keywordsRemoved: 0 });
});

test("rename follows into rules, keywords, hints and colours; comments and other lines untouched", () => {
  const rules = "# work stuff\nexample.com , Freelancing\n@app\\.x\\.com\\?a=1 , freelancing\nother.com , Personal\n";
  const sc = { fm: { url: "https://mail.example/?passport=Freelancing", container: "Freelancing" }, p: { url: "https://p/", container: "Personal" } };
  const r = renameContainer(rules, sc, { Freelancing: { color: "yellow", icon: "dollar" } }, "Freelancing", "HrolTech");
  assert.equal(r.rulesText, "# work stuff\nexample.com , HrolTech\n@app\\.x\\.com\\?a=1 , HrolTech\nother.com , Personal\n");
  assert.equal(r.shortcuts.fm.container, "HrolTech");
  assert.equal(new URL(r.shortcuts.fm.url).searchParams.get("passport"), "HrolTech");
  assert.deepEqual(r.shortcuts.p, sc.p);
  assert.deepEqual(r.meta, { HrolTech: { color: "yellow", icon: "dollar" } });
});

test("aliases resolve old names, follow chains and never loop", () => {
  assert.equal(resolveAlias("Freelancing", { Freelancing: "HrolTech" }), "HrolTech");
  assert.equal(resolveAlias("freelancing", { Freelancing: "HrolTech" }), "HrolTech");
  assert.equal(resolveAlias("A", { A: "B", B: "C" }), "C");
  assert.equal(resolveAlias("A", { A: "B", B: "A" }), "A");
  assert.equal(resolveAlias("Klaria", { Freelancing: "HrolTech" }), "Klaria");
});

test("problems: duplicate keywords, keywords without a bookmark, hints that override or point nowhere", () => {
  const rules = parseRules("oc.example , OC\n");
  const shortcuts = { kcrm: { url: "https://crm/app", container: "K" }, kdash: { url: "https://crm/app", container: "K" }, lone: { url: "https://lone/", container: "K" }, srch: { url: "https://s/?q=%s", container: "K" } };
  const containers = [{ name: "OC" }, { name: "K" }, { name: "HrolTech" }];
  const bookmarks = [
    { title: "CRM", url: "https://crm/app" },
    { title: "OC dash", url: "https://oc.example/admin?passport=HrolTech" },
    { title: "Old", url: "https://old.example/?passport=Freelancing" },
  ];
  const texts = findProblems({ rules, shortcuts, containers, bookmarks }).map(p => p.text);
  assert.ok(texts.some(t => t.startsWith("Keywords kcrm and kdash open the same page")));
  assert.ok(texts.some(t => t.startsWith("Keyword lone has no bookmark")));
  assert.ok(!texts.some(t => t.includes("srch")));
  assert.ok(texts.some(t => t.includes("OC dash carries ?passport=HrolTech, which overrides the rule that sends the site to OC")));
  assert.ok(texts.some(t => t.includes("Old asks for container Freelancing, which does not exist")));
});

test("problems without a bookmark list stay as before (no bookmark checks)", () => {
  const texts = findProblems({ rules: [], shortcuts: { a: { url: "https://a/", container: "X" } }, containers: [{ name: "X" }] }).map(p => p.text);
  assert.ok(!texts.some(t => t.includes("no bookmark")));
});
