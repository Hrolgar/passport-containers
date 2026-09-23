/* global PassportMatcher, PassportAccount */
const { parseRules, matchUrl, matchRule, removeRule, containerNames, parseShortcuts, serializeShortcuts, resolveShortcut, expandUrl, searchQuery, containerHint, upsertRule } = PassportMatcher;
const COLORS = ["blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple"];
const CHUNK = 7000; // storage.sync caps one item at 8 KiB

let rules = [];
let shortcuts = {};              // keyword -> {url, container}
let containerMeta = {};          // name -> {color, icon}
let idByName = new Map();        // container name -> cookieStoreId
let paused = false;
let loading = null;

function hashColor(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }

// ---------- storage
async function readSync() {
  const all = await browser.storage.sync.get(null);
  const parts = Object.keys(all).filter(k => k.startsWith("rules_")).sort((a, b) => +a.slice(6) - +b.slice(6));
  return { rulesText: parts.map(k => all[k]).join(""), containerMeta: all.containerMeta || {}, shortcuts: all.shortcuts || {} };
}
async function writeSync(rulesText, meta) {
  const all = await browser.storage.sync.get(null);
  const stale = Object.keys(all).filter(k => k.startsWith("rules_"));
  const chunks = {};
  for (let i = 0; i * CHUNK < rulesText.length || i === 0; i++) chunks["rules_" + i] = rulesText.slice(i * CHUNK, (i + 1) * CHUNK);
  await browser.storage.sync.remove(stale);
  await browser.storage.sync.set({ ...chunks, containerMeta: meta, updatedAt: Date.now() });
}
async function writeShortcuts(map) { await browser.storage.sync.set({ shortcuts: map, updatedAt: Date.now() }); }

// ---------- containers
async function ensureContainers() {
  const existing = await browser.contextualIdentities.query({});
  idByName = new Map(existing.map(c => [c.name, c.cookieStoreId]));
  const findExisting = name => existing.find(c => c.name.toLowerCase() === String(name).toLowerCase());
  // Only what rules and keywords need gets created. Styling for a container that no longer exists
  // and nothing refers to is dropped, so a container deleted in Firefox stays deleted.
  const wanted = new Set([...containerNames(rules), ...Object.values(shortcuts).map(x => x.container).filter(Boolean)]);
  let pruned = false;
  for (const name of Object.keys(containerMeta)) {
    if (!findExisting(name) && ![...wanted].some(w => w.toLowerCase() === name.toLowerCase())) { delete containerMeta[name]; pruned = true; }
  }
  if (pruned) await browser.storage.sync.set({ containerMeta });
  for (const name of wanted) {
    if (name.toLowerCase() === "default") continue;
    const meta = containerMeta[name] || {};
    const cur = findExisting(name);
    if (!cur) {
      const c = await browser.contextualIdentities.create({ name, color: meta.color || hashColor(name), icon: meta.icon || "fingerprint" });
      idByName.set(name, c.cookieStoreId);
    } else if ((meta.color && cur.color !== meta.color) || (meta.icon && cur.icon !== meta.icon)) {
      await browser.contextualIdentities.update(cur.cookieStoreId, { color: meta.color || cur.color, icon: meta.icon || cur.icon });
    }
  }
}
function storeFor(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  if (n === "default") return "firefox-default";
  if (idByName.has(name)) return idByName.get(name);
  for (const [k, v] of idByName) if (k.toLowerCase() === n) return v;
  return null;
}
function targetStore(url) { return storeFor(matchUrl(url, rules)); }

async function load() {
  const { rulesText, containerMeta: meta, shortcuts: sc } = await readSync();
  rules = parseRules(rulesText); containerMeta = meta; shortcuts = sc;
  paused = !!(await browser.storage.local.get("paused")).paused;
  await ensureContainers();
  await showPaused();
}
function reload() { loading = load().catch(e => console.error("passport load", e)); return loading; }
async function showPaused() {
  await browser.browserAction.setBadgeText({ text: paused ? "II" : "" });
  await browser.browserAction.setBadgeBackgroundColor({ color: "#b45309" });
  await browser.browserAction.setTitle({ title: paused ? "Passport (paused)" : "Passport" });
}

