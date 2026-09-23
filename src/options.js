/* global PassportMatcher */
const { parseRules, serializeRules, parseShortcuts, serializeShortcuts, containerNames, findProblems, engineRecognised } = PassportMatcher;
const COLORS = ["", "blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple"];
const ICONS = ["", "fingerprint", "briefcase", "dollar", "cart", "circle", "gift", "vacation", "food", "fruit", "pet", "tree", "chill", "fence"];
const MENU = "menu________";
const $ = s => document.querySelector(s);
let state = { rulesText: "", shortcuts: {}, containerMeta: {}, containers: [] };
let folders = [];          // [{id,title,plain}]
let bmOriginal = new Map(); // bookmark id -> {title,url,parentId}

// ---------- small helpers
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function input(val, ph) { const i = el("input"); i.value = val || ""; if (ph) i.placeholder = ph; return i; }
function select(opts, val) { const s = el("select"); for (const o of opts) { const x = el("option", null, o.label ?? (o || "(auto)")); x.value = o.value ?? o; if ((o.value ?? o) === val) x.selected = true; s.append(x); } return s; }
function td(...kids) { const c = el("td"); for (const k of kids) c.append(k); return c; }
function dot(name) { const c = state.containers.find(x => x.name.toLowerCase() === String(name || "").toLowerCase()); return el("span", "dot" + (c ? " " + c.color : "")); }
function hostOf(url) { try { return new URL(url).host; } catch { return url; } }
function hostOfPattern(r) { if (r.type === "plain") return r.pattern.split("/")[0]; const m = r.pattern.replace(/\\\./g, ".").match(/[a-z0-9-]+(\.[a-z0-9-]+)+/i); return m ? m[0].replace(/^\*\./, "") : r.pattern; }
function knownContainers() {
  const names = new Set(state.containers.map(c => c.name));
  for (const n of containerNames(parseRules(state.rulesText))) names.add(n);
  for (const v of Object.values(state.shortcuts)) if (v.container) names.add(v.container);
  return [...names].filter(n => n.toLowerCase() !== "default").sort((a, b) => a.localeCompare(b));
}
function containerInput(val, { allowNone = false } = {}) {
  const wrap = el("span"); wrap.style.display = "flex"; wrap.style.gap = "6px";
  const names = knownContainers(); if (val && !names.some(n => n.toLowerCase() === String(val).toLowerCase()) && !/^(default|none)$/i.test(val)) names.push(val);
  const opts = [...names.map(n => ({ value: n, label: n }))];
  opts.push(allowNone ? { value: "", label: "none (rules decide)" } : { value: "Default", label: "Default (no container)" });
  opts.push({ value: "__new", label: "New container..." });
  const s = select(opts, val || (allowNone ? "" : names[0] || "Default"));
  const i = input("", "New container name"); i.classList.add("hidden");
  s.onchange = () => { i.classList.toggle("hidden", s.value !== "__new"); if (s.value === "__new") i.focus(); };
  wrap.append(s, i); wrap.readValue = () => (s.value === "__new" ? i.value.trim() : s.value); wrap.setValue = v => { s.value = v; };
  return wrap;
}
function removeBtn(tr) { const b = el("button", "ghost", "✕"); b.title = "Remove"; b.onclick = () => tr.remove(); return b; }
function checkbox(tr) { const c = el("input"); c.type = "checkbox"; c.className = "sel"; return c; }
function show(tab) {
  for (const s of document.querySelectorAll("section")) s.classList.toggle("active", s.id === "tab-" + tab);
  for (const a of document.querySelectorAll("nav a")) a.classList.toggle("active", a.dataset.tab === tab);
}
function filterRows(tbody, q) { q = q.trim().toLowerCase(); for (const tr of tbody.children) tr.classList.toggle("hidden", q && !tr.textContent.toLowerCase().includes(q) && ![...tr.querySelectorAll("input,select")].some(i => String(i.value).toLowerCase().includes(q))); }

