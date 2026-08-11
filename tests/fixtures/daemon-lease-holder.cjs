"use strict";

const fs = require("node:fs");

const nativeFileLockPath = process.argv[2];
const leasePath = process.argv[3];
if (nativeFileLockPath === undefined || leasePath === undefined) {
  throw new Error("Expected native file-lock module path and lease path.");
}

const { tryLock } = require(nativeFileLockPath);
const descriptor = fs.openSync(
  leasePath,
  fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
  0o600
);
if (!tryLock(descriptor)) throw new Error("Fixture lock was unexpectedly held.");
process.stdout.write("acquired\n");
setInterval(() => {}, 2 ** 30);
