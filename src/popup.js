const $ = s => document.querySelector(s);
const MENU = "menu________";
let tab, state, folders, host = "", path = "";

async function folderList() {
  const [root] = await browser.bookmarks.getTree();
  const out = [];
  (function walk(node, depth) {
    for (const c of node.children || []) {
      if (!c.url) {
        if (c.id !== "root________") out.push({ id: c.id, title: "  ".repeat(depth) + (c.title || c.id), plain: c.title || c.id });
        walk(c, c.id === "root________" ? depth : depth + 1);
      }
    }
  })(root, 0);
  return out;
}
async function passportFolderId() {
  const hit = folders.find(f => f.plain === "Passport");
  if (hit) return hit.id;
  const f = await browser.bookmarks.create({ parentId: MENU, title: "Passport" });
  return f.id;
}
function sameSite(url) { try { return new URL(url).host === host; } catch { return false; } }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function dot(name) {
  const c = (state.containers || []).find(x => x.name.toLowerCase() === String(name || "").toLowerCase());
  if (!c) return el("span", "dot");
  const e = el("span", "ci " + c.color); e.style.setProperty("--m", `url(icons/ci/${c.icon || "fingerprint"}.svg)`); e.style.marginRight = "5px"; return e;
}
function row(tag, parts, onRemove) {
  const r = el("div", "row"); r.append(el("span", "tag", tag));
  const b = el("span", "body"); for (const p of parts) b.append(typeof p === "string" ? document.createTextNode(p) : p); r.append(b);
  if (onRemove) { const x = el("button", "ghost", "\u2715"); x.title = "Remove"; x.onclick = onRemove; r.append(x); }
  return r;
}

