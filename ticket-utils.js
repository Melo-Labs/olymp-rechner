"use strict";

function normalizeTicketTypes(value) {
  if (typeof value !== "string") throw new Error("Bitte gib die Ticket-Arten als Liste an.");
  const types = value.split(/[,\n;]/).map(type => type.trim()).filter(Boolean);
  if (!types.length || types.length > 25) {
    throw new Error("Bitte gib zwischen 1 und 25 Ticket-Arten an.");
  }
  const seen = new Set();
  for (const type of types) {
    if (type.length > 80 || /[\r\n]/.test(type)) {
      throw new Error("Jede Ticket-Art darf höchstens 80 Zeichen lang sein.");
    }
    const key = type.toLocaleLowerCase("de");
    if (seen.has(key)) throw new Error(`Die Ticket-Art „${type}“ ist doppelt.`);
    seen.add(key);
  }
  return types;
}

function createTicketTopic(ticket) {
  const payload = {
    ownerId: ticket.ownerId,
    type: ticket.type,
    status: ticket.status,
    createdAt: ticket.createdAt
  };
  return `olymp-ticket:${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

function parseTicketTopic(topic) {
  if (typeof topic !== "string" || !topic.startsWith("olymp-ticket:")) return null;
  try {
    const ticket = JSON.parse(Buffer.from(topic.slice("olymp-ticket:".length), "base64url").toString("utf8"));
    if (!/^\d{17,20}$/.test(ticket.ownerId)
      || typeof ticket.type !== "string"
      || !["open", "closed"].includes(ticket.status)
      || typeof ticket.createdAt !== "string"
      || Number.isNaN(Date.parse(ticket.createdAt))) {
      return null;
    }
    return ticket;
  } catch {
    return null;
  }
}

function ticketChannelSlug(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "ticket";
}

module.exports = { createTicketTopic, normalizeTicketTypes, parseTicketTopic, ticketChannelSlug };
