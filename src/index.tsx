import { FluxDispatcher } from "./discord";
import { startHidden } from "./hidden";
import { log } from "./log";
import { startLoadMore } from "./loadmore";
import { interceptReactions, startReactions } from "./reactions";
import { interceptReveal, patchRows, rerender } from "./rows";
import { startSelfUpdate } from "./selfupdate";
import { applyDefaults, storage } from "./settings";
import { SettingsPage } from "./ui";
import { interceptPassive, startUnreads } from "./unreads";

/** True swallows the action. */
function interceptor(action: any): boolean {
    try {
        return interceptReveal(action) || interceptReactions(action) || interceptPassive(action);
    } catch (e) {
        log.error("interceptor", e);
        return false;
    }
}

function addInterceptor() {
    // Kettu's flux API: nullish keeps the action, false blocks it.
    const intercept = (globalThis as any).bunny?.api?.flux?.intercept;
    if (typeof intercept === "function") return intercept((action: any) => (interceptor(action) ? false : undefined));

    // Other Vendetta-compatible mods: plain dispatcher interceptor.
    FluxDispatcher.addInterceptor(interceptor);
    return () => {
        const list: any[] = FluxDispatcher._interceptors ?? [];
        if (list.includes(interceptor)) list.splice(list.indexOf(interceptor), 1);
    };
}

function devBootstrap() {
    // Dev builds attach Kettu's debug WebSocket to the dev server (adb reverse -> PC), but only
    // when it answers: Kettu's own auto-connect would toast an error on every launch away from the PC.
    const s = vendetta.settings;
    if (s.autoDebugger) s.autoDebugger = false;
    // Kettu 1.4.3 toasts don't fit Discord 350.x's toast store and crash the app chrome;
    // the debugger connection toasts every time, so drop Kettu's own toasts in dev builds.
    const toasts = vendetta.metro.common.toasts;
    if (toasts?.open && !(globalThis as any).__nbToastPatch) {
        (globalThis as any).__nbToastPatch = vendetta.patcher.instead("open", toasts, (args: any[], orig: Function) =>
            String(args[0]?.key ?? "").startsWith("vd-toast-") ? undefined : orig(...args));
    }
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
        for (const start of [startHidden, addInterceptor, patchRows, startLoadMore, startUnreads, startReactions, startSelfUpdate]) {
            try {
                cleanups.push(start());
            } catch (e) {
                log.error(`${start.name} failed`, e);
            }
        }
        if (__DEV__) (globalThis as any).__nb = { storage, rerender };
        rerender();
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
