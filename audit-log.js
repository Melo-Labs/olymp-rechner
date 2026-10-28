"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { writeJsonAtomically } = require("./json-store");

const AUDIT_CATEGORIES = Object.freeze({
  familie: "Familien",
  ticket: "Tickets",
  coupon: "Coupons",
  familienkasse: "Familienkassen",
  buchung: "Buchungen"
});
const MAX_AUDIT_ENTRIES = 5000;
const MAX_FEED_LIMIT = 500;

function readList(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (!Array.isArray(value)) throw new Error("Die Audit-Datei enthält keine gültige Liste.");
  return value;
}

function createAuditLog(file) {
  function read() {
    return readList(file);
  }

  function record({ category, action, subject = "", actorId = "", actorName = "", details = "" }) {
    if (!Object.hasOwn(AUDIT_CATEGORIES, category)) throw new Error("Ungültige Audit-Kategorie.");
    const entry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      category,
      action: String(action || "").slice(0, 120),
      subject: String(subject || "").slice(0, 200),
      actorId: String(actorId || "").slice(0, 40),
      actorName: String(actorName || "").slice(0, 80),
      details: String(details || "").slice(0, 500)
    };
    writeJsonAtomically(file, [entry, ...read()].slice(0, MAX_AUDIT_ENTRIES));
    return entry;
  }

  return { read, record };
}

function normalizeFamilyAuditEntries(entries) {
  return entries.map(entry => ({
    id: String(entry.id || ""),
    timestamp: String(entry.timestamp || ""),
    category: "familie",
    action: String(entry.action || ""),
    subject: String(entry.familyName || ""),
    actorId: String(entry.actorId || ""),
    actorName: "",
    details: String(entry.details || "")
  }));
}

function normalizeLedgerEntries(entries) {
  return entries.map(entry => {
    const kind = entry.kind === "income" ? "Einnahme" : "Ausgabe";
    const voided = entry.voided ? " (storniert)" : "";
    return {
      id: String(entry.id || ""),
      timestamp: String(entry.bookedAt || ""),
      category: "buchung",
      action: `${kind}${voided}`,
      subject: String(entry.description || ""),
      actorId: "",
      actorName: String(entry.bookedBy || ""),
      details: `${Number(entry.amount || 0).toLocaleString("de-DE")} $ · ${entry.source === "order" ? "Bestellung" : "manuell"}`
    };
  });
}

function buildAuditFeed({ audit = [], family = [], ledger = [], category = "", query = "", limit = 100 } = {}) {
  const wantedCategory = Object.hasOwn(AUDIT_CATEGORIES, category) ? category : "";
  const needle = String(query || "").trim().toLocaleLowerCase("de");
  const cappedLimit = Math.max(1, Math.min(MAX_FEED_LIMIT, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 100));
  const timeOf = entry => {
    const time = Date.parse(entry.timestamp);
    return Number.isNaN(time) ? 0 : time;
  };
  return [
    ...audit,
    ...normalizeFamilyAuditEntries(family),
    ...normalizeLedgerEntries(ledger)
  ]
    .filter(entry => !wantedCategory || entry.category === wantedCategory)
    .filter(entry => !needle
      || `${entry.action} ${entry.subject} ${entry.actorId} ${entry.actorName} ${entry.details}`
        .toLocaleLowerCase("de")
        .includes(needle))
    .sort((left, right) => timeOf(right) - timeOf(left))
    .slice(0, cappedLimit);
}

module.exports = { AUDIT_CATEGORIES, buildAuditFeed, createAuditLog };