// ---------- opening things
const bypass = new Set();  // URLs Passport itself is opening: the rule engine must let them through
function allowOnce(url) { bypass.add(url); setTimeout(() => bypass.delete(url), 5000); }
async function openInContainer(url, store, cur, { active = true, closeFresh = true } = {}) {
  allowOnce(url);
  if (cur && cur.cookieStoreId === store) { await browser.tabs.update(cur.id, { url }); return; }
  await browser.tabs.create({ url, cookieStoreId: store, active, index: cur ? cur.index + 1 : undefined, windowId: cur ? cur.windowId : undefined });
  if (closeFresh && cur && /^about:(blank|newtab|home)$/.test(cur.url || "")) browser.tabs.remove(cur.id).catch(() => {});
}
async function openShortcut(hit, cur, disposition = "currentTab") {
  const url = expandUrl(hit.shortcut.url, hit.args);
  const store = storeFor(hit.shortcut.container) || (cur ? cur.cookieStoreId : "firefox-default");
  await openInContainer(url, store, disposition === "currentTab" ? cur : null, { active: disposition !== "newBackgroundTab" });
}
// Move a tab into another container: same URL, new tab in the container, old one closed.
async function reopenTab(tab, store) {
  if (tab.cookieStoreId === store) return;
  allowOnce(tab.url);
  await browser.tabs.create({ url: tab.url, cookieStoreId: store, active: true, index: tab.index + 1, windowId: tab.windowId, pinned: tab.pinned });
  await browser.tabs.remove(tab.id);
}

// ---------- URL bar: "go <keyword> [args]"
browser.omnibox.setDefaultSuggestion({ description: "Passport: type a keyword (go mail)" });
browser.omnibox.onInputChanged.addListener(async (text, suggest) => {
  await loading;
  const q = text.trim().toLowerCase().split(/\s+/)[0];
  suggest(Object.keys(shortcuts).filter(k => k.startsWith(q)).sort().slice(0, 8)
    .map(k => ({ content: k, description: `${k}  ${shortcuts[k].url}${shortcuts[k].container ? "  [" + shortcuts[k].container + "]" : ""}` })));
});
browser.omnibox.onInputEntered.addListener(async (text, disposition) => {
  await loading;
  const hit = resolveShortcut(text, shortcuts);
  if (!hit) return;
  const [cur] = await browser.tabs.query({ active: true, currentWindow: true });
  await openShortcut(hit, cur, disposition);
});

