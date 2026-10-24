// Dev server for the Kettu plugin.
//  - GET  /manifest.json, /index.js   -> fresh build of the plugin (Kettu fetches these)
//  - WS   /                           -> Kettu "debug WebSocket" (logs in, code out)
//  - POST /eval     {code}            -> run code on the device, wait for the result
//  - POST /reload                     -> refetch + restart the plugin on the device
//  - GET  /logs?since=N               -> device log lines (also appended to logs/device.log)
import { appendFileSync, mkdirSync } from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

import { buildPlugin } from "./build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 4041);
export const PLUGIN_URL = `http://localhost:${PORT}/`;

mkdirSync(path.join(root, "logs"), { recursive: true });
const logFile = path.join(root, "logs", "device.log");

/** @type {{ n: number, t: number, level: string, text: string }[]} */
const logs = [];
let logCounter = 0;
/** @type {import("ws").WebSocket | null} */
let device = null;
const pending = new Map(); // eval id -> { resolve, timer }

function pushLog(level, text) {
    const entry = { n: ++logCounter, t: Date.now(), level, text };
    logs.push(entry);
    if (logs.length > 5000) logs.shift();
    appendFileSync(logFile, `${new Date(entry.t).toISOString()} [${level}] ${text}\n`);
    return entry;
}

function stringifyArg(a) {
    return typeof a === "string" ? a : JSON.stringify(a);
}

function handleDeviceMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return pushLog("raw", raw.toString()); }
    if (msg.type === "hello") return pushLog("info", `device hello v${msg.data?.version}`);
    if (msg.type !== "log") return pushLog("raw", raw.toString());

    const args = msg.data?.message ?? [];
    const first = typeof args[0] === "string" ? args[0] : "";
    // Eval results are tagged by the wrapper below: "\u0001R<id>" / "\u0001E<id>"
    const m = /^\u0001([RE])(\d+)$/.exec(first);
    if (m) {
        const p = pending.get(Number(m[2]));
        if (p) {
            clearTimeout(p.timer);
            pending.delete(Number(m[2]));
            p.resolve({ ok: m[1] === "R", result: args[1] });
        }
        return;
    }
    const text = args.map(stringifyArg).join(" ");
    // Kettu also mirrors console output through nativeLoggingHook as a preformatted string; drop the eval-tag echoes.
    if (text.includes("\u0001") || text.includes("\\u0001")) return;
    pushLog(msg.data.level ?? "default", text);
}

// Runs on the device: a cycle/depth-safe inspector so results survive JSON transport.
const INSPECT_SRC = `function(v, depth) {
    var seen = [];
    function ins(v, d) {
        if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return v === undefined ? "<undefined>" : v;
        if (typeof v === "string") return v.length > 4000 ? v.slice(0, 4000) + "…(" + v.length + ")" : v;
        if (typeof v === "function") return "<fn " + (v.displayName || v.name || "anon") + "(" + v.length + ")>";
        if (typeof v === "symbol" || typeof v === "bigint") return String(v);
        if (v instanceof Error) return { __error: String(v), stack: String(v.stack || "").split("\\n").slice(0, 8).join("\\n") };
        if (seen.indexOf(v) !== -1) return "<cycle>";
        if (d >= depth) return Array.isArray(v) ? "<array " + v.length + ">" : "<object " + ((v.constructor && v.constructor.name) || "") + " keys=" + Object.keys(v).length + ">";
        seen.push(v);
        var out;
        if (Array.isArray(v)) {
            out = [];
            for (var i = 0; i < Math.min(v.length, 100); i++) out.push(ins(v[i], d + 1));
            if (v.length > 100) out.push("…+" + (v.length - 100));
        } else if (v instanceof Map || v instanceof Set) {
            out = { __type: v.constructor.name, size: v.size, entries: ins(Array.from(v).slice(0, 50), d + 1) };
        } else {
            out = {};
            var keys = Object.keys(v);
            for (var j = 0; j < Math.min(keys.length, 150); j++) {
                var k = keys[j];
                try { out[k] = ins(v[k], d + 1); } catch (e) { out[k] = "<throws " + e + ">"; }
            }
            if (keys.length > 150) out["…"] = "+" + (keys.length - 150) + " keys";
        }
        seen.pop();
        return out;
    }
    return ins(v, 0);
}`;

