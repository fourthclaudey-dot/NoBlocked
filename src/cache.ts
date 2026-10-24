// Keeps hidden messages out of Discord's on-device message cache.
// Kettu starts plugins in parallel with Discord, so on launch Discord draws the last open chat
// from this cache before any plugin runs. Whatever is not in the cache cannot flash.
// - writes: MobileAppDatabaseManager gets copies of message actions without hidden messages, and
//   replies keep their reference but lose the embedded copy of a hidden author's message;
// - existing entries: hidden messages of loaded chats are deleted from the cache at start and
//   whenever someone gets blocked/ignored.
// Discord itself (MessageStore & co.) still receives everything, so bars work as usual once
// the real data arrives from the server.
import { displayCategory } from "./classify";
import { FluxDispatcher, MessageStore } from "./discord";
import { onHiddenChange } from "./hidden";
import { log } from "./log";

const DB_STORE = "MobileAppDatabaseManager";
const seenChannels = new Set<string>();
const FLUSH_DELAY_MS = 2500;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function storeNodes(AH: any): any[] {
    const nodes = AH?._dependencyGraph?.nodes ?? AH?._nodes;
    if (!nodes) return [];
    return nodes instanceof Map ? [...nodes.values()] : Object.values(nodes);
}

/** Message as it should be cached, or null when it must not be cached at all. */
function cacheable(message: any): any | null {
    if (!message || displayCategory(message)) return null;
    const ref = message.referenced_message;
    if (ref && displayCategory(ref)) return { ...message, referenced_message: null };
    return message;
}

export function startCacheGuard() {
    // Dev-only switch for before/after recordings.
    if (__DEV__ && (vendetta.plugin.storage as any).__devNoCacheGuard) return () => {};
    const node = storeNodes(FluxDispatcher._actionHandlers).find(n => n?.name === DB_STORE);
    const handlers = node?.actionHandler;
    if (!handlers) {
        log.warn(`${DB_STORE} not found, message cache not guarded`);
        return () => {};
    }
    const orig = {
        MESSAGE_CREATE: handlers.MESSAGE_CREATE,
        MESSAGE_UPDATE: handlers.MESSAGE_UPDATE,
        LOAD_MESSAGES_SUCCESS: handlers.LOAD_MESSAGES_SUCCESS,
        MESSAGE_DELETE_BULK: handlers.MESSAGE_DELETE_BULK,
    };

    const deleteCached = (channelId: string, ids: string[]) => {
        if (!ids.length || typeof orig.MESSAGE_DELETE_BULK !== "function") return;
        try {
            orig.MESSAGE_DELETE_BULK.call(node, { type: "MESSAGE_DELETE_BULK", channelId, ids, __kb: true });
        } catch (e) {
            log.warn("cache delete failed", e);
        }
    };

    const wrapSingle = (key: "MESSAGE_CREATE" | "MESSAGE_UPDATE") => {
        const fn = orig[key];
        if (typeof fn !== "function") return;
        handlers[key] = function (this: any, action: any) {
            const msg = action?.message;
            if (action?.channelId) seenChannels.add(action.channelId);
            const keep = cacheable(msg);
            if (msg && !keep) {
                if (key === "MESSAGE_UPDATE" && msg.id && action.channelId) deleteCached(action.channelId, [msg.id]);
                return false;
            }
            return fn.call(this, keep === msg ? action : { ...action, message: keep });
        };
    };
    wrapSingle("MESSAGE_CREATE");
    wrapSingle("MESSAGE_UPDATE");

    if (typeof orig.LOAD_MESSAGES_SUCCESS === "function") {
        handlers.LOAD_MESSAGES_SUCCESS = function (this: any, action: any) {
            const list: any[] = action?.messages;
            if (!action?.channelId || !Array.isArray(list)) return orig.LOAD_MESSAGES_SUCCESS.call(this, action);
            seenChannels.add(action.channelId);
            const dropped: string[] = [];
            const kept: any[] = [];
            for (const m of list) {
                const c = cacheable(m);
                if (c) kept.push(c);
                else if (m?.id) dropped.push(m.id);
            }
            const ret = orig.LOAD_MESSAGES_SUCCESS.call(this, kept.length === list.length && !dropped.length ? action : { ...action, messages: kept });
            deleteCached(action.channelId, dropped);
            return ret;
        };
    }
    FluxDispatcher._actionHandlers._invalidateCaches?.();

    /** Remove hidden messages of every chat loaded this session from the cache. */
    const purge = () => {
        const channels = new Set(seenChannels);
        const selected = vendetta.metro.findByStoreName("SelectedChannelStore")?.getChannelId?.();
        if (selected) channels.add(selected);
        let total = 0;
        for (const channelId of channels) {
            const msgs: any[] = MessageStore().getMessages(channelId)?.toArray?.() ?? [];
            // Only hidden messages themselves: replies keep their cache entry and get their stripped
            // copy written on the next load of the chat.
            const ids = msgs.filter(m => displayCategory(m)).map(m => m.id);
            deleteCached(channelId, ids);
            total += ids.length;
        }
        if (!total) return;
        // The database applies deletes asynchronously and only persists them on a cache flush;
        // flush once they have landed, or a killed app would load them again.
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(() => FluxDispatcher.dispatch({ type: "WRITE_CACHES" }), FLUSH_DELAY_MS);
        log.info(`removed ${total} hidden message(s) from the local cache`);
    };
    const purgeSoon = () => setTimeout(purge, 0);
    // Relationships arrive with CONNECTION_OPEN; purge once they are known, and on every change.
    FluxDispatcher.subscribe("CONNECTION_OPEN", purgeSoon);
    const offHidden = onHiddenChange(purgeSoon);
    purgeSoon();

    return () => {
        for (const [k, fn] of Object.entries(orig)) if (typeof fn === "function") handlers[k] = fn;
        FluxDispatcher._actionHandlers._invalidateCaches?.();
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", purgeSoon);
        offHidden();
    };
}
