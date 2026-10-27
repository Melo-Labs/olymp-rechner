"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLedger, periodRange, summarize } = require("../ledger");

function withLedger(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "olymp-ledger-"));
  const ledger = createLedger(path.join(directory, "ledger.json"));
  try {
    run(ledger);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("syncs accepted orders once and records buyback as expense", () => {
  withLedger(ledger => {
    const acceptedOrder = {
      id: "order-income",
      type: "material",
      totalPrice: 1250,
      status: "Angenommen",
      createdAt: "2026-10-25T10:00:00.000Z",
      updatedAt: "2026-10-26T10:00:00.000Z",
      updatedBy: "Admin"
    };
    const acceptedOffer = {
      id: "order-expense",
      type: "sell-offer",
      totalPrice: 300,
      status: "Erledigt",
      createdAt: "2026-10-25T10:00:00.000Z",
      updatedAt: "2026-10-26T11:00:00.000Z",
      updatedBy: "Admin"
    };

    assert.equal(ledger.syncOrder(acceptedOrder).added.kind, "income");
    assert.equal(ledger.syncOrder(acceptedOrder).added, null);
    assert.equal(ledger.syncOrder(acceptedOffer).added.kind, "expense");
    const summary = summarize(ledger.read());
    assert.equal(summary.income, 1250);
    assert.equal(summary.expense, 300);
    assert.equal(summary.net, 950);
    assert.equal(summary.count, 2);
  });
});

test("does not book open orders and voids orders when status is rolled back", () => {
  withLedger(ledger => {
    const order = {
      id: "order-transition",
      type: "custom",
      totalPrice: 600,
      status: "Neu",
      createdAt: "2026-10-25T10:00:00.000Z"
    };
    assert.equal(ledger.syncOrder(order).added, null);
    order.status = "Angenommen";
    order.updatedAt = "2026-10-26T10:00:00.000Z";
    assert.ok(ledger.syncOrder(order).added);
    order.status = "Abgelehnt";
    const cancelled = ledger.syncOrder(order);
    assert.ok(cancelled.voided.voided);
    assert.equal(summarize(ledger.read()).net, 0);
    order.status = "Angenommen";
    assert.ok(ledger.syncOrder(order).added);
    assert.equal(summarize(ledger.read()).net, 600);
    assert.equal(ledger.read().length, 2);
  });
});

test("validates manual entries and summarizes Berlin date periods", () => {
  withLedger(ledger => {
    assert.throws(() => ledger.add({
      kind: "income",
      category: "manual",
      amount: 0,
      description: "Ungültig"
    }), /Betrag/);

    const manualEntry = {
      kind: "income",
      category: "manual",
      amount: 200,
      description: "Kassenstart",
      bookedAt: "2026-10-27T09:00:00.000Z",
      sourceId: "discord-interaction-1"
    };
    const first = ledger.add(manualEntry);
    const retry = ledger.add(manualEntry);
    assert.equal(retry.id, first.id);
    ledger.add({
      kind: "expense",
      category: "manual",
      amount: 50,
      description: "Material",
      bookedAt: "2026-10-26T09:00:00.000Z"
    });

    const todayRange = periodRange("heute", "2026-10-27");
    const today = summarize(ledger.read(), todayRange);
    assert.equal(today.income, 200);
    assert.equal(today.expense, 0);
    assert.equal(today.net, 200);
    assert.equal(periodRange("monat", "2026-10-27").from, "2026-10-01");
  });
});
