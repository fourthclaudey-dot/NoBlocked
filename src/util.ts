// Small helpers shared by the features.
import { HTTP } from "./discord";

// ---- snowflakes (Discord ids) -------------------------------------------------------------
// Ids are compared as strings: same length -> lexicographic order equals numeric order.

const DISCORD_EPOCH = 1420070400000;

/** a > b */
export const isNewer = (a: string, b: string) => (a.length !== b.length ? a.length > b.length : a > b);
/** a >= b */
export const isNotOlder = (a: string, b: string) => a === b || isNewer(a, b);
/** The newer of two ids; `undefined` counts as older than anything. */
export const newestId = (a: string | undefined, b: string) => (a && isNotOlder(a, b) ? a : b);
/** The id right before `id` (for "after" queries that must include `id`). */
export const idBefore = (id: string) => (BigInt(id) - BigInt(1)).toString();
/** Creation time of an id, in ms. */
export const idTimestamp = (id: string) => Number((BigInt(id) >> BigInt(22)) + BigInt(DISCORD_EPOCH));
/** Smallest id created at `ms`. */
export const idFromTimestamp = (ms: number) => ((BigInt(ms) - BigInt(DISCORD_EPOCH)) << BigInt(22)).toString();

// ---- misc ---------------------------------------------------------------------------------

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** GET from Discord's API; waits and retries (up to 4 times) when rate-limited. */
export async function apiGet(url: string, query: Record<string, unknown>): Promise<any[]> {
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            return (await HTTP().get({ url, query })).body ?? [];
        } catch (e: any) {
            if (e?.status !== 429) throw e;
            await sleep(Math.max(500, (e.body?.retry_after ?? 1) * 1000));
        }
    }
    return [];
}
