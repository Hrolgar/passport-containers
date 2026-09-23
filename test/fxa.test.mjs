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
