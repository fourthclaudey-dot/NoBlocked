// Settings page built from Discord's current table components (the ones its own settings use).
import { t } from "./i18n";
import { rerender } from "./rows";
import { Category, Mode, storage, ThreadMode } from "./settings";
import { refreshThreads } from "./threads";

const { React, ReactNative } = vendetta.metro.common;
const { findByProps } = vendetta.metro;
const { useProxy } = vendetta.storage;

const component = (name: string) => findByProps(name)?.[name];
const Stack = component("Stack");
const TableRowGroup = component("TableRowGroup");
const TableRadioGroup = component("TableRadioGroup");
const TableRadioRow = component("TableRadioRow");
const TableSwitchRow = component("TableSwitchRow");
const TableRow = component("TableRow");

type ModeKey = "inherit" | Mode;

const changed = () => setTimeout(() => rerender(), 0); // let the open chat pick up the change

function ModeGroup({ title, value, options, onChange }: { title: string; value: string; options: ModeKey[]; onChange(v: ModeKey): void }) {
    const labels = t().modes;
    return (
        <TableRadioGroup title={title} value={value} onChange={(v: ModeKey) => { if (!storage.total) { onChange(v); changed(); } }}>
            {options.map(o => <TableRadioRow key={o} label={labels[o]} value={o} disabled={storage.total} />)}
        </TableRadioGroup>
    );
}

function CategorySettings({ cat, title, options }: { cat: Category; title: string; options: ModeKey[] }) {
    const s = storage[cat] as { mode: string; unread: boolean; reactions?: boolean; threads?: ThreadMode };
    const str = t();
    const set = (key: "unread" | "reactions") => (v: boolean) => { s[key] = v; changed(); };
    return (
        <>
            <ModeGroup title={title} value={s.mode} options={options} onChange={v => (s.mode = v)} />
            <TableRowGroup>
                <TableSwitchRow label={str.countsNew} subLabel={str.countsNewNote} value={!storage.total && s.unread} disabled={storage.total} onValueChange={set("unread")} />
                {cat !== "replies" && (
                    <TableSwitchRow label={str.reactions} subLabel={str.reactionsNote} value={storage.total || !!s.reactions} disabled={storage.total} onValueChange={set("reactions")} />
                )}
            </TableRowGroup>
            {cat !== "replies" && (
                <TableRadioGroup
                    title={str.threads}
                    value={storage.total ? "hide" : s.threads}
                    onChange={(v: ThreadMode) => { if (!storage.total) { s.threads = v; refreshThreads(); changed(); } }}
                >
                    <TableRadioRow label={str.threadModes.mask} value="mask" disabled={storage.total} />
                    <TableRadioRow label={str.threadModes.hide} value="hide" disabled={storage.total} />
                </TableRadioGroup>
            )}
        </>
    );
}

export function SettingsPage() {
    useProxy(storage);
    const str = t();
    const toggle = (key: "total" | "merge" | "serverAck") => (v: boolean) => { storage[key] = v; changed(); };

    return (
        <ReactNative.ScrollView style={{ flex: 1 }}>
            <Stack style={{ paddingVertical: 24, paddingHorizontal: 12 }} spacing={24}>
                <TableRowGroup title={str.main}>
                    <TableSwitchRow label={str.total} subLabel={str.totalNote} value={storage.total} onValueChange={toggle("total")} />
                </TableRowGroup>
                <ModeGroup title={str.shared} value={storage.mode} options={["reveal", "bar", "remove"]} onChange={v => (storage.mode = v as any)} />
                <CategorySettings cat="blocked" title={str.blocked} options={["inherit", "reveal", "bar", "remove"]} />
                <CategorySettings cat="ignored" title={str.ignored} options={["inherit", "reveal", "bar", "remove"]} />
                <CategorySettings cat="replies" title={str.replies} options={["off", "reveal", "bar", "remove"]} />
                <TableRowGroup title={str.display}>
                    <TableSwitchRow label={str.merge} subLabel={str.mergeNote} value={storage.merge} onValueChange={toggle("merge")} />
                    <TableSwitchRow label={str.serverAck} subLabel={str.serverAckNote} value={storage.serverAck} onValueChange={toggle("serverAck")} />
                    <TableRow label={str.cached(storage.cache.blocked.length, storage.cache.ignored.length)} />
                </TableRowGroup>
            </Stack>
        </ReactNative.ScrollView>
    );
}
