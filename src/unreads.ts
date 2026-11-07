// Keeps hidden messages from making chats look new.
// 1. Live: the stores behind unread dots, badges, DM order, previews and in-app notifications
//    never see a silenced MESSAGE_CREATE (MessageStore still does, so bars keep working).
// 2. Server: if the chat was read before, the silenced message is acked, so other devices and
//    the next launch agree.
// 3. Startup: chats that only got hidden messages while the app was closed are checked (one
//    request each) and acked.
// 4. Passive guild updates carry no author: held back until one request shows who wrote.
// 5. The open chat's unread getters (banner, NEW MESSAGES line) skip hidden messages.
import { silentForUnread } from "./classify";
import { AckActions, ChannelStore, FluxDispatcher, MessageStore, ReadStateStore, SelectedChannelStore, storeNodes, UserGuildSettingsStore } from "./discord";
import { onHiddenChange } from "./hidden";
import { log } from "./log";
import { storage } from "./settings";
import { apiGet, idFromTimestamp, idTimestamp, isNewer, isNotOlder, newestId, sleep } from "./util";

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

const shouldSilence = (action: any) => !!action?.message && !action.optimistic && silentForUnread(action.message);
const newestOf = (msgs: any[]) => msgs.reduce<string | undefined>((a, m) => newestId(a, m.id), undefined)!;

function wrapStoreHandlers() {
    const nodes = storeNodes();
    if (!nodes) {
        log.error("flux store nodes not found, unread silencing disabled");
        return () => {};
    }
    const restore: (() => void)[] = [];
    for (const node of nodes) {
        if (!SILENCED_STORES.includes(node?.name)) continue;
        const handlers = node.actionHandler;
        const orig = handlers?.MESSAGE_CREATE;
        if (typeof orig !== "function") continue;
        handlers.MESSAGE_CREATE = function (this: unknown, action: any) {
            return shouldSilence(action) ? false : orig.call(this, action);
        };
        restore.push(() => void (handlers.MESSAGE_CREATE = orig));
    }
    if (!restore.length) log.error("no unread-related stores found, unread silencing disabled");
    const AH = FluxDispatcher._actionHandlers;
    AH._invalidateCaches?.();
    return () => {
        restore.forEach(f => f());
        AH._invalidateCaches?.();
    };
}

// ---- server acks ----------------------------------------------------------------------------

const pendingAcks = new Map<string, string>();
let ackTimer: ReturnType<typeof setTimeout> | null = null;

function queueAck(channelId: string, messageId: string) {
    if (!storage.serverAck) return;
    pendingAcks.set(channelId, newestId(pendingAcks.get(channelId), messageId));
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
    // Chat had nothing new before this message: moving the server ack keeps it that way.
    if (!ReadStateStore().hasUnread(action.channelId)) queueAck(action.channelId, action.message.id);
}

// ---- startup reconcile ----------------------------------------------------------------------

let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

function ackAnchor(state: any): string | null {
    if (state._ackMessageId) return state._ackMessageId;
    if (state._ackMessageTimestamp) return idFromTimestamp(state._ackMessageTimestamp);
    return null;
}

function isMuted(channelId: string) {
    const ch = ChannelStore().getChannel(channelId);
    return !!ch?.guild_id && !!UserGuildSettingsStore()?.isGuildOrCategoryOrChannelMuted?.(ch.guild_id, channelId);
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
                const msgs = await apiGet(`/channels/${s.channelId}/messages`, { after, limit: 100 });
                if (!msgs.length || !msgs.every(silentForUnread)) break;
                const newest = newestOf(msgs);
                queueAck(s.channelId, newest);
                acked++;
                if (msgs.length < 100) break;
                after = newest;
            }
        } catch (e) {
            log.warn("reconcile request failed", e);
        }
        await sleep(350);
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
// For "passive" guilds Discord sends PASSIVE_UPDATE_V2 with only a channel's new last message id.
// Entries that would turn a read channel unread are held back and checked with one request:
// released if something visible arrived, acked if only hidden messages did.

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
            const msgs = after ? await apiGet(`/channels/${channelId}/messages`, { after, limit: 50 }) : [];
            if (!msgs.length) continue; // nothing there anymore (deleted): drop
            if (msgs.every(silentForUnread)) queueAck(channelId, newestOf(msgs));
            else release.push(entry);
        } catch {
            release.push(entry); // fail open: never lose a real unread
        }
        await sleep(250);
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
        if (!local || !isNewer(last, local)) return true;
        held.push(c);
        return false;
    });
    if (held.length) void verifyPassive(action, key, held).catch(e => log.error("passive verify", e));
    return false;
}

