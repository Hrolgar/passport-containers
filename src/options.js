/* global PassportMatcher */
const COLORS = ["", "blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple"];
const ICONS = ["", "fingerprint", "briefcase", "dollar", "cart", "circle", "gift", "vacation", "food", "fruit", "pet", "tree", "chill", "fence"];
const $ = s => document.querySelector(s);
let meta = {};
function sel(opts, val) { const s = document.createElement("select"); for (const o of opts) { const x = document.createElement("option"); x.value = o; x.textContent = o || "(auto)"; if (o === val) x.selected = true; s.append(x); } return s; }
function renderContainers(existing) {
  const names = PassportMatcher.containerNames(PassportMatcher.parseRules($("#rules").value));
  const tb = $("#containers tbody"); tb.innerHTML = "";
  for (const n of names) {
    if (n.toLowerCase() === "default") continue;
    const m = meta[n] || {}; const tr = document.createElement("tr");
    const c = sel(COLORS, m.color || ""), i = sel(ICONS, m.icon || "");
    c.onchange = () => { meta[n] = { ...meta[n], color: c.value }; }; i.onchange = () => { meta[n] = { ...meta[n], icon: i.value }; };
    const cell = t => { const td = document.createElement("td"); td.append(t); return td; };
    tr.append(cell(n), cell(c), cell(i), cell(existing.some(e => e.name === n) ? "yes" : "will be created on save"));
    tb.append(tr);
  }
}
async function init() {
  const s = await browser.runtime.sendMessage({ type: "get" });
  $("#rules").value = s.rulesText; meta = s.containerMeta || {};
  renderContainers(s.containers);
  const st = await browser.storage.sync.get("updatedAt");
  if (st.updatedAt) $("#meta").textContent = "Last saved " + new Date(st.updatedAt).toLocaleString();
  $("#rules").addEventListener("input", () => renderContainers(s.containers));
}
$("#save").onclick = async () => {
  const r = await browser.runtime.sendMessage({ type: "save", rulesText: $("#rules").value, containerMeta: meta });
  $("#status").textContent = r.ok ? `Saved ${r.count} rules, synced to your Firefox account.` : "Save failed";
  const s = await browser.runtime.sendMessage({ type: "get" }); renderContainers(s.containers);
};
init();
