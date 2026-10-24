// Who is hidden. Discord only learns relationships on CONNECTION_OPEN (~1.5s after start),
// while cached messages render ~0.3s after start; until then we trust our persisted copy —
// and lend it to RelationshipStore itself, so everything Discord draws in that window (bars,
// "Blocked message" reply previews, …) already knows who is hidden.
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

/**
 * Until Discord has the real relationship list, answer its blocked/ignored checks from our cache
 * too. Once authoritative, every patch returns Discord's own answer untouched.
 */
function patchRelationshipStore() {
    const R = RelationshipStore();
    const cacheBlocked = new Set(storage.cache.blocked);
    const cacheIgnored = new Set(storage.cache.ignored);
    const early = () => !authoritative;
    const isB = (id: any) => early() && typeof id === "string" && cacheBlocked.has(id);
    const isI = (id: any) => early() && typeof id === "string" && cacheIgnored.has(id) && !cacheBlocked.has(id);
    const withCache = (ret: unknown, extra: Set<string>) =>
        early() && Array.isArray(ret) ? [...new Set([...ret, ...extra])] : ret;
    const hooks: [string, (args: any[], ret: any) => any][] = [
        ["isBlocked", ([id], ret) => ret || isB(id)],
        ["isIgnored", ([id], ret) => ret || isI(id)],
        ["isBlockedOrIgnored", ([id], ret) => ret || isB(id) || isI(id)],
        ["isBlockedForMessage", ([m], ret) => ret || isB(m?.author?.id)],
        ["isIgnoredForMessage", ([m], ret) => ret || isI(m?.author?.id)],
        ["isBlockedOrIgnoredForMessage", ([m], ret) => ret || isB(m?.author?.id) || isI(m?.author?.id)],
        ["getBlockedIDs", (_, ret) => withCache(ret, cacheBlocked)],
        ["getIgnoredIDs", (_, ret) => withCache(ret, cacheIgnored)],
        ["getBlockedOrIgnoredIDs", (_, ret) => withCache(ret, new Set([...cacheBlocked, ...cacheIgnored]))],
        ["getRelationshipType", ([id], ret) => (!ret && isB(id) ? 2 : ret)], // 2 = blocked
    ];
    // Patch what exists: a method renamed by a Discord update only loses its own hook.
    const unpatches = hooks.filter(([name]) => typeof R[name] === "function").map(([name, fn]) => vendetta.patcher.after(name, R, fn));
    return () => unpatches.forEach(u => u());
}

function onConnectionOpen() {
    authoritative = true;
    sync();
}

export function startHidden() {
    // Plugin (re)loaded mid-session: Discord already has the real relationship list.
    authoritative = !!GatewayConnectionStore()?.isConnected?.();
    let unpatchStore = () => {};
    try { unpatchStore = patchRelationshipStore(); } catch (e) { log.error("RelationshipStore patch failed", e); }
    sync();
    if (__DEV__) {
        // Cold-start probe: what Discord's own checks say about cached users before the server answers.
        const probe = () => {
            FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", probe);
            const R = RelationshipStore();
            (globalThis as any).__nbEarly = {
                authoritative,
                blocked: storage.cache.blocked.map(id => [id, R.isBlocked(id)]),
                ignored: storage.cache.ignored.map(id => [id, R.isIgnored(id)]),
            };
        };
        FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", probe);
    }
    RelationshipStore().addChangeListener(sync);
    FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
    for (const t of RELATIONSHIP_EVENTS) FluxDispatcher.subscribe(t, sync);
    return () => {
        RelationshipStore().removeChangeListener(sync);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen);
        for (const t of RELATIONSHIP_EVENTS) FluxDispatcher.unsubscribe(t, sync);
        listeners.clear();
        unpatchStore();
    };
}