// ---------- the router
const inflight = new Set();
browser.webRequest.onBeforeRequest.addListener(async details => {
  if (details.tabId < 0) return {};
  await loading;
  if (paused) return {};
  if (bypass.has(details.url)) { bypass.delete(details.url); return {}; }
  // Bare keyword typed in the URL bar: Firefox sends it to the search engine, we take it instead.
  const q = searchQuery(details.url);
  const hit = q ? resolveShortcut(q, shortcuts) : null;
  if (hit) {
    let cur; try { cur = await browser.tabs.get(details.tabId); } catch { return {}; }
    openShortcut(hit, cur).catch(e => console.error("passport shortcut", e));
    return { cancel: true };
  }
  // ?passport=Container in the URL (a bookmark that chose its container): honour it, strip it.
  const hint = containerHint(details.url);
  if (hint) {
    const store = storeFor(hint.container);
    let cur; try { cur = await browser.tabs.get(details.tabId); } catch { return {}; }
    if (store) openInContainer(hint.url, store, cur).catch(e => console.error("passport hint", e));
    else { allowOnce(hint.url); browser.tabs.update(cur.id, { url: hint.url }).catch(() => {}); }
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

// ---------- keyboard shortcuts (rebind in about:addons, Manage Extension Shortcuts)
browser.commands.onCommand.addListener(async cmd => {
  await loading;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (cmd === "reopen-next-container" || cmd === "reopen-prev-container") {
    const all = await browser.contextualIdentities.query({});
    const stores = ["firefox-default", ...all.map(c => c.cookieStoreId)];
    const i = Math.max(0, stores.indexOf(tab.cookieStoreId));
    const next = stores[(i + (cmd === "reopen-next-container" ? 1 : stores.length - 1)) % stores.length];
    await reopenTab(tab, next);
  }
  if (cmd === "toggle-pause") { paused = !paused; await browser.storage.local.set({ paused }); await showPaused(); }
});

// ---------- messages from popup / options
browser.storage.onChanged.addListener((_, area) => { if (area === "sync") reload(); });
browser.contextualIdentities.onRemoved.addListener(async info => {
  // Deleted in Firefox: forget its styling unless a rule or keyword still needs it (then it comes back).
  const name = info && info.contextualIdentity && info.contextualIdentity.name;
  if (name && containerMeta[name]) { delete containerMeta[name]; await browser.storage.sync.set({ containerMeta }); }
  reload();
});
browser.runtime.onMessage.addListener(async msg => {
  if (msg.type === "get") {
    await loading; const s = await readSync();
    return { ...s, shortcutsText: serializeShortcuts(s.shortcuts), containers: await browser.contextualIdentities.query({}), paused };
  }
  if (msg.type === "save") { await writeSync(msg.rulesText, msg.containerMeta || containerMeta); await reload(); return { ok: true, count: rules.length }; }
  if (msg.type === "match") { await loading; const r = matchRule(msg.url, rules); return { container: r ? r.container : null, pattern: r ? r.pattern : null, type: r ? r.type : null }; }
  if (msg.type === "deleteRule") { const s = await readSync(); await writeSync(removeRule(s.rulesText, msg.pattern), s.containerMeta); await reload(); return { ok: true }; }
  if (msg.type === "setRule") { const s = await readSync(); await writeSync(upsertRule(s.rulesText, msg.pattern, msg.container), s.containerMeta); await reload(); return { ok: true }; }
  if (msg.type === "addShortcut") {
    const s = await readSync();
    const map = { ...s.shortcuts, [String(msg.keyword).toLowerCase().split(/\s+/)[0]]: { url: msg.url, container: msg.container || "" } };
    await writeShortcuts(map); await reload(); return { ok: true };
  }
  if (msg.type === "deleteShortcut") { const s = await readSync(); const map = { ...s.shortcuts }; delete map[String(msg.keyword).toLowerCase()]; await writeShortcuts(map); await reload(); return { ok: true }; }
  if (msg.type === "saveShortcuts") { await writeShortcuts(parseShortcuts(msg.text)); await reload(); return { ok: true, count: Object.keys(shortcuts).length }; }
  if (msg.type === "reopen") { const tab = await browser.tabs.get(msg.tabId); await reopenTab(tab, msg.store); return { ok: true }; }
  if (msg.type === "setPaused") { paused = !!msg.paused; await browser.storage.local.set({ paused }); await showPaused(); return { ok: true, paused }; }
  if (msg.type === "engine") { try { const e = (await browser.search.get()).find(x => x.isDefault); return { name: e ? e.name : null }; } catch { return { name: null }; } }
  // Mozilla account: native keywords through Sync
  if (msg.type === "accountStatus") return PassportAccount.status();
  if (msg.type === "accountConnect") { try { return await PassportAccount.connect(); } catch (e) { return { error: e.message }; } }
  if (msg.type === "accountDisconnect") { await PassportAccount.disconnect(); return { ok: true }; }
  if (msg.type === "setNativeKeyword") { try { return await PassportAccount.setNativeKeyword(msg.bookmarkId, msg.keyword); } catch (e) { return { error: e.message }; } }
  if (msg.type === "restore") {
    // {rulesText, shortcuts, containerMeta}, mode "replace" | "merge"
    const s = await readSync();
    const rulesText = msg.mode === "merge" ? (s.rulesText.trimEnd() + "\n" + (msg.rulesText || "")).replace(/^\n/, "") : (msg.rulesText || "");
    const sc = msg.mode === "merge" ? { ...s.shortcuts, ...(msg.shortcuts || {}) } : (msg.shortcuts || {});
    const meta = msg.mode === "merge" ? { ...s.containerMeta, ...(msg.containerMeta || {}) } : (msg.containerMeta || {});
    await writeSync(rulesText, meta); await writeShortcuts(sc); await reload();
    return { ok: true, rules: rules.length, keywords: Object.keys(shortcuts).length };
  }
});

// Right-click on the toolbar icon: straight to a settings tab
const MENU_TABS = [["sites", "Sites"], ["rules", "Rules"], ["keywords", "Keywords"], ["bookmarks", "Bookmarks"], ["containers", "Containers"], ["advanced", "Advanced (raw text, backup)"]];
for (const [id, title] of MENU_TABS) browser.menus.create({ id: "passport-" + id, title, contexts: ["browser_action"] });
browser.menus.create({ id: "passport-sep", type: "separator", contexts: ["browser_action"] });
browser.menus.create({ id: "passport-pause", title: "Pause routing", type: "checkbox", contexts: ["browser_action"] });
browser.menus.onClicked.addListener(async info => {
  if (info.menuItemId === "passport-pause") { paused = !!info.checked; await browser.storage.local.set({ paused }); await showPaused(); return; }
  const tab = String(info.menuItemId).replace("passport-", "");
  if (MENU_TABS.some(([id]) => id === tab)) browser.tabs.create({ url: browser.runtime.getURL("options.html#" + tab) });
});
browser.menus.onShown.addListener(async () => { await browser.menus.update("passport-pause", { checked: paused }); browser.menus.refresh(); });

reload();
