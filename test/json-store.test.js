"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeJsonAtomically } = require("../json-store");

test("writes and replaces JSON without leaving temporary files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "olymp-json-store-"));
  const file = path.join(directory, "nested", "state.json");
  try {
    writeJsonAtomically(file, [{ version: 1 }]);
    writeJsonAtomically(file, [{ version: 2 }]);

    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [{ version: 2 }]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
