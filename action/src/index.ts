import { run } from "./run.js";

run({ env: process.env }).then(
  (result) => {
    process.exitCode = result.exitCode;
  },
  (err: Error) => {
    process.stdout.write(`::error::ArchGuard failed: ${err.message.replace(/\n/g, "%0A")}\n`);
    process.exitCode = 1;
  },
);
