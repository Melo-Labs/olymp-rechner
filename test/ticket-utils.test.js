"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createTicketTopic,
  normalizeTicketTypes,
  parseTicketTopic,
  ticketChannelSlug
} = require("../ticket-utils");

test("normalizes configurable ticket types and rejects invalid lists", () => {
  assert.deepEqual(normalizeTicketTypes("Support, Bestellung\nSonstiges"), [
    "Support",
    "Bestellung",
    "Sonstiges"
  ]);
  assert.throws(() => normalizeTicketTypes(""), /zwischen 1 und 25/);
  assert.throws(() => normalizeTicketTypes("Support, support"), /doppelt/);
  assert.throws(() => normalizeTicketTypes(Array(26).fill("Art").join(",")), /zwischen 1 und 25/);
  assert.throws(() => normalizeTicketTypes("x".repeat(81)), /höchstens 80 Zeichen/);
});

test("round-trips validated ticket metadata in a Discord channel topic", () => {
  const ticket = {
    ownerId: "12345678901234567",
    type: "Support",
    status: "open",
    createdAt: "2026-10-28T10:00:00.000Z"
  };
  assert.deepEqual(parseTicketTopic(createTicketTopic(ticket)), ticket);
  assert.equal(parseTicketTopic("ordinary channel topic"), null);
  assert.equal(parseTicketTopic("olymp-ticket:invalid"), null);
});

test("creates Discord-safe ticket channel names", () => {
  assert.equal(ticketChannelSlug("Hilfe für Bestellung!"), "hilfe-fur-bestellung");
  assert.equal(ticketChannelSlug(""), "ticket");
  assert.ok(ticketChannelSlug("x".repeat(100)).length <= 40);
});
