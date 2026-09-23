/* global PassportMatcher */
const { parseRules, serializeRules, parseShortcuts, serializeShortcuts, containerNames } = PassportMatcher;
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
  tr.append(td(input(b.title, "Title")), td(input(url, "https://")), td(containerInput(hint, { allowNone: true })), td(select(folders.map(f => ({ value: f.id, label: f.title })), b.parentId)));
  const x = el("button", "ghost", "✕"); x.title = "Delete bookmark"; x.onclick = async () => { await browser.bookmarks.remove(b.id); tr.remove(); };
  tr.append(td(x)); tr.lastChild.className = "act"; return tr;
}
async function renderBookmarks() {
  const tb = $("#bookmarks"); tb.innerHTML = ""; bmOriginal = new Map();
  for (const b of (await managedBookmarks()).sort((a, c) => hostOf(a.url).localeCompare(hostOf(c.url)) || a.title.localeCompare(c.title))) { bmOriginal.set(b.id, { title: b.title, url: b.url, parentId: b.parentId }); tb.append(bmRow(b)); }
  if (!tb.children.length) tb.append(el("tr")).append(td(el("span", "muted", "No managed bookmarks yet. The popup creates them, or add ?passport=Name to any bookmark URL.")));
}
async function saveBookmarks() {
  let n = 0;
  for (const tr of $("#bookmarks").children) {
    const id = tr.dataset.id; if (!id) continue;
    const title = tr.children[0].querySelector("input").value.trim();
    let url = tr.children[1].querySelector("input").value.trim();
    const hint = tr.children[2].firstChild.readValue();
    const parentId = tr.children[3].querySelector("select").value;
    try { const u = new URL(url); u.searchParams.delete("passport"); if (hint) u.searchParams.set("passport", hint); url = u.toString(); } catch { continue; }
    const o = bmOriginal.get(id);
    if (title !== o.title || url !== o.url) { await browser.bookmarks.update(id, { title, url }); n++; }
    if (parentId !== o.parentId) { await browser.bookmarks.move(id, { parentId }); n++; }
  }
  $("#msg-bm").textContent = n ? `Saved ${n} change${n > 1 ? "s" : ""}.` : "Nothing changed.";
  await renderBookmarks();
}
// ---------- containers
function renderContainers() {
  const tb = $("#containers"); tb.innerHTML = "";
  for (const n of knownContainers()) {
    const here = state.containers.find(c => c.name === n), m = state.containerMeta[n] || {};
    const tr = el("tr"), d = el("span", "dot " + (m.color || (here && here.color) || ""));
    const cs = select(COLORS, m.color || ""), is = select(ICONS, m.icon || "");
    cs.onchange = () => { state.containerMeta[n] = { ...state.containerMeta[n], color: cs.value }; d.className = "dot " + (cs.value || (here && here.color) || ""); };
    is.onchange = () => { state.containerMeta[n] = { ...state.containerMeta[n], icon: is.value }; };
    tr.append(td(d), td(el("span", null, n)), td(cs), td(is), td(el("span", here ? null : "muted", here ? "yes" : "will be created on save")));
    tr.firstChild.className = "dotcell"; tb.append(tr);
  }
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
// ---------- load / save
function renderAll() {
  const rb = $("#rules"); rb.innerHTML = ""; const rs = parseRules(state.rulesText); for (const r of rs) rb.append(ruleRow(r));
  $("#rules-empty").classList.toggle("hidden", rs.length > 0);
  const kb = $("#keywords"); kb.innerHTML = ""; for (const [k, v] of Object.entries(state.shortcuts).sort()) kb.append(kwRow(k, v));
  $("#rawrules").value = state.rulesText; $("#rawkw").value = serializeShortcuts(state.shortcuts);
  renderContainers(); renderSites(); renderBookmarks();
  filterRows($("#rules"), $("#rfilter").value); filterRows($("#keywords"), $("#kfilter").value);
}
async function load() {
  state = await browser.runtime.sendMessage({ type: "get" });
  state.containerMeta = state.containerMeta || {}; state.shortcuts = state.shortcuts || {};
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
$("#savecont").onclick = () => saveRules(state.rulesText, "#msg-cont");
$("#saveraw").onclick = async () => { await saveRules($("#rawrules").value, "#msg-raw"); await saveKeywords($("#rawkw").value, "#msg-raw"); $("#msg-raw").textContent = "Saved. Synced."; };
$("#rfilter").oninput = () => filterRows($("#rules"), $("#rfilter").value);
$("#kfilter").oninput = () => filterRows($("#keywords"), $("#kfilter").value);
$("#bfilter").oninput = () => filterRows($("#bookmarks"), $("#bfilter").value);
for (const id of ["sfilter", "sgroup", "ssort"]) $("#" + id).addEventListener("input", renderSites);
$("#scollapse").onclick = () => { for (const g of document.querySelectorAll("#sites .group")) g.classList.add("collapsed"); };
$("#sexpand").onclick = () => { for (const g of document.querySelectorAll("#sites .group")) g.classList.remove("collapsed"); };
wireBulk("#rules", "#rall", "#rbulk", "#rcount", "#rbulkc", "#rapply", "#rdelete");
wireBulk("#keywords", "#kall", "#kbulk", "#kcount", "#kbulkc", "#kapply", "#kdelete");
for (const a of document.querySelectorAll("nav a")) a.onclick = e => { e.preventDefault(); location.hash = a.dataset.tab; show(a.dataset.tab); };
window.addEventListener("hashchange", () => show(location.hash.slice(1) || "sites"));
show(location.hash.slice(1) || "sites");
load();
