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
  browser.tabs.onUpdated.addListener(async (tabId, info) => {
    if (!flow || tabId !== flow.tabId || !info.url) return;
    const r = F.parseRedirect(info.url, flow.state); if (!r) return;
    const f = flow; flow = null;
    browser.tabs.remove(tabId).catch(() => {});
    if (r.error) { f.reject(new Error("Mozilla login failed: " + r.error)); return; }
    try { const acc = await finish(r.code, f); f.resolve({ connected: true, connectedAt: acc.connectedAt }); } catch (e) { f.reject(e); }
  });
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
  async function setNativeKeyword(bookmarkId, keyword, { attempts = 12, delayMs = 5000 } = {}) {
    const acc = await ready(); const hawk = hawkOf(acc), bulk = bulkOf(acc);
    let rec = null;
    for (let i = 0; i < attempts && !rec; i++) {
      try { rec = await F.getRecord(hawk, bulk, "bookmarks", bookmarkId); }
      catch (e) { if (e.status !== 404) throw e; await new Promise(r => setTimeout(r, delayMs)); }
    }
    if (!rec) throw new Error("Firefox has not uploaded that bookmark yet. Try again in a minute.");
    if (rec.data.keyword === keyword) return { ok: true, unchanged: true };
    const modified = await F.putRecord(hawk, bulk, "bookmarks", bookmarkId, { ...rec.data, keyword: keyword || null }, rec.modified);
    await nudgeSync();
    return { ok: true, modified };
  }
  // A tiny local bookmark change makes Firefox sync within seconds, which pulls the keyword down.
  async function nudgeSync() {
    const title = "Passport sync";
    let [ping] = await browser.bookmarks.search({ title });
    if (!ping) { const [f] = (await browser.bookmarks.search({ title: "Passport" })).filter(b => !b.url); ping = await browser.bookmarks.create({ parentId: f ? f.id : "menu________", title, url: "https://addons.mozilla.org/firefox/addon/passport-containers/" }); }
    await browser.bookmarks.update(ping.id, { title: title + "​" });
    await new Promise(r => setTimeout(r, 1500));
    await browser.bookmarks.update(ping.id, { title });
  }
  async function status() { const acc = await load(); return acc ? { connected: true, connectedAt: acc.connectedAt } : { connected: false }; }

  root.PassportAccount = { connect, disconnect, status, setNativeKeyword, ready, load };
})(globalThis);
