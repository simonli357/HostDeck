"use strict";

const fs = require("node:fs");

const fsExtPath = process.argv[2];
const leasePath = process.argv[3];
if (fsExtPath === undefined || leasePath === undefined) {
  throw new Error("Expected fs-ext module path and lease path.");
}

const { flockSync } = require(fsExtPath);
const descriptor = fs.openSync(
  leasePath,
  fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
  0o600
);
flockSync(descriptor, "ex");
process.stdout.write("acquired\n");
setInterval(() => {}, 2 ** 30);
