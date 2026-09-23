// Mozilla accounts + Firefox Sync client for Passport. Runs in the extension (WebCrypto) and in node 22.
// Protocol as used by Firefox itself and by third-party clients: onepw login, Hawk-signed token requests,
// scoped key for Sync, token server, Sync 1.5 storage with the crypto/keys key bundle.
(function (root) {
  const AUTH = "https://api.accounts.firefox.com/v1";
  const TOKENSERVER = "https://token.services.mozilla.com/1.0/sync/1.5";
  const CLIENT_ID = "e7ce535d93522896";
  const SCOPE = "https://identity.mozilla.com/apps/oldsync";
  const NS = "identity.mozilla.com/picl/v1/";
  const subtle = (root.crypto || require("crypto").webcrypto).subtle;
  const cryptoObj = root.crypto || require("crypto").webcrypto;

  // ---------- bytes
  const te = new TextEncoder(), td = new TextDecoder();
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
  const unhex = s => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16)));
  const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64url = b => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const cat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
  const xor = (a, b) => a.map((x, i) => x ^ b[i]);
  const rand = n => cryptoObj.getRandomValues(new Uint8Array(n));

  // ---------- primitives
  async function sha256(data) { return new Uint8Array(await subtle.digest("SHA-256", data)); }
  async function hmac(key, data) { const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await subtle.sign("HMAC", k, data)); }
  async function pbkdf2(password, salt, iterations, len) { const k = await subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]); return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: te.encode(salt), iterations }, k, len * 8)); }
  async function hkdf(ikm, info, len, salt = new Uint8Array(0)) { const k = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]); return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te.encode(info) }, k, len * 8)); }
  const derive = (secret, ns, len) => hkdf(secret, NS + ns, len);
  async function aesCbcEncrypt(key, iv, data) { const k = await subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]); return new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv }, k, data)); }
  async function aesCbcDecrypt(key, iv, data) { const k = await subtle.importKey("raw", key, "AES-CBC", false, ["decrypt"]); return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, k, data)); }

  // ---------- onepw
  const quickStretch = (email, password) => pbkdf2(password, NS + "quickStretch:" + email, 1000, 32);
  const authPW = stretched => derive(stretched, "authPW", 32);
  const unwrapBKey = stretched => derive(stretched, "unwrapBkey", 32);

  // ---------- Hawk
  async function hawkHeader({ id, key, method, url, body, contentType = "application/json" }) {
    const u = new URL(url);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    let hash = "";
    if (method !== "GET" && body) hash = b64(await sha256(te.encode(`hawk.1.payload\n${contentType}\n${body}\n`)));
    const ts = Math.floor(Date.now() / 1000).toString(), nonce = b64(rand(5));
    const norm = ["hawk.1.header", ts, nonce, method, u.pathname + u.search, u.hostname.toLowerCase(), port, hash, "", ""].join("\n");
    const mac = b64(await hmac(key, te.encode(norm)));
    return `Hawk id="${id}", mac="${mac}", ts="${ts}", nonce="${nonce}"` + (hash ? `, hash="${hash}"` : "");
  }
  async function tokenHawk(token, tokenType, method, url, body) {
    const km = await derive(token, tokenType, 96);
    return { header: await hawkHeader({ id: hex(km.slice(0, 32)), key: km.slice(32, 64), method, url, body }), bundleKey: km.slice(64, 96) };
  }

  // ---------- HTTP
  class FxAError extends Error { constructor(status, body) { super(`FxA ${status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`); this.status = status; this.body = body; this.errno = body && body.errno; } }
  async function http(method, url, { body, headers = {}, credentials } = {}) {
    const init = { method, headers: { Accept: "application/json", ...headers } };
    if (body !== undefined) { init.body = typeof body === "string" ? body : JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
    if (credentials) init.credentials = credentials;
    const r = await fetch(url, init);
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!r.ok) throw new FxAError(r.status, json);
    return { json, headers: r.headers };
  }
  async function authRequest(method, path, body, token, tokenType) {
    const url = AUTH + path; const raw = body === undefined ? undefined : JSON.stringify(body);
    const { header, bundleKey } = await tokenHawk(token, tokenType, method, url, raw || "");
    const r = await http(method, url, { body: raw, headers: { Authorization: header } });
    return { json: r.json, bundleKey };
  }

  // ---------- account login -> session, keys, oauth, tokenserver, crypto/keys
  async function login(email, password, { credentials } = {}) {
    let stretched = await quickStretch(email, password);
    const attempt = async (e, s) => http("POST", AUTH + "/account/login?keys=true", { body: { email: e, authPW: hex(await authPW(s)), reason: "login" }, credentials });
    let r;
    try { r = await attempt(email, stretched); }
    catch (e) {
      if (e.status === 400 && e.errno === 120 && e.body && e.body.email) { stretched = await quickStretch(e.body.email, password); r = await attempt(e.body.email, stretched); }
      else throw e;
    }
    const j = r.json;
    return { uid: j.uid, email, sessionToken: unhex(j.sessionToken), keyFetchToken: unhex(j.keyFetchToken), stretched, verified: !!j.verified, verificationMethod: j.verificationMethod || null };
  }
  const verifyTotp = (session, code) => authRequest("POST", "/session/verify/totp", { code, service: "login" }, session.sessionToken, "sessionToken").then(r => r.json);
  const verifyEmailCode = (session, code) => authRequest("POST", "/session/verify_code", { code, service: "login" }, session.sessionToken, "sessionToken").then(r => r.json);
  const resendCode = session => authRequest("POST", "/session/resend_code", {}, session.sessionToken, "sessionToken").then(r => r.json);

  async function fetchKeys(session) {
    const { json, bundleKey } = await authRequest("GET", "/account/keys", undefined, session.keyFetchToken, "keyFetchToken");
    const bundle = unhex(json.bundle), ct = bundle.slice(0, bundle.length - 32), mac = bundle.slice(bundle.length - 32);
    const km = await derive(bundleKey, "account/keys", 32 + ct.length);
    const expect = await hmac(km.slice(0, 32), ct);
    if (hex(expect) !== hex(mac)) throw new Error("account/keys HMAC mismatch");
    const keys = xor(ct, km.slice(32));
    const kB = xor(keys.slice(32, 64), await unwrapBKey(session.stretched));
    return { kA: keys.slice(0, 32), kB };
  }
  async function oauthToken(session, refreshToken) {
    const body = refreshToken ? { grant_type: "fxa-credentials", refresh_token: refreshToken, client_id: CLIENT_ID, scope: SCOPE } : { grant_type: "fxa-credentials", access_type: "offline", client_id: CLIENT_ID, scope: SCOPE };
    const t = (await authRequest("POST", "/oauth/token", body, session.sessionToken, "sessionToken")).json;
    const skd = (await authRequest("POST", "/account/scoped-key-data", { client_id: CLIENT_ID, scope: SCOPE }, session.sessionToken, "sessionToken")).json[SCOPE];
    return { accessToken: t.access_token, refreshToken: t.refresh_token || refreshToken, expiresAt: Date.now() + (t.expires_in || 0) * 1000, keyRotationTimestamp: skd.keyRotationTimestamp };
  }
  async function keyId(kB, keyRotationTimestamp) { return `${keyRotationTimestamp}-${b64url((await sha256(kB)).slice(0, 16))}`; }
  async function tokenServer(accessToken, kid) {
    const { json } = await http("GET", TOKENSERVER, { headers: { Authorization: "Bearer " + accessToken, "X-KeyID": kid } });
    if (json.hashalg !== "sha256") throw new Error("unsupported hashalg " + json.hashalg);
    return { id: json.id, key: te.encode(json.key), endpoint: json.api_endpoint, expiresAt: Date.now() + json.duration * 1000 };
  }

  // ---------- OAuth authorization-code flow with scoped keys (login happens on accounts.firefox.com)
  const OAUTH = "https://oauth.accounts.firefox.com/v1";
  const AUTHORIZE = "https://accounts.firefox.com/authorization";
  const REDIRECT_PREFIX = "https://lockbox.firefox.com/fxa/android-redirect.html";
  async function beginAuthorization() {
    const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const pubJwk = await subtle.exportKey("jwk", kp.publicKey); const privJwk = await subtle.exportKey("jwk", kp.privateKey);
    const verifier = b64url(rand(32)); const challenge = b64url(await sha256(te.encode(verifier))); const state = b64url(rand(16));
    const keysJwk = b64url(te.encode(JSON.stringify({ kty: "EC", crv: "P-256", x: pubJwk.x, y: pubJwk.y })));
    const q = new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE, state, code_challenge_method: "S256", code_challenge: challenge, access_type: "offline", keys_jwk: keysJwk });
    return { url: `${AUTHORIZE}?${q}`, verifier, state, privJwk };
  }
  function parseRedirect(url, state) {
    if (!url.startsWith(REDIRECT_PREFIX)) return null;
    const u = new URL(url); const code = u.searchParams.get("code"), st = u.searchParams.get("state");
    if (!code) return { error: u.searchParams.get("error") || "no code in redirect" };
    if (st !== state) return { error: "state mismatch" };
    return { code };
  }
  async function exchangeCode(code, verifier) {
    const { json } = await http("POST", OAUTH + "/token", { body: { client_id: CLIENT_ID, grant_type: "authorization_code", code, code_verifier: verifier } });
    return json; // access_token, refresh_token, expires_in, keys_jwe, scope
  }
  async function refreshAccessToken(refreshToken) {
    const { json } = await http("POST", OAUTH + "/token", { body: { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken, scope: SCOPE } });
    return json;
  }
  async function destroyToken(refreshToken) { try { await http("POST", OAUTH + "/destroy", { body: { refresh_token: refreshToken } }); } catch {} }
  // keys_jwe: ECDH-ES (P-256) + Concat KDF (SHA-256) + A256GCM, per RFC 7518, AAD = protected header
  async function decryptKeysJwe(jwe, privJwk) {
    const [h, , ivB, ctB, tagB] = jwe.split(".");
    const header = JSON.parse(td.decode(unb64url(h)));
    if (header.alg !== "ECDH-ES" || header.enc !== "A256GCM") throw new Error("unexpected JWE " + header.alg + "/" + header.enc);
    const priv = await subtle.importKey("jwk", { ...privJwk, key_ops: ["deriveBits"] }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const epk = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: header.epk.x, y: header.epk.y }, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const z = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: epk }, priv, 256));
    const u32 = n => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    const enc = te.encode(header.enc);
    const otherInfo = cat(u32(enc.length), enc, u32(0), u32(0), u32(256));
    const key = await sha256(cat(u32(1), z, otherInfo));
    const k = await subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const ct = cat(unb64url(ctB), unb64url(tagB));
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64url(ivB), additionalData: te.encode(h), tagLength: 128 }, k, ct);
    const keys = JSON.parse(td.decode(plain));
    const sk = keys[SCOPE]; if (!sk) throw new Error("no sync key in keys_jwe");
    const raw = unb64url(sk.k);
    return { kid: sk.kid, bundle: { encKey: raw.slice(0, 32), hmacKey: raw.slice(32, 64) } };
  }
  const unb64url = s => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4));

  // ---------- storage
  async function storage(hawk, method, path, body, extraHeaders = {}) {
    const url = hawk.endpoint + path; const raw = body === undefined ? undefined : JSON.stringify(body);
    const header = await hawkHeader({ id: hawk.id, key: hawk.key, method, url, body: raw || "" });
    return http(method, url, { body: raw, headers: { Authorization: header, ...extraHeaders } });
  }
  async function decryptPayload(payloadStr, bundle) {
    const p = JSON.parse(payloadStr);
    const expect = hex(await hmac(bundle.hmacKey, te.encode(p.ciphertext)));
    if (expect !== p.hmac) throw new Error("record HMAC mismatch");
    return td.decode(await aesCbcDecrypt(bundle.encKey, unb64(p.IV), unb64(p.ciphertext)));
  }
  async function encryptPayload(plaintext, bundle) {
    const iv = rand(16); const ciphertext = b64(await aesCbcEncrypt(bundle.encKey, iv, te.encode(plaintext)));
    return JSON.stringify({ ciphertext, IV: b64(iv), hmac: hex(await hmac(bundle.hmacKey, te.encode(ciphertext))) });
  }
  async function syncKeyBundle(kB) { const km = await hkdf(kB, NS + "oldsync", 64); return { encKey: km.slice(0, 32), hmacKey: km.slice(32, 64) }; }
  async function fetchBulkKeys(hawk, kBOrBundle) {
    const { json } = await storage(hawk, "GET", "/storage/crypto/keys");
    const syncBundle = kBOrBundle.encKey ? kBOrBundle : await syncKeyBundle(kBOrBundle);
    const keys = JSON.parse(await decryptPayload(json.payload, syncBundle));
    const toBundle = arr => ({ encKey: unb64(arr[0]), hmacKey: unb64(arr[1]) });
    const out = { default: toBundle(keys.default), collections: {} };
    for (const [c, v] of Object.entries(keys.collections || {})) out.collections[c] = toBundle(v);
    return out;
  }
  const bundleFor = (bulk, collection) => bulk.collections[collection] || bulk.default;
  async function getRecord(hawk, bulk, collection, id) {
    const { json } = await storage(hawk, "GET", `/storage/${collection}/${encodeURIComponent(id)}`);
    return { id: json.id, modified: json.modified, data: JSON.parse(await decryptPayload(json.payload, bundleFor(bulk, collection))) };
  }
  async function putRecord(hawk, bulk, collection, id, data, ifUnmodifiedSince) {
    const payload = await encryptPayload(JSON.stringify(data), bundleFor(bulk, collection));
    const headers = ifUnmodifiedSince ? { "X-If-Unmodified-Since": String(ifUnmodifiedSince) } : {};
    const { json } = await storage(hawk, "PUT", `/storage/${collection}/${encodeURIComponent(id)}`, { id, payload }, headers);
    return json; // new modified timestamp
  }
  async function listIds(hawk, collection, params = "") { const { json } = await storage(hawk, "GET", `/storage/${collection}${params}`); return json; }

  // Places guid <-> Sync record id for the roots
  const ROOT_TO_SYNC = { root________: "places", menu________: "menu", toolbar_____: "toolbar", unfiled_____: "unfiled", mobile______: "mobile" };
  const guidToSyncId = g => ROOT_TO_SYNC[g] || g;

  const api = { AUTH, TOKENSERVER, OAUTH, CLIENT_ID, SCOPE, REDIRECT_PREFIX, beginAuthorization, parseRedirect, exchangeCode, refreshAccessToken, destroyToken, decryptKeysJwe, unb64url, hex, unhex, b64, unb64, b64url, quickStretch, authPW, unwrapBKey, hawkHeader, tokenHawk, login, verifyTotp, verifyEmailCode, resendCode, fetchKeys, oauthToken, keyId, tokenServer, storage, fetchBulkKeys, getRecord, putRecord, listIds, decryptPayload, encryptPayload, syncKeyBundle, guidToSyncId, FxAError };
  if (typeof module !== "undefined") module.exports = api; else root.PassportSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
