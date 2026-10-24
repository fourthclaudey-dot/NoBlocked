// Small adb wrapper for the dev loop.
//   node tools/adb.mjs reverse          forward phone localhost:4041 -> PC dev server
//   node tools/adb.mjs restart          force-stop + launch Discord (re-applies reverse)
//   node tools/adb.mjs open             bring Discord to the front without restarting
//   node tools/adb.mjs shot [out.png]   screenshot (default logs/shot.png)
//   node tools/adb.mjs tap X Y | swipe X1 Y1 X2 Y2 [ms] | text "..." | key KEYCODE
//   node tools/adb.mjs ui [filter]      dump visible UI nodes (text/desc/bounds)
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADB = process.env.ADB ?? "adb"; // set ADB=/path/to/adb if it is not on PATH
const PKG = process.env.DISCORD_PACKAGE ?? "cocobo1.pupu.app";
const PORT = process.env.PORT ?? "4041";
const USER = process.env.ANDROID_USER ?? "0";

const adb = (...args) => execFileSync(ADB, args, { maxBuffer: 64 * 1024 * 1024 });
const sh = cmd => adb("shell", cmd).toString();
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Some Android skins with "app clone" / "dual apps" show a chooser even for explicit launches.
 * The original is the left icon; the clone lives in another Android user and is never picked.
 */
function pickOriginalIfAsked() {
    for (let i = 0; i < 20; i++) {
        const top = sh("dumpsys activity activities | grep topResumedActivity || true");
        if (top.includes(`u${USER} ${PKG}/`)) return;
        if (top.includes("DoubleAppResolverActivity")) {
            sleep(700); // let the sheet finish sliding in, taps during the animation are lost
            const [w, h] = sh("wm size").match(/(\d+)x(\d+)/).slice(1).map(Number);
            sh(`input tap ${Math.round(w * 0.287)} ${Math.round(h * 0.9025)}`);
            console.log("dual-app chooser: picked original");
        }
        sleep(400);
    }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
    case "reverse":
        adb("reverse", `tcp:${PORT}`, `tcp:${PORT}`);
        console.log(adb("reverse", "--list").toString());
        break;
    case "restart":
        adb("reverse", `tcp:${PORT}`, `tcp:${PORT}`);
        // Always pin the Android user: with an app clone installed, `am force-stop` without --user
        // would also kill the clone.
        sh(`am force-stop --user ${USER} ${PKG}`);
        sh(`am start --user ${USER} -n ${PKG}/com.discord.main.MainDefault`);
        pickOriginalIfAsked();
        console.log("restarted");
        break;
    case "open": // bring Kettu to the front without restarting it
        adb("reverse", `tcp:${PORT}`, `tcp:${PORT}`);
        sh(`am start --user ${USER} -n ${PKG}/com.discord.main.MainDefault`);
        pickOriginalIfAsked();
        console.log("opened");
        break;
    case "shot": {
        const out = path.resolve(rest[0] ?? path.join(root, "logs", "shot.png"));
        mkdirSync(path.dirname(out), { recursive: true });
        writeFileSync(out, adb("exec-out", "screencap", "-p"));
        console.log(out);
        break;
    }
    case "tap": sh(`input tap ${rest[0]} ${rest[1]}`); break;
    case "swipe": sh(`input swipe ${rest.join(" ")}`); break;
    case "key": sh(`input keyevent ${rest[0]}`); break;
    case "text": sh(`input text ${JSON.stringify(rest.join(" ").replace(/ /g, "%s"))}`); break;
    case "ui": {
        sh("uiautomator dump /sdcard/kb-ui.xml");
        const xml = sh("cat /sdcard/kb-ui.xml");
        const filter = (rest[0] ?? "").toLowerCase();
        for (const m of xml.matchAll(/<node [^>]*>/g)) {
            const a = Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(x => [x[1], x[2]]));
            const label = [a.text, a["content-desc"]].filter(Boolean).join(" | ");
            if (!label && !a.clickable?.includes("true")) continue;
            if (filter && !label.toLowerCase().includes(filter) && !a["resource-id"]?.toLowerCase().includes(filter)) continue;
            console.log(`${a.bounds}  ${a.class?.split(".").pop()}  ${label}${a["resource-id"] ? `  #${a["resource-id"]}` : ""}`);
        }
        break;
    }
    default:
        console.log("usage: reverse | restart | shot [file] | tap x y | swipe ... | key code | text str | ui [filter]");
}
