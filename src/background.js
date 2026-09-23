/* global PassportMatcher */
const { parseRules, matchUrl, containerNames, parseShortcuts, serializeShortcuts, keywordFromSearch } = PassportMatcher;
const COLORS = ["blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple"];
const CHUNK = 7000; // storage.sync caps one item at 8 KiB

let rules = [];
let shortcuts = {};              // keyword -> {url, container}
let containerMeta = {};          // name -> {color, icon}
let idByName = new Map();        // container name -> cookieStoreId
let loading = null;

function hashColor(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }

async function readSync() {
  const all = await browser.storage.sync.get(null);
  const parts = Object.keys(all).filter(k => k.startsWith("rules_")).sort((a, b) => +a.slice(6) - +b.slice(6));
  return { rulesText: parts.map(k => all[k]).join(""), containerMeta: all.containerMeta || {}, shortcuts: all.shortcuts || {} };
}
async function writeShortcuts(map) { await browser.storage.sync.set({ shortcuts: map, updatedAt: Date.now() }); }
async function writeSync(rulesText, meta) {
  const all = await browser.storage.sync.get(null);
  const stale = Object.keys(all).filter(k => k.startsWith("rules_"));
  const chunks = {};
  for (let i = 0; i * CHUNK < rulesText.length || i === 0; i++) chunks["rules_" + i] = rulesText.slice(i * CHUNK, (i + 1) * CHUNK);
  await browser.storage.sync.remove(stale);
  await browser.storage.sync.set({ ...chunks, containerMeta: meta, updatedAt: Date.now() });
}

async function ensureContainers() {
  const existing = await browser.contextualIdentities.query({});
  idByName = new Map(existing.map(c => [c.name, c.cookieStoreId]));
  const wanted = new Set([...containerNames(rules), ...Object.values(shortcuts).map(x => x.container).filter(Boolean)]);
  for (const name of wanted) {
    if (name.toLowerCase() === "default") continue;
    const meta = containerMeta[name] || {};
    if (!idByName.has(name)) {
      const c = await browser.contextualIdentities.create({ name, color: meta.color || hashColor(name), icon: meta.icon || "fingerprint" });
      idByName.set(name, c.cookieStoreId);
    } else if (meta.color || meta.icon) {
      const cur = existing.find(c => c.name === name);
      if ((meta.color && cur.color !== meta.color) || (meta.icon && cur.icon !== meta.icon))
        await browser.contextualIdentities.update(cur.cookieStoreId, { color: meta.color || cur.color, icon: meta.icon || cur.icon });
    }
  }
}

async function load() {
  const { rulesText, containerMeta: meta, shortcuts: sc } = await readSync();
  rules = parseRules(rulesText); containerMeta = meta; shortcuts = sc;
  await ensureContainers();
}
function reload() { loading = load().catch(e => console.error("passport load", e)); return loading; }

function storeFor(name) {
  if (!name) return null;
  if (name.toLowerCase() === "default") return "firefox-default";
  return idByName.get(name) || null;
}
function targetStore(url) { return storeFor(matchUrl(url, rules)); }

// "go <keyword>" in the URL bar opens a shortcut straight into its container
browser.omnibox.setDefaultSuggestion({ description: "Passport: type a keyword (go mail)" });
browser.omnibox.onInputChanged.addListener(async (text, suggest) => {
  await loading;
  const q = text.trim().toLowerCase();
  suggest(Object.keys(shortcuts).filter(k => k.startsWith(q)).sort().slice(0, 8)
    .map(k => ({ content: k, description: `${k}  ${shortcuts[k].url}${shortcuts[k].container ? "  [" + shortcuts[k].container + "]" : ""}` })));
});
async function openShortcut(sc, cur, disposition = "currentTab") {
  const store = storeFor(sc.container) || "firefox-default";
  if (cur && disposition === "currentTab" && cur.cookieStoreId === store) { await browser.tabs.update(cur.id, { url: sc.url }); return; }
  await browser.tabs.create({ url: sc.url, cookieStoreId: store, active: disposition !== "newBackgroundTab", index: cur ? cur.index + 1 : undefined, windowId: cur ? cur.windowId : undefined });
  if (cur && disposition === "currentTab" && /^about:(blank|newtab|home)$/.test(cur.url || "")) browser.tabs.remove(cur.id).catch(() => {});
}
browser.omnibox.onInputEntered.addListener(async (text, disposition) => {
  await loading;
  const sc = shortcuts[text.trim().toLowerCase().split(/\s+/)[0]];
  if (!sc) return;
  const [cur] = await browser.tabs.query({ active: true, currentWindow: true });
  await openShortcut(sc, cur, disposition);
});

const inflight = new Set();
browser.webRequest.onBeforeRequest.addListener(async details => {
  if (details.tabId < 0) return {};
  await loading;
  // Bare keyword typed in the URL bar: Firefox sends it to the search engine, we take it instead.
  const kw = keywordFromSearch(details.url, shortcuts);
  if (kw) {
    let cur; try { cur = await browser.tabs.get(details.tabId); } catch { return {}; }
    openShortcut(shortcuts[kw], cur).catch(e => console.error("passport shortcut", e));
    return { cancel: true };
  }
  const target = targetStore(details.url);
  if (!target) return {};
  let tab; try { tab = await browser.tabs.get(details.tabId); } catch { return {}; }
  if (tab.cookieStoreId === target) return {};
  const key = details.tabId + "|" + details.url;
  if (inflight.has(key)) return {};
  inflight.add(key); setTimeout(() => inflight.delete(key), 2000);
  const fresh = !tab.url || /^about:(blank|newtab|home)$/.test(tab.url);
  await browser.tabs.create({ url: details.url, cookieStoreId: target, index: tab.index + 1, active: tab.active, pinned: false, windowId: tab.windowId });
  if (fresh) browser.tabs.remove(tab.id).catch(() => {});
  return { cancel: true };
}, { urls: ["<all_urls>"], types: ["main_frame"] }, ["blocking"]);

browser.storage.onChanged.addListener((_, area) => { if (area === "sync") reload(); });
browser.contextualIdentities.onRemoved.addListener(() => reload());
browser.runtime.onMessage.addListener(async msg => {
  if (msg.type === "get") { await loading; const s = await readSync(); return { ...s, shortcutsText: serializeShortcuts(s.shortcuts), containers: await browser.contextualIdentities.query({}) }; }
  if (msg.type === "save") { await writeSync(msg.rulesText, msg.containerMeta || containerMeta); await reload(); return { ok: true, count: rules.length }; }
  if (msg.type === "match") { await loading; return { container: matchUrl(msg.url, rules) }; }
  if (msg.type === "addShortcut") {
    const s = await readSync();
    const map = { ...s.shortcuts, [String(msg.keyword).toLowerCase().split(/\s+/)[0]]: { url: msg.url, container: msg.container || "" } };
    await writeShortcuts(map); await reload(); return { ok: true };
  }
  if (msg.type === "saveShortcuts") { await writeShortcuts(parseShortcuts(msg.text)); await reload(); return { ok: true, count: Object.keys(shortcuts).length }; }
  if (msg.type === "addRule") {
    const s = await readSync();
    const text = (s.rulesText.trimEnd() + "\n" + msg.line + "\n").replace(/^\n/, "");
    await writeSync(text, s.containerMeta); await reload(); return { ok: true };
  }
});
reload();