// ---------- bulk selection shared by rules and keywords
function wireBulk(tbodySel, allSel, barSel, countSel, bulkcSel, applySel, deleteSel) {
  const tbody = $(tbodySel), bar = $(barSel);
  const picker = containerInput(""); $(bulkcSel).innerHTML = ""; $(bulkcSel).append(picker);
  const selected = () => [...tbody.children].filter(tr => tr.querySelector(".sel")?.checked && !tr.classList.contains("hidden"));
  const refresh = () => { const n = selected().length; bar.classList.toggle("hidden", n === 0); $(countSel).textContent = `${n} selected`; };
  tbody.addEventListener("change", e => { if (e.target.classList.contains("sel")) refresh(); });
  $(allSel).onchange = () => { for (const tr of tbody.children) if (!tr.classList.contains("hidden")) tr.querySelector(".sel").checked = $(allSel).checked; refresh(); };
  $(applySel).onclick = () => { const v = picker.readValue(); if (!v) return; for (const tr of selected()) tr.querySelector("td:nth-child(4) > span")?.setValue(v); };
  $(deleteSel).onclick = () => { for (const tr of selected()) tr.remove(); $(allSel).checked = false; refresh(); };
  return refresh;
}

// ---------- rules
function ruleRow(r = { type: "plain", pattern: "", container: "" }) {
  const tr = el("tr");
  tr.append(td(checkbox(tr)), td(input(r.pattern, "host/path")), td(select([{ value: "plain", label: "plain" }, { value: "regex", label: "regex" }, { value: "glob", label: "glob" }], r.type)), td(containerInput(r.container)), td(removeBtn(tr)));
  tr.firstChild.className = "chk"; tr.lastChild.className = "act"; return tr;
}
function readRules() {
  const out = [];
  for (const tr of $("#rules").children) {
    const p = tr.children[1].querySelector("input"), t = tr.children[2].querySelector("select"), c = tr.children[3].firstChild.readValue();
    if (p.value.trim() && c) out.push({ type: t.value, pattern: p.value.trim().replace(/^https?:\/\//, ""), container: c });
  }
  return out;
}
// ---------- keywords
function kwRow(k = "", v = { url: "", container: "" }) {
  const tr = el("tr");
  tr.append(td(checkbox(tr)), td(input(k, "pdb")), td(input(v.url, "https://")), td(containerInput(v.container)), td(removeBtn(tr)));
  tr.firstChild.className = "chk"; tr.lastChild.className = "act"; return tr;
}
function readKeywords() {
  const lines = [];
  for (const tr of $("#keywords").children) {
    const k = tr.children[1].querySelector("input"), u = tr.children[2].querySelector("input"), c = tr.children[3].firstChild.readValue();
    if (k.value.trim() && u.value.trim()) lines.push(`${k.value.trim()} , ${u.value.trim()}${c && c !== "Default" ? " , " + c : ""}`);
  }
  return lines.join("\n");
}
// ---------- bookmarks
async function loadFolders() {
  const [root] = await browser.bookmarks.getTree(); folders = [];
  (function walk(node, depth) { for (const c of node.children || []) { if (!c.url) { if (c.id !== "root________") folders.push({ id: c.id, title: "  ".repeat(depth) + (c.title || c.id), plain: c.title || c.id }); walk(c, c.id === "root________" ? depth : depth + 1); } } })(root, 0);
}
async function managedBookmarks() {
  const all = await browser.bookmarks.search({});
  const pf = folders.find(f => f.plain === "Passport");
  return all.filter(b => b.url && (/[?&]passport=/.test(b.url) || (pf && b.parentId === pf.id)));
}
function bmRow(b) {
  let url = b.url, hint = ""; try { const u = new URL(b.url); hint = u.searchParams.get("passport") || ""; u.searchParams.delete("passport"); url = u.toString(); } catch {}
  const tr = el("tr"); tr.dataset.id = b.id;
  tr.append(td(checkbox(tr)), td(input(b.title, "Title")), td(input(url, "https://")), td(containerInput(hint, { allowNone: true })), td(select(folders.map(f => ({ value: f.id, label: f.title })), b.parentId)));
  const x = el("button", "ghost", "✕"); x.title = "Delete bookmark"; x.onclick = async () => { await browser.bookmarks.remove(b.id); tr.remove(); };
  tr.firstChild.className = "chk"; tr.append(td(x)); tr.lastChild.className = "act"; return tr;
}
async function renderBookmarks() {
  const tb = $("#bookmarks"); tb.innerHTML = ""; bmOriginal = new Map();
  const fs = $("#bfolder"); fs.innerHTML = ""; for (const f of folders) { const o = el("option", null, f.title); o.value = f.id; fs.append(o); }
  for (const b of (await managedBookmarks()).sort((a, c) => hostOf(a.url).localeCompare(hostOf(c.url)) || a.title.localeCompare(c.title))) { bmOriginal.set(b.id, { title: b.title, url: b.url, parentId: b.parentId }); tb.append(bmRow(b)); }
  if (!tb.children.length) { const tr = el("tr"); const c = td(el("span", "muted", "No managed bookmarks yet. The popup creates them, or add ?passport=Name to any bookmark URL.")); c.colSpan = 6; tr.append(c); tb.append(tr); }
}
async function saveBookmarks() {
  let n = 0;
  for (const tr of $("#bookmarks").children) {
    const id = tr.dataset.id; if (!id) continue;
    const title = tr.children[1].querySelector("input").value.trim();
    let url = tr.children[2].querySelector("input").value.trim();
    const hint = tr.children[3].firstChild.readValue();
    const parentId = tr.children[4].querySelector("select").value;
    try { const u = new URL(url); u.searchParams.delete("passport"); if (hint) u.searchParams.set("passport", hint); url = u.toString(); } catch { continue; }
    const o = bmOriginal.get(id);
    if (title !== o.title || url !== o.url) { await browser.bookmarks.update(id, { title, url }); n++; }
    if (parentId !== o.parentId) { await browser.bookmarks.move(id, { parentId }); n++; }
  }
  $("#msg-bm").textContent = n ? `Saved ${n} change${n > 1 ? "s" : ""}.` : "Nothing changed.";
  await renderBookmarks();
}
// ---------- containers
const COLOR_OPTS = COLORS.filter(Boolean), ICON_OPTS = ICONS.filter(Boolean);
function usage(name) {
  const n = String(name).toLowerCase();
  const r = parseRules(state.rulesText).filter(x => x.container.toLowerCase() === n).length;
  const k = Object.values(state.shortcuts).filter(x => (x.container || "").toLowerCase() === n).length;
  return { r, k, text: [r ? `${r} rule${r > 1 ? "s" : ""}` : "", k ? `${k} keyword${k > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ") || "nothing" };
}
function ci(color, icon) { const e = el("span", "ci " + (color || "")); e.style.setProperty("--m", `url(icons/ci/${ICON_OPTS.includes(icon) ? icon : "fingerprint"}.svg)`); return e; }
function swatchPicker(val, onChange) {
  const box = el("div", "swatches"); box.value = val || "blue";
  for (const c of COLOR_OPTS) { const b = el("button", c); b.type = "button"; b.title = c; b.onclick = () => { box.value = c; for (const x of box.children) x.classList.toggle("on", x === b); onChange && onChange(c); }; if (c === box.value) b.classList.add("on"); box.append(b); }
  return box;
}
function iconPicker(val, color, onChange) {
  const box = el("div", "iconpick"); box.value = ICON_OPTS.includes(val) ? val : "fingerprint";
  for (const i of ICON_OPTS) { const b = el("button"); b.type = "button"; b.title = i; b.append(ci(color, i)); b.onclick = () => { box.value = i; for (const x of box.children) x.classList.toggle("on", x === b); onChange && onChange(i); }; if (i === box.value) b.classList.add("on"); box.append(b); }
  box.recolor = c => { for (const x of box.children) x.firstChild.className = "ci " + c; };
  return box;
}
function contRow(c) {
  // c: {name, color, icon, cookieStoreId?}  (cookieStoreId missing = not on this machine yet)
  const tr = el("tr"); tr.dataset.store = c.cookieStoreId || ""; tr.dataset.orig = c.name;
  const color = c.color || "blue", icon = ICON_OPTS.includes(c.icon) ? c.icon : "fingerprint";
  const d = ci(color, icon);
  const name = input(c.name, "Name");
  const is = iconPicker(icon, color, i => { d.style.setProperty("--m", `url(icons/ci/${i}.svg)`); });
  const cs = swatchPicker(color, col => { d.className = "ci " + col; is.recolor(col); });
  const u = usage(c.name);
  const x = el("button", "ghost", "\u2715"); x.title = "Delete container from Firefox (only when nothing uses it)";
  x.onclick = async () => {
    if (u.r || u.k) { $("#err-cont").textContent = `${c.name} is still used by ${u.text}. Change those first.`; return; }
    if (c.cookieStoreId) await browser.contextualIdentities.remove(c.cookieStoreId);
    delete state.containerMeta[c.name]; tr.remove();
  };
  tr.append(td(d), td(name), td(cs), td(is), td(el("span", u.r || u.k ? null : "muted", u.text)), td(el("span", c.cookieStoreId ? null : "muted", c.cookieStoreId ? "yes" : "will be created on save")), td(x));
  tr.firstChild.className = "dotcell"; tr.lastChild.className = "act"; return tr;
}
function renderContainers() {
  const tb = $("#containers"); tb.innerHTML = "";
  const rows = state.containers.map(c => ({ ...c }));
  for (const n of knownContainers()) if (!rows.some(c => c.name.toLowerCase() === n.toLowerCase())) rows.push({ name: n, color: (state.containerMeta[n] || {}).color, icon: (state.containerMeta[n] || {}).icon });
  for (const c of rows.sort((a, b) => a.name.localeCompare(b.name))) tb.append(contRow(c));
}
function renameEverywhere(oldName, newName) {
  const o = oldName.toLowerCase();
  state.rulesText = serializeRules(parseRules(state.rulesText).map(r => r.container.toLowerCase() === o ? { ...r, container: newName } : r));
  for (const v of Object.values(state.shortcuts)) if ((v.container || "").toLowerCase() === o) v.container = newName;
  if (state.containerMeta[oldName]) { state.containerMeta[newName] = state.containerMeta[oldName]; delete state.containerMeta[oldName]; }
}
async function saveContainers() {
  $("#msg-cont").textContent = ""; $("#err-cont").textContent = "";
  const renames = [];
  try {
    for (const tr of $("#containers").children) {
      const name = tr.children[1].querySelector("input").value.trim();
      const color = tr.children[2].firstChild.value, icon = tr.children[3].firstChild.value;
      if (!name) continue;
      state.containerMeta[name] = { color, icon };
      if (tr.dataset.store) {
        const cur = state.containers.find(c => c.cookieStoreId === tr.dataset.store);
        if (cur && (cur.name !== name || cur.color !== color || cur.icon !== icon)) await browser.contextualIdentities.update(tr.dataset.store, { name, color, icon });
        if (cur && cur.name !== name) renames.push([cur.name, name]);
      } else {
        await browser.contextualIdentities.create({ name, color, icon });
      }
    }
    for (const [a, b] of renames) {
      renameEverywhere(a, b);
      // bookmark hints carry the name too
      for (const bm of await managedBookmarks()) { try { const u = new URL(bm.url); if ((u.searchParams.get("passport") || "").toLowerCase() === a.toLowerCase()) { u.searchParams.set("passport", b); await browser.bookmarks.update(bm.id, { url: u.toString() }); } } catch {} }
    }
    await browser.runtime.sendMessage({ type: "save", rulesText: state.rulesText, containerMeta: state.containerMeta });
    if (renames.length) await browser.runtime.sendMessage({ type: "saveShortcuts", text: serializeShortcuts(state.shortcuts) });
    $("#msg-cont").textContent = renames.length ? `Saved. Renamed ${renames.map(([a, b]) => a + " to " + b).join(", ")} everywhere.` : "Saved and applied to Firefox.";
  } catch (e) { $("#err-cont").textContent = "Firefox refused: " + e.message; }
  await load();
}
// ---------- sites overview
let siteEntries = [];  // {host, kind, container, text}
async function collectSites() {
  siteEntries = [];
  for (const r of parseRules(state.rulesText)) siteEntries.push({ host: hostOfPattern(r), kind: "rule", container: r.container, text: `${r.type === "plain" ? "" : r.type + " "}${r.pattern}` });
  for (const [k, v] of Object.entries(state.shortcuts)) siteEntries.push({ host: hostOf(v.url), kind: "keyword", container: v.container || "default", text: k, extra: v.url });
  try { for (const b of await managedBookmarks()) { let h = ""; try { h = new URL(b.url).searchParams.get("passport") || ""; } catch {} siteEntries.push({ host: hostOf(b.url), kind: "bookmark", container: h || "default", text: b.title }); } } catch {}
}
function renderSites() {
  const box = $("#sites"); box.innerHTML = "";
  const q = $("#sfilter").value.trim().toLowerCase(), by = $("#sgroup").value, sort = $("#ssort").value;
  const rows = siteEntries.filter(e => !q || [e.host, e.text, e.container, e.extra || ""].some(x => x.toLowerCase().includes(q)));
  if (!rows.length) { box.append(el("p", "muted", siteEntries.length ? "Nothing matches the filter." : "Nothing yet. Add keywords and rules from the toolbar popup on any site.")); return; }
  const groups = new Map();
  for (const e of rows) { const g = by === "site" ? e.host : e.container; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(e); }
  const keys = [...groups.keys()].sort((a, b) => sort === "count" ? groups.get(b).length - groups.get(a).length || a.localeCompare(b) : a.localeCompare(b));
  for (const g of keys) {
    const wrap = el("div", "group"), h = el("h2");
    if (by === "container") h.append(dot(g));
    h.append(document.createTextNode(g), el("span", "n", `${groups.get(g).length}`));
    h.onclick = () => wrap.classList.toggle("collapsed");
    const card = el("div", "card");
    for (const e of groups.get(g).sort((a, b) => a.kind.localeCompare(b.kind) || a.text.localeCompare(b.text))) {
      const r = el("div", "row"); r.append(el("span", "tag", e.kind));
      const b = el("span", "body");
      if (by === "container") b.append(el("small", null, e.host + "  "));
      b.append(el("span", e.kind === "keyword" ? "k" : null, e.text), document.createTextNode("  →  "), dot(e.container), document.createTextNode(e.container));
      if (e.extra) b.append(el("small", null, "   " + e.extra));
      r.append(b); card.append(r);
    }
    wrap.append(h, card); box.append(wrap);
  }
}
// ---------- problems
let engineName = null;
function renderProblems() {
  const box = $("#problems"); box.innerHTML = "";
  const probs = findProblems({ rules: parseRules(state.rulesText), shortcuts: state.shortcuts, containers: state.containers, engine: engineName === null ? null : engineRecognised(engineName) });
  box.classList.toggle("hidden", !probs.length);
  if (!probs.length) return;
  const wrap = el("div", "group"); const h = el("h2"); h.append(document.createTextNode("Problems"), el("span", "n", String(probs.length))); h.onclick = () => wrap.classList.toggle("collapsed");
  const card = el("div", "card");
  for (const p of probs) { const r = el("div", "row"); r.append(el("span", "tag", p.level), el("span", "body", p.text)); r.lastChild.style.whiteSpace = "normal"; if (p.level === "error") r.lastChild.style.color = "var(--danger)"; card.append(r); }
  wrap.append(h, card); box.append(wrap);
}
// ---------- backup / restore
function download(name, text) { const a = el("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
async function restore(mode) {
  $("#msg-io").textContent = ""; $("#err-io").textContent = "";
  const f = $("#importfile").files[0]; if (!f) { $("#err-io").textContent = "Pick a backup file first."; return; }
  try {
    const d = JSON.parse(await f.text());
    if (!d || d.app !== "passport-containers") throw new Error("Not a Passport backup.");
    const r = await browser.runtime.sendMessage({ type: "restore", mode, rulesText: d.rulesText || "", shortcuts: d.shortcuts || {}, containerMeta: d.containerMeta || {} });
    $("#msg-io").textContent = `Restored: ${r.rules} rules, ${r.keywords} keywords. Synced.`; await load();
  } catch (e) { $("#err-io").textContent = e.message; }
}
// ---------- Mozilla account
async function renderAccount() {
  const st = await browser.runtime.sendMessage({ type: "accountStatus" });
  $("#acc-connected").style.display = st.connected ? "" : "none"; $("#acc-form").style.display = st.connected ? "none" : "";
  if (st.connected) { $("#acc-email").textContent = st.email; $("#acc-since").textContent = "since " + new Date(st.connectedAt).toLocaleString(); }
}
let accKind = null;
$("#acc-connect").onclick = async () => {
  $("#acc-msg").textContent = ""; $("#acc-err").textContent = "";
  const b = $("#acc-connect"); b.disabled = true;
  try {
    let r;
    if (accKind) r = await browser.runtime.sendMessage({ type: "accountVerify", code: $("#acc-code").value.trim(), kind: accKind });
    else r = await browser.runtime.sendMessage({ type: "accountConnect", email: $("#acc-mail").value.trim(), password: $("#acc-pass").value });
    if (r.error) { $("#acc-err").textContent = r.error; return; }
    if (r.needs) {
      accKind = r.needs === "totp" ? "totp" : "email";
      $("#acc-codebox").classList.remove("hidden"); $("#acc-code").focus();
      $("#acc-codelabel").textContent = r.needs === "totp" ? "Code from your authenticator app" : r.needs === "email-link" ? "Mozilla sent you an email. Confirm it there, then enter the code if you got one, or press Connect again." : "Code from the email Mozilla just sent";
      b.textContent = "Verify"; return;
    }
    if (r.connected) { $("#acc-pass").value = ""; $("#acc-code").value = ""; accKind = null; b.textContent = "Connect"; $("#acc-codebox").classList.add("hidden"); $("#acc-msg").textContent = "Connected."; await renderAccount(); }
  } finally { b.disabled = false; }
};
$("#acc-disconnect").onclick = async () => { await browser.runtime.sendMessage({ type: "accountDisconnect" }); await renderAccount(); };
// ---------- load / save
function renderAll() {
  const rb = $("#rules"); rb.innerHTML = ""; const rs = parseRules(state.rulesText); for (const r of rs) rb.append(ruleRow(r));
  $("#rules-empty").classList.toggle("hidden", rs.length > 0);
  const kb = $("#keywords"); kb.innerHTML = ""; for (const [k, v] of Object.entries(state.shortcuts).sort()) kb.append(kwRow(k, v));
  $("#rawrules").value = state.rulesText; $("#rawkw").value = serializeShortcuts(state.shortcuts);
  renderContainers(); renderSites(); renderBookmarks(); renderProblems(); renderAccount();
  filterRows($("#rules"), $("#rfilter").value); filterRows($("#keywords"), $("#kfilter").value);
}
async function load() {
  state = await browser.runtime.sendMessage({ type: "get" });
  state.containerMeta = state.containerMeta || {}; state.shortcuts = state.shortcuts || {};
  try { engineName = (await browser.runtime.sendMessage({ type: "engine" })).name; } catch { engineName = null; }
  await loadFolders(); await collectSites(); renderAll();
  const st = await browser.storage.sync.get("updatedAt");
  $("#synced").textContent = st.updatedAt ? "Last saved " + new Date(st.updatedAt).toLocaleString() : "";
}
async function saveRules(text, msgSel) {
  const r = await browser.runtime.sendMessage({ type: "save", rulesText: text, containerMeta: state.containerMeta });
  $(msgSel).textContent = r.ok ? `Saved ${r.count} rules. Synced.` : "Save failed"; await load();
}
async function saveKeywords(text, msgSel) {
  const r = await browser.runtime.sendMessage({ type: "saveShortcuts", text });
  $(msgSel).textContent = r.ok ? `Saved ${r.count} keywords. Synced.` : "Save failed"; await load();
}
// ---------- wiring
$("#addrule").onclick = () => { $("#rules").append(ruleRow()); $("#rules").lastChild.children[1].querySelector("input").focus(); };
$("#saverules").onclick = () => saveRules(serializeRules(readRules()), "#msg-rules");
$("#addkw").onclick = () => { $("#keywords").append(kwRow()); $("#keywords").lastChild.children[1].querySelector("input").focus(); };
$("#savekw").onclick = () => saveKeywords(readKeywords(), "#msg-kw");
$("#savebm").onclick = saveBookmarks;
$("#export").onclick = () => download(`passport-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: "passport-containers", version: 1, exported: new Date().toISOString(), rulesText: state.rulesText, shortcuts: state.shortcuts, containerMeta: state.containerMeta }, null, 2));
$("#importmerge").onclick = () => restore("merge"); $("#importreplace").onclick = () => restore("replace");
$("#savecont").onclick = saveContainers;
const newColor = swatchPicker("blue", c => newIcon.recolor(c)), newIcon = iconPicker("fingerprint", "blue");
$("#newcolor").append(newColor); $("#newicon").append(newIcon);
$("#addcont").onclick = async () => {
  const name = $("#newcont").value.trim(); $("#err-cont").textContent = "";
  if (!name) { $("#err-cont").textContent = "Give the container a name."; return; }
  if (state.containers.some(c => c.name.toLowerCase() === name.toLowerCase())) { $("#err-cont").textContent = `${name} already exists.`; return; }
  try {
    await browser.contextualIdentities.create({ name, color: newColor.value, icon: newIcon.value });
    state.containerMeta[name] = { color: newColor.value, icon: newIcon.value };
    await browser.runtime.sendMessage({ type: "save", rulesText: state.rulesText, containerMeta: state.containerMeta });
    $("#newcont").value = ""; $("#msg-cont").textContent = `Created ${name}.`; await load();
  } catch (e) { $("#err-cont").textContent = "Firefox refused: " + e.message; }
};
$("#saveraw").onclick = async () => { await saveRules($("#rawrules").value, "#msg-raw"); await saveKeywords($("#rawkw").value, "#msg-raw"); $("#msg-raw").textContent = "Saved. Synced."; };
$("#rfilter").oninput = () => filterRows($("#rules"), $("#rfilter").value);
$("#kfilter").oninput = () => filterRows($("#keywords"), $("#kfilter").value);
$("#bfilter").oninput = () => filterRows($("#bookmarks"), $("#bfilter").value);
for (const id of ["sfilter", "sgroup", "ssort"]) $("#" + id).addEventListener("input", renderSites);
$("#scollapse").onclick = () => { for (const g of document.querySelectorAll("#sites .group")) g.classList.add("collapsed"); };
$("#sexpand").onclick = () => { for (const g of document.querySelectorAll("#sites .group")) g.classList.remove("collapsed"); };
wireBulk("#rules", "#rall", "#rbulk", "#rcount", "#rbulkc", "#rapply", "#rdelete");
wireBulk("#keywords", "#kall", "#kbulk", "#kcount", "#kbulkc", "#kapply", "#kdelete");
const bmRefresh = wireBulk("#bookmarks", "#ball", "#bbulk", "#bcount", "#bbulkc", "#bapply", "#bdelete");
$("#bdelete").onclick = async () => {
  const rows = [...$("#bookmarks").children].filter(tr => tr.querySelector(".sel")?.checked && !tr.classList.contains("hidden"));
  for (const tr of rows) { if (tr.dataset.id) await browser.bookmarks.remove(tr.dataset.id); tr.remove(); }
  $("#ball").checked = false; bmRefresh();
};
$("#bmove").onclick = () => {
  const to = $("#bfolder").value;
  for (const tr of $("#bookmarks").children) if (tr.querySelector(".sel")?.checked && !tr.classList.contains("hidden")) tr.children[4].querySelector("select").value = to;
};
for (const a of document.querySelectorAll("nav a")) a.onclick = e => { e.preventDefault(); location.hash = a.dataset.tab; show(a.dataset.tab); };
window.addEventListener("hashchange", () => show(location.hash.slice(1) || "sites"));
show(location.hash.slice(1) || "sites");
load();
