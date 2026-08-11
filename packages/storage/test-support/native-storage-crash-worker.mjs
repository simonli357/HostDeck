import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromStorage = createRequire(
  fileURLToPath(new URL("../package.json", import.meta.url))
);
const Database = requireFromStorage("better-sqlite3");

try {
  const [mode, source, auxiliary, signal] = process.argv.slice(2);
  requirePath(source);
  requirePath(auxiliary);
  requirePath(signal);
  if (mode === "migration") {
    runInterruptedMigration(source, auxiliary, signal);
  } else if (mode === "restore") {
    await runInterruptedRestore(source, auxiliary, signal);
  } else {
    throw new TypeError("Unknown native storage worker mode.");
  }
} catch {
  process.stderr.write("Native storage crash worker failed.\n");
  process.exitCode = 1;
}

function runInterruptedMigration(databasePath, migrationPath, signalPath) {
  const migration = JSON.parse(readFileSync(migrationPath, "utf8"));
  if (
    migration === null ||
    typeof migration !== "object" ||
    Object.keys(migration).sort().join(",") !== "sql,version" ||
    typeof migration.version !== "string" ||
    typeof migration.sql !== "string"
  ) {
    throw new TypeError("Migration fixture is invalid.");
  }
  const database = new Database(databasePath, { fileMustExist: true });
  database.pragma("foreign_keys = ON");
  database.exec("BEGIN IMMEDIATE");
  database.exec(migration.sql);
  database
    .prepare(
      "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)"
    )
    .run(
      migration.version,
      createHash("sha256").update(migration.sql).digest("hex"),
      "2026-08-11T12:00:00.000Z"
    );
  signalAndWait(signalPath);
}

async function runInterruptedRestore(backupPath, databasePath, signalPath) {
  const source = new Database(backupPath, {
    fileMustExist: true,
    readonly: true
  });
  let progressCount = 0;
  await source.backup(databasePath, {
    progress() {
      progressCount += 1;
      if (progressCount >= 2) signalAndWait(signalPath);
      return 1;
    }
  });
  source.close();
  throw new Error("Interrupted restore unexpectedly completed.");
}

function signalAndWait(signalPath) {
  writeFileSync(signalPath, "ready\n", { flag: "wx", mode: 0o600 });
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0);
}

function requirePath(candidate) {
  if (
    typeof candidate !== "string" ||
    !isAbsolute(candidate) ||
    candidate.includes("\0")
  ) {
    throw new TypeError("Native storage worker path is invalid.");
  }
}
