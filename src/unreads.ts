// Keeps hidden messages from making chats look new.
// 1. Live: the stores that compute unread dots, mention badges, DM bumps, previews and in-app
//    notifications simply never see a silenced MESSAGE_CREATE (the message itself still reaches
//    MessageStore, so bars keep working).
// 2. Server: if the chat was fully read, we ack the silenced message so other devices and the
//    next app start agree.
// 3. Startup: Discord's own unread state comes from the server; channels that only got hidden
//    messages while we were away are checked (one request each) and acked.
// 4. Passive guild updates carry no author: held back until one request shows who wrote.
import { log } from "./log";
import { silentForUnread } from "./classify";
import { AckActions, ChannelStore, FluxDispatcher, HTTP, MessageStore, ReadStateStore, SelectedChannelStore, UserGuildSettingsStore } from "./discord";
import { onHiddenChange } from "./hidden";
import { storage } from "./settings";

const SILENCED_STORES = [
    "ReadStateStore",
    "GuildReadStateStore",
    "ChannelListStore",
    "PrivateChannelReadStateStore",
    "PrivateChannelSortStore",
    "InAppNotificationStore",
    "NotificationCenterStore",
    "RecentMentionsStore",
    "MessagePreviewStore",
    "ForumPostUnreadCountStore",
    "ForumPostRecentMessageStore",
    "ActiveJoinedThreadsStore",
    "UnreadSettingNoticeStore2",
    "MessageRequestPreviewStore",
    "ActiveChannelsStore",
];

function shouldSilence(action: any) {
    return !!action?.message && !action.optimistic && silentForUnread(action.message);
}

/** Store nodes of the dispatcher: a plain object in Discord 300.x, a Map since 350.x. */
function storeNodes(AH: any): any[] | null {
    const nodes = AH?._dependencyGraph?.nodes ?? AH?._nodes;
    if (!nodes) return null;
    return nodes instanceof Map ? [...nodes.values()] : Object.values(nodes);
}

function wrapStoreHandlers() {
    const AH = FluxDispatcher._actionHandlers;
    const nodes = storeNodes(AH);
    if (!nodes) {
        log.error("flux store nodes not found, unread silencing disabled");
        return () => {};
    }
    const restore: (() => void)[] = [];
    for (const node of nodes) {
        if (!node) continue;
        if (!SILENCED_STORES.includes(node.name)) continue;
        const handlers = node.actionHandler;
        const orig = handlers?.MESSAGE_CREATE;
        if (typeof orig !== "function") continue;
        handlers.MESSAGE_CREATE = function (this: any, action: any) {
            if (shouldSilence(action)) return false;
            return orig.apply(this, arguments as any);
        };
        restore.push(() => void (handlers.MESSAGE_CREATE = orig));
    }
    if (!restore.length) log.error("no unread-related stores found, unread silencing disabled");
    AH._invalidateCaches?.();
    return () => {
        restore.forEach(f => f());
        AH._invalidateCaches?.();
    };
}

// ---- server acks ----------------------------------------------------------------------------

const pendingAcks = new Map<string, string>();
let ackTimer: ReturnType<typeof setTimeout> | null = null;

function snowflakeMax(a: string | undefined, b: string) {
    if (!a) return b;
    return a.length !== b.length ? (a.length > b.length ? a : b) : a > b ? a : b;
}

function queueAck(channelId: string, messageId: string) {
    if (!storage.serverAck) return;
    pendingAcks.set(channelId, snowflakeMax(pendingAcks.get(channelId), messageId));
    ackTimer ??= setTimeout(flushAcks, 2500);
}

function flushAcks() {
    ackTimer = null;
    const channels = [...pendingAcks].map(([channelId, messageId]) => ({ channelId, messageId, readStateType: 0 }));
    pendingAcks.clear();
    if (!channels.length) return;
    try {
        AckActions().bulkAck(channels);
        log.info(`acked hidden activity in ${channels.length} channel(s)`);
    } catch (e) {
        log.error("bulkAck failed", e);
    }
}

function onMessageCreate(action: any) {
    if (!shouldSilence(action)) return;
    const { channelId, message } = action;
    // Chat had nothing new before this message: moving the server ack keeps it that way.
    if (!ReadStateStore().hasUnread(channelId)) queueAck(channelId, message.id);
}

// ---- startup reconcile ----------------------------------------------------------------------

const DISCORD_EPOCH = 1420070400000;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

function ackAnchor(state: any): string | null {
    if (state._ackMessageId) return state._ackMessageId;
    if (state._ackMessageTimestamp) return String((BigInt(state._ackMessageTimestamp) - BigInt(DISCORD_EPOCH)) << BigInt(22));
    return null;
}

function isMuted(channelId: string) {
    const ch = ChannelStore().getChannel(channelId);
    if (!ch?.guild_id) return false;
    return !!UserGuildSettingsStore()?.isGuildOrCategoryOrChannelMuted?.(ch.guild_id, channelId);
}

