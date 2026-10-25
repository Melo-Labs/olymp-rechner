"use strict";

const ORDER_STATUS_LABELS = {
  new: "Neu",
  accepted: "Angenommen",
  processing: "In Bearbeitung",
  completed: "Erledigt",
  rejected: "Abgelehnt"
};

const ORDER_TYPES = {
  material: {
    emoji: "📦",
    noun: "Materialbestellung",
    footer: "Olymp Rechner • Material-Ankauf"
  },
  stank: {
    emoji: "🌿",
    noun: "STANK-Bestellung",
    footer: "Olymp Rechner • STANK-Kauf"
  },
  custom: {
    emoji: "🛒",
    noun: "Wunsch-Bestellung",
    footer: "Olymp Rechner • Wunsch-Bestellung"
  },
  "sell-offer": {
    emoji: "💰",
    noun: "Ankauf-Angebot",
    footer: "Olymp Rechner • Ankauf"
  }
};

const STATUS_COLORS = {
  Neu: 0x5865f2,
  Angenommen: 0xfee75c,
  "In Bearbeitung": 0xe67e22,
  Erledigt: 0x57f287,
  Abgelehnt: 0xed4245
};

function isAdminOrderClosed(order) {
  return order.status === "Erledigt" || order.status === "Abgelehnt";
}

function displayAdminOrderStatus(order) {
  return isAdminOrderClosed(order) ? `${order.status} · Abgeschlossen` : order.status || "Neu";
}

function formatMoney(value) {
  return `${Number(value || 0).toLocaleString("de-DE")} $`;
}

function formatCount(value) {
  return Number(value || 0).toLocaleString("de-DE");
}

function truncate(text, max) {
  const value = String(text || "");
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function field(name, value, inline = true) {
  return { name, value: truncate(String(value || "—"), 1024) || "—", inline };
}

function orderMeta(order) {
  return ORDER_TYPES[order.type] || ORDER_TYPES.custom;
}

function embedColor(order) {
  return STATUS_COLORS[order.status] || orderMeta(order) && STATUS_COLORS.Neu;
}

function itemList(order, emptyText) {
  if (Array.isArray(order.items) && order.items.length) {
    return order.items.map((item, index) => {
      const wish = item.type === "custom" ? " · Wunsch" : "";
      const priceKind = item.type === "custom" ? "Preisvorschlag" : "Festpreis";
      return `**${index + 1}. ${item.name}**${wish}\n${formatCount(item.quantity)} × ${formatMoney(item.pricePerItem)} (${priceKind}) = **${formatMoney(item.totalPrice)}**`;
    }).join("\n");
  }
  return order.discordDescription || emptyText;
}

function baseEmbed(order, extraFields, description) {
  const meta = orderMeta(order);
  const status = displayAdminOrderStatus(order);
  const shortId = String(order.id || "").slice(0, 8);
  return {
    title: `${meta.emoji} ${meta.noun}`,
    description: truncate(description || `Bestellung von **${order.icName || "Unbekannt"}**`, 4096),
    color: embedColor(order),
    fields: [
      field("Kunde", order.icName || "—"),
      field("Telefon", order.phone || "—"),
      field("Status", `**${status}**`),
      ...extraFields
    ],
    footer: { text: shortId ? `${meta.footer} · ${shortId}` : meta.footer },
    timestamp: order.createdAt || new Date().toISOString()
  };
}

function messageContent(order) {
  const meta = orderMeta(order);
  const status = order.status || "Neu";
  const name = order.icName || "Unbekannt";
  if (isAdminOrderClosed(order)) {
    return `${meta.emoji} **${status}** · ${name}`;
  }
  return `${meta.emoji} **${status}** · ${name}`;
}

function buildOrderComponents(order) {
  if (isAdminOrderClosed(order)) return [];
  const workflow = [
    { key: "accepted", style: 2, emoji: { name: "✅" } },
    { key: "processing", style: 1, emoji: { name: "🔧" } },
    { key: "completed", style: 3, emoji: { name: "☑️" } }
  ].map(button => ({
    type: 2,
    style: button.style,
    emoji: button.emoji,
    label: ORDER_STATUS_LABELS[button.key],
    custom_id: `order_status:${order.id}:${button.key}`,
    disabled: order.status === ORDER_STATUS_LABELS[button.key]
  }));
  return [
    { type: 1, components: workflow },
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 4,
          emoji: { name: "⛔" },
          label: ORDER_STATUS_LABELS.rejected,
          custom_id: `order_status:${order.id}:rejected`,
          disabled: order.status === ORDER_STATUS_LABELS.rejected
        },
        {
          type: 2,
          style: 2,
          emoji: { name: "📞" },
          label: "Kontakt",
          custom_id: `order_contact:${order.id}`
        }
      ]
    }
  ];
}

