declare const __DEV__: boolean;
declare const __DEBUGGER_HOST__: string;

type Unpatch = () => void;

/** The parts of Kettu's Vendetta-compatible plugin API that NoBlocked uses. */
declare const vendetta: {
    patcher: {
        before(name: string, target: any, cb: (args: any[]) => unknown): Unpatch;
        after(name: string, target: any, cb: (args: any[], ret: any) => unknown): Unpatch;
        instead(name: string, target: any, cb: (args: any[], orig: (...a: any[]) => any) => unknown): Unpatch;
    };
    metro: {
        findByStoreName(name: string): any;
        findByProps(...props: string[]): any;
        findByName(name: string, defaultExport?: boolean): any;
        common: { FluxDispatcher: any; React: any; ReactNative: any; toasts: any };
    };
    plugin: { id: string; storage: any };
    plugins: { plugins: Record<string, any>; fetchPlugin(id: string): Promise<void> };
    storage: { useProxy(store: object): void };
    logger: Record<"log" | "warn" | "error", (...args: unknown[]) => void>;
    settings: any;
    debug: { connectToDebugger(url: string): void };
};