// ---- what the open chat says is new --------------------------------------------------------
// Read state from the server counts hidden users' messages too, so a chat opened at launch got a
// "25+ new messages since 12:05" banner and a NEW MESSAGES line even when only blocked users had
// written. For chats whose messages are loaded up to the newest one, the unread getters are
// answered from the visible messages instead — never with more than Discord's own values.

interface UnreadView { oldestId: string | null; oldestTs: number; count: number; estimated: boolean }
const viewCache = new WeakMap<object, { key: string; view: UnreadView | null }>();
/** Bumped when who is hidden changes, so cached views are recomputed. */
let hiddenVersion = 0;
/**
 * Set while computing a view. Kettu patches methods in place, so the getters called from inside
 * the computation are the patched ones; while this is set they return Discord's own values.
 */
let computing = false;

/** Unread state without hidden messages, or null when the loaded messages can't tell. */
function unreadView(RS: any, channelId: string): UnreadView | null {
    if (computing) return null;
    computing = true;
    try { return computeView(RS, channelId); } finally { computing = false; }
}

function computeView(RS: any, channelId: string): UnreadView | null {
    const anchor: string | null = RS.getOldestUnreadMessageId(channelId);
    if (!anchor) return null;
    const cm = MessageStore().getMessages(channelId);
    if (!cm) return null;
    const msgs: any[] = cm.toArray();
    if (!msgs.length) return null;
    // Nothing unread by Discord's own count (e.g. just acked while the chat stays open, which keeps
    // the old anchor): leave its values alone, we may only ever take away from them.
    const origCount: number = RS.getUnreadCount(channelId) ?? 0;
    if (!origCount && !RS.hasUnread(channelId)) return null;
    // The ack and Discord's count are part of the key: reading the chat changes them without
    // changing the loaded messages or the anchor, and a stale view kept the banner up.
    const cacheKey = `${anchor}|${RS.ackMessageId(channelId)}|${origCount}|${hiddenVersion}`;
    const hit = viewCache.get(cm);
    if (hit?.key === cacheKey) return hit.view;

    // Only when the loaded messages reach the channel's newest one; otherwise new messages are missing.
    const newest: string | null = RS.lastMessageId(channelId);
    if (cm.hasMoreAfter || !newest || !isNotOlder(msgs[msgs.length - 1].id, newest)) return null;
    const unread = msgs.filter(m => isNotOlder(m.id, anchor));
    const visible = unread.filter(m => !silentForUnread(m));
    // All unread messages are loaded only if something at or before the anchor is loaded too.
    const complete = !isNewer(msgs[0].id, anchor);
    const origEstimated = !!RS.isEstimated(channelId);

    let view: UnreadView | null = null;
    if (complete) {
        const first = visible[0];
        view = first
            ? { oldestId: first.id, oldestTs: idTimestamp(first.id), count: Math.min(origCount, visible.length), estimated: origEstimated && visible.length >= origCount }
            : { oldestId: null, oldestTs: 0, count: 0, estimated: false };
    } else if (unread.length !== visible.length) {
        // Older unread messages aren't loaded: keep the anchor, just don't count hidden ones we see.
        const hiddenSeen = unread.length - visible.length;
        view = { oldestId: anchor, oldestTs: RS.getOldestUnreadTimestamp(channelId), count: Math.max(0, origCount - hiddenSeen), estimated: origEstimated };
    }
    viewCache.set(cm, { key: cacheKey, view });
    return view;
}

function patchReadState() {
    const RS = ReadStateStore();
    const getters: [keyof ReturnType<typeof ReadStateStore>, (v: UnreadView, ret: any) => any][] = [
        ["getOldestUnreadMessageId", v => v.oldestId],
        ["getOldestUnreadTimestamp", v => v.oldestTs],
        ["getUnreadCount", v => v.count],
        ["isEstimated", v => v.estimated],
        ["hasUnread", (v, ret) => ret && v.count > 0],
    ];
    if (!getters.every(([name]) => typeof RS?.[name] === "function")) {
        log.warn("ReadStateStore getters changed, unread banner not adjusted");
        return () => {};
    }
    const unpatches = getters.map(([name, pick]) => vendetta.patcher.after(name, RS, ([channelId], ret) => {
        if (typeof channelId !== "string" || (name === "hasUnread" && !ret)) return ret;
        const v = unreadView(RS, channelId);
        return v ? pick(v, ret) : ret;
    }));
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
