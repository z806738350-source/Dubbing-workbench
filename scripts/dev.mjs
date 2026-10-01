import { spawn } from "node:child_process";
const processes = [
  spawn(process.execPath, ["--watch", "server/index.mjs"], {
    stdio: "inherit",
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit",
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  processes.forEach((p) => p.kill("SIGTERM"));
  process.exitCode = code;
}
for (const p of processes) p.on("exit", (code) => stop(code || 0));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
