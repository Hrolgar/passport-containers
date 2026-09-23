/* global PassportSync, browser */
// Passport's connected Mozilla account. Login happens on accounts.firefox.com (OAuth with PKCE and scoped keys);
// Passport receives a code on the redirect and the Sync key encrypted to its own key pair. No password is ever seen.
// Everything is kept in storage.local (this machine only).
(function (root) {
  const F = PassportSync;
  const KEY = "account";
  let flow = null; // in-progress authorization: {tabId, verifier, state, privJwk, resolve, reject}

  const load = async () => (await browser.storage.local.get(KEY))[KEY] || null;
  const save = async acc => { await browser.storage.local.set({ [KEY]: acc }); return acc; };

  async function finish(code, f) {
    const tok = await F.exchangeCode(code, f.verifier);
    if (!tok.keys_jwe) throw new Error("Mozilla did not return the Sync key. Try connecting again.");
    const { kid, bundle } = await F.decryptKeysJwe(tok.keys_jwe, f.privJwk);
    const hawk = await F.tokenServer(tok.access_token, kid);
    const bulk = await F.fetchBulkKeys(hawk, bundle);
    const acc = {
      accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + (tok.expires_in || 0) * 1000, kid,
      syncKey: [F.hex(bundle.encKey), F.hex(bundle.hmacKey)],
      hawk: { id: hawk.id, key: new TextDecoder().decode(hawk.key), endpoint: hawk.endpoint, expiresAt: hawk.expiresAt },
      bulk: { default: [F.hex(bulk.default.encKey), F.hex(bulk.default.hmacKey)], collections: Object.fromEntries(Object.entries(bulk.collections).map(([c, b]) => [c, [F.hex(b.encKey), F.hex(b.hmacKey)]])) },
      connectedAt: Date.now(),
    };
    return save(acc);
  }
  // Opens Mozilla's login page in a tab and resolves when the redirect carrying the code shows up.
  function connect() {
    if (flow) { try { browser.tabs.remove(flow.tabId); } catch {} flow.reject(new Error("restarted")); flow = null; }
    return new Promise(async (resolve, reject) => {
      const a = await F.beginAuthorization();
      const tab = await browser.tabs.create({ url: a.url, active: true });
      flow = { tabId: tab.id, verifier: a.verifier, state: a.state, privJwk: a.privJwk, resolve, reject };
      setTimeout(() => { if (flow && flow.tabId === tab.id) { flow.reject(new Error("Login timed out.")); flow = null; } }, 10 * 60 * 1000);
    });
  }
  // The redirect address belongs to a retired Mozilla app and forwards elsewhere, so catch the request itself,
  // take the code, and cancel the navigation before the forward happens.
  function onRedirect(url, tabId) {
    if (!flow || tabId !== flow.tabId) return false;
    const r = F.parseRedirect(url, flow.state); if (!r) return false;
    const f = flow; flow = null;
    setTimeout(() => browser.tabs.remove(tabId).catch(() => {}), 300);
    if (r.error) { f.reject(new Error("Mozilla login failed: " + r.error)); return true; }
    finish(r.code, f).then(acc => f.resolve({ connected: true, connectedAt: acc.connectedAt }), e => f.reject(e));
    return true;
  }
  browser.webRequest.onBeforeRequest.addListener(
    details => (onRedirect(details.url, details.tabId) ? { cancel: true } : {}),
    { urls: [F.REDIRECT_PREFIX + "*"], types: ["main_frame"] }, ["blocking"]);
  browser.tabs.onUpdated.addListener((tabId, info) => { if (info.url) onRedirect(info.url, tabId); });
  browser.tabs.onRemoved.addListener(tabId => { if (flow && flow.tabId === tabId) { const f = flow; flow = null; f.reject(new Error("Login window was closed.")); } });

  async function disconnect() { const acc = await load(); if (acc && acc.refreshToken) await F.destroyToken(acc.refreshToken); await browser.storage.local.remove(KEY); }

  const hawkOf = acc => ({ id: acc.hawk.id, key: new TextEncoder().encode(acc.hawk.key), endpoint: acc.hawk.endpoint });
  function bulkOf(acc) { const b = arr => ({ encKey: F.unhex(arr[0]), hmacKey: F.unhex(arr[1]) }); return { default: b(acc.bulk.default), collections: Object.fromEntries(Object.entries(acc.bulk.collections).map(([c, v]) => [c, b(v)])) }; }
  async function ready() {
    let acc = await load(); if (!acc) throw new Error("No Mozilla account connected. Settings, Mozilla account, Sign in.");
    if (Date.now() > acc.hawk.expiresAt - 60000) {
      if (Date.now() > acc.expiresAt - 60000) { const t = await F.refreshAccessToken(acc.refreshToken); acc = { ...acc, accessToken: t.access_token, refreshToken: t.refresh_token || acc.refreshToken, expiresAt: Date.now() + (t.expires_in || 0) * 1000 }; }
      const hawk = await F.tokenServer(acc.accessToken, acc.kid);
      acc.hawk = { id: hawk.id, key: new TextDecoder().decode(hawk.key), endpoint: hawk.endpoint, expiresAt: hawk.expiresAt };
      await save(acc);
    }
    return acc;
  }
  // Wait until Firefox has uploaded the bookmark (it syncs within seconds of a bookmark change), then set the keyword.
  async function setNativeKeyword(bookmarkId, keyword, opts) {
    const started = Date.now();
    try { const r = await doSetNativeKeyword(bookmarkId, keyword, opts); await browser.storage.local.set({ lastNative: { keyword, bookmarkId, ok: true, at: started, ms: Date.now() - started, ...r } }); return r; }
    catch (e) { await browser.storage.local.set({ lastNative: { keyword, bookmarkId, ok: false, at: started, error: e.message } }); throw e; }
  }
  async function doSetNativeKeyword(bookmarkId, keyword, { attempts = 3, delayMs = 4000 } = {}) {
    const acc = await ready(); const hawk = hawkOf(acc), bulk = bulkOf(acc);
    let rec = null;
    for (let i = 0; i < attempts && !rec; i++) {
      try { rec = await F.getRecord(hawk, bulk, "bookmarks", bookmarkId); }
      catch (e) { if (e.status !== 404) throw e; if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs)); }
    }
    if (rec) {
      if (rec.data.keyword === keyword) return { ok: true, unchanged: true };
      const modified = await F.putRecord(hawk, bulk, "bookmarks", bookmarkId, { ...rec.data, keyword: keyword || null }, rec.modified);
      await nudgeSync(); return { ok: true, modified };
    }
    // Firefox has not uploaded it yet: write the record ourselves, and add it to the parent's child list.
    const [bm] = await browser.bookmarks.get(bookmarkId);
    const parentSyncId = F.guidToSyncId(bm.parentId);
    let parentTitle = ""; let parentRec = null;
    try { parentRec = await F.getRecord(hawk, bulk, "bookmarks", parentSyncId); parentTitle = parentRec.data.title || ""; } catch (e) { if (e.status !== 404) throw e; }
    if (!parentRec) throw new Error("The folder holding this bookmark is not on the server yet. Wait for Firefox to sync once, then try again.");
    const record = { id: bookmarkId, type: "bookmark", title: bm.title || "", bmkUri: bm.url, description: null, loadInSidebar: false, tags: [], keyword: keyword || null, parentid: parentSyncId, parentName: parentTitle, dateAdded: bm.dateAdded || Date.now() };
    const modified = await F.putRecord(hawk, bulk, "bookmarks", bookmarkId, record);
    const children = Array.isArray(parentRec.data.children) ? parentRec.data.children.slice() : [];
    if (!children.includes(bookmarkId)) {
      const siblings = await browser.bookmarks.getChildren(bm.parentId); const idx = Math.max(0, siblings.findIndex(x => x.id === bookmarkId));
      children.splice(Math.min(idx, children.length), 0, bookmarkId);
      await F.putRecord(hawk, bulk, "bookmarks", parentSyncId, { ...parentRec.data, children }, parentRec.modified);
    }
    await nudgeSync();
    return { ok: true, modified, created: true };
  }
  // Firefox syncs immediately once its change score passes a threshold (1000 on a single-device account, each
  // bookmark change counts 301). Four small edits to a helper bookmark get it there, so the keyword lands in seconds.
  async function nudgeSync() {
    const title = "Passport sync";
    let [ping] = (await browser.bookmarks.search({ title })).filter(x => x.url);
    if (!ping) { const [f] = (await browser.bookmarks.search({ title: "Passport" })).filter(x => !x.url); ping = await browser.bookmarks.create({ parentId: f ? f.id : "menu________", title, url: "https://addons.mozilla.org/firefox/addon/passport-containers/" }); }
    for (let i = 0; i < 4; i++) { await browser.bookmarks.update(ping.id, { title: i % 2 ? title : title + "\u200b" }); await new Promise(r => setTimeout(r, 300)); }
  }
  async function status() { const acc = await load(); const { lastNative } = await browser.storage.local.get("lastNative"); return acc ? { connected: true, connectedAt: acc.connectedAt, lastNative } : { connected: false, lastNative }; }

  root.PassportAccount = { connect, disconnect, status, setNativeKeyword, ready, load };
})(globalThis);