function wrapPayload(order, extraFields, description) {
  return {
    content: messageContent(order),
    embeds: [baseEmbed(order, extraFields, description)],
    components: buildOrderComponents(order),
    allowed_mentions: { parse: [] }
  };
}

function buildMaterialOrderPayload(order) {
  return wrapPayload(order, [
    field("Technik", formatCount(order.technical)),
    field("Medizin", formatCount(order.medical)),
    field("Stück", formatCount(order.totalMaterials)),
    field("Gesamtpreis", formatMoney(order.totalPrice), false)
  ], "Neue Materialbestellung aus dem Rechner.");
}

function buildStankOrderPayload(order) {
  return wrapPayload(order, [
    field("Pflanzen", formatCount(order.quantity)),
    field("Stückpreis", "2.000 $"),
    field("Gesamtpreis", formatMoney(order.totalPrice))
  ], "Neue STANK-Bestellung.");
}

function buildCustomOrderPayload(order) {
  return wrapPayload(order, [
    field("Gesamtpreis", formatMoney(order.totalPrice), false)
  ], itemList(order, "Bestellpositionen"));
}

function buildSellOfferPayload(order) {
  const lines = Array.isArray(order.items) && order.items.length
    ? order.items.map(item =>
      `**${item.name}** — ${formatCount(item.quantity)} × ${formatMoney(item.pricePerItem)} = **${formatMoney(item.totalPrice)}**`
    ).join("\n")
    : order.discordDescription || "Angebotspositionen";
  return wrapPayload(order, [
    field("Gesamtpreis", formatMoney(order.totalPrice), false)
  ], lines);
}

function buildAdminOrderDiscordPayload(order) {
  const builders = {
    material: buildMaterialOrderPayload,
    stank: buildStankOrderPayload,
    custom: buildCustomOrderPayload,
    "sell-offer": buildSellOfferPayload
  };
  const builder = builders[order.type];
  if (!builder) throw new Error(`Unbekannter Bestelltyp: ${order.type}`);
  return builder(order);
}

function parseButtonAction(customId) {
  const status = /^order_status:([a-f0-9-]{36}):(accepted|processing|completed|rejected)$/i.exec(customId || "");
  if (status) {
    return { kind: "status", orderId: status[1], statusKey: status[2].toLowerCase() };
  }
  const contact = /^order_contact:([a-f0-9-]{36})$/i.exec(customId || "");
  if (contact) return { kind: "contact", orderId: contact[1] };
  if (/^(material|stank|custom|sell-offer)_order_contact$/.test(customId || "")) {
    return { kind: "contact", orderId: "" };
  }
  return { kind: "unknown" };
}

function phoneFromEmbed(embed) {
  const fields = Array.isArray(embed?.fields) ? embed.fields : [];
  const match = fields.find(entry => /^(telefon|handynummer|handynummer \/ ic|telefonnummer)$/i.test(String(entry.name || "").trim()));
  const value = String(match?.value || "").replace(/[*_`]/g, "").trim();
  return value && value !== "—" ? value : "";
}

module.exports = {
  ORDER_STATUS_LABELS,
  ORDER_TYPES,
  isAdminOrderClosed,
  displayAdminOrderStatus,
  formatMoney,
  buildOrderComponents,
  buildMaterialOrderPayload,
  buildStankOrderPayload,
  buildCustomOrderPayload,
  buildSellOfferPayload,
  buildAdminOrderDiscordPayload,
  parseButtonAction,
  phoneFromEmbed
};
