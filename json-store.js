"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];
const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      const retryable = ["EPERM", "EACCES", "EBUSY"].includes(error.code);
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) throw error;
      Atomics.wait(waitBuffer, 0, 0, delay);
    }
  }
}

function writeJsonAtomically(filePath, value) {
  if (typeof filePath !== "string" || !filePath) throw new Error("Ein JSON-Dateipfad muss angegeben werden.");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    renameWithRetry(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw error;
  }
}

module.exports = { writeJsonAtomically };
