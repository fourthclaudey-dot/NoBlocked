import { log } from "./log";
import { FluxDispatcher } from "./discord";
import { kindOf, startHidden } from "./hidden";
import { startLoadMore } from "./loadmore";
import { interceptReactions, startReactions } from "./reactions";
import { interceptReveal, patchRows, rerender } from "./rows";
import { applyDefaults, storage } from "./settings";
import { SettingsPage } from "./ui";
import { interceptPassive, startUnreads } from "./unreads";

function interceptor(action: any): boolean {
    try {
        if (action.type === "TYPING_START") return storage.typing && !!kindOf(action.userId);
        return interceptReveal(action) || interceptReactions(action) || interceptPassive(action);
    } catch (e) {
        log.error("interceptor", e);
        return false;
    }
}

function addInterceptor() {
    FluxDispatcher.addInterceptor(interceptor);
    return () => {
        const list: any[] = FluxDispatcher._interceptors ?? [];
        const i = list.indexOf(interceptor);
        if (i !== -1) list.splice(i, 1);
    };
}

function devBootstrap() {
    // Dev builds attach Kettu's debug WebSocket to the dev server (adb reverse -> PC), but only
    // when it answers: Kettu's own auto-connect would toast an error on every launch away from the PC.
    const s = vendetta.settings;
    if (s.autoDebugger) s.autoDebugger = false;
    if (Date.now() - ((globalThis as any).__kbDevPing ?? 0) < 5000) return; // already attached
    fetch(`http://${__DEBUGGER_HOST__}/status`)
        .then(r => r.ok && vendetta.debug.connectToDebugger(__DEBUGGER_HOST__))
        .catch(() => {});
}

let cleanups: (() => void)[] = [];

export default {
    onLoad() {
        if (__DEV__) devBootstrap();
        applyDefaults();
        // Order matters: hidden IDs first, the rest reads them.
        for (const start of [startHidden, addInterceptor, patchRows, startLoadMore, startUnreads, startReactions]) {
            try {
                cleanups.push(start());
            } catch (e) {
                log.error(`${start.name} failed`, e);
            }
        }
        if (__DEV__) (globalThis as any).__nb = { storage, rerender };
        rerender();
        log.info("loaded");
    },
    onUnload() {
        for (const fn of cleanups.reverse()) {
            try { fn(); } catch (e) { log.error("cleanup failed", e); }
        }
        cleanups = [];
        rerender();
    },
    settings: SettingsPage,
};