async function renderHave() {
  state = await browser.runtime.sendMessage({ type: "get" });
  const box = $("#have"); box.innerHTML = "";
  const m = await browser.runtime.sendMessage({ type: "match", url: tab.url });
  const cur = state.containers.find(c => c.cookieStoreId === tab.cookieStoreId);
  const ti = $("#tabinfo"); ti.innerHTML = ""; ti.append(dot(cur && cur.name), document.createTextNode(cur ? cur.name : "no container"));
  $("#pause").checked = !!state.paused; $("#pausebar").style.background = state.paused ? "rgba(180,83,9,.15)" : "";
  const ro = $("#reopen"); ro.innerHTML = "";
  const targets = [{ name: "Default", cookieStoreId: "firefox-default", color: "" }, ...state.containers];
  for (const t of targets) {
    if (t.cookieStoreId === tab.cookieStoreId) continue;
    const b = el("button", null); b.style.margin = "0 4px 4px 0"; b.style.padding = "2px 8px"; b.append(dot(t.name), document.createTextNode(t.name));
    b.onclick = async () => { await browser.runtime.sendMessage({ type: "reopen", tabId: tab.id, store: t.cookieStoreId }); window.close(); };
    ro.append(b);
  }
  if (m.container) box.append(row("rule", [m.type === "plain" ? "" : m.type + " ", el("span", "k", m.pattern), "  \u2192  ", dot(m.container), m.container],
    async () => { await browser.runtime.sendMessage({ type: "deleteRule", pattern: m.pattern }); renderHave(); }));
  const kws = Object.entries(state.shortcuts || {}).filter(([, v]) => sameSite(v.url));
  for (const [k, v] of kws) box.append(row("keyword", [el("span", "k", k), "  \u2192  ", dot(v.container), v.container || "default", "  ", el("small", null, v.url.replace(/^https?:\/\//, ""))],
    async () => { await browser.runtime.sendMessage({ type: "deleteShortcut", keyword: k }); renderHave(); }));
  const bms = (await browser.bookmarks.search({})).filter(b => b.url && sameSite(b.url));
  for (const b of bms) {
    const f = folders.find(x => x.id === b.parentId);
    const hint = (() => { try { return new URL(b.url).searchParams.get("passport"); } catch { return null; } })();
    box.append(row("bookmark", [b.title, "  ", el("small", null, "in " + (f ? f.plain : b.parentId)), ...(hint ? ["  \u2192  ", dot(hint), hint] : [])],
      async () => { await browser.bookmarks.remove(b.id); renderHave(); }));
  }
  if (!m.container && !kws.length && !bms.length) box.append(el("small", null, "Nothing yet."));
}

(async () => {
  try {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    try { const u = new URL(tab.url); host = u.host; path = u.pathname.replace(/\/$/, ""); } catch {}
    folders = await folderList();
    state = await browser.runtime.sendMessage({ type: "get" });
    const cur = state.containers.find(c => c.cookieStoreId === tab.cookieStoreId);
    const sel = $("#container");
    for (const c of state.containers) { const o = el("option", null, c.name); o.value = c.name; if (cur && cur.name === c.name) o.selected = true; sel.append(o); }
    const o = el("option", null, "New container..."); o.value = "__new"; sel.append(o);
    sel.onchange = () => $("#newname").classList.toggle("hidden", sel.value !== "__new");
    $("#title").value = tab.title || host;
    $("#pattern").value = host + path; $("#patlabel").textContent = host + path;
    $("#editpat").onclick = e => { e.preventDefault(); $("#pattern").classList.remove("hidden"); };
    $("#pattern").oninput = () => { $("#patlabel").textContent = $("#pattern").value; };
    const fsel = $("#folder");
    for (const f of folders) { const op = el("option", null, f.title); op.value = f.id; fsel.append(op); }
    const last = (await browser.storage.local.get("lastFolder")).lastFolder;
    const pf = folders.find(f => f.plain === "Passport");
    fsel.value = last && folders.some(f => f.id === last) ? last : (pf ? pf.id : MENU);
    $("#bm").onchange = () => $("#bmbox").classList.toggle("hidden", !$("#bm").checked);
    await renderHave();
    const acc = await browser.runtime.sendMessage({ type: "accountStatus" });
    state.account = acc;
    $("#kwhint").textContent = acc.connected ? "(becomes a real Firefox keyword on the bookmark, synced everywhere)" : "(Passport keyword: Enter works, no top suggestion. Connect your Mozilla account in settings for real keywords)";
    // Firefox popups on Linux/Wayland show a caret before the popup owns keyboard focus; claim it once it does.
    const grab = () => { window.focus(); $("#keyword").focus(); };
    grab(); setTimeout(grab, 120); setTimeout(grab, 400);
    window.addEventListener("focus", grab, { once: true });
  } catch (e) { $("#err").textContent = "Popup failed to load: " + e.message; }

  $("#add").onclick = async () => {
    $("#msg").textContent = ""; $("#err").textContent = "";
    try {
      const sel = $("#container");
      let name = sel.value;
      if (name === "__new") { name = $("#newname").value.trim(); if (!name) throw new Error("Give the new container a name."); }
      const kw = $("#keyword").value.trim().toLowerCase().split(/\s+/)[0];
      const done = [];
      const native = !!(state.account && state.account.connected);
      let bookmarkId = null;
      if ($("#bm").checked || (kw && native)) {
        const parentId = $("#folder").value || await passportFolderId();
        let url = tab.url;
        if ($("#hint").checked) { const u = new URL(url); u.searchParams.set("passport", name); url = u.toString(); }
        const dupes = (await browser.bookmarks.search({ url })).filter(b => b.parentId === parentId);
        if (dupes.length) { bookmarkId = dupes[0].id; done.push("bookmark was already there"); }
        else { const b = await browser.bookmarks.create({ parentId, title: $("#title").value.trim() || host, url }); bookmarkId = b.id; done.push("bookmark added"); }
        await browser.storage.local.set({ lastFolder: parentId });
      }
      if (kw && native) {
        $("#msg").textContent = "Waiting for Firefox to upload the bookmark, then setting the keyword...";
        const r = await browser.runtime.sendMessage({ type: "setNativeKeyword", bookmarkId, keyword: kw });
        if (r.error) throw new Error(r.error);
        done.push(`Firefox keyword ${kw} set (arrives on next sync, seconds)`);
      } else if (kw) {
        const existed = !!(state.shortcuts || {})[kw];
        await browser.runtime.sendMessage({ type: "addShortcut", keyword: kw, url: tab.url, container: name });
        done.push(`${existed ? "updated" : "added"} keyword ${kw} -> ${name}`);
      }
      if ($("#rule").checked) {
        const pattern = $("#pattern").value.trim();
        if (pattern) { await browser.runtime.sendMessage({ type: "setRule", pattern, container: name }); done.push(`rule ${pattern} -> ${name}`); }
      }
      if (!done.length) throw new Error("Nothing selected: give a keyword, tick bookmark, or tick rule.");
      $("#msg").textContent = done.join(", ") + ". Synced.";
      $("#keyword").value = "";
      await renderHave();
    } catch (e) { $("#err").textContent = e.message; }
  };
  $("#opt").onclick = e => { e.preventDefault(); browser.runtime.openOptionsPage(); };
  $("#pause").onchange = async () => { const r = await browser.runtime.sendMessage({ type: "setPaused", paused: $("#pause").checked }); state.paused = r.paused; $("#pausebar").style.background = r.paused ? "rgba(180,83,9,.15)" : ""; };
  document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.tagName === "INPUT") $("#add").click(); });
})();
