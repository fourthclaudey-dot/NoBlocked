// Who is hidden. Discord only learns relationships on CONNECTION_OPEN (~1.5s after start),
// while cached messages render ~0.3s after start; until then we trust our persisted copy.
import { log } from "./log";
import { FluxDispatcher, GatewayConnectionStore, RelationshipStore, RELATIONSHIP_EVENTS } from "./discord";
import { Kind, storage } from "./settings";

let blocked = new Set<string>();
let ignored = new Set<string>();
let authoritative = false;
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

export function onHiddenChange(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

function sameSet(a: Set<string>, b: Set<string>) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}

function sync() {
    const R = RelationshipStore();
    const liveBlocked: string[] = R.getBlockedIDs();
    const liveIgnored: string[] = R.getIgnoredIDs();

    const nextBlocked = new Set(authoritative ? liveBlocked : [...liveBlocked, ...storage.cache.blocked]);
    const nextIgnored = new Set(authoritative ? liveIgnored : [...liveIgnored, ...storage.cache.ignored]);
    for (const id of nextBlocked) nextIgnored.delete(id);

    if (authoritative) storage.cache = { blocked: [...nextBlocked], ignored: [...nextIgnored] };
    if (sameSet(blocked, nextBlocked) && sameSet(ignored, nextIgnored)) return;
    blocked = nextBlocked;
    ignored = nextIgnored;
    for (const fn of listeners) {
        try { fn(); } catch (e) { log.error("hidden listener", e); }
    }
}

function onConnectionOpen() {
    authoritative = true;
    sync();
}

export function startHidden() {
    // Plugin (re)loaded mid-session: Discord already has the real relationship list.
    authoritative = !!GatewayConnectionStore()?.isConnected?.();
    sync();
    RelationshipStore().addChangeListener(sync);
    FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
    for (const t of RELATIONSHIP_EVENTS) FluxDispatcher.subscribe(t, sync);
    return () => {
        RelationshipStore().removeChangeListener(sync);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen);
        for (const t of RELATIONSHIP_EVENTS) FluxDispatcher.unsubscribe(t, sync);
        listeners.clear();
    };
}
