// scan all initialized metro modules for export keys / function names matching a regex
const re = new RegExp(globalThis.__scanRe || "blocked|ignored", "i");
const mods = vendetta.metro.modules;
const hits = [];
const ids = mods instanceof Map ? [...mods.keys()] : Object.keys(mods);
for (const id of ids) {
  const m = mods instanceof Map ? mods.get(id) : mods[id];
  const ex = m?.publicModule?.exports;
  if (!ex || !m.isInitialized) continue;
  const keys = [];
  try {
    for (const k of Object.keys(ex)) {
      if (re.test(k)) keys.push(k);
      const v = ex[k];
      if (typeof v === "function" && re.test(v.name || "")) keys.push(k + "=>" + v.name);
    }
    if (typeof ex === "function" && re.test(ex.name)) keys.push("<self>" + ex.name);
    if (ex.default && typeof ex.default === "function" && re.test(ex.default.name)) keys.push("default=>" + ex.default.name);
  } catch (e) {}
  if (keys.length) hits.push(id + ": " + keys.slice(0, 12).join(", "));
}
return { total: ids.length, hits };
