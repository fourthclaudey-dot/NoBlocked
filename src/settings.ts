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

export interface Settings {
    /** "Полное исключение": every category behaves as `remove` and never counts as new. */
    total: boolean;
    /** Shared mode for blocked and ignored users. */
    mode: Exclude<Mode, "off">;
    blocked: { mode: Exclude<Mode, "off"> | "inherit"; unread: boolean };
    ignored: { mode: Exclude<Mode, "off"> | "inherit"; unread: boolean };
    replies: { mode: Mode; unread: boolean };
    /** Collapse a run of adjacent bars into one bar. */
    merge: boolean;
    /** Subtract hidden users from reaction counters (costs extra API requests). */
    reactions: boolean;
    /** Mark hidden-only activity as read on Discord's servers too (other devices, next start). */
    serverAck: boolean;
    /** Last known blocked/ignored IDs, used before Discord loads relationships at startup. */
    cache: { blocked: string[]; ignored: string[] };
}

const defaults: Settings = {
    total: false,
    mode: "reveal",
    blocked: { mode: "inherit", unread: false },
    ignored: { mode: "inherit", unread: false },
    replies: { mode: "off", unread: true },
    merge: true,
    reactions: true,
    serverAck: true,
    cache: { blocked: [], ignored: [] },
};

export const storage: Settings = vendetta.plugin.storage;

export function applyDefaults() {
    const s = storage as any;
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

/** Whether messages of this category make a chat look like it has something new. */
export function countsAsNew(cat: Category): boolean {
    return !storage.total && storage[cat].unread;
}
