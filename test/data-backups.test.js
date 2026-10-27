"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createDataBackup } = require("../data-backups");

function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "olymp-backup-"));
  try {
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("creates verifiable snapshots without changing source files", () => {
  withDirectory(directory => {
    const sourcePath = path.join(directory, "orders.json");
    const sourceContent = '[{"id":"test-order"}]\n';
    fs.writeFileSync(sourcePath, sourceContent);

    const backupPath = createDataBackup({
      directory: path.join(directory, "backups"),
      files: [{ name: "admin-orders", path: sourcePath }],
      now: new Date("2026-10-27T18:00:00.000Z")
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(backupPath, "manifest.json"), "utf8"));
    const backedUpContent = fs.readFileSync(path.join(backupPath, "admin-orders.json"), "utf8");

    assert.equal(backedUpContent, sourceContent);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceContent);
    assert.deepEqual(manifest.files, [{
      name: "admin-orders",
      file: "admin-orders.json",
      sourceName: "orders.json",
      bytes: Buffer.byteLength(sourceContent),
      sha256: crypto.createHash("sha256").update(sourceContent).digest("hex")
    }]);
  });
});

test("keeps only the configured number of latest snapshots", () => {
  withDirectory(directory => {
    const backupRoot = path.join(directory, "backups");
    const files = [];
    for (let day = 1; day <= 3; day++) {
      files.push(createDataBackup({
        directory: backupRoot,
        files: [],
        now: new Date(`2026-10-0${day}T00:00:00.000Z`),
        retention: 2
      }));
    }

    assert.equal(fs.readdirSync(backupRoot).length, 2);
    assert.equal(fs.existsSync(files[0]), false);
    assert.equal(fs.existsSync(files[1]), true);
    assert.equal(fs.existsSync(files[2]), true);
  });
});

test("rejects unsafe or invalid backup settings", () => {
  assert.throws(() => createDataBackup({ directory: "", files: [] }), /Backup-Verzeichnis/);
  assert.throws(() => createDataBackup({ directory: "backups", files: [], retention: 0 }), /Backup-Dateien/);
});
