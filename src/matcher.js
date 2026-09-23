// Rule format (Containerise compatible, one per line):
//   host/path , Container          plain: host + path prefix, on segment boundaries (query ignored)
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
  function matchUrl(url, rules) {
    let u; try { u = new URL(url); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const hostPath = u.host + u.pathname;
    let best = null;
    for (const r of rules) {
      let hit = false;
      try {
        if (r.type === "plain") hit = plainMatches(hostPath, r.pattern);
        else if (r.type === "regex") hit = new RegExp(r.pattern).test(url);
        else if (r.type === "glob") hit = globToRegex(r.pattern).test(hostPath);
      } catch { /* bad regex: skip the rule */ }
      if (hit && (!best || r.pattern.length > best.pattern.length)) best = r;
    }
    return best ? best.container : null;
  }
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
  function keywordFromSearch(url, shortcuts) {
    const q = searchQuery(url);
    if (!q || /\s/.test(q)) return null;
    const k = q.toLowerCase();
    return shortcuts[k] ? k : null;
  }
  const api = { parseRules, matchUrl, containerNames, globToRegex, parseShortcuts, serializeShortcuts, searchQuery, keywordFromSearch };
  if (typeof module !== "undefined") module.exports = api; else root.PassportMatcher = api;
})(typeof self !== "undefined" ? self : this);
