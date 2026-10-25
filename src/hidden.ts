// Who is hidden. Discord learns relationships from the gateway (~1.5 s after start); until then the
// chat stays blank (see rows.ts) rather than showing messages we can't classify yet. Offline, the
// chat opens after READY_TIMEOUT_MS with the persisted list from the last session.
import { FluxDispatcher, GatewayConnectionStore, RelationshipStore, RELATIONSHIP_EVENTS } from "./discord";
import { log } from "./log";
import { Kind, storage } from "./settings";

const READY_TIMEOUT_MS = 5000;

let blocked = new Set<string>();
let ignored = new Set<string>();
/** Discord's own relationship list is loaded. */
let authoritative = false;
/** The chat may render: relationships are known, or we gave up waiting and use the cache. */
let ready = false;
const listeners = new Set<() => void>();

export function kindOf(userId: string | undefined | null): Kind | null {
    if (!userId) return null;
    if (blocked.has(userId)) return "blocked";
    if (ignored.has(userId)) return "ignored";
    return null;
}

export function hiddenIds(): string[] {
    return [...blocked, ...ignored];
}

export function isReady() {
    return ready;
}

/** Called when the hidden list changes or the chat becomes ready to render. */
export function onHiddenChange(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

function notify() {
    for (const fn of listeners) {
        try { fn(); } catch (e) { log.error("hidden listener", e); }
    }
}

function sameSet(a: Set<string>, b: Set<string>) {
    return a.size === b.size && [...a].every(x => b.has(x));
}

function sync() {
    const R = RelationshipStore();
    const nextBlocked = new Set<string>(R.getBlockedIDs());
    const nextIgnored = new Set<string>(R.getIgnoredIDs());
    if (!authoritative) {
        storage.cache.blocked.forEach(id => nextBlocked.add(id));
        storage.cache.ignored.forEach(id => nextIgnored.add(id));
    }
    nextBlocked.forEach(id => nextIgnored.delete(id));

    if (authoritative) storage.cache = { blocked: [...nextBlocked], ignored: [...nextIgnored] };
    if (sameSet(blocked, nextBlocked) && sameSet(ignored, nextIgnored)) return;
    blocked = nextBlocked;
    ignored = nextIgnored;
    notify();
}

function markReady() {
    if (ready) return;
    ready = true;
    notify();
}

function onConnectionOpen() {
    authoritative = true;
    sync();
    markReady();
}

export function startHidden() {
    // Plugin (re)loaded mid-session: Discord already has the real relationship list.
    authoritative = ready = !!GatewayConnectionStore()?.isConnected?.();
    sync();
    const timer = setTimeout(markReady, READY_TIMEOUT_MS);
    RelationshipStore().addChangeListener(sync);
    FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
    for (const t of RELATIONSHIP_EVENTS) FluxDispatcher.subscribe(t, sync);
    return () => {
        clearTimeout(timer);
        RelationshipStore().removeChangeListener(sync);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen);
        for (const t of RELATIONSHIP_EVENTS) FluxDispatcher.unsubscribe(t, sync);
        listeners.clear();
    };
}
