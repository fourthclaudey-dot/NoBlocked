// ESLint 8 only picks up eslint.config.mjs (flat config) when asked to.
import { spawnSync } from "child_process";

process.env.ESLINT_USE_FLAT_CONFIG = "true";
const { status } = spawnSync("npx", ["eslint", "src", ...process.argv.slice(2)], { stdio: "inherit", shell: true });
process.exit(status ?? 1);
