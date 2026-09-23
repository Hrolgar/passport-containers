/* global PassportMatcher */
const { parseRules, matchUrl, containerNames } = PassportMatcher;
const COLORS = ["blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple"];
const CHUNK = 7000; // storage.sync caps one item at 8 KiB

let rules = [];
let containerMeta = {};          // name -> {color, icon}
let idByName = new Map();        // container name -> cookieStoreId
let loading = null;

function hashColor(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }

async function readSync() {
  const all = await browser.storage.sync.get(null);
  const parts = Object.keys(all).filter(k => k.startsWith("rules_")).sort((a, b) => +a.slice(6) - +b.slice(6));
  return { rulesText: parts.map(k => all[k]).join(""), containerMeta: all.containerMeta || {} };
}
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
  for (const name of containerNames(rules)) {
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
  const { rulesText, containerMeta: meta } = await readSync();
  rules = parseRules(rulesText); containerMeta = meta;
  await ensureContainers();
}
function reload() { loading = load().catch(e => console.error("passport load", e)); return loading; }

function targetStore(url) {
  const name = matchUrl(url, rules);
  if (!name) return null;
  if (name.toLowerCase() === "default") return "firefox-default";
  return idByName.get(name) || null;
}

const inflight = new Set();
browser.webRequest.onBeforeRequest.addListener(async details => {
  if (details.tabId < 0) return {};
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
  if (msg.type === "get") { await loading; const s = await readSync(); return { ...s, containers: await browser.contextualIdentities.query({}) }; }
  if (msg.type === "save") { await writeSync(msg.rulesText, msg.containerMeta || containerMeta); await reload(); return { ok: true, count: rules.length }; }
  if (msg.type === "match") { await loading; return { container: matchUrl(msg.url, rules) }; }
  if (msg.type === "addRule") {
    const s = await readSync();
    const text = (s.rulesText.trimEnd() + "\n" + msg.line + "\n").replace(/^\n/, "");
    await writeSync(text, s.containerMeta); await reload(); return { ok: true };
  }
});
reload();
