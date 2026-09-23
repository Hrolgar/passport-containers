import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const F = createRequire(import.meta.url)("../src/sync/fxa.js");

// Mozilla accounts onepw protocol test vectors (from the FxA auth-server docs)
test("onepw derivations match Mozilla's published vectors", async () => {
  const email = "andré@example.org", password = "pässwörd";
  const s = await F.quickStretch(email, password);
  assert.equal(F.hex(s), "e4e8889bd8bd61ad6de6b95c059d56e7b50dacdaf62bd84644af7e2add84345d");
  assert.equal(F.hex(await F.authPW(s)), "247b675ffb4c46310bc87e26d712153abe5e1c90ef00a4784594f97ef54f2375");
  assert.equal(F.hex(await F.unwrapBKey(s)), "de6a2648b78284fcb9ffa81ba95803309cfba7af583c01a8a1a63e567234dd28");
});
test("payload encrypt/decrypt round-trips and detects tampering", async () => {
  const bundle = { encKey: F.unhex("00".repeat(32)), hmacKey: F.unhex("11".repeat(32)) };
  const enc = await F.encryptPayload(JSON.stringify({ id: "abc", keyword: "kfiken" }), bundle);
  assert.deepEqual(JSON.parse(await F.decryptPayload(enc, bundle)), { id: "abc", keyword: "kfiken" });
  const bad = JSON.parse(enc); bad.hmac = "00" + bad.hmac.slice(2);
  await assert.rejects(F.decryptPayload(JSON.stringify(bad), bundle), /HMAC/);
});
test("hawk header has the required fields and a payload hash only when there is a body", async () => {
  const key = F.unhex("22".repeat(32));
  const g = await F.hawkHeader({ id: "abc", key, method: "GET", url: "https://example.com/storage/x?y=1", body: "" });
  assert.match(g, /^Hawk id="abc", mac="[A-Za-z0-9+/=]+", ts="\d+", nonce="[A-Za-z0-9+/=]+"$/);
  const p = await F.hawkHeader({ id: "abc", key, method: "PUT", url: "https://example.com/storage/x", body: "{}" });
  assert.match(p, /, hash="[A-Za-z0-9+/=]+"$/);
});
test("root guid mapping", () => {
  assert.equal(F.guidToSyncId("toolbar_____"), "toolbar"); assert.equal(F.guidToSyncId("abcdefghijkl"), "abcdefghijkl");
});

test("OAuth: authorization URL carries PKCE, state and our public key; redirect parsing checks state", async () => {
  const a = await F.beginAuthorization();
  const u = new URL(a.url);
  assert.equal(u.origin + u.pathname, "https://accounts.firefox.com/authorization");
  assert.equal(u.searchParams.get("client_id"), F.CLIENT_ID); assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("access_type"), "offline"); assert.equal(u.searchParams.get("scope"), F.SCOPE);
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  const jwk = JSON.parse(new TextDecoder().decode(F.unb64url(u.searchParams.get("keys_jwk"))));
  assert.equal(jwk.crv, "P-256"); assert.ok(jwk.x && jwk.y);
  assert.deepEqual(F.parseRedirect(`${F.REDIRECT_PREFIX}?code=abc&state=${a.state}`, a.state), { code: "abc" });
  assert.deepEqual(F.parseRedirect(`${F.REDIRECT_PREFIX}?code=abc&state=nope`, a.state), { error: "state mismatch" });
  assert.equal(F.parseRedirect("https://accounts.firefox.com/signin", a.state), null);
});
test("keys_jwe decrypts an ECDH-ES A256GCM envelope built the way Mozilla builds it", async () => {
  const { webcrypto } = await import("node:crypto"); const subtle = webcrypto.subtle; const te = new TextEncoder();
  const a = await F.beginAuthorization();
  // server side: ephemeral key, ECDH with our public key, Concat KDF, AES-GCM with the header as AAD
  const ours = JSON.parse(new TextDecoder().decode(F.unb64url(new URL(a.url).searchParams.get("keys_jwk"))));
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ephPub = await subtle.exportKey("jwk", eph.publicKey);
  const ourPub = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: ours.x, y: ours.y }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const z = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: ourPub }, eph.privateKey, 256));
  const u32 = n => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const enc = te.encode("A256GCM"); const cat = (...x) => { const o = new Uint8Array(x.reduce((n, b) => n + b.length, 0)); let p = 0; for (const b of x) { o.set(b, p); p += b.length; } return o; };
  const key = new Uint8Array(await subtle.digest("SHA-256", cat(u32(1), z, u32(enc.length), enc, u32(0), u32(0), u32(256))));
  const header = { alg: "ECDH-ES", enc: "A256GCM", epk: { kty: "EC", crv: "P-256", x: ephPub.x, y: ephPub.y } };
  const h = F.b64url(te.encode(JSON.stringify(header)));
  const kraw = webcrypto.getRandomValues(new Uint8Array(64)); const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const plain = te.encode(JSON.stringify({ [F.SCOPE]: { kty: "oct", scope: F.SCOPE, k: F.b64url(kraw), kid: "1700000000000-abc" } }));
  const k = await subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(h), tagLength: 128 }, k, plain));
  const jwe = [h, "", F.b64url(iv), F.b64url(ct.slice(0, ct.length - 16)), F.b64url(ct.slice(ct.length - 16))].join(".");
  const out = await F.decryptKeysJwe(jwe, a.privJwk);
  assert.equal(out.kid, "1700000000000-abc");
  assert.equal(F.hex(out.bundle.encKey), F.hex(kraw.slice(0, 32))); assert.equal(F.hex(out.bundle.hmacKey), F.hex(kraw.slice(32, 64)));
});
