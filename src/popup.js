const $ = s => document.querySelector(s);
const MENU = "menu________";
async function folderList() {
  const [root] = await browser.bookmarks.getTree();
  const out = [];
  (function walk(node, depth) {
    for (const c of node.children || []) {
      if (c.type === "folder" || (!c.url && c.children)) {
        if (c.id !== "root________") out.push({ id: c.id, title: "  ".repeat(depth) + (c.title || c.id) });
        walk(c, c.id === "root________" ? depth : depth + 1);
      }
    }
  })(root, 0);
  return out;
}
async function passportFolderId(folders) {
  const hit = folders.find(f => f.title.trim() === "Passport");
  if (hit) return hit.id;
  const f = await browser.bookmarks.create({ parentId: MENU, title: "Passport" });
  return f.id;
}
(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const s = await browser.runtime.sendMessage({ type: "get" });
  let host = "", path = "";
  try { const u = new URL(tab.url); host = u.host; path = u.pathname.replace(/\/$/, ""); } catch {}
  $("#pattern").value = host + path;
  $("#title").value = tab.title || host;
  const m = await browser.runtime.sendMessage({ type: "match", url: tab.url });
  const cur = s.containers.find(c => c.cookieStoreId === tab.cookieStoreId);
  $("#cur").textContent = `This tab: ${cur ? cur.name : "no container"}` + (m.container ? ` (rule says ${m.container})` : " (no rule)");
  const sel = $("#container");
  for (const c of s.containers) { const o = document.createElement("option"); o.value = c.name; o.textContent = c.name; if (cur && cur.name === c.name) o.selected = true; sel.append(o); }
  const o = document.createElement("option"); o.value = "__new"; o.textContent = "New container..."; sel.append(o);
  sel.onchange = () => $("#newname").classList.toggle("hidden", sel.value !== "__new");
  const folders = await folderList();
  const fsel = $("#folder");
  for (const f of folders) { const op = document.createElement("option"); op.value = f.id; op.textContent = f.title; fsel.append(op); }
  const last = (await browser.storage.local.get("lastFolder")).lastFolder;
  const pf = folders.find(f => f.title.trim() === "Passport");
  fsel.value = last && folders.some(f => f.id === last) ? last : (pf ? pf.id : MENU);
  $("#bm").onchange = () => { for (const id of ["title", "folder", "keyword"]) $("#" + id).disabled = !$("#bm").checked; };
  $("#add").onclick = async () => {
    let name = sel.value;
    if (name === "__new") { name = $("#newname").value.trim(); if (!name) { $("#msg").textContent = "Give the new container a name."; return; } }
    const pattern = $("#pattern").value.trim();
    const done = [];
    if (pattern) { await browser.runtime.sendMessage({ type: "addRule", line: `${pattern} , ${name}` }); done.push(`rule ${pattern} -> ${name}`); }
    if ($("#bm").checked) {
      let parentId = fsel.value || await passportFolderId(folders);
      await browser.bookmarks.create({ parentId, title: $("#title").value.trim() || host, url: tab.url });
      await browser.storage.local.set({ lastFolder: parentId });
      done.push("bookmark");
      const kw = $("#keyword").value.trim().toLowerCase().split(/\s+/)[0];
      if (kw) { await browser.runtime.sendMessage({ type: "addShortcut", keyword: kw, url: tab.url, container: name }); done.push(`keyword "go ${kw}"`); }
    }
    $("#msg").textContent = done.length ? "Added " + done.join(", ") + ". Synced." : "Nothing to add.";
  };
  $("#opt").onclick = e => { e.preventDefault(); browser.runtime.openOptionsPage(); };
})();
