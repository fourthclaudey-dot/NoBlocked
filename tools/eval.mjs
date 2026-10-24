// Run JS on the phone through the dev server and print the result.
//   node tools/eval.mjs "RelationshipStore.getBlockedIDs()"     (expression)
//   node tools/eval.mjs -f scratch.js                          (function body, use `return`)
//   node tools/eval.mjs --reload                               (refetch + restart plugin)
//   node tools/eval.mjs --logs [since]                         (dump device logs)
// Code may use `await`; it is transpiled for Hermes first. Helpers available on device:
//   vendetta, bunny, find/findByProps/findByStoreName (from vendetta.metro)
import swc from "@swc/core";
import { readFileSync } from "fs";

const PORT = Number(process.env.PORT ?? 4041);
const base = `http://127.0.0.1:${PORT}`;
const argv = process.argv.slice(2);

function opt(name, fallback) {
    const i = argv.indexOf(name);
    if (i === -1) return fallback;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
}

const PRELUDE = `var M = vendetta.metro, find = M.find, findByProps = M.findByProps, findByStoreName = M.findByStoreName, findByName = M.findByName, F = M.common.FluxDispatcher;`;

function transpile(body) {
    let src = `async function __kb(){ ${PRELUDE}\nreturn (${body}\n); }`;
    try { swc.parseSync(src, { syntax: "typescript" }); } catch {
        src = `async function __kb(){ ${PRELUDE}\n${body}\n }`;
    }
    const { code } = swc.transformSync(src, {
        jsc: { parser: { syntax: "typescript" }, externalHelpers: false, target: undefined },
        env: { targets: "fully supports es6", include: ["transform-block-scoping", "transform-classes", "transform-async-to-generator"] },
        isModule: false,
    });
    return `${code}\nreturn __kb();`;
}

async function post(path, payload) {
    const r = await fetch(base + path, { method: "POST", body: JSON.stringify(payload ?? {}) });
    return r.json();
}

if (argv[0] === "--reload") {
    console.log(JSON.stringify(await post("/reload"), null, 2));
} else if (argv[0] === "--logs") {
    const r = await fetch(`${base}/logs?since=${argv[1] ?? 0}`);
    for (const l of await r.json()) console.log(`${l.n} [${l.level}] ${l.text}`);
} else {
    const depth = Number(opt("--depth", 3));
    const timeout = Number(opt("--timeout", 20000));
    const file = opt("-f");
    const body = file ? readFileSync(file, "utf8") : argv.join(" ");
    const res = await post("/eval", { code: transpile(body), depth, timeout });
    console.log(res.ok ? "" : "ERROR:");
    console.log(typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2));
    process.exitCode = res.ok ? 0 : 1;
}
