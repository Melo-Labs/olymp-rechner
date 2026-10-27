"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomically } = require("./json-store");

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
    writeJsonAtomically(file, entries);
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

  function correctEntry(id, { by = "System", reason, replacement = null } = {}) {
    const entries = read();
    const entry = entries.find(item => item.id === id);
    if (!entry) {
      const error = new Error("Buchung nicht gefunden.");
      error.code = "NOT_FOUND";
      throw error;
    }
    if (entry.voided) {
      const error = new Error("Diese Buchung wurde bereits storniert oder korrigiert.");
      error.code = "ALREADY_VOIDED";
      throw error;
    }
    const normalizedReason = String(reason || "").trim();
    if (normalizedReason.length < 3 || normalizedReason.length > 200) {
      throw new Error("Der Grund muss zwischen 3 und 200 Zeichen lang sein.");
    }
    if (entry.orderId && !replacement) {
      throw new Error("Bestellbuchungen können nicht manuell storniert werden. Ändere stattdessen den Bestellstatus.");
    }
    if (replacement) {
      validate({
        kind: replacement.kind || entry.kind,
        category: entry.category,
        amount: replacement.amount,
        description: replacement.description
      });
    }

    const changedAt = new Date().toISOString();
    const replacementId = replacement ? crypto.randomUUID() : "";
    entry.voided = {
      at: changedAt,
      by: String(by || "System").slice(0, 80),
      reason: normalizedReason,
      action: replacement ? "corrected" : "voided",
      replacementId
    };
    let corrected = null;
    if (replacement) {
      corrected = {
        id: replacementId,
        kind: replacement.kind || entry.kind,
        category: entry.category,
        amount: replacement.amount,
        description: replacement.description.trim().slice(0, 200),
        source: entry.source,
        orderId: entry.orderId,
        sourceId: "",
        correctionOf: entry.id,
        bookedAt: changedAt,
        bookedBy: String(by || "System").slice(0, 80),
        voided: null
      };
      entries.push(corrected);
    }
    write(entries);
    return { entry, corrected };
  }

  // Bestellungen werden nur bei Angenommen/Erledigt gebucht; Ankauf-Angebote sind Ausgaben.
  // Fällt der Status zurück oder wird abgelehnt, werden alle aktiven zugehörigen Buchungen storniert.
  function syncOrder(order) {
    const orderId = String(order?.id || "");
    if (!orderId) return { added: null, voided: null };
    const entries = read();
    const activeEntries = entries.filter(entry => entry.orderId === orderId && !entry.voided);
    const bookable = BOOKING_STATUSES.has(order.status)
      && Number.isSafeInteger(order.totalPrice) && order.totalPrice > 0
      && Object.hasOwn(CATEGORY_LABELS, order.type);

    if (activeEntries.length && !bookable) {
      for (const active of activeEntries) {
        active.voided = {
          at: new Date().toISOString(),
          by: String(order.updatedBy || "System").slice(0, 80),
          reason: `Bestellstatus: ${order.status || "unbekannt"}`,
          action: "voided",
          replacementId: ""
        };
      }
      write(entries);
      return { added: null, voided: activeEntries[0] };
    }
    if (activeEntries.length || !bookable) return { added: null, voided: null };

    const customer = order.icName || order.customerName || "Unbekannt";
    const latestCorrection = entries
      .filter(entry => entry.orderId === orderId && entry.correctionOf)
      .sort((left, right) => Date.parse(left.bookedAt) - Date.parse(right.bookedAt))
      .at(-1);
    const entry = {
      id: crypto.randomUUID(),
      kind: latestCorrection?.kind || (order.type === "sell-offer" ? "expense" : "income"),
      category: order.type,
      amount: latestCorrection?.amount || order.totalPrice,
      description: latestCorrection?.description || `${CATEGORY_LABELS[order.type]} · ${customer}`.slice(0, 200),
      source: "order",
      orderId,
      sourceId: "",
      correctionOf: latestCorrection?.id || "",
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

  return { read, add, correctEntry, syncOrder, syncAllOrders };
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
