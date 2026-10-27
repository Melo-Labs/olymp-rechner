"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function createDataBackup({ directory, files, now = new Date(), retention = 30 }) {
  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error("Ein Backup-Verzeichnis muss angegeben werden.");
  }
  if (!Array.isArray(files) || !Number.isSafeInteger(retention) || retention < 1) {
    throw new Error("Die Backup-Dateien oder Aufbewahrungsdauer sind ungültig.");
  }

  const backupRoot = path.resolve(directory);
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupRoot, `backup-${timestamp}-${crypto.randomUUID()}`);
  fs.mkdirSync(backupPath, { mode: 0o700 });

  try {
    const seen = new Set();
    const copiedFiles = [];
    for (const entry of files) {
      if (!entry || typeof entry.name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(entry.name)
        || typeof entry.path !== "string" || seen.has(entry.name)) {
        throw new Error("Eine Backup-Dateiangabe ist ungültig oder doppelt.");
      }
      seen.add(entry.name);
      if (!fs.existsSync(entry.path)) continue;

      const contents = fs.readFileSync(entry.path);
      const fileName = `${entry.name}.json`;
      fs.writeFileSync(path.join(backupPath, fileName), contents, { flag: "wx", mode: 0o600 });
      copiedFiles.push({
        name: entry.name,
        file: fileName,
        sourceName: path.basename(entry.path),
        bytes: contents.length,
        sha256: crypto.createHash("sha256").update(contents).digest("hex")
      });
    }

    const manifest = {
      version: 1,
      createdAt: now.toISOString(),
      files: copiedFiles
    };
    fs.writeFileSync(
      path.join(backupPath, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { flag: "wx", mode: 0o600 }
    );
  } catch (error) {
    try {
      fs.rmSync(backupPath, { recursive: true });
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }

  const backups = fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith("backup-"))
    .map(entry => {
      const backup = path.join(backupRoot, entry.name);
      const manifest = JSON.parse(fs.readFileSync(path.join(backup, "manifest.json"), "utf8"));
      const createdAt = Date.parse(manifest.createdAt);
      if (!Number.isFinite(createdAt)) throw new Error(`Backup-Zeitstempel ist ungültig: ${entry.name}`);
      return { path: backup, createdAt };
    })
    .sort((left, right) => right.createdAt - left.createdAt);

  for (const backup of backups.slice(retention)) {
    fs.rmSync(backup.path, { recursive: true });
  }
  return backupPath;
}

module.exports = { createDataBackup };
