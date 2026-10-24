import { t } from "./i18n";
import { rerender } from "./rows";
import { Category, Mode, storage } from "./settings";

const React = vendetta.metro.common.React;
const { ScrollView } = vendetta.metro.common.ReactNative;
const { FormSection, FormRadioRow, FormSwitchRow, FormDivider, FormText } = vendetta.ui.components.Forms;
const { useProxy } = vendetta.storage;

type ModeKey = "inherit" | Mode;

function changed() {
    // let the open chat pick up the new settings
    setTimeout(() => rerender(), 0);
}

function ModePicker({ value, options, onChange, disabled }: { value: string; options: ModeKey[]; onChange(v: ModeKey): void; disabled?: boolean }) {
    const labels = t().modes;
    return (
        <>
            {options.map(o => (
                <FormRadioRow
                    key={o}
                    label={labels[o]}
                    selected={value === o}
                    disabled={disabled}
                    onPress={() => { if (!disabled) { onChange(o); changed(); } }}
                />
            ))}
        </>
    );
}

function CategorySection({ cat, title, options }: { cat: Category; title: string; options: ModeKey[] }) {
    const s = storage[cat] as { mode: string; unread: boolean };
    const str = t();
    return (
        <FormSection title={title}>
            <ModePicker value={s.mode} options={options} disabled={storage.total} onChange={v => (s.mode = v)} />
            <FormDivider />
            <FormSwitchRow
                label={str.countsNew}
                subLabel={str.countsNewNote}
                value={!storage.total && s.unread}
                disabled={storage.total}
                onValueChange={(v: boolean) => { s.unread = v; changed(); }}
            />
        </FormSection>
    );
}

export function SettingsPage() {
    useProxy(storage);
    const str = t();
    const toggle = (key: "total" | "merge" | "reactions" | "serverAck") => (v: boolean) => {
        storage[key] = v;
        changed();
    };

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 48 }}>
            <FormSection title={str.main}>
                <FormSwitchRow label={str.total} subLabel={str.totalNote} value={storage.total} onValueChange={toggle("total")} />
            </FormSection>

            <FormSection title={str.shared}>
                <ModePicker value={storage.mode} options={["reveal", "bar", "remove"]} disabled={storage.total} onChange={v => (storage.mode = v as any)} />
            </FormSection>

            <CategorySection cat="blocked" title={str.blocked} options={["inherit", "reveal", "bar", "remove"]} />
            <CategorySection cat="ignored" title={str.ignored} options={["inherit", "reveal", "bar", "remove"]} />
            <CategorySection cat="replies" title={str.replies} options={["off", "reveal", "bar", "remove"]} />

            <FormSection title={str.display}>
                <FormSwitchRow label={str.merge} subLabel={str.mergeNote} value={storage.merge} onValueChange={toggle("merge")} />
                <FormSwitchRow label={str.reactions} subLabel={str.reactionsNote} value={storage.reactions} onValueChange={toggle("reactions")} />
                <FormSwitchRow label={str.serverAck} subLabel={str.serverAckNote} value={storage.serverAck} onValueChange={toggle("serverAck")} />
            </FormSection>

            <FormText style={{ paddingHorizontal: 16, opacity: 0.6 }}>
                {str.cached(storage.cache.blocked.length, storage.cache.ignored.length)}
            </FormText>
        </ScrollView>
    );
}
