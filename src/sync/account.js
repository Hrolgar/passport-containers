/* global PassportSync, browser */
// Passport's connected Mozilla account: login state, token refresh, and "set native keyword" through Sync.
// Secrets live in storage.local only (never synced). Password is never stored.
(function (root) {
  const F = PassportSync;
  const KEY = "account";
  let pending = null; // login session awaiting a verification code

  async function load() { return (await browser.storage.local.get(KEY))[KEY] || null; }
  async function save(acc) { await browser.storage.local.set({ [KEY]: acc }); return acc; }
  async function clear() { await browser.storage.local.remove(KEY); }

  // Firefox carries its own cookie for firefox.com, which gets past the login endpoint's anti-bot gate.
  async function loginWithGate(email, password) {
    try { return await F.login(email, password, { credentials: "include" }); }
    catch (e) {
      if (e.status !== 406) throw e;
      const tab = await browser.tabs.create({ url: "https://accounts.firefox.com/", active: false });
      await new Promise(r => setTimeout(r, 6000));
      browser.tabs.remove(tab.id).catch(() => {});
      return F.login(email, password, { credentials: "include" });
    }
  }
  async function finishLogin(session) {
    const { kB } = await F.fetchKeys(session);
    const tok = await F.oauthToken(session);
    const kid = await F.keyId(kB, tok.keyRotationTimestamp);
    const hawk = await F.tokenServer(tok.accessToken, kid);
    const bulk = await F.fetchBulkKeys(hawk, kB);
    const acc = {
      email: session.email, uid: session.uid, sessionToken: F.hex(session.sessionToken), kB: F.hex(kB),
      refreshToken: tok.refreshToken, accessToken: tok.accessToken, expiresAt: tok.expiresAt, keyRotationTimestamp: tok.keyRotationTimestamp,
      hawk: { id: hawk.id, key: new TextDecoder().decode(hawk.key), endpoint: hawk.endpoint, expiresAt: hawk.expiresAt },
      bulk: { default: [F.hex(bulk.default.encKey), F.hex(bulk.default.hmacKey)], collections: Object.fromEntries(Object.entries(bulk.collections).map(([c, b]) => [c, [F.hex(b.encKey), F.hex(b.hmacKey)]])) },
      connectedAt: Date.now(),
    };
    pending = null;
    return save(acc);
  }
  // Step 1: email + password. Returns {connected:true} or {needs:"totp"|"email"} when a code is required.
  async function connect(email, password) {
    const session = await loginWithGate(email, password);
    if (!session.verified) {
      pending = session;
      const m = session.verificationMethod || "";
      if (m === "totp-2fa") return { needs: "totp" };
      if (m === "email-2fa" || m === "email-otp") return { needs: "email" };
      if (m === "email") return { needs: "email-link" };
      return { needs: "email" };
    }
    await finishLogin(session); return { connected: true };
  }
  // Step 2: the code from the authenticator app or from the email
  async function verify(code, kind) {
    if (!pending) throw new Error("No login in progress. Start again with email and password.");
    if (kind === "totp") { const r = await F.verifyTotp(pending, code); if (!r || r.success === false) throw new Error("Code not accepted."); }
    else await F.verifyEmailCode(pending, code);
    await finishLogin(pending); return { connected: true };
  }
  async function disconnect() { clear(); pending = null; }

  function hawkOf(acc) { return { id: acc.hawk.id, key: new TextEncoder().encode(acc.hawk.key), endpoint: acc.hawk.endpoint }; }
  function bulkOf(acc) {
    const b = arr => ({ encKey: F.unhex(arr[0]), hmacKey: F.unhex(arr[1]) });
    return { default: b(acc.bulk.default), collections: Object.fromEntries(Object.entries(acc.bulk.collections).map(([c, v]) => [c, b(v)])) };
  }
  // Refresh the OAuth token and token-server credentials when they run out.
  async function ready() {
    let acc = await load(); if (!acc) throw new Error("No Mozilla account connected.");
    if (Date.now() > acc.hawk.expiresAt - 60000) {
      const session = { sessionToken: F.unhex(acc.sessionToken) };
      if (Date.now() > acc.expiresAt - 60000) { const tok = await F.oauthToken(session, acc.refreshToken); acc = { ...acc, accessToken: tok.accessToken, refreshToken: tok.refreshToken, expiresAt: tok.expiresAt, keyRotationTimestamp: tok.keyRotationTimestamp }; }
      const kid = await F.keyId(F.unhex(acc.kB), acc.keyRotationTimestamp);
      const hawk = await F.tokenServer(acc.accessToken, kid);
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
    if (!ping) { const [f] = await browser.bookmarks.search({ title: "Passport" }); ping = await browser.bookmarks.create({ parentId: f && !f.url ? f.id : "menu________", title, url: "https://addons.mozilla.org/firefox/addon/passport-containers/" }); }
    await browser.bookmarks.update(ping.id, { title: title + "​" });
    await new Promise(r => setTimeout(r, 1500));
    await browser.bookmarks.update(ping.id, { title });
  }
  async function status() { const acc = await load(); return acc ? { connected: true, email: acc.email, connectedAt: acc.connectedAt } : { connected: false }; }

  root.PassportAccount = { connect, verify, disconnect, status, setNativeKeyword, ready, load };
})(globalThis);
