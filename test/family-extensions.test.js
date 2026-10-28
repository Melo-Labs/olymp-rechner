"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAuditLog, buildAuditFeed } = require("../audit-log");
const { createFamilyTreasury } = require("../family-treasury");
const { familyRankRoleName } = require("../family-ranks");
const { createTicketTopic, parseTicketTopic } = require("../ticket-utils");

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "olymp-ext-"));
  const file = path.join(dir, "data.json");
  fs.writeFileSync(file, "[]");
  return file;
}

test("family treasury books deposits and withdrawals and blocks overdrafts", () => {
  const treasury = createFamilyTreasury(tempFile());
  const actor = { id: "1", name: "Test" };
  assert.equal(treasury.deposit("fam", "Fam", 500, "Start", actor).balance, 500);
  assert.equal(treasury.withdraw("fam", "Fam", 200, "Waffen", actor).balance, 300);
  assert.throws(() => treasury.withdraw("fam", "Fam", 301, "zu viel", actor), /reicht nicht aus/);
  assert.throws(() => treasury.deposit("fam", "Fam", 0, "", actor));
  assert.throws(() => treasury.deposit("fam", "Fam", 1.5, "", actor));
  assert.equal(treasury.getAccount("fam").transactions.length, 2);
});

test("family treasury renames and removes accounts", () => {
  const treasury = createFamilyTreasury(tempFile());
  treasury.deposit("alt", "Alt", 10, "x", {});
  assert.equal(treasury.rename("alt", "neu", "Neu"), true);
  assert.equal(treasury.getAccount("neu").name, "Neu");
  assert.equal(treasury.remove("neu").balance, 10);
  assert.equal(treasury.remove("neu"), null);
});

test("audit log records entries and merges feeds with filters", () => {
  const audit = createAuditLog(tempFile());
  audit.record({ category: "coupon", action: "Coupon erstellt", subject: "ABC" });
  audit.record({ category: "ticket", action: "Ticket übernommen", subject: "ticket-1" });
  assert.throws(() => audit.record({ category: "unbekannt", action: "x" }));
  const all = buildAuditFeed({ audit: audit.read(), family: [], ledger: [], limit: 50 });
  assert.equal(all.length, 2);
  const filtered = buildAuditFeed({ audit: audit.read(), family: [], ledger: [], category: "coupon", limit: 50 });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].subject, "ABC");
});

test("family rank role names are built and length checked", () => {
  assert.equal(familyRankRoleName("Olymp", "boss"), "Olymp | Boss");
  assert.equal(familyRankRoleName("Olymp", "unterboss"), "Olymp | Unterboss");
  assert.throws(() => familyRankRoleName("x".repeat(100), "boss"));
  assert.throws(() => familyRankRoleName("Olymp", "king"));
});

test("ticket topic keeps the claimer", () => {
  const base = { ownerId: "123456789012345678", type: "Support", status: "open", createdAt: new Date().toISOString() };
  const topic = createTicketTopic({ ...base, claimedBy: "223456789012345678" });
  assert.equal(parseTicketTopic(topic).claimedBy, "223456789012345678");
});
