/** blocked/ignored: authored by such users; replies: someone else replying to such a user. */
export type Category = "blocked" | "ignored" | "replies";
export type Kind = "blocked" | "ignored";

/**
 * reveal — a bar that can be tapped open
 * bar    — a bar that cannot be opened
 * remove — no trace at all
 * off    — (replies only) shown as normal messages
 */
export type Mode = "reveal" | "bar" | "remove" | "off";

/**
 * Threads created by a hidden user:
 * hide — not in the channel list, not under messages
 * mask — shown, but the title is replaced with a placeholder
 */
export type ThreadMode = "hide" | "mask";

export interface Settings {
    /** "Полное исключение": every category behaves as `remove` and never counts as new. */
    total: boolean;
    /** Shared mode for blocked and ignored users. */
    mode: Exclude<Mode, "off">;
    /** `reactions`: drop their reactions from counters and the "who reacted" list; `threads`: see ThreadMode. */
    blocked: { mode: Exclude<Mode, "off"> | "inherit"; unread: boolean; reactions: boolean; threads: ThreadMode };
    ignored: { mode: Exclude<Mode, "off"> | "inherit"; unread: boolean; reactions: boolean; threads: ThreadMode };
    replies: { mode: Mode; unread: boolean };
    /** Collapse a run of adjacent bars into one bar. */
    merge: boolean;
    /** Mark hidden-only activity as read on Discord's servers too (other devices, next start). */
    serverAck: boolean;
    /** Last known blocked/ignored IDs, used before Discord loads relationships at startup. */
    cache: { blocked: string[]; ignored: string[] };
}

const defaults: Settings = {
    total: false,
    mode: "reveal",
    blocked: { mode: "inherit", unread: false, reactions: true, threads: "mask" },
    ignored: { mode: "inherit", unread: false, reactions: true, threads: "mask" },
    replies: { mode: "off", unread: true },
    merge: true,
    serverAck: true,
    cache: { blocked: [], ignored: [] },
};

export const storage: Settings = vendetta.plugin.storage;

export function applyDefaults() {
    const s = storage as any;
    // 1.x had one shared "reactions" switch; carry the user's choice over to both kinds.
    if (typeof s.reactions === "boolean") {
        for (const kind of ["blocked", "ignored"]) if (s[kind] && s[kind].reactions === undefined) s[kind].reactions = s.reactions;
        delete s.reactions;
    }
    for (const [key, value] of Object.entries(defaults)) {
        if (s[key] === undefined || typeof s[key] !== typeof value) s[key] = JSON.parse(JSON.stringify(value));
        else if (value && typeof value === "object" && !Array.isArray(value)) {
            for (const [k, v] of Object.entries(value)) if (s[key][k] === undefined) s[key][k] = JSON.parse(JSON.stringify(v));
        }
    }
}

export function modeOf(cat: Category): Mode {
    if (storage.total) return "remove";
    if (cat === "replies") return storage.replies.mode;
    const own = storage[cat].mode;
    return own === "inherit" ? storage.mode : own;
}

/** Whether reactions from this kind of hidden user are dropped from counters and reactor lists. */
export function hidesReactions(kind: Kind): boolean {
    return storage.total || storage[kind].reactions;
}

/** What to do with threads created by this kind of hidden user. */
export function threadModeOf(kind: Kind): ThreadMode {
    return storage.total ? "hide" : storage[kind].threads;
}

/** Whether messages of this category make a chat look like it has something new. */
export function countsAsNew(cat: Category): boolean {
    return !storage.total && storage[cat].unread;
}
