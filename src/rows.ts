// Post-processes the rows Discord hands to the native chat list (index 0 = newest message).
// Discord folds blocked/ignored authors into bar rows itself; we apply the display modes, fold
// replies to hidden users the same way, merge runs of bars and drop dividers left empty.
// Until relationships are known the chat renders no rows at all (see hidden.ts).
import { displayCategory } from "./classify";
import { ChannelStreamModule, FluxDispatcher, MessageStore, RowType, SelectedChannelStore } from "./discord";
import { isReady, onHiddenChange } from "./hidden";
import { t } from "./i18n";
import { log } from "./log";
import { Category, modeOf, storage } from "./settings";

type Row = Record<string, any>;
interface Bar { __bar: true; row: Row; cat: Category; count: number; synthetic: boolean }

const isBar = (x: unknown): x is Bar => !!x && (x as Bar).__bar === true;

/** Bars that must not open, by the id the native list sends back on tap (MESSAGE_REVEAL). */
const revealDenied = new Set<string>();
/** Merged bar id -> contexts of the bars it stands for. */
const mergedRuns = new Map<string, string[]>();
/** Contexts of bars whose merged run the user expanded. */
const expanded = new Set<string>();

let visibleListener: ((channelId: string, messages: any[]) => void) | null = null;
/** Receives the message records that ended up visible after each pass (used by reactions). */
export function onVisibleMessages(fn: typeof visibleListener) {
    visibleListener = fn;
}

function barText(cat: Category, n: number) {
    const s = t();
    return cat === "replies" ? s.repliesBar(n) : cat === "blocked" ? s.blockedBar(n) : s.ignoredBar(n);
}

/**
 * Text of the single bar that replaces a run of adjacent bars.
 * Counts are messages per category inside the run.
 */
export function mergedLabel(stats: Record<Category, number>) {
    const s = t();
    const total = stats.blocked + stats.ignored + stats.replies;
    const parts: string[] = [];
    if (stats.blocked) parts.push(s.mergedBlocked(stats.blocked));
    if (stats.ignored) parts.push(s.mergedIgnored(stats.ignored));
    if (stats.replies) parts.push(s.mergedReplies(stats.replies));
    return `${s.mergedTotal(total)} · ${parts.join(" · ")}`;
}

function groupCategory(row: Row): Category | null {
    if (row.rowType === RowType.BLOCKED_GROUP) return "blocked";
    if (row.rowType === RowType.IGNORED_GROUP) return "ignored";
    return null;
}

/** Step 1: classify rows, fold hidden message rows into bars, drop `remove` categories. */
function collect(rows: Row[], revealedId: string | null): (Row | Bar)[] {
    const out: (Row | Bar)[] = [];
    for (const row of rows) {
        let bar: Bar | null = null;
        const groupCat = groupCategory(row);

        if (groupCat) {
            bar = { __bar: true, row, cat: groupCat, count: row.content?.length || 1, synthetic: false };
        } else if (row.rowType === RowType.MESSAGE && row.message) {
            const cat = displayCategory(row.message);
            if (cat) {
                const prev = out[out.length - 1];
                if (isBar(prev) && prev.synthetic && prev.cat === cat) {
                    // rows go newest -> oldest, so the bar's context becomes the oldest message
                    prev.row.content.push(row);
                    prev.row.context = row.message.id;
                    prev.row.text = barText(cat, ++prev.count);
                    prev.row.revealed = revealedId === prev.row.context;
                    continue;
                }
                bar = {
                    __bar: true,
                    cat,
                    count: 1,
                    synthetic: true,
                    row: {
                        ...row,
                        rowType: cat === "blocked" ? RowType.BLOCKED_GROUP : RowType.IGNORED_GROUP,
                        content: [row],
                        text: barText(cat, 1),
                        revealed: revealedId === row.message.id,
                        context: row.message.id,
                    },
                };
            }
        }

        if (!bar) out.push(row);
        else if (modeOf(bar.cat) !== "remove") out.push(bar);
    }
    return out;
}

function emitBar(b: Bar, result: Row[]) {
    let row = b.row;
    if (modeOf(b.cat) !== "reveal") {
        revealDenied.add(row.context);
        row = { ...row, revealed: false, content: [] };
    }
    result.push(row);
}

/**
 * Id for a merged bar. The native list ignores taps on bars whose id isn't a real message of
 * the chat, and it must not equal an inner bar's id or tapping that bar would toggle the merge.
 */
function pickHeaderId(run: Bar[], contexts: string[], neighbours: (Row | Bar | undefined)[]): string {
    for (const b of run) {
        for (const r of b.row.content ?? []) {
            const id = r.message?.id;
            if (id && !contexts.includes(id)) return id;
        }
    }
    // every bar holds a single message: borrow an adjacent visible message's id
    for (const n of neighbours) if (n && !isBar(n) && n.rowType === RowType.MESSAGE && n.message?.id) return n.message.id;
    return contexts[contexts.length - 1];
}

