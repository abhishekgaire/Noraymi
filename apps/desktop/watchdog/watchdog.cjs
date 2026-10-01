#!/usr/bin/env node
/* The desktop app's watchdog (M1-29, spec 09): a small separate process the
   operating system runs at login and keeps alive (a launchd agent on macOS,
   a scheduled task on Windows). It starts the app, starts it again when it
   exits, and when the app stops answering (its alive file stops being
   touched) it ends the app and starts it again. No dependencies: it runs on
   the Node.js inside Electron (ELECTRON_RUN_AS_NODE=1) or any Node.js.

   watchdog.cjs --app <executable> --alive <file> [--stale-ms 30000] [--restart-ms 2000] [--poll-ms 1000] [-- app args] */
"use strict";
const { spawn } = require("node:child_process");
const { statSync } = require("node:fs");

function parse(argv) {
  const options = { app: "", alive: "", staleMs: 30_000, restartMs: 2000, pollMs: 1000, args: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") {
      options.args = argv.slice(i + 1);
      break;
    }
    if (a === "--app") options.app = argv[++i];
    else if (a === "--alive") options.alive = argv[++i];
    else if (a === "--stale-ms") options.staleMs = Number(argv[++i]);
    else if (a === "--restart-ms") options.restartMs = Number(argv[++i]);
    else if (a === "--poll-ms") options.pollMs = Number(argv[++i]);
  }
  if (!options.app || !options.alive)
    throw new Error("usage: watchdog.cjs --app <executable> --alive <file> [-- args]");
  return options;
}

function log(line) {
  process.stdout.write(`${new Date().toISOString()} watchdog: ${line}\n`);
}

function run(options) {
  let child = null;
  let stopping = false;
  let startedAt = 0;

  const start = () => {
    startedAt = Date.now();
    child = spawn(options.app, options.args, { stdio: "inherit", env: process.env });
    log(`started ${options.app} (pid ${child.pid})`);
    child.on("exit", (code, signal) => {
      child = null;
      if (stopping) return;
      log(`exited (${code ?? signal}); starting again in ${options.restartMs} ms`);
      setTimeout(start, options.restartMs);
    });
  };

  const aliveAgo = () => {
    try {
      return Date.now() - statSync(options.alive).mtimeMs;
    } catch {
      return Date.now() - startedAt;
    }
  };

  const poll = setInterval(() => {
    if (!child || stopping) return;
    // A fresh start gets a grace period as long as the stale limit before its alive file counts.
    if (Date.now() - startedAt < options.staleMs) return;
    const ago = aliveAgo();
    if (ago > options.staleMs) {
      log(`not answering for ${Math.round(ago / 1000)} s; ending it`);
      child.kill("SIGKILL");
    }
  }, options.pollMs);

  const stop = () => {
    stopping = true;
    clearInterval(poll);
    if (child) child.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  start();
}

if (require.main === module) run(parse(process.argv.slice(2)));
module.exports = { parse };
