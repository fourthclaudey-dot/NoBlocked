// Kettu starts a plugin whose updates are on only after downloading its manifest (and code)
// again. On a slow network Discord has drawn the cached chat by then, so hidden messages flash.
// So NoBlocked turns that off for itself — Kettu then starts it straight from its cache — and
// checks for a new version in the background; a new version is stored for the next launch.
import { log } from "./log";

const CHECK_DELAY_MS = 8000;

export function startSelfUpdate() {
    const id: string | undefined = vendetta.plugin?.id;
    const entry = id ? vendetta.plugins.plugins[id] : undefined;
    if (!id || !entry) return () => {};

    // Dev builds come from the dev server and must be refetched by Kettu on every start.
    if (__DEV__) return () => {};

    if (entry.update) entry.update = false;

    const timer = setTimeout(async () => {
        try {
            const res = await fetch(`${id}manifest.json`, { cache: "no-store" } as any);
            if (!res.ok) return;
            const remote = await res.json();
            if (!remote?.hash || remote.hash === entry.manifest?.hash) return;
            await vendetta.plugins.fetchPlugin(id); // stores the new code; the running copy is untouched
            log.info(`downloaded ${remote.hash}, active on next launch`);
        } catch (e) {
            log.warn("update check failed", e);
        }
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
}
