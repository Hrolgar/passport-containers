// Rule format (Containerise compatible, one per line):
//   host/path , Container          plain: host + path prefix, on segment boundaries (query ignored);
//                                  example.com also covers www.example.com
//   @regex , Container             regex tested against the full URL
//   !host/*/x , Container          glob on host + path (* = any run of characters)
//   # comment
// The most specific matching rule wins (longest pattern); ties go to the earlier line.
(function (root) {
  function parseRules(text) {
    const rules = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.lastIndexOf(",");
      if (i < 0) continue;
      let pattern = line.slice(0, i).trim();
      const container = line.slice(i + 1).trim();
      if (!pattern || !container) continue;
      let type = "plain";
      if (pattern.startsWith("@")) { type = "regex"; pattern = pattern.slice(1).trim(); }
      else if (pattern.startsWith("!")) { type = "glob"; pattern = pattern.slice(1).trim(); }
      else pattern = pattern.replace(/^https?:\/\//, "");
      rules.push({ type, pattern, container });
    }
    return rules;
  }
  function globToRegex(g) {
    return new RegExp("^" + g.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*"));
  }
  function plainMatches(hostPath, pattern) {
    const p = pattern.replace(/\/$/, "");
    if (!hostPath.startsWith(p)) return false;
    const next = hostPath.charAt(p.length);
    return next === "" || next === "/";
  }
  function bestRule(url, rules) {
    let u; try { u = new URL(url); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const hostPath = u.host + u.pathname;
    let best = null;
    for (const r of rules) {
      let hit = false;
      try {
        // A plain rule for example.com also covers www.example.com: sites redirect between the
        // two and nobody writes the rule twice. A rule that names www. itself still matches only www.
        if (r.type === "plain") hit = plainMatches(hostPath, r.pattern) || (u.host.startsWith("www.") && plainMatches(hostPath.slice(4), r.pattern));
        else if (r.type === "regex") hit = new RegExp(r.pattern).test(url);
        else if (r.type === "glob") hit = globToRegex(r.pattern).test(hostPath);
      } catch { /* bad regex: skip the rule */ }
      if (hit && (!best || r.pattern.length > best.pattern.length)) best = r;
    }
    return best;
  }
  function matchRule(url, rules) { return bestRule(url, rules); }
  function matchUrl(url, rules) { const r = bestRule(url, rules); return r ? r.container : null; }
  function containerNames(rules) { return [...new Set(rules.map(r => r.container))]; }
  // Shortcuts: "keyword , url , Container" per line. Typed as "go keyword" in the URL bar.
  function parseShortcuts(text) {
    const out = {};
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(",").map(x => x.trim());
      if (parts.length < 2 || !parts[0] || !parts[1]) continue;
      const keyword = parts[0].toLowerCase().split(/\s+/)[0];
      const url = /^[a-z]+:\/\//i.test(parts[1]) ? parts[1] : "https://" + parts[1];
      out[keyword] = { url, container: parts[2] || "" };
    }
    return out;
  }
  function serializeShortcuts(map) {
    return Object.keys(map).sort().map(k => `${k} , ${map[k].url}${map[k].container ? " , " + map[k].container : ""}`).join("\n");
  }
  // A bare keyword typed in the URL bar becomes a search on the default engine. Recognise
  // those requests so the keyword can be intercepted before the search ever loads.
  const ENGINES = [
    [/(^|\.)google\.[a-z.]+$/, "/search", "q"],
    [/(^|\.)bing\.com$/, "/search", "q"],
    [/(^|\.)duckduckgo\.com$/, "/", "q"],
    [/(^|\.)startpage\.com$/, "/", "query"],
    [/(^|\.)ecosia\.org$/, "/search", "q"],
    [/(^|\.)search\.brave\.com$/, "/search", "q"],
    [/(^|\.)qwant\.com$/, "/", "q"],
    [/(^|\.)search\.yahoo\.com$/, "/search", "p"],
    [/(^|\.)yandex\.[a-z]+$/, "/search", "text"],
    [/(^|\.)kagi\.com$/, "/search", "q"],
  ];
  function searchQuery(url) {
    let u; try { u = new URL(url); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    for (const [host, path, param] of ENGINES) {
      if (host.test(u.hostname) && u.pathname.startsWith(path)) {
        const q = (u.searchParams.get(param) || "").trim();
        return q || null;
      }
    }
    return null;
  }
  // "kgh my-repo": first word is the keyword, the rest are arguments for a %s in its URL.
  function resolveShortcut(text, shortcuts) {
    const t = String(text || "").trim(); if (!t) return null;
    const sp = t.search(/\s/); const k = (sp < 0 ? t : t.slice(0, sp)).toLowerCase(); const args = sp < 0 ? "" : t.slice(sp + 1).trim();
    const sc = shortcuts[k]; if (!sc) return null;
    if (args && !sc.url.includes("%s")) return null;          // "pdb something" is a real search
    return { keyword: k, shortcut: sc, args };
  }
  function expandUrl(template, args) {
    return String(template).replace(/%s/g, args ? encodeURIComponent(args) : "");
  }
  function keywordFromSearch(url, shortcuts) {
    const q = searchQuery(url);
    const r = q ? resolveShortcut(q, shortcuts) : null;
    return r ? r.keyword : null;
  }
  // Consistency checks shown on the Sites tab
  function findProblems({ rules = [], shortcuts = {}, containers = [], engine = null, bookmarks = null } = {}) {
    const out = [];
    const seen = new Map();
    for (const r of rules) {
      const key = r.type + ":" + r.pattern;
      if (seen.has(key) && seen.get(key) !== r.container) out.push({ level: "warn", text: `Two rules for ${r.pattern} point at ${seen.get(key)} and ${r.container}; the earlier one wins.` });
      seen.set(key, r.container);
      if (r.type === "regex") { try { new RegExp(r.pattern); } catch (e) { out.push({ level: "error", text: `Regex rule ${r.pattern} is invalid: ${e.message}` }); } }
      if (r.type === "plain" && /[?#]/.test(r.pattern)) out.push({ level: "warn", text: `Plain rule ${r.pattern} contains a query string, which plain rules never see. Use a regex (@) rule.` });
    }
    for (const [k, v] of Object.entries(shortcuts)) {
      const ruleC = matchUrl(expandUrl(v.url, "x"), rules);
      if (ruleC && v.container && ruleC.toLowerCase() !== v.container.toLowerCase())
        out.push({ level: "info", text: `Keyword ${k} opens ${v.url} in ${v.container}, but a rule sends that site to ${ruleC}. The keyword still works; plain links will land in ${ruleC}.` });
      if (!v.container) out.push({ level: "info", text: `Keyword ${k} has no container; it opens wherever you are.` });
    }
    const names = new Set(containers.map(c => c.name.toLowerCase()));
    if (containers.length) {
      for (const n of containerNames(rules)) if (n.toLowerCase() !== "default" && !names.has(n.toLowerCase())) out.push({ level: "info", text: `Container ${n} does not exist here yet; it will be created when Passport next loads.` });
    }
    // Two keywords for one page: a bookmark holds one Firefox keyword, so only one of them can be native.
    const byUrl = new Map();
    for (const [k, v] of Object.entries(shortcuts)) { if (String(v.url).includes("%s")) continue; const u = keyUrl(v.url); byUrl.set(u, [...(byUrl.get(u) || []), k]); }
    for (const ks of byUrl.values()) if (ks.length > 1) out.push({ level: "info", text: `Keywords ${ks.sort().join(" and ")} open the same page. A bookmark holds one Firefox keyword, so only ${ks[0]} can be native; consider dropping the others.` });
    if (bookmarks) {
      const marked = new Set(bookmarks.filter(b => b.url).map(b => keyUrl(b.url)));
      const noMark = Object.keys(shortcuts).filter(k => !String(shortcuts[k].url).includes("%s") && !marked.has(keyUrl(shortcuts[k].url)));
      if (noMark.length) out.push({ level: "info", text: `${noMark.length === 1 ? "Keyword" : "Keywords"} ${noMark.sort().join(", ")} ${noMark.length === 1 ? "has" : "have"} no bookmark, so Firefox has no native keyword for ${noMark.length === 1 ? "it" : "them"} (the "Visit" suggestion). Keywords tab: Create missing bookmarks.` });
      for (const b of bookmarks) {
        const h = b.url && containerHint(b.url); if (!h || !h.container) continue;
        const exists = !containers.length || names.has(h.container.toLowerCase());
        const ruleC = matchUrl(h.url, rules);
        if (!exists) out.push({ level: "warn", text: `Bookmark ${b.title || h.url} asks for container ${h.container}, which does not exist. Edit its ?passport= value.` });
        else if (ruleC && ruleC.toLowerCase() !== h.container.toLowerCase()) out.push({ level: "info", text: `Bookmark ${b.title || h.url} carries ?passport=${h.container}, which overrides the rule that sends the site to ${ruleC}. Remove the hint if the rule should decide.` });
      }
    }
    if (engine === false) out.push({ level: "warn", text: "Your default search engine is not one Passport recognises, so bare keywords in the URL bar will not work. Use the 'go keyword' form, or switch to Google, Bing, DuckDuckGo, Startpage, Ecosia, Brave, Qwant, Yahoo, Yandex or Kagi." });
    return out;
  }
  const KNOWN_ENGINES = ["google", "bing", "duckduckgo", "startpage", "ecosia", "brave", "qwant", "yahoo", "yandex", "kagi"];
  function engineRecognised(name) { const n = String(name || "").toLowerCase(); return KNOWN_ENGINES.some(e => n.includes(e)); }
  // Explicit container hint in a URL: https://site/?passport=Work  -> open in Work, strip the param.
  // Lets a plain bookmark choose its container; bookmarks sync natively.
  function containerHint(url) {
    let u; try { u = new URL(url); } catch { return null; }
    if (!/^https?:$/.test(u.protocol) || !u.searchParams.has("passport")) return null;
    const container = (u.searchParams.get("passport") || "").trim();
    u.searchParams.delete("passport");
    return { container, url: u.toString() };
  }
  function withHint(url, container) {
    const u = new URL(url); u.searchParams.set("passport", container); return u.toString();
  }
  // Upsert a plain/regex/glob rule by its pattern text, keeping the rest of the file as is.
  function upsertRule(text, pattern, container) {
    const key = pattern.trim().replace(/^https?:\/\//, "");
    const lines = String(text || "").split(/\r?\n/);
    let hit = false;
    const out = lines.map(l => {
      const i = l.lastIndexOf(",");
      if (i < 0 || l.trim().startsWith("#")) return l;
      const pat = l.slice(0, i).trim().replace(/^https?:\/\//, "");
      if (pat === key) { hit = true; return `${key} , ${container}`; }
      return l;
    });
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    if (!hit) out.push(`${key} , ${container}`);
    return out.join("\n") + "\n";
  }
  function removeRule(text, pattern) {
    const key = pattern.trim().replace(/^https?:\/\//, "");
    const out = String(text || "").split(/\r?\n/).filter(l => {
      const i = l.lastIndexOf(",");
      if (i < 0 || l.trim().startsWith("#")) return true;
      return l.slice(0, i).trim().replace(/^https?:\/\//, "") !== key;
    });
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    return out.length ? out.join("\n") + "\n" : "";
  }
  function serializeRules(rules) {
    return rules.map(r => (r.type === "regex" ? "@" : r.type === "glob" ? "!" : "") + r.pattern + " , " + r.container).join("\n") + (rules.length ? "\n" : "");
  }
  // Merge two rule files, keeping the first copy of each rule line (a merge restore used to double everything).
  function mergeRules(a, b) {
    const seen = new Set(); const out = [];
    for (const l of (String(a || "").trimEnd() + "\n" + String(b || "")).split(/\r?\n/)) {
      const k = l.trim();
      if (k && !k.startsWith("#")) { if (seen.has(k)) continue; seen.add(k); }
      out.push(l);
    }
    while (out.length && out[0].trim() === "") out.shift();
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    return out.length ? out.join("\n") + "\n" : "";
  }
  // Merge where the incoming file wins: a rule for the same pattern replaces the current one instead of
  // sitting next to it (where the earlier, current copy would win and the restore would look ignored).
  function mergeRulesIncoming(current, incoming) {
    const keys = new Set(parseRules(incoming).map(r => r.type + ":" + r.pattern));
    const kept = String(current || "").split(/\r?\n/).filter(l => { const r = parseRules(l)[0]; return !r || !keys.has(r.type + ":" + r.pattern); });
    return mergeRules(kept.join("\n"), incoming);
  }
  // What a restore would change, for the confirmation before it runs.
  function restoreDiff(cur, inc, mode) {
    const after = mode === "merge" ? mergeRulesIncoming(cur.rulesText, inc.rulesText) : (inc.rulesText || "");
    const map = text => new Map(parseRules(text).map(r => [r.type + ":" + r.pattern, r.container]));
    const a = map(cur.rulesText), b = map(after);
    const scA = cur.shortcuts || {}, scB = mode === "merge" ? { ...scA, ...(inc.shortcuts || {}) } : (inc.shortcuts || {});
    const same = (x, y) => x && y && x.url === y.url && (x.container || "") === (y.container || "");
    return {
      rulesAdded: [...b.keys()].filter(k => !a.has(k)).length,
      rulesChanged: [...b.keys()].filter(k => a.has(k) && a.get(k) !== b.get(k)).length,
      rulesRemoved: [...a.keys()].filter(k => !b.has(k)).length,
      keywordsAdded: Object.keys(scB).filter(k => !scA[k]).length,
      keywordsChanged: Object.keys(scB).filter(k => scA[k] && !same(scA[k], scB[k])).length,
      keywordsRemoved: Object.keys(scA).filter(k => !scB[k]).length,
    };
  }
  // A container renamed (in Passport, in Firefox, or on another machine): every rule, keyword and colour
  // that named it follows, comments and the order of the file untouched.
  function renameContainer(rulesText, shortcuts, meta, oldName, newName) {
    const o = String(oldName).toLowerCase();
    const lines = String(rulesText || "").split(/\r?\n/).map(l => {
      const r = parseRules(l)[0];
      return r && r.container.toLowerCase() === o ? serializeRules([{ ...r, container: newName }]).trimEnd() : l;
    });
    const sc = {};
    for (const [k, v] of Object.entries(shortcuts || {})) {
      const h = containerHint(v.url);
      const url = h && h.container.toLowerCase() === o ? withHint(h.url, newName) : v.url;
      sc[k] = { ...v, url, container: (v.container || "").toLowerCase() === o ? newName : v.container };
    }
    const m = { ...(meta || {}) };
    for (const k of Object.keys(m)) if (k.toLowerCase() === o) { m[newName] = m[k]; delete m[k]; }
    return { rulesText: lines.join("\n"), shortcuts: sc, meta: m };
  }
  // Old container names that were renamed: a bookmark hint or a rule that still says the old name
  // resolves to the new one instead of recreating an empty container.
  function resolveAlias(name, aliases) {
    let n = String(name || ""); const seen = new Set();
    while (aliases && !seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      const hit = Object.keys(aliases).find(k => k.toLowerCase() === n.toLowerCase());
      if (!hit) break;
      n = aliases[hit];
    }
    return n;
  }
  // The URL a bookmark and a keyword are compared by: container hint dropped, parsed form.
  function keyUrl(url) {
    const h = containerHint(url); const u = h ? h.url : url;
    try { return new URL(u).toString(); } catch { return String(u || ""); }
  }
  // What the Firefox keyword on each bookmark should become after the keyword list changed.
  // A bookmark holds one keyword, so per URL: a keyword that is new wins, otherwise a remaining one,
  // otherwise it is cleared, but only if it still is one of the keywords that went away (`expect`).
  function keywordChanges(before, after) {
    const group = map => { const g = new Map(); for (const [k, v] of Object.entries(map || {})) { const u = keyUrl(v.url); if (!g.has(u)) g.set(u, []); g.get(u).push(k); } return g; };
    const a = group(before), b = group(after); const out = [];
    for (const url of new Set([...a.keys(), ...b.keys()])) {
      const was = (a.get(url) || []).sort(), now = (b.get(url) || []).sort();
      if (was.join(" ") === now.join(" ")) continue;
      const added = now.filter(k => !was.includes(k)), removed = was.filter(k => !now.includes(k));
      if (added.length) out.push({ url, keyword: added[0], expect: null });
      else if (now.length) out.push({ url, keyword: now[0], expect: removed });
      else out.push({ url, keyword: null, expect: removed });
    }
    return out;
  }
  const api = { parseRules, serializeRules, mergeRules, mergeRulesIncoming, restoreDiff, renameContainer, resolveAlias, keyUrl, keywordChanges, resolveShortcut, expandUrl, findProblems, engineRecognised, matchUrl, matchRule, removeRule, containerNames, globToRegex, parseShortcuts, serializeShortcuts, searchQuery, keywordFromSearch, containerHint, withHint, upsertRule };
  if (typeof module !== "undefined") module.exports = api; else root.PassportMatcher = api;
})(typeof self !== "undefined" ? self : this);