/** Step 2: merge runs of adjacent bars and apply reveal permissions. */
function finish(items: (Row | Bar)[]): Row[] {
    const result: Row[] = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!isBar(item)) {
            result.push(item);
            continue;
        }
        const run: Bar[] = [item];
        while (storage.merge && isBar(items[i + 1])) run.push(items[++i] as Bar);
        if (run.length < 2) {
            emitBar(item, result);
            continue;
        }

        const contexts = run.map(b => String(b.row.context));
        const id = pickHeaderId(run, contexts, [items[i + 1], result[result.length - 1]]);
        const base = run[run.length - 1].row;
        const message = base.message;
        mergedRuns.set(id, contexts);
        const stats: Record<Category, number> = { blocked: 0, ignored: 0, replies: 0 };
        for (const b of run) stats[b.cat] += b.count;
        const isOpen = contexts.some(c => expanded.has(c));

        // Newest-first order: the expanded bars come first so the header sits above them on screen.
        if (isOpen) for (const b of run) emitBar(b, result);
        const inner = base.content?.[base.content.length - 1] ?? base;
        result.push({
            ...base,
            message,
            rowType: stats.blocked ? RowType.BLOCKED_GROUP : RowType.IGNORED_GROUP,
            text: (isOpen ? `${t().collapse} · ` : "") + mergedLabel(stats),
            revealed: false,
            content: [inner], // never shown (never "revealed"), but taps need content
            context: id,
        });
    }
    return result;
}

/** "NEW MESSAGES" divider with nothing visible below it (all new messages were hidden). */
function dropDanglingUnread(rows: Row[]): Row[] {
    const i = rows.findIndex(r => r.rowType === RowType.UNREAD);
    if (i === -1) return rows;
    for (let j = 0; j < i; j++) if (rows[j].rowType === RowType.MESSAGE) return rows;
    return rows.filter((_, j) => j !== i);
}

/** Rows that only decorate the list: they never count as a day having content. */
const META_ROWS = new Set<unknown>([RowType.DAY, RowType.UNREAD, RowType.LOAD_BEFORE]);

/**
 * Date dividers ("day" rows) whose day lost all its rows: otherwise "1 Oct" would sit right above
 * "2 Oct", or today's date above nothing, revealing that hidden users talked. Rows are newest-first,
 * so a day's content is between its divider and the next divider at a lower index.
 */
export function dropEmptyDays(rows: Row[]): Row[] {
    const drop = new Set<number>();
    let hasContent = false;
    for (let i = 0; i < rows.length; i++) {
        const type = rows[i].rowType;
        if (type === RowType.DAY) {
            if (!hasContent) drop.add(i);
            hasContent = false;
        } else if (!META_ROWS.has(type)) {
            hasContent = true;
        }
    }
    return drop.size ? rows.filter((_, i) => !drop.has(i)) : rows;
}

function processRows(args: any[], rows: Row[]): Row[] {
    if (!isReady()) return [];
    const opts = args[0] ?? {};
    const channelId: string | undefined = opts.channel?.id;
    revealDenied.clear();
    mergedRuns.clear();
    const out = dropEmptyDays(dropDanglingUnread(finish(collect(rows, opts.messages?.revealedMessageId ?? null))));

    if (visibleListener && channelId) {
        const msgs: any[] = [];
        for (const r of out) if (r.rowType === RowType.MESSAGE && r.message) msgs.push(r.message);
        try { visibleListener(channelId, msgs); } catch (e) { log.error("visible listener", e); }
    }
    return out;
}

/**
 * Make the open chat rebuild its rows. The list only rebuilds when the channel's message
 * collection changes; re-applying the current reveal state is the lightest action that does it.
 */
export function rerender(channelId: string | undefined = SelectedChannelStore()?.getChannelId?.()) {
    if (!channelId) return;
    const messageId = MessageStore().getMessages(channelId)?.revealedMessageId ?? null;
    FluxDispatcher.dispatch({ type: "MESSAGE_REVEAL", channelId, messageId, __kb: true });
}

/** Interceptor for taps on bars. Returns true to swallow the action. */
export function interceptReveal(action: any): boolean {
    if (action.type !== "MESSAGE_REVEAL" || action.__kb || !action.messageId) return false;
    const run = mergedRuns.get(action.messageId);
    if (run) {
        const open = run.some(c => expanded.has(c));
        for (const c of run) open ? expanded.delete(c) : expanded.add(c);
        setTimeout(() => rerender(action.channelId), 0);
        return true;
    }
    return revealDenied.has(action.messageId);
}

export function patchRows() {
    const mod = ChannelStreamModule();
    if (!mod) {
        log.error("createChannelStream not found, chat filtering disabled");
        return () => {};
    }
    const unpatch = vendetta.patcher.after("default", mod, (args: any[], rows: Row[]) => {
        if (!Array.isArray(rows)) return rows;
        try {
            return processRows(args, rows);
        } catch (e) {
            log.error("row processing failed", e);
            return rows;
        }
    });
    const offHidden = onHiddenChange(() => rerender());
    return () => {
        unpatch();
        offHidden();
    };
}

