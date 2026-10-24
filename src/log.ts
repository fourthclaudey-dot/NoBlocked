// Plugin logger; dev builds mirror into console so the debug WebSocket sees it.
const pluginLogger = vendetta.logger;

function make(level: "log" | "warn" | "error") {
    return (...args: any[]) => {
        pluginLogger[level](...args);
        if (__DEV__) console[level]("[NoBlocked]", ...args);
    };
}

export const log = { info: make("log"), warn: make("warn"), error: make("error") };
