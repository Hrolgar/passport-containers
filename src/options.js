/* global PassportMatcher */
const { parseRules, serializeRules, parseShortcuts, serializeShortcuts, containerNames } = PassportMatcher;
const COLORS = ["", "blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple"];
const ICONS = ["", "fingerprint", "briefcase", "dollar", "cart", "circle", "gift", "vacation", "food", "fruit", "pet", "tree", "chill", "fence"];
const $ = s => document.querySelector(s);
let state = { rulesText: "", shortcuts: {}, containerMeta: {}, containers: [] };

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function input(val, ph) { const i = el("input"); i.value = val || ""; if (ph) i.placeholder = ph; return i; }
function select(opts, val) { const s = el("select"); for (const o of opts) { const x = el("option", null, o.label ?? (o || "(auto)")); x.value = o.value ?? o; if ((o.value ?? o) === val) x.selected = true; s.append(x); } return s; }
function containerInput(val) { const i = input(val, "Container"); i.setAttribute("list", "containerlist"); return i; }
function td(...kids) { const c = el("td"); for (const k of kids) c.append(k); return c; }
function removeBtn(tr) { const b = el("button", "ghost", "✕"); b.title = "Remove"; b.onclick = () => tr.remove(); return b; }
function show(tab) {
  for (const s of document.querySelectorAll("section")) s.classList.toggle("active", s.id === "tab-" + tab);
  for (const a of document.querySelectorAll("nav a")) a.classList.toggle("active", a.dataset.tab === tab);
}
function knownContainers() {
  const names = new Set(state.containers.map(c => c.name));
  for (const n of containerNames(parseRules(state.rulesText))) names.add(n);
  for (const v of Object.values(state.shortcuts)) if (v.container) names.add(v.container);
  return [...names].filter(n => n.toLowerCase() !== "default").sort((a, b) => a.localeCompare(b));
}
function refreshDatalist() { const d = $("#containerlist"); d.innerHTML = ""; for (const n of [...knownContainers(), "Default"]) { const o = el("option"); o.value = n; d.append(o); } }

function ruleRow(r = { type: "plain", pattern: "", container: "" }) {
  const tr = el("tr");
  tr.append(td(input(r.pattern, "host/path")), td(select([{ value: "plain", label: "plain" }, { value: "regex", label: "regex" }, { value: "glob", label: "glob" }], r.type)), td(containerInput(r.container)), td(removeBtn(tr)));
  tr.lastChild.className = "act"; return tr;
}
function readRules() {
  const out = [];
  for (const tr of $("#rules").children) {
    const [p, t, c] = [...tr.querySelectorAll("input,select")];
    if (p.value.trim() && c.value.trim()) out.push({ type: t.value, pattern: p.value.trim().replace(/^https?:\/\//, ""), container: c.value.trim() });
  }
  return out;
}
function kwRow(k = "", v = { url: "", container: "" }) {
  const tr = el("tr");
  tr.append(td(input(k, "pdb")), td(input(v.url, "https://")), td(containerInput(v.container)), td(removeBtn(tr)));
  tr.lastChild.className = "act"; return tr;
}
function readKeywords() {
  const lines = [];
  for (const tr of $("#keywords").children) {
    const [k, u, c] = [...tr.querySelectorAll("input")];
    if (k.value.trim() && u.value.trim()) lines.push(`${k.value.trim()} , ${u.value.trim()}${c.value.trim() ? " , " + c.value.trim() : ""}`);
  }
  return lines.join("\n");
}
function renderContainers() {
  const tb = $("#containers"); tb.innerHTML = "";
  for (const n of knownContainers()) {
    const here = state.containers.find(c => c.name === n);
    const m = state.containerMeta[n] || {};
    const tr = el("tr");
    const d = el("span", "dot " + (m.color || (here && here.color) || ""));
    const cs = select(COLORS, m.color || ""), is = select(ICONS, m.icon || "");
    cs.onchange = () => { state.containerMeta[n] = { ...state.containerMeta[n], color: cs.value }; d.className = "dot " + (cs.value || (here && here.color) || ""); };
    is.onchange = () => { state.containerMeta[n] = { ...state.containerMeta[n], icon: is.value }; };
    tr.append(td(d), td(el("span", null, n)), td(cs), td(is), td(el("span", here ? null : "muted", here ? "yes" : "will be created on save")));
    tr.firstChild.className = "dotcell"; tb.append(tr);
  }
}
function renderAll() {
  const rb = $("#rules"); rb.innerHTML = ""; for (const r of parseRules(state.rulesText)) rb.append(ruleRow(r));
  const kb = $("#keywords"); kb.innerHTML = ""; for (const [k, v] of Object.entries(state.shortcuts).sort()) kb.append(kwRow(k, v));
  $("#rawrules").value = state.rulesText; $("#rawkw").value = serializeShortcuts(state.shortcuts);
  renderContainers(); refreshDatalist();
}
async function load() {
  state = await browser.runtime.sendMessage({ type: "get" });
  state.containerMeta = state.containerMeta || {}; state.shortcuts = state.shortcuts || {};
  renderAll();
  const st = await browser.storage.sync.get("updatedAt");
  $("#synced").textContent = st.updatedAt ? "Last saved " + new Date(st.updatedAt).toLocaleString() : "";
}
async function saveRules(text, msgSel) {
  const r = await browser.runtime.sendMessage({ type: "save", rulesText: text, containerMeta: state.containerMeta });
  $(msgSel).textContent = r.ok ? `Saved ${r.count} rules. Synced.` : "Save failed";
  await load();
}
async function saveKeywords(text, msgSel) {
  const r = await browser.runtime.sendMessage({ type: "saveShortcuts", text });
  $(msgSel).textContent = r.ok ? `Saved ${r.count} keywords. Synced.` : "Save failed";
  await load();
}
$("#addrule").onclick = () => { $("#rules").append(ruleRow()); $("#rules").lastChild.querySelector("input").focus(); };
$("#saverules").onclick = () => saveRules(serializeRules(readRules()), "#msg-rules");
$("#addkw").onclick = () => { $("#keywords").append(kwRow()); $("#keywords").lastChild.querySelector("input").focus(); };
$("#savekw").onclick = () => saveKeywords(readKeywords(), "#msg-kw");
$("#savecont").onclick = () => saveRules(state.rulesText, "#msg-cont");
$("#saveraw").onclick = async () => { await saveRules($("#rawrules").value, "#msg-raw"); await saveKeywords($("#rawkw").value, "#msg-raw"); $("#msg-raw").textContent = "Saved. Synced."; };
for (const a of document.querySelectorAll("nav a")) a.onclick = e => { e.preventDefault(); location.hash = a.dataset.tab; show(a.dataset.tab); };
window.addEventListener("hashchange", () => show(location.hash.slice(1) || "rules"));
show(location.hash.slice(1) || "rules");
load();