async function reconcile() {
    reconcileTimer = null;
    const RS = ReadStateStore();
    const states = (RS.getAllReadStates?.() ?? []).filter((s: any) =>
        s.type === 0 && RS.hasUnread(s.channelId) && (!isMuted(s.channelId) || RS.getMentionCount(s.channelId) > 0));

    let acked = 0;
    for (const s of states.slice(0, 60)) {
        let after = ackAnchor(s);
        if (!after) continue;
        try {
            for (let page = 0; page < 3; page++) {
                const res = await HTTP().get({ url: `/channels/${s.channelId}/messages`, query: { after, limit: 100 } });
                const msgs: any[] = res.body ?? [];
                if (!msgs.length || !msgs.every(m => silentForUnread(m))) break;
                const newest = msgs.reduce((a: string | undefined, m: any) => snowflakeMax(a, m.id), undefined as any);
                queueAck(s.channelId, newest);
                acked++;
                if (msgs.length < 100) break;
                after = newest;
            }
        } catch (e: any) {
            if (e?.status === 429) await new Promise(r => setTimeout(r, (e.body?.retry_after ?? 2) * 1000));
        }
        await new Promise(r => setTimeout(r, 350));
    }
    if (states.length) log.info(`reconcile: checked ${states.length} unread channel(s), ${acked} only had hidden messages`);
}

function scheduleReconcile(delay = 4000) {
    if (!storage.serverAck) return;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => void reconcile().catch(e => log.error("reconcile", e)), delay);
}

const onConnectionOpen = () => scheduleReconcile();

// ---- passive updates ------------------------------------------------------------------------
// For "passive" guilds Discord sends PASSIVE_UPDATE_V2 with only a channel's new last message id,
// no author. ReadStateStore would light the channel up at once. Entries that would turn a read
// channel unread are held back, checked with one request, and released only if something visible
// arrived; hidden-only activity is acked instead.

function snowflakeGreater(a: string, b: string) {
    return a.length !== b.length ? a.length > b.length : a > b;
}

/** Same action with only these channels and every other list emptied, so no other update repeats. */
function passiveWith(action: any, key: string, channels: any[]) {
    const out: any = { __kb: true };
    for (const [k, v] of Object.entries(action)) out[k] = Array.isArray(v) ? [] : v;
    out[key] = channels;
    return out;
}

async function verifyPassive(action: any, key: string, held: any[]) {
    const RS = ReadStateStore();
    const release: any[] = [];
    for (const entry of held) {
        const channelId = entry.id;
        const state = RS.getAllReadStates?.().find((s: any) => s.channelId === channelId);
        const after = (state && ackAnchor(state)) ?? RS.lastMessageId(channelId);
        try {
            const msgs: any[] = after ? (await HTTP().get({ url: `/channels/${channelId}/messages`, query: { after, limit: 50 } })).body ?? [] : [];
            if (!msgs.length) continue; // nothing there anymore (deleted): drop
            if (msgs.every(m => silentForUnread(m))) {
                queueAck(channelId, msgs.reduce((a: string | undefined, m: any) => snowflakeMax(a, m.id), undefined as any));
                continue;
            }
            release.push(entry);
        } catch (e) {
            release.push(entry); // fail open: never lose a real unread
        }
        await new Promise(r => setTimeout(r, 250));
    }
    log.info(`passive update: ${held.length} held, ${release.length} released`);
    if (release.length) FluxDispatcher.dispatch(passiveWith(action, key, release));
}

/** Interceptor: mutates PASSIVE_UPDATE_V2 in place; never swallows the whole action. */
export function interceptPassive(action: any): boolean {
    if (action.type !== "PASSIVE_UPDATE_V2" || action.__kb) return false;
    const key = Array.isArray(action.channels) ? "channels" : Array.isArray(action.updatedChannels) ? "updatedChannels" : null;
    if (!key) return false;
    const RS = ReadStateStore();
    const selected = SelectedChannelStore()?.getChannelId?.();
    const held: any[] = [];
    action[key] = action[key].filter((c: any) => {
        const last: string | undefined = c?.lastMessageId ?? c?.last_message_id;
        if (!c?.id || !last || c.id === selected || RS.hasUnread(c.id)) return true;
        // Without a local read state there's nothing to check the update against: let it through.
        const local = RS.lastMessageId(c.id);
        if (!local || !snowflakeGreater(last, local)) return true;
        held.push(c);
        return false;
    });
    if (held.length) void verifyPassive(action, key, held).catch(e => log.error("passive verify", e));
    return false;
}

// ---- what the open chat says is new --------------------------------------------------------
// Read state comes from the server and counts hidden users' messages too, so a chat opened at
// launch got a "25+ new messages since 12:05" banner and a NEW MESSAGES line even when only
// blocked users had written. For chats whose messages are loaded, the unread getters are
// answered from the visible messages instead.