let evalCounter = 0;
async function evalOnDevice(code, { depth = 3, timeout = 20000 } = {}) {
    if (!device || device.readyState !== 1) return { ok: false, result: "device not connected" };
    const id = ++evalCounter;
    // `code` is the body of a function (already transpiled by the client into ES5-ish code);
    // its return value (or awaited promise) is sent back.
    const wrapped = `(function(){var __ins=(${INSPECT_SRC});var __log=globalThis.__kbOrigLog||console.log;` +
        `function done(t,v){console.log("\\u0001"+t+"${id}", t==="R"?__ins(v,${depth}):__ins(v,2));}` +
        `try{Promise.resolve((function(){${code}\n})()).then(function(v){done("R",v)},function(e){done("E",e)});}catch(e){done("E",e)}})()`;
    return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, result: "timeout" }); }, timeout);
        pending.set(id, { resolve, timer });
        device.send(JSON.stringify({ type: "run", data: { code: wrapped } }));
    });
}

const RELOAD_CODE = `
var id = ${JSON.stringify(PLUGIN_URL)};
var P = vendetta.plugins;
if (!P.plugins[id]) return P.installPlugin(id).then(function(){ return "installed"; });
try { P.stopPlugin(id, false); } catch (e) {}
return P.fetchPlugin(id).then(function(){ return P.startPlugin(id); }).then(function(){ return "reloaded " + P.plugins[id].manifest.hash + " enabled=" + P.plugins[id].enabled; });
`;

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", c => data += c);
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}

function send(res, status, body, type = "application/json") {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
        if (req.method === "GET" && (url.pathname === "/manifest.json" || url.pathname === "/index.js")) {
            const { js, manifest, hash, ms } = await buildPlugin({ dev: true, debuggerHost: `localhost:${PORT}` });
            if (url.pathname === "/manifest.json") pushLog("server", `served manifest ${hash} (build ${ms}ms)`);
            return url.pathname === "/index.js" ? send(res, 200, js, "application/javascript") : send(res, 200, manifest);
        }
        if (req.method === "GET" && url.pathname === "/status") {
            return send(res, 200, { connected: !!device && device.readyState === 1, logs: logCounter, pluginUrl: PLUGIN_URL });
        }
        if (req.method === "GET" && url.pathname === "/logs") {
            const since = Number(url.searchParams.get("since") ?? 0);
            return send(res, 200, logs.filter(l => l.n > since));
        }
        if (req.method === "POST" && url.pathname === "/eval") {
            const { code, depth, timeout } = JSON.parse(await readBody(req));
            return send(res, 200, await evalOnDevice(code, { depth, timeout }));
        }
        if (req.method === "POST" && url.pathname === "/reload") {
            await buildPlugin({ dev: true, debuggerHost: `localhost:${PORT}` });
            return send(res, 200, await evalOnDevice(RELOAD_CODE, { timeout: 30000 }));
        }
        send(res, 404, { error: "not found" });
    } catch (e) {
        pushLog("server-error", String(e?.stack ?? e));
        send(res, 500, { error: String(e?.message ?? e) });
    }
});

const wss = new WebSocketServer({ server });
wss.on("connection", ws => {
    if (device && device !== ws) device.close();
    device = ws;
    pushLog("server", "device connected");
    ws.on("message", handleDeviceMessage);
    // Heartbeat: lets the dev build of the plugin know the debugger is already attached (see src/index.tsx).
    const ping = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: "run", data: { code: "globalThis.__kbDevPing=Date.now()" } }));
    ping();
    const hb = setInterval(ping, 2000);
    ws.on("close", () => clearInterval(hb));
    ws.on("close", () => { if (device === ws) device = null; pushLog("server", "device disconnected"); });
});

server.listen(PORT, "127.0.0.1", () => console.log(`kettu-blocks dev server on http://127.0.0.1:${PORT} (plugin url ${PLUGIN_URL})`));
