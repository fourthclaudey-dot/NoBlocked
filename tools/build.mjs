// Builds src/index.tsx into a Vendetta-style plugin (dist/manifest.json + dist/index.js).
// Kettu evaluates plugins as `vendetta => { return <js> }`, so the output must be a single expression.
import swc from "@swc/core";
import crypto from "crypto";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

// Modules that live inside Discord's runtime; resolved to globals at eval time.
const globals = {
    "react": "window.React",
    "react-native": "vendetta.metro.common.ReactNative",
    "react/jsx-runtime": "vendetta.metro.find(m => m.jsx && m.jsxs)",
};

const swcPlugin = {
    name: "swc",
    setup(b) {
        b.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
            if (args.path.includes("node_modules")) return;
            const result = await swc.transformFile(args.path, {
                jsc: {
                    externalHelpers: true,
                    parser: { syntax: "typescript", tsx: args.path.endsWith("x") },
                    transform: { react: { runtime: "classic", pragma: "React.createElement", pragmaFrag: "React.Fragment" } },
                },
                // Same Hermes targets Kettu itself uses
                env: {
                    targets: "fully supports es6",
                    include: ["transform-block-scoping", "transform-classes", "transform-async-to-generator", "transform-async-generator-functions"],
                    exclude: ["transform-parameters", "transform-template-literals", "transform-exponentiation-operator", "transform-named-capturing-groups-regex", "transform-nullish-coalescing-operator", "transform-object-rest-spread", "transform-optional-chaining", "transform-logical-assignment-operators"],
                },
            });
            return { contents: result.code, loader: "js" };
        });
    },
};

const globalsPlugin = {
    name: "globals",
    setup(b) {
        const filter = new RegExp(`^(${Object.keys(globals).map(k => k.replace(/[/]/g, "\\/")).join("|")})$`);
        b.onResolve({ filter }, args => ({ path: args.path, namespace: "globals" }));
        b.onLoad({ filter: /.*/, namespace: "globals" }, args => ({ contents: `module.exports = ${globals[args.path]};`, loader: "js" }));
    },
};

export async function buildPlugin({ dev = false, debuggerHost = "localhost:4041" } = {}) {
    const started = Date.now();
    const result = await build({
        entryPoints: [path.join(root, "src/index.tsx")],
        bundle: true,
        write: false,
        format: "cjs",
        platform: "neutral",
        target: "es2020",
        supported: { "const-and-let": false },
        legalComments: "none",
        minifySyntax: true, // folds `if (__DEV__)`: release builds carry no dev code
        define: { __DEV__: JSON.stringify(dev), __DEBUGGER_HOST__: JSON.stringify(debuggerHost) },
        logLevel: "silent",
        plugins: [globalsPlugin, swcPlugin],
    });

    const body = result.outputFiles[0].text;
    const js = `(() => {\nvar module = { exports: {} }, exports = module.exports;\n${body}\nreturn module.exports;\n})()`;
    const hash = crypto.createHash("sha256").update(js).digest("hex").slice(0, 16);

    const base = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    const manifest = { ...base, main: "index.js", hash };

    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, "index.js"), js);
    await writeFile(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
    return { js, manifest, hash, ms: Date.now() - started };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const { hash, ms, js } = await buildPlugin();
    console.log(`built ${hash} in ${ms}ms (${js.length} bytes)`);
}