interface UnreadView { oldestId: string | null; oldestTs: number; count: number; estimated: boolean }
const viewCache = new WeakMap<object, { anchor: string; view: UnreadView | null }>();
/** Bumped when who is hidden changes, so cached views are recomputed. */
let hiddenVersion = 0;
const DISCORD_EPOCH_MS = 1420070400000;

const snowflakeTs = (id: string) => Number((BigInt(id) >> BigInt(22)) + BigInt(DISCORD_EPOCH_MS));
const notOlder = (a: string, b: string) => (a.length !== b.length ? a.length > b.length : a >= b);

/** Unread state without hidden messages, or null when the loaded messages can't tell. */
/** Set while computing a view: the patched getters then answer with Discord's own values. */
let computing = false;

function unreadView(RS: any, channelId: string): UnreadView | null {
    if (computing) return null;
    computing = true;
    try { return computeView(RS, channelId); } finally { computing = false; }
}

function computeView(RS: any, channelId: string): UnreadView | null {
    const anchor: string | null = RS.getOldestUnreadMessageId(channelId);
    if (!anchor) return null;
    const cm = MessageStore().getMessages(channelId);
    const msgs: any[] = cm?.toArray?.() ?? [];
    if (!msgs.length) return null;
    const hit = viewCache.get(cm);
    if (hit?.anchor === anchor + "|" + hiddenVersion) return hit.view;

    // Only when the loaded messages reach the channel's newest one; otherwise new messages are missing.
    const newest: string | null = RS.lastMessageId(channelId);
    if (cm.hasMoreAfter || !newest || !notOlder(msgs[msgs.length - 1].id, newest)) return null;
    const unread = msgs.filter(m => notOlder(m.id, anchor));
    // All unread messages are loaded only if something at or before the anchor is loaded too.
    const complete = !notOlder(msgs[0].id, anchor) || msgs[0].id === anchor;
    const visible = unread.filter(m => !silentForUnread(m));
    let view: UnreadView | null = null;
    // Hidden messages can only take away from what Discord says, never add to it.
    const origCount: number = RS.getUnreadCount(channelId) ?? 0;
    const origEstimated = !!RS.isEstimated(channelId);
    if (complete) {
        const first = visible[0];
        view = first
            ? { oldestId: first.id, oldestTs: snowflakeTs(first.id), count: Math.min(origCount, visible.length), estimated: origEstimated && visible.length >= origCount }
            : { oldestId: null, oldestTs: 0, count: 0, estimated: false };
    } else if (unread.length !== visible.length) {
        // Older unread messages aren't loaded: keep the anchor, just don't count hidden ones we see.
        view = { oldestId: anchor, oldestTs: RS.getOldestUnreadTimestamp(channelId), count: Math.max(0, origCount - (unread.length - visible.length)), estimated: origEstimated };
    }
    viewCache.set(cm, { anchor: anchor + "|" + hiddenVersion, view });
    return view;
}

function patchReadState() {
    const RS = ReadStateStore();
    const names = ["getOldestUnreadMessageId", "getOldestUnreadTimestamp", "getUnreadCount", "isEstimated", "hasUnread"];
    if (!names.every(n => typeof RS?.[n] === "function")) {
        log.warn("ReadStateStore getters changed, unread banner not adjusted");
        return () => {};
    }
    const view = (args: any[]) => (typeof args[0] === "string" ? unreadView(RS, args[0]) : null);
    const p = vendetta.patcher;
    const unpatches = [
        p.after("getOldestUnreadMessageId", RS, (a: any[], r: any) => { const v = view(a); return v ? v.oldestId : r; }),
        p.after("getOldestUnreadTimestamp", RS, (a: any[], r: any) => { const v = view(a); return v ? v.oldestTs : r; }),
        p.after("getUnreadCount", RS, (a: any[], r: any) => { const v = view(a); return v ? v.count : r; }),
        p.after("isEstimated", RS, (a: any[], r: any) => { const v = view(a); return v ? v.estimated : r; }),
        p.after("hasUnread", RS, (a: any[], r: any) => { if (!r) return r; const v = view(a); return v ? v.count > 0 : r; }),
    ];
    return () => unpatches.forEach(u => u());
}

export function startUnreads() {
    const unwrap = wrapStoreHandlers();
    const unpatchReadState = patchReadState();
    FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
    FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
    const offHidden = onHiddenChange(() => { hiddenVersion++; scheduleReconcile(1500); });
    scheduleReconcile(1500);
    return () => {
        unwrap();
        unpatchReadState();
        offHidden();
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen);
        if (reconcileTimer) clearTimeout(reconcileTimer);
        if (ackTimer) clearTimeout(ackTimer);
        flushAcks();
    };
}
