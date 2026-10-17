// Starts each built server (`pnpm build` first) with no configuration. A
// working bundle loads all its modules and then stops at configuration
// validation; a broken one (for example a bundled CommonJS dependency that
// cannot require Node built-ins) crashes before that. Development runs the
// TypeScript source, so this is the only check that the built output starts.
import { spawnSync } from "node:child_process";

const SERVERS = [
  { name: "api", entry: "apps/api/dist/server.js", expect: "Invalid API configuration" },
  { name: "worker", entry: "apps/worker/dist/main.js", expect: "Invalid worker configuration" },
];

let failed = false;
for (const server of SERVERS) {
  // Only PATH and the Node runtime: no .env, no database.
  const run = spawnSync(process.execPath, [server.entry], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 30_000 });
  const output = `${run.stdout}${run.stderr}`;
  if (output.includes(server.expect)) {
    console.log(`${server.name}: bundle loads`);
  } else {
    failed = true;
    console.error(`${server.name}: bundle failed before configuration was checked:\n${output.slice(0, 2000)}`);
  }
}
process.exit(failed ? 1 : 0);
