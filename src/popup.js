const $ = s => document.querySelector(s);
(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const s = await browser.runtime.sendMessage({ type: "get" });
  let host = "", path = "";
  try { const u = new URL(tab.url); host = u.host; path = u.pathname.replace(/\/$/, ""); } catch {}
  $("#pattern").value = host + path;
  const m = await browser.runtime.sendMessage({ type: "match", url: tab.url });
  const cur = s.containers.find(c => c.cookieStoreId === tab.cookieStoreId);
  $("#cur").textContent = `This tab: ${cur ? cur.name : "no container"}` + (m.container ? ` (rule says ${m.container})` : " (no rule)");
  const sel = $("#container");
  for (const c of s.containers) { const o = document.createElement("option"); o.value = c.name; o.textContent = c.name; if (cur && cur.name === c.name) o.selected = true; sel.append(o); }
  const o = document.createElement("option"); o.value = "__new"; o.textContent = "New container..."; sel.append(o);
  $("#add").onclick = async () => {
    let name = sel.value;
    if (name === "__new") { name = prompt("Container name"); if (!name) return; }
    await browser.runtime.sendMessage({ type: "addRule", line: `${$("#pattern").value} , ${name}` });
    $("#msg").textContent = `Added: ${$("#pattern").value} -> ${name}. Synced.`;
  };
  $("#opt").onclick = e => { e.preventDefault(); browser.runtime.openOptionsPage(); };
})();
