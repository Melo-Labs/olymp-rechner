"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BOOKING_STATUSES = new Set(["Angenommen", "Erledigt"]);
const CATEGORY_LABELS = {
  material: "Materialbestellungen",
  stank: "STANK-Bestellungen",
  custom: "Wunschbestellungen",
  "sell-offer": "Ankauf",
  manual: "Manuelle Buchungen"
};
const MAX_AMOUNT = 1_000_000_000;

function dateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(key, days) {
  const [year, month, day] = key.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

// Zeitraum als inklusive Datumsgrenzen in Berliner Zeit.
function periodRange(period, today = dateKey()) {
  if (period === "heute") return { from: today, to: today, label: "Heute" };
  if (period === "woche") {
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay() || 7;
    return { from: shiftDateKey(today, 1 - weekday), to: today, label: "Diese Woche" };
  }
  if (period === "monat") return { from: `${today.slice(0, 8)}01`, to: today, label: "Dieser Monat" };
  return { from: null, to: null, label: "Gesamt" };
}

function createLedger(file) {
  function read() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) return [];
    const entries = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
    if (!Array.isArray(entries)) throw new Error("Hauptbuch enthält keine Buchungsliste.");
    return entries;
  }

  function write(entries) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporaryPath = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(entries, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, file);
  }

  function validate({ kind, category, amount, description }) {
    if (kind !== "income" && kind !== "expense") throw new Error("Ungültige Buchungsart.");
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_AMOUNT) throw new Error("Der Betrag muss eine ganze Zahl zwischen 1 und 1.000.000.000 sein.");
    if (!Object.hasOwn(CATEGORY_LABELS, category)) throw new Error("Ungültige Buchungskategorie.");
    if (typeof description !== "string" || !description.trim()) throw new Error("Bitte eine Beschreibung angeben.");
  }

  function add({ kind, category, amount, description, source, orderId = "", sourceId = "", bookedBy = "System", bookedAt = new Date().toISOString() }) {
    validate({ kind, category, amount, description });
    const entries = read();
    if (sourceId) {
      const previous = entries.find(entry => entry.sourceId === sourceId);
      if (previous) return previous;
    }
    const entry = {
      id: crypto.randomUUID(),
      kind,
      category,
      amount,
      description: description.trim().slice(0, 200),
      source: source === "order" ? "order" : "manual",
      orderId: String(orderId || ""),
      sourceId: String(sourceId || ""),
      bookedAt,
      bookedBy: String(bookedBy || "System").slice(0, 80),
      voided: null
    };
    entries.push(entry);
    write(entries);
    return entry;
  }

  function voidEntry(id, by, reason) {
    const entries = read();
    const entry = entries.find(item => item.id === id);
    if (!entry) return { error: "NOT_FOUND" };
    if (entry.voided) return { error: "ALREADY_VOIDED", entry };
    entry.voided = {
      at: new Date().toISOString(),
      by: String(by || "System").slice(0, 80),
      reason: String(reason || "").trim().slice(0, 200)
    };
    write(entries);
    return { entry };
  }

  // Bestellungen werden nur bei Angenommen/Erledigt gebucht; Ankauf-Angebote sind Ausgaben.
  // Fällt der Status zurück oder wird abgelehnt, wird die zugehörige Buchung storniert.
  function syncOrder(order) {
    const orderId = String(order?.id || "");
    if (!orderId) return { added: null, voided: null };
    const entries = read();
    const active = entries.find(entry => entry.orderId === orderId && !entry.voided);
    const bookable = BOOKING_STATUSES.has(order.status)
      && Number.isSafeInteger(order.totalPrice) && order.totalPrice > 0
      && Object.hasOwn(CATEGORY_LABELS, order.type);

    if (active && !bookable) {
      active.voided = {
        at: new Date().toISOString(),
        by: String(order.updatedBy || "System").slice(0, 80),
        reason: `Bestellstatus: ${order.status || "unbekannt"}`
      };
      write(entries);
      return { added: null, voided: active };
    }
    if (active || !bookable) return { added: null, voided: null };

    const customer = order.icName || order.customerName || "Unbekannt";
    const entry = {
      id: crypto.randomUUID(),
      kind: order.type === "sell-offer" ? "expense" : "income",
      category: order.type,
      amount: order.totalPrice,
      description: `${CATEGORY_LABELS[order.type]} · ${customer}`.slice(0, 200),
      source: "order",
      orderId,
      bookedAt: order.updatedAt || order.createdAt || new Date().toISOString(),
      bookedBy: String(order.updatedBy || "System").slice(0, 80),
      voided: null
    };
    entries.push(entry);
    write(entries);
    return { added: entry, voided: null };
  }

  function syncAllOrders(orders) {
    let added = 0;
    for (const order of orders) {
      if (syncOrder(order).added) added += 1;
    }
    return added;
  }

  return { read, add, voidEntry, syncOrder, syncAllOrders };
}

function summarize(entries, { from = null, to = null } = {}) {
  const categories = Object.create(null);
  let income = 0;
  let expense = 0;
  let count = 0;
  for (const entry of entries) {
    if (entry.voided) continue;
    const key = dateKey(new Date(entry.bookedAt));
    if ((from && key < from) || (to && key > to)) continue;
    const bucket = categories[entry.category] || (categories[entry.category] = { income: 0, expense: 0, count: 0 });
    bucket[entry.kind] += entry.amount;
    bucket.count += 1;
    if (entry.kind === "income") income += entry.amount;
    else expense += entry.amount;
    count += 1;
  }
  return { income, expense, net: income - expense, count, categories };
}

module.exports = { CATEGORY_LABELS, BOOKING_STATUSES, createLedger, summarize, dateKey, shiftDateKey, periodRange };
