#!/usr/bin/env node
// Dev harness: exercise the Sync storage half of src/sync/fxa.js with an existing ffsclient session file.
//   node tools/sync-harness.mjs get <bookmark-guid>
//   node tools/sync-harness.mjs set-keyword <bookmark-guid> <keyword>
//   node tools/sync-harness.mjs clear-keyword <bookmark-guid>
// Reads ~/.config/firefox-sync-client.secret (hex keys, hawk creds). Never prints keys.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const F = createRequire(import.meta.url)("../src/sync/fxa.js");
const [cmd, guid, kw] = process.argv.slice(2);
if (!cmd || !guid) { console.error("usage: get|set-keyword|clear-keyword <guid> [keyword]"); process.exit(2); }
const s = JSON.parse(readFileSync(process.env.FFS_SECRET || `${homedir()}/.config/firefox-sync-client.secret`, "utf8"));
if (s.timeout && s.timeout / 1000 < Date.now()) console.error("warning: ffsclient session token may be expired; run `ffsclient refresh` if requests fail");
const hawk = { id: s.hawk.id, key: new TextEncoder().encode(s.hawk.key), endpoint: s.hawk.apiEndpoint };
const bulk = { default: { encKey: F.unhex(s.hawk.bulkKeys[""][0]), hmacKey: F.unhex(s.hawk.bulkKeys[""][1]) }, collections: {} };
for (const [c, v] of Object.entries(s.hawk.bulkKeys)) if (c) bulk.collections[c] = { encKey: F.unhex(v[0]), hmacKey: F.unhex(v[1]) };
const rec = await F.getRecord(hawk, bulk, "bookmarks", guid);
console.log("record", rec.id, "modified", rec.modified, JSON.stringify({ type: rec.data.type, title: rec.data.title, bmkUri: rec.data.bmkUri, keyword: rec.data.keyword, parentid: rec.data.parentid, parentName: rec.data.parentName }));
if (cmd === "set-keyword" || cmd === "clear-keyword") {
  const data = { ...rec.data, keyword: cmd === "set-keyword" ? kw : null };
  if (cmd === "set-keyword" && !kw) { console.error("keyword required"); process.exit(2); }
  const modified = await F.putRecord(hawk, bulk, "bookmarks", guid, data, rec.modified);
  console.log("written, new modified", modified);
  const back = await F.getRecord(hawk, bulk, "bookmarks", guid);
  console.log("readback keyword:", JSON.stringify(back.data.keyword));
}
