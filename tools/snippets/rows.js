// Dump the rows the native chat list receives (after NoBlocked's processing).
const mod = findByName("createChannelStream", false);
// re-register every time so this hook runs after the plugin's (spitroast runs afters in order)
if (globalThis.__kbCap) globalThis.__kbCap.un();
globalThis.__kbCap = { last: null };
globalThis.__kbCap.un = vendetta.patcher.after("default", mod, (args, ret) => { globalThis.__kbCap.last = ret; });
const ch = findByStoreName("SelectedChannelStore").getChannelId();
const prev = findByStoreName("MessageStore").getMessages(ch).revealedMessageId;
F.dispatch({ type: "MESSAGE_REVEAL", channelId: ch, messageId: "kb-x" + Date.now(), __kb: true });
F.dispatch({ type: "MESSAGE_REVEAL", channelId: ch, messageId: prev, __kb: true });
await new Promise(r => setTimeout(r, 300));
const rows = globalThis.__kbCap.last || [];
return rows.map((r, i) => {
  const t = r.rowType;
  if (t === 1) return `${i} MSG ${r.message.author.username}: ${(r.message.content || "").slice(0, 30)}`;
  if (t === 2 || t === 6) return `${i} BAR(${t}) "${r.text}" revealed=${r.revealed} content=${(r.content || []).length} ctx=${r.context}`;
  return `${i} ${t} ${r.text || ""}`;
});
