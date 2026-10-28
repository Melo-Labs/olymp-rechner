"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { verifyKey } = require("discord-interactions");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder
} = require("discord.js");
const { CATEGORY_LABELS, createLedger, periodRange, shiftDateKey, summarize } = require("./ledger");
const { createDataBackup } = require("./data-backups");
const { writeJsonAtomically } = require("./json-store");
const {
  calculateCouponPrice,
  couponUsesRemaining,
  findActiveCoupon,
  normalizeCouponCode,
  validateCouponDefinition
} = require("./coupon-utils");
const {
  ORDER_STATUS_LABELS,
  isAdminOrderClosed,
  displayAdminOrderStatus,
  buildAdminOrderDiscordPayload,
  parseButtonAction,
  phoneFromEmbed
} = require("./discord-order-ui");
const {
  createTicketTopic,
  normalizeTicketTypes,
  parseTicketTopic,
  ticketChannelSlug
} = require("./ticket-utils");

function loadEnvFile() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!match || match[1].startsWith("#") || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === "true";
const SESSION_TTL = 8 * 60 * 60 * 1000;
const ROLE_CHECK_TTL = 60 * 1000;
const HEALTH_CACHE_TTL = 5 * 1000;
const STALE_ORDER_DELIVERY_TTL = 2 * 60 * 1000;
const ORDER_CHANNEL_ID = process.env.DISCORD_ORDER_CHANNEL_ID || "1558426870465302538";
const STANK_ORDER_CHANNEL_ID = "1558497954921193592";
const CUSTOM_ORDER_CHANNEL_ID = "1558508937400291338";
const SELL_OFFER_CHANNEL_ID = process.env.DISCORD_SELL_OFFER_CHANNEL_ID || "1558812539805110434";
const COUPON_NOTIFICATION_CHANNEL_ID = "1564934131442257961";
const ORDER_DELIVERY_TARGETS = {
  material: { channelId: ORDER_CHANNEL_ID, archiveFile: "material-bestellungen.json" },
  stank: { channelId: STANK_ORDER_CHANNEL_ID, archiveFile: "stank-bestellungen.json" },
  custom: { channelId: CUSTOM_ORDER_CHANNEL_ID, archiveFile: "wunsch-bestellungen.json" },
  "sell-offer": { channelId: SELL_OFFER_CHANNEL_ID, archiveFile: "ankauf-angebote.json" }
};
const CATALOG_AUDIT_CHANNEL_ID = "1558539114662330419";
const WELCOME_CHANNEL_ID = "1558193685860982880";
const UNVERIFIED_ROLE_ID = "1558193824386261192";
const ACCOUNTING_CHANNEL_ID = "1559327859351232603";
const FAMILY_CATEGORY_NAME = "Familien";
const pendingFamilyDeletions = new Map();
const pendingFamilyMemberChanges = new Map();
const pendingFamilyListPages = new Map();
const pendingTicketCreations = new Set();
let discordGatewayClient = null;
const ROOT = __dirname;
const LEGACY_CATALOG_FILE = path.join(ROOT, "shop-products.json");
const LEGACY_CATALOG_AUDIT_PENDING_FILE = path.join(ROOT, "shop-audit-pending.json");
const BUYBACK_PRODUCTS_FILE = path.join(ROOT, "data", "buyback-products.json");
// Set to { id, name, price } to publish the next shop bundle.
const WEEKLY_BUNDLE = null;
const SHOP_CONTENT = {
  weeklyOffers: [],
  ads: [
    {
      title: "Werbefläche im OLYMP SHOP",
      image: "/img/werbung1.png"
    }
  ]
};
const ACCOUNTING_REPORTS_FILE = process.env.ACCOUNTING_REPORTS_FILE
  ? (path.isAbsolute(process.env.ACCOUNTING_REPORTS_FILE)
    ? process.env.ACCOUNTING_REPORTS_FILE
    : path.resolve(ROOT, process.env.ACCOUNTING_REPORTS_FILE))
  : path.join(ROOT, "data", "accounting-reports.json");
const ACCOUNTING_LEDGER_FILE = process.env.ACCOUNTING_LEDGER_FILE
  ? (path.isAbsolute(process.env.ACCOUNTING_LEDGER_FILE)
    ? process.env.ACCOUNTING_LEDGER_FILE
    : path.resolve(ROOT, process.env.ACCOUNTING_LEDGER_FILE))
  : path.join(ROOT, "data", "accounting-ledger.json");
const LOCAL_ORDER_LOG_DIR = process.env.LOCAL_ORDER_LOG_DIR
  ? (path.isAbsolute(process.env.LOCAL_ORDER_LOG_DIR)
    ? process.env.LOCAL_ORDER_LOG_DIR
    : path.resolve(ROOT, process.env.LOCAL_ORDER_LOG_DIR))
  : ROOT;
const DATA_BACKUP_DIR = process.env.DATA_BACKUP_DIR
  ? (path.isAbsolute(process.env.DATA_BACKUP_DIR)
    ? process.env.DATA_BACKUP_DIR
    : path.resolve(ROOT, process.env.DATA_BACKUP_DIR))
  : path.join(ROOT, "data", "backups");
const accountingLedger = createLedger(ACCOUNTING_LEDGER_FILE);

function resolvePersistentDataFile(envKey, fallbackPath, legacyPath) {
  const configured = process.env[envKey]?.trim();
  const target = configured ? (path.isAbsolute(configured) ? configured : path.resolve(ROOT, configured)) : path.join(ROOT, fallbackPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (!fs.existsSync(target)) {
    if (legacyPath && fs.existsSync(legacyPath)) {
      fs.copyFileSync(legacyPath, target);
    } else {
      fs.writeFileSync(target, envKey === "CATALOG_FILE" ? "[]" : "[]", "utf8");
    }
  }
  return target;
}

const CATALOG_FILE = resolvePersistentDataFile("CATALOG_FILE", "data/shop-products.json", LEGACY_CATALOG_FILE);
const CATALOG_AUDIT_PENDING_FILE = resolvePersistentDataFile("CATALOG_AUDIT_PENDING_FILE", "data/shop-audit-pending.json", LEGACY_CATALOG_AUDIT_PENDING_FILE);
const ADMIN_ORDERS_FILE = resolvePersistentDataFile("ADMIN_ORDERS_FILE", "data/admin-orders.json");
const SHOP_COUPONS_FILE = resolvePersistentDataFile("SHOP_COUPONS_FILE", "data/shop-coupons.json");
const FAMILY_AUDIT_FILE = resolvePersistentDataFile("FAMILY_AUDIT_FILE", "data/family-audit.json");
const FAMILY_APPLICATIONS_FILE = resolvePersistentDataFile("FAMILY_APPLICATIONS_FILE", "data/family-applications.json");
const TICKET_CONFIG_FILE = resolvePersistentDataFile("TICKET_CONFIG_FILE", "data/ticket-config.json");
const ORDER_WEBHOOK_URL = process.env.DISCORD_ORDER_WEBHOOK_URL || "";
const sessions = new Map();
const pendingLogins = new Map();
let catalogAuditInProgress = false;
let adminOrdersCache = null;
let cachedHealthReport = null;
const staticFiles = new Map([
  ["/", "landing.html"],
  ["/index.html", "landing.html"],
  ["/ankauf.html", "ankauf.html"],
  ["/ankauf.js", "ankauf.js"],
  ["/material-ankauf.html", "material-ankauf.html"],
  ["/material-ankauf.js", "material-ankauf.js"],
  ["/stank-kauf.html", "stank-kauf.html"],
  ["/stank-kauf.js", "stank-kauf.js"],
  ["/freie-bestellung.html", "freie-bestellung.html"],
  ["/freie-bestellung.js", "freie-bestellung.js"],
  ["/admin/catalog", "catalog-admin.html"],
  ["/admin/catalog.js", "catalog-admin.js"],
  ["/admin/coupons", "coupons-admin.html"],
  ["/admin/coupons.js", "coupons-admin.js"],
  ["/admin/buyback", "buyback-admin.html"],
  ["/admin/buyback.js", "buyback-admin.js"],
  ["/admin/nav.css", "admin-nav.css"],
  ["/admin/nav.js", "admin-nav.js"],
  ["/admin/orders", "orders-admin.html"],
  ["/admin/orders.js", "orders-admin.js"],
  ["/admin/accounting", "accounting-admin.html"],
  ["/admin/accounting.js", "accounting-admin.js"],
  ["/produktions-rechner.html", "produktions-rechner.html"],
  ["/production-utils.js", "production-utils.js"],
  ["/script.js", "script.js"],
  ["/style.css", "style.css"],
  ["/theme.css", "theme.css"],
  ["/shop.css", "shop.css"],
  ["/forms.css", "forms.css"],
  ["/bg.js", "bg.js"]
]);

function discordConfig() {
  return {
    clientId: process.env.DISCORD_CLIENT_ID || "",
    clientSecret: process.env.DISCORD_CLIENT_SECRET || "",
    guildId: process.env.DISCORD_GUILD_ID || "",
    roleId: process.env.DISCORD_ROLE_ID || "",
    catalogAdminRoleId: process.env.DISCORD_CATALOG_ADMIN_ROLE_ID || "",
    redirectUri: process.env.DISCORD_REDIRECT_URI || "",
    botToken: process.env.DISCORD_BOT_TOKEN || "",
    publicKey: process.env.DISCORD_PUBLIC_KEY || "",
    allowedLogChannelId: process.env.DISCORD_ALLOWED_LOG_CHANNEL_ID || "",
    deniedLogChannelId: process.env.DISCORD_DENIED_LOG_CHANNEL_ID || ""
  };
}

function configIsReady(config) {
  const snowflake = /^\d{17,20}$/;
  return [
    config.clientId,
    config.clientSecret,
    config.guildId,
    config.roleId,
    config.redirectUri,
    config.botToken,
    config.publicKey,
    config.allowedLogChannelId,
    config.deniedLogChannelId
  ].every(Boolean)
    && [config.guildId, config.roleId, config.allowedLogChannelId, config.deniedLogChannelId].every(id => snowflake.test(id));
}

function appendCookie(res, cookie) {
  const current = res.getHeader("Set-Cookie");
  const cookies = current ? (Array.isArray(current) ? current : [current]) : [];
  res.setHeader("Set-Cookie", [...cookies, cookie]);
}

function makeCookie(name, value, maxAge, httpOnly = true) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (httpOnly) parts.push("HttpOnly");
  if (COOKIE_SECURE) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(res, name) {
  appendCookie(res, makeCookie(name, "", 0));
}

function cookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    try {
      result[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      result[name] = "";
    }
  }
  return result;
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  applySecurityHeaders(res);
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function redirect(res, location) {
  applySecurityHeaders(res);
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function loginPage(error = "", title = "Produktionsrechner", redirectPath = "/produktions-rechner.html") {
  const messages = {
    setup: "Der Discord-Login oder der private Log-Channel ist noch nicht konfiguriert.",
    role: "Du hast keine passende Rolle auf dem Discord-Server.",
    state: "Der Login ist abgelaufen. Bitte versuche es erneut.",
    discord: "Die Anmeldung bei Discord ist fehlgeschlagen.",
    cancelled: "Die Discord-Anmeldung wurde abgebrochen."
  };
  const message = messages[error] || "";
  const adminPath = ["/admin/catalog", "/admin/orders", "/admin/accounting", "/admin/coupons"].includes(redirectPath) ? redirectPath : "/admin/catalog";
  const authHref = title === "Admin Panel" ? `/auth/discord?next=${encodeURIComponent(adminPath)}` : "/auth/discord";
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Discord-Anmeldung</title>
<link rel="stylesheet" href="/theme.css">
<style>
:root{color-scheme:dark;--text:#ececec;--muted:#9a9da3;--error:#ff8d82;--br:rgba(228,232,238,.5)}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;color:var(--text);font:16px/1.5 var(--body)}
.login{width:min(440px,calc(100% - 32px));padding:34px 30px;border:1px solid rgba(228,232,238,.14);border-radius:6px;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);background:linear-gradient(var(--br),var(--br)) 0 0/14px 1px no-repeat,linear-gradient(var(--br),var(--br)) 0 0/1px 14px no-repeat,linear-gradient(var(--br),var(--br)) 100% 0/14px 1px no-repeat,linear-gradient(var(--br),var(--br)) 100% 0/1px 14px no-repeat,linear-gradient(var(--br),var(--br)) 0 100%/14px 1px no-repeat,linear-gradient(var(--br),var(--br)) 0 100%/1px 14px no-repeat,linear-gradient(var(--br),var(--br)) 100% 100%/14px 1px no-repeat,linear-gradient(var(--br),var(--br)) 100% 100%/1px 14px no-repeat,linear-gradient(165deg,rgba(27,29,33,.82),rgba(11,12,14,.9))}
h1{margin:0 0 8px;font:700 24px/1.2 var(--display);letter-spacing:.05em;text-shadow:0 0 16px rgba(255,255,255,.3)}
p{margin:0 0 24px;color:var(--muted)}.error{margin:0 0 18px;color:var(--error)}
a{display:flex;align-items:center;justify-content:center;min-height:48px;padding:10px 16px;background:linear-gradient(135deg,#f4f6f9,#aeb6c1);color:#0a0a0b;text-decoration:none;font-weight:600;letter-spacing:.04em;border-radius:6px;transition:box-shadow .2s}
a:hover{box-shadow:0 0 26px rgba(228,232,238,.4)}
</style></head><body><main class="login"><h1>${title}</h1><p>Zum Zugriff mit Discord anmelden.</p>${message ? `<p class="error" role="alert">${message}</p>` : ""}<a href="${authHref}">Mit Discord anmelden</a></main><script src="/bg.js"></script></body></html>`;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function discordFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { "User-Agent": "OlympProduktionsRechner/1.0", ...(options.headers || {}) },
    signal: AbortSignal.timeout(10000)
  });
}

async function exchangeCode(config, code, verifier) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier
  });
  const response = await discordFetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = parseJson(await response.text());
  if (!response.ok || !data?.access_token) {
    const reason = [data?.error, data?.error_description]
      .filter(Boolean)
      .join(": ")
      .slice(0, 240);
    throw new Error(`Discord token exchange failed (HTTP ${response.status}${reason ? `, ${reason}` : ""})`);
  }
  return data;
}

async function memberHasRole(session, config, roleId = config.roleId) {
  const response = await discordFetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(config.guildId)}/members/${encodeURIComponent(session.userId)}`, {
    headers: { Authorization: `Bot ${config.botToken}` }
  });
  if (response.status === 404) return false;
  const member = parseJson(await response.text());
  if (!response.ok || !Array.isArray(member?.roles)) {
    throw new Error(`Discord membership check failed (HTTP ${response.status}, code ${member?.code ?? "unknown"}: ${String(member?.message || "unknown response").slice(0, 160)})`);
  }
  return member.roles.includes(roleId);
}

async function logDiscordAccess(user, authorized, config) {
  const channelId = authorized ? config.allowedLogChannelId : config.deniedLogChannelId;
  const displayName = String(user.global_name || user.username || "Unbekannt").slice(0, 80);
  const embed = {
    author: { name: "OLYMP • ZUGRIFFSPROTOKOLL" },
    title: authorized ? "Zugriff freigegeben" : "Zugriff verweigert",
    description: authorized
      ? "Discord-Identität bestätigt. Die erforderliche Serverrolle ist vorhanden."
      : "Discord-Identität erkannt, aber die erforderliche Serverrolle fehlt.",
    color: authorized ? 0x48a868 : 0xd44c4c,
    fields: [
      { name: "DISCORD-KONTO", value: `<@${user.id}>\n${displayName}`, inline: true },
      { name: "ROLLENPRÜFUNG", value: authorized ? "✅ Berechtigung bestätigt" : "❌ Berechtigung fehlt", inline: true },
      { name: "USER-ID", value: `\`${user.id}\``, inline: false }
    ],
    footer: { text: "OLYMP • Sicherheitsprotokoll" },
    timestamp: new Date().toISOString()
  };
  if (user.avatar) {
    const extension = user.avatar.startsWith("a_") ? "gif" : "png";
    embed.thumbnail = { url: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=256` };
  }
  const statusImage = authorized ? "approved.png" : "denied.png";
  const message = { embeds: [embed], allowed_mentions: { parse: [] } };
  const headers = { Authorization: `Bot ${config.botToken}` };
  let body;
  try {
    const image = await fs.promises.readFile(path.join(ROOT, "img", statusImage));
    embed.image = { url: `attachment://${statusImage}` };
    const formData = new FormData();
    formData.append("payload_json", JSON.stringify(message));
    formData.append("files[0]", new Blob([image], { type: "image/png" }), statusImage);
    body = formData;
  } catch (error) {
    console.error("Discord-Zugriffsbild konnte nicht angehängt werden:", error.message);
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(message);
  }
  const response = await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers,
    body
  });
  if (!response.ok) {
    const error = parseJson(await response.text());
    throw new Error(`Discord access log failed (${response.status}, code ${error?.code ?? "unknown"}): ${String(error?.message || "unknown response").slice(0, 200)}`);
  }
}

function pruneState() {
  const now = Date.now();
  for (const [key, value] of pendingLogins) if (value.expiresAt <= now) pendingLogins.delete(key);
  for (const [key, value] of sessions) if (value.sessionExpiresAt <= now) sessions.delete(key);
}

async function authorizedSession(req, config) {
  const id = cookies(req).olymp_session;
  const session = id && sessions.get(id);
  if (!session || session.sessionExpiresAt <= Date.now()) {
    if (id) sessions.delete(id);
    return null;
  }
  if (Date.now() - session.roleCheckedAt < ROLE_CHECK_TTL) return session;
  if (!await memberHasRole(session, config)) {
    sessions.delete(id);
    return null;
  }
  session.roleCheckedAt = Date.now();
  return session;
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function beginLogin(req, res, config) {
  if (!configIsReady(config)) {
    const loginUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const requestedDestination = loginUrl.searchParams.get("next");
    const isAdmin = ["/admin/catalog", "/admin/orders", "/admin/accounting", "/admin/coupons"].includes(requestedDestination);
    send(res, 503, loginPage("setup", isAdmin ? "Admin Panel" : "Produktionsrechner", requestedDestination || "/admin/catalog"), "text/html; charset=utf-8");
    return;
  }
  pruneState();
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const loginUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const requestedDestination = loginUrl.searchParams.get("next");
  const redirectPath = ["/admin/catalog", "/admin/orders", "/admin/accounting", "/admin/coupons"].includes(requestedDestination) ? requestedDestination : "";
  pendingLogins.set(state, { verifier, redirectPath, expiresAt: Date.now() + 10 * 60 * 1000 });
  appendCookie(res, makeCookie("olymp_oauth_state", state, 600));
  const query = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: "identify",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  redirect(res, `https://discord.com/oauth2/authorize?${query}`);
}

async function finishLogin(req, res, url, config) {
  clearCookie(res, "olymp_oauth_state");
  if (url.searchParams.has("error")) {
    redirect(res, "/login?error=cancelled");
    return;
  }
  const state = url.searchParams.get("state") || "";
  const stateCookie = cookies(req).olymp_oauth_state || "";
  const pending = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!state || !safeEqual(state, stateCookie) || !pending || pending.expiresAt <= Date.now()) {
    redirect(res, "/login?error=state");
    return;
  }
  const code = url.searchParams.get("code");
  if (!code || !configIsReady(config)) {
    redirect(res, "/login?error=discord");
    return;
  }
  try {
    const token = await exchangeCode(config, code, pending.verifier);
    const userResponse = await discordFetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    const user = parseJson(await userResponse.text());
    if (!userResponse.ok || !user?.id) throw new Error("Discord user lookup failed");
    const session = {
      userId: user.id,
      discordName: String(user.global_name || user.username || "Unbekannt").slice(0, 80),
      username: String(user.username || "Unbekannt").slice(0, 80),
      sessionExpiresAt: Date.now() + SESSION_TTL,
      roleCheckedAt: 0
    };
    const authorized = await memberHasRole(session, config);
    await logDiscordAccess(user, authorized, config);
    if (!authorized) {
      redirect(res, "/login?error=role");
      return;
    }
    session.roleCheckedAt = Date.now();
    const sessionId = crypto.randomBytes(32).toString("base64url");
    sessions.set(sessionId, session);
    appendCookie(res, makeCookie("olymp_session", sessionId, SESSION_TTL / 1000));
    redirect(res, pending.redirectPath || "/produktions-rechner.html");
  } catch (error) {
    console.error("Discord OAuth fehlgeschlagen:", error.message);
    redirect(res, "/login?error=discord");
  }
}

function staticFile(pathname) {
  if (staticFiles.has(pathname)) return path.join(ROOT, staticFiles.get(pathname));
  if (!pathname.startsWith("/img/")) return null;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const imageRoot = path.resolve(ROOT, "img");
  const file = path.resolve(ROOT, `.${decoded}`);
  return file.startsWith(`${imageRoot}${path.sep}`) ? file : null;
}

function serveStatic(req, res, pathname) {
  const file = staticFile(pathname);
  if (!file) {
    send(res, 404, "Nicht gefunden");
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      send(res, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "Nicht gefunden" : "Interner Fehler");
      return;
    }
    const extension = path.extname(file).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2"
    };
    applySecurityHeaders(res);
    res.writeHead(200, { "Content-Type": types[extension] || "application/octet-stream", "Cache-Control": "private, no-store" });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

function saveOrderLocally(order, fileName) {
  const logPath = path.join(LOCAL_ORDER_LOG_DIR, path.basename(fileName));
  let list = [];
  if (fs.existsSync(logPath)) {
    try {
      const existing = fs.readFileSync(logPath, "utf8");
      list = JSON.parse(existing);
    } catch (error) {
      const readError = new Error(`Lokales Bestellprotokoll ${path.basename(logPath)} ist beschädigt und wurde nicht überschrieben.`);
      readError.code = "ORDER_LOG_READ_FAILED";
      readError.cause = error;
      throw readError;
    }
    if (!Array.isArray(list)) {
      const invalidError = new Error(`Lokales Bestellprotokoll ${path.basename(logPath)} enthält keine Bestellliste.`);
      invalidError.code = "ORDER_LOG_INVALID";
      throw invalidError;
    }
  }

  list.push({
    createdAt: new Date().toISOString(),
    ...order
  });

  writeAccountingJson(logPath, list);
  return logPath;
}

function saveMaterialOrderLocally(order) {
  return saveOrderLocallyWithWarning(order, "material-bestellungen.json");
}

function saveOrderLocallyWithWarning(order, fileName) {
  try {
    saveOrderLocally(order, fileName);
    return "";
  } catch (error) {
    console.error(`Zusätzliche lokale Archivkopie für Bestellung ${order.id} fehlgeschlagen:`, error.message);
    return "Die Bestellung ist in der Adminverwaltung gespeichert, aber die zusätzliche Archivkopie konnte nicht gesichert werden. ";
  }
}

function readAdminOrders() {
  if (adminOrdersCache) return adminOrdersCache;
  const orders = JSON.parse(fs.readFileSync(ADMIN_ORDERS_FILE, "utf8"));
  if (!Array.isArray(orders)) throw new Error("Admin-Bestelldatei enthält keine Bestellliste.");
  for (const order of orders) {
    if (!order.type && Number.isFinite(order.technical) && Number.isFinite(order.medical)) {
      order.type = "material";
    }
  }
  adminOrdersCache = orders;
  return orders;
}

function writeAdminOrders(orders) {
  writeAccountingJson(ADMIN_ORDERS_FILE, orders);
  adminOrdersCache = orders;
  cachedHealthReport = null;
}

function trackAdminOrder(order) {
  const orders = readAdminOrders().slice();
  const tracked = {
    ...order,
    id: crypto.randomUUID(),
    status: "Neu",
    deliveryStatus: "pending"
  };
  orders.push(tracked);
  writeAdminOrders(orders);
  return tracked;
}

function updateAdminOrder(orderId, updates) {
  const currentOrders = readAdminOrders();
  const index = currentOrders.findIndex(order => order.id === orderId);
  if (index < 0) return null;
  const updatedOrder = { ...currentOrders[index], ...updates };
  const orders = currentOrders.slice();
  orders[index] = updatedOrder;
  writeAdminOrders(orders);
  if (Object.hasOwn(updates, "status")) {
    try {
      accountingLedger.syncOrder(updatedOrder);
    } catch (error) {
      console.error("Hauptbuch konnte nicht mit der Bestelländerung synchronisiert werden:", error.message);
      const syncError = new Error("Bestellstatus wurde gespeichert, aber die Buchhaltung konnte nicht synchronisiert werden.");
      syncError.code = "ACCOUNTING_SYNC_FAILED";
      syncError.cause = error;
      throw syncError;
    }
  }
  return updatedOrder;
}

function recordOrderDelivery(order, deliveryStatus, discordMessage = {}, deliveryError = "") {
  const updated = updateAdminOrder(order.id, {
    deliveryStatus,
    discordChannelId: discordMessage.channelId || "",
    discordMessageId: discordMessage.messageId || "",
    deliveryError: deliveryError.slice(0, 240)
  });
  if (updated) Object.assign(order, updated);
}

const orderDeliveriesInProgress = new Set();

function queueOrderDelivery(orderId) {
  if (orderDeliveriesInProgress.has(orderId)) return;
  orderDeliveriesInProgress.add(orderId);
  setImmediate(() => {
    void deliverOrderToDiscord(orderId)
      .catch(error => console.error(`Hintergrundversand für Bestellung ${orderId} fehlgeschlagen:`, error.message))
      .finally(() => orderDeliveriesInProgress.delete(orderId));
  });
}

function respondWithQueuedOrder(res, order, fields, message) {
  queueOrderDelivery(order.id);
  const deliveryMessage = discordConfig().botToken
    ? "Der Discord-Versand läuft im Hintergrund."
    : "Die Discord-Bot-Konfiguration fehlt; der Auftrag ist lokal gespeichert.";
  send(res, 202, JSON.stringify({
    ok: true,
    ...fields,
    orderId: order.id,
    deliveryStatus: "pending",
    savedLocally: true,
    message: `${message} ${deliveryMessage}`
  }), "application/json; charset=utf-8");
}

async function deliverOrderToDiscord(orderId) {
  let order;
  let target;
  try {
    order = readAdminOrders().find(entry => entry.id === orderId);
    if (!order || order.deliveryStatus !== "pending") return;
    target = ORDER_DELIVERY_TARGETS[order.type];
    if (!target) throw new Error(`Unbekannter Bestelltyp für Discord-Versand: ${order.type}`);
    const payload = buildAdminOrderDiscordPayload(order);
    const result = await postToDiscordChannel(payload, target.channelId, false);
    recordOrderDelivery(order, result.method, result);
    if (result.method === "local-only") saveOrderLocallyWithWarning(order, target.archiveFile);
  } catch (error) {
    console.error(`Discord-Versand für Bestellung ${orderId} fehlgeschlagen:`, error.message);
    if (!order) return;
    try {
      recordOrderDelivery(order, "failed", {}, error.message || String(error));
      if (target) saveOrderLocallyWithWarning(order, target.archiveFile);
    } catch (persistenceError) {
      console.error(`Lieferfehler für Bestellung ${orderId} konnte nicht gespeichert werden:`, persistenceError.message);
    }
  }
}

function retryPendingOrderDeliveries() {
  try {
    for (const order of readAdminOrders()) {
      if (order.deliveryStatus === "pending") queueOrderDelivery(order.id);
    }
  } catch (error) {
    console.error("Ausstehende Discord-Bestellungen konnten nicht geladen werden:", error.message);
  }
}

function accountingDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function previousAccountingDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}-${String(previous.getUTCDate()).padStart(2, "0")}`;
}

function nextAccountingDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function writeAccountingJson(filePath, value) {
  writeJsonAtomically(filePath, value);
}

function runDailyDataBackup() {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastDataBackupDay) return;
  try {
    const backupPath = createDataBackup({
      directory: DATA_BACKUP_DIR,
      files: [
        { name: "admin-orders", path: ADMIN_ORDERS_FILE },
        { name: "shop-products", path: CATALOG_FILE },
        { name: "shop-coupons", path: SHOP_COUPONS_FILE },
        { name: "family-audit", path: FAMILY_AUDIT_FILE },
        { name: "family-applications", path: FAMILY_APPLICATIONS_FILE },
        { name: "ticket-config", path: TICKET_CONFIG_FILE },
        { name: "catalog-audit-pending", path: CATALOG_AUDIT_PENDING_FILE },
        { name: "accounting-ledger", path: ACCOUNTING_LEDGER_FILE },
        { name: "accounting-reports", path: ACCOUNTING_REPORTS_FILE },
        { name: "material-bestellungen", path: path.join(LOCAL_ORDER_LOG_DIR, "material-bestellungen.json") },
        { name: "stank-bestellungen", path: path.join(LOCAL_ORDER_LOG_DIR, "stank-bestellungen.json") },
        { name: "wunsch-bestellungen", path: path.join(LOCAL_ORDER_LOG_DIR, "wunsch-bestellungen.json") },
        { name: "ankauf-angebote", path: path.join(LOCAL_ORDER_LOG_DIR, "ankauf-angebote.json") }
      ]
    });
    lastDataBackupDay = today;
    console.log(`Datenbackup erstellt: ${backupPath}`);
  } catch (error) {
    console.error("Datenbackup konnte nicht erstellt werden:", error.message);
  }
}

function readShopCoupons() {
  const coupons = JSON.parse(fs.readFileSync(SHOP_COUPONS_FILE, "utf8"));
  if (!Array.isArray(coupons) || coupons.length > 1000) {
    throw new Error("Coupon-Datei enthält keine gültige Coupon-Liste.");
  }
  const ids = new Set();
  const codes = new Set();
  for (const coupon of coupons) {
    if (!coupon || typeof coupon !== "object" || Array.isArray(coupon)) {
      throw new Error("Coupon-Datei enthält ungültige Einträge.");
    }
    const definition = validateCouponDefinition(coupon);
    if (!/^[a-f0-9-]{36}$/i.test(coupon.id || "")
      || definition.code !== coupon.code
      || coupon.percent !== definition.percent
      || typeof coupon.active !== "boolean"
      || (coupon.maxUses !== undefined && coupon.maxUses !== definition.maxUses)
      || typeof coupon.createdAt !== "string"
      || Number.isNaN(Date.parse(coupon.createdAt))
      || typeof coupon.createdBy !== "string"
      || coupon.createdBy.length > 80
      || ids.has(coupon.id)
      || codes.has(coupon.code)) {
      throw new Error("Coupon-Datei enthält ungültige oder doppelte Einträge.");
    }
    ids.add(coupon.id);
    codes.add(coupon.code);
  }
  return coupons;
}

function getCouponUsageCounts(coupons) {
  const counts = new Map(coupons.map(coupon => [coupon.code, 0]));
  for (const order of readAdminOrders()) {
    const code = typeof order.couponCode === "string" ? order.couponCode.toUpperCase() : "";
    if (counts.has(code)) counts.set(code, counts.get(code) + 1);
  }
  return counts;
}

function couponWithUsage(coupon, uses) {
  return {
    ...coupon,
    maxUses: coupon.maxUses ?? null,
    uses,
    usesRemaining: couponUsesRemaining(coupon, uses)
  };
}

function couponRequestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function priceOrderWithCoupon(subtotal, rawCode) {
  const requestedCode = String(rawCode || "").trim();
  if (!requestedCode) {
    return {
      subtotalPrice: subtotal,
      discountAmount: 0,
      totalPrice: subtotal,
      couponCode: "",
      couponPercent: 0
    };
  }

  let code;
  try {
    code = normalizeCouponCode(requestedCode);
  } catch (error) {
    throw couponRequestError(error.message);
  }
  const coupons = readShopCoupons();
  const coupon = findActiveCoupon(coupons, code);
  if (!coupon) {
    throw couponRequestError("Dieser Coupon-Code ist ungültig oder nicht mehr aktiv.");
  }
  const uses = getCouponUsageCounts(coupons).get(coupon.code) || 0;
  if (couponUsesRemaining(coupon, uses) === 0) {
    throw couponRequestError("Dieser Coupon hat sein Einlösungslimit bereits erreicht.");
  }
  const price = calculateCouponPrice(subtotal, coupon.percent);
  return {
    subtotalPrice: price.subtotal,
    discountAmount: price.discountAmount,
    totalPrice: price.total,
    couponCode: coupon.code,
    couponPercent: coupon.percent
  };
}

function sendCouponOrderError(res, error, context) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(`${context}:`, error.message);
  send(res, status, JSON.stringify({
    ok: false,
    message: status === 400 ? error.message : "Coupons sind momentan nicht verfügbar."
  }), "application/json; charset=utf-8");
}

function priceBreakdownMessage(pricing) {
  if (!pricing.couponCode) return `Gesamtpreis: ${pricing.totalPrice.toLocaleString("de-DE")} $.`;
  return `Zwischensumme: ${pricing.subtotalPrice.toLocaleString("de-DE")} $ · Coupon ${pricing.couponCode} (${pricing.couponPercent}%): −${pricing.discountAmount.toLocaleString("de-DE")} $ · Endpreis: ${pricing.totalPrice.toLocaleString("de-DE")} $.`;
}

function couponPriceResponse(pricing) {
  return {
    subtotal: pricing.subtotalPrice,
    discountAmount: pricing.discountAmount,
    total: pricing.totalPrice,
    coupon: pricing.couponCode
      ? { code: pricing.couponCode, percent: pricing.couponPercent }
      : null
  };
}

function readAccountingReports() {
  if (!fs.existsSync(ACCOUNTING_REPORTS_FILE)) {
    const initial = { startedOn: accountingDateKey(), sentDates: [], sentWeeks: [], sentMonths: [] };
    writeAccountingJson(ACCOUNTING_REPORTS_FILE, initial);
    return initial;
  }
  const state = JSON.parse(fs.readFileSync(ACCOUNTING_REPORTS_FILE, "utf8"));
  if (!state || !/^\d{4}-\d{2}-\d{2}$/.test(state.startedOn) || !Array.isArray(state.sentDates)) {
    throw new Error("Buchhaltungsstatus ist ungültig.");
  }
  if (!Array.isArray(state.sentWeeks)) state.sentWeeks = [];
  if (!Array.isArray(state.sentMonths)) state.sentMonths = [];
  return state;
}

function accountingDateIsDue(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
  return values.hour > 0 || (values.hour === 0 && values.minute >= 5);
}

function accountingWeekStart(date) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  return shiftDateKey(date, 1 - weekday);
}

function accountingMonthStart(date) {
  return `${date.slice(0, 7)}-01`;
}

function accountingMonthEnd(monthStart) {
  return shiftDateKey(shiftDateKey(monthStart, 32).slice(0, 7) + "-01", -1);
}

function accountingDateLabel(date) {
  return date.split("-").reverse().join(".");
}

async function sendAccountingReport(title, range, entries) {
  const summary = summarize(entries, range);
  const embed = {
    title,
    description: `**Einnahmen: ${summary.income.toLocaleString("de-DE")} $**\n**Ausgaben: ${summary.expense.toLocaleString("de-DE")} $**\n**Saldo: ${summary.net.toLocaleString("de-DE")} $**\n${summary.count} Buchungen`,
    color: 0x3978d4,
    fields: Object.entries(summary.categories).map(([category, totals]) => ({
      name: CATEGORY_LABELS[category] || category,
      value: `+${totals.income.toLocaleString("de-DE")} $ / −${totals.expense.toLocaleString("de-DE")} $ · ${totals.count} Buchungen`,
      inline: true
    })),
    footer: { text: "Abgelehnte und offene Bestellungen sind nicht gebucht." },
    timestamp: new Date().toISOString()
  };
  const result = await postToDiscordChannel(
    { embeds: [embed], allowed_mentions: { parse: [] } },
    ACCOUNTING_CHANNEL_ID,
    false
  );
  if (result.method === "local-only") {
    throw new Error("Buchhaltungsbericht konnte nicht gesendet werden: DISCORD_BOT_TOKEN fehlt.");
  }
}

let accountingReportInProgress = false;
let lastAccountingReportError = "";
let lastDataBackupDay = "";

async function runDailyAccountingReport() {
  if (accountingReportInProgress || !accountingDateIsDue()) return;
  accountingReportInProgress = true;
  try {
    const state = readAccountingReports();
    const today = accountingDateKey();
    const latestClosedDate = previousAccountingDate(today);
    if (state.startedOn > latestClosedDate) return;
    let reportDate = state.startedOn;
    while (reportDate <= latestClosedDate && state.sentDates.includes(reportDate)) {
      reportDate = nextAccountingDate(reportDate);
    }
    if (reportDate <= latestClosedDate) {
      await sendAccountingReport(
        `Tagesbuchhaltung · ${accountingDateLabel(reportDate)}`,
        { from: reportDate, to: reportDate },
        accountingLedger.read()
      );
      state.sentDates.push(reportDate);
      writeAccountingJson(ACCOUNTING_REPORTS_FILE, state);
      lastAccountingReportError = "";
      console.log(`Buchhaltungsbericht für ${reportDate} in Discord veröffentlicht.`);
      return;
    }

    const latestClosedWeek = shiftDateKey(accountingWeekStart(today), -7);
    let weekStart = accountingWeekStart(state.startedOn);
    while (weekStart <= latestClosedWeek && state.sentWeeks.includes(weekStart)) {
      weekStart = shiftDateKey(weekStart, 7);
    }
    if (weekStart <= latestClosedWeek) {
      const weekEnd = shiftDateKey(weekStart, 6);
      const from = state.startedOn > weekStart ? state.startedOn : weekStart;
      await sendAccountingReport(
        `Wochenbuchhaltung · ${accountingDateLabel(from)}–${accountingDateLabel(weekEnd)}`,
        { from, to: weekEnd },
        accountingLedger.read()
      );
      state.sentWeeks.push(weekStart);
      writeAccountingJson(ACCOUNTING_REPORTS_FILE, state);
      lastAccountingReportError = "";
      console.log(`Wochenbuchhaltungsbericht ab ${weekStart} in Discord veröffentlicht.`);
      return;
    }

    const latestClosedMonth = previousAccountingDate(accountingMonthStart(today));
    const latestClosedMonthStart = accountingMonthStart(latestClosedMonth);
    let monthStart = accountingMonthStart(state.startedOn);
    while (monthStart <= latestClosedMonthStart && state.sentMonths.includes(monthStart)) {
      monthStart = accountingMonthStart(shiftDateKey(monthStart, 32));
    }
    if (monthStart > latestClosedMonthStart) return;
    const monthEnd = accountingMonthEnd(monthStart);
    const from = state.startedOn > monthStart ? state.startedOn : monthStart;
    const monthLabel = new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      month: "long",
      year: "numeric"
    }).format(new Date(`${monthStart}T12:00:00Z`));
    await sendAccountingReport(
      `Monatsbuchhaltung · ${monthLabel}`,
      { from, to: monthEnd },
      accountingLedger.read()
    );
    state.sentMonths.push(monthStart);
    writeAccountingJson(ACCOUNTING_REPORTS_FILE, state);
    lastAccountingReportError = "";
    console.log(`Monatsbuchhaltungsbericht ${monthStart} in Discord veröffentlicht.`);
  } catch (error) {
    const signature = error.message || String(error);
    if (signature !== lastAccountingReportError) {
      console.error("Buchhaltungsbericht konnte nicht veröffentlicht werden:", signature);
      lastAccountingReportError = signature;
    }
  } finally {
    accountingReportInProgress = false;
  }
}

function normalizeShopProduct(product, fallbackId = crypto.randomUUID()) {
  const id = typeof product?.id === "string" && /^[a-f0-9-]{36}$/i.test(product.id)
    ? product.id
    : fallbackId;
  const name = String(product?.name ?? "").trim();
  const price = Number(product?.price);
  const image = typeof product?.image === "string" ? product.image.trim() : "";
  const category = String(product?.category ?? "").trim() || "Allgemein";
  const available = typeof product?.available === "boolean" ? product.available : true;
  const active = typeof product?.active === "boolean" ? product.active : true;

  return {
    id,
    name,
    price,
    image,
    category,
    available: Boolean(available),
    active
  };
}

function getShopPromotion(product) {
  const promotion = SHOP_CONTENT.weeklyOffers.find(entry => entry.productId === product.id);
  if (!promotion || !Number.isSafeInteger(promotion.price) || promotion.price < 1 || promotion.price >= product.price) return null;
  return {
    price: promotion.price,
    label: String(promotion.label || "Wochenangebot")
  };
}

function readShopProducts() {
  const products = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
  if (!Array.isArray(products)) throw new Error("Shop product catalog must be a JSON array.");
  return products.map((product, index) => normalizeShopProduct(product, `${index}-${crypto.randomUUID()}`));
}

function saveShopProducts(products) {
  const temporaryFile = `${CATALOG_FILE}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(products, null, 2), { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporaryFile, CATALOG_FILE);
}

function saveBuybackProducts(products) {
  const temporaryFile = `${BUYBACK_PRODUCTS_FILE}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(products, null, 2), { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporaryFile, BUYBACK_PRODUCTS_FILE);
}

function validateBuybackProducts(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    return { error: "Die Ankaufspreisliste muss zwischen 1 und 100 Produkte enthalten." };
  }
  const products = [];
  const ids = new Set();
  for (const entry of value) {
    const name = String(entry?.name || "").trim();
    const price = Number(entry?.price);
    let id = String(entry?.id || "").trim();
    if (!name || name.length > 80 || !Number.isSafeInteger(price) || price < 1 || price > 1000000000) {
      return { error: "Produktdaten ungültig: Name und Preis prüfen." };
    }
    if (!id) {
      const base = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "produkt";
      id = base;
      let suffix = 2;
      while (ids.has(id)) id = `${base}-${suffix++}`;
    }
    if (!/^[a-z0-9-]{1,80}$/.test(id) || ids.has(id)) {
      return { error: "Produktdaten ungültig: Produktnamen dürfen nicht doppelt sein." };
    }
    ids.add(id);
    products.push({ id, name, price });
  }
  return { products };
}

async function requireCatalogAdmin(req, res, config, redirectPath = "/admin/catalog") {
  const deny = (status, message) => {
    if (String(req.headers.accept || "").includes("text/html")) {
      const page = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Produktverwaltung</title><body style="margin:0;padding:3rem;background:#101214;color:#ececec;font:16px/1.6 system-ui,sans-serif"><main style="max-width:640px;margin:auto"><h1>Produktverwaltung</h1><p>${message}</p><a style="color:#8ec6e8" href="/freie-bestellung.html">Zurück zum Shop</a></main></body></html>`;
      send(res, status, page, "text/html; charset=utf-8");
    } else {
      send(res, status, JSON.stringify({ ok: false, message }), "application/json; charset=utf-8");
    }
  };
  if (!/^\d{17,20}$/.test(config.catalogAdminRoleId)) {
    deny(503, "Die Discord-Rolle für die Produktverwaltung ist noch nicht konfiguriert. Bitte DISCORD_CATALOG_ADMIN_ROLE_ID setzen.");
    return false;
  }
  if (!configIsReady(config)) {
    redirect(res, "/login?error=setup&admin=1");
    return false;
  }

  let session;
  try {
    session = await authorizedSession(req, config);
  } catch (error) {
    console.error("Katalog-Admin-Rollenprüfung fehlgeschlagen:", error.message);
    deny(502, "Die Discord-Rollenprüfung ist momentan nicht erreichbar. Bitte versuche es später erneut.");
    return false;
  }
  if (!session) {
    if (String(req.headers.accept || "").includes("text/html")) {
      redirect(res, `/login?admin=1&next=${encodeURIComponent(redirectPath)}`);
    } else {
      send(res, 401, JSON.stringify({ ok: false, message: "Bitte melde dich mit deinem Discord-Admin-Konto an." }), "application/json; charset=utf-8");
    }
    return null;
  }

  try {
    if (!await memberHasRole(session, config, config.catalogAdminRoleId)) {
      deny(403, "Dein Discord-Konto hat keine Katalog-Admin-Rolle.");
      return null;
    }
  } catch (error) {
    console.error("Katalog-Admin-Rollenprüfung fehlgeschlagen:", error.message);
    deny(502, "Die Discord-Rollenprüfung ist momentan nicht erreichbar. Bitte versuche es später erneut.");
    return null;
  }
  return session;
}

function validateShopProducts(value) {
  if (!Array.isArray(value) || value.length > 200) {
    return { error: "Der Katalog darf höchstens 200 Produkte enthalten." };
  }
  const products = [];
  const ids = new Set();
  for (const entry of value) {
    const product = normalizeShopProduct(entry, crypto.randomUUID());
    const name = product.name;
    const price = Number(product.price);
    const image = typeof product.image === "string" ? product.image.trim() : "";
    const category = String(product.category || "").trim() || "Allgemein";
    const available = typeof product.available === "boolean" ? product.available : true;
    const validImage = !image
      || /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i.test(image)
      || /^https?:\/\/[^\s]+\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(image)
      || /^\/img\/[^\s]+\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(image)
      || /^\.?\.?\/[^\s]+\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(image);
    if (!name || name.length > 80 || category.length > 40
      || !Number.isSafeInteger(price) || price < 1 || price > 1000000000
      || !validImage || typeof product.active !== "boolean" || typeof available !== "boolean" || ids.has(product.id)) {
      return { error: "Produktdaten ungültig: Name, Preis, Bild, Kategorie, Verfügbarkeit, Status oder Produkt-ID prüfen." };
    }
    ids.add(product.id);
    products.push({
      id: product.id,
      name,
      price,
      image,
      category,
      available,
      active: product.active
    });
  }
  return { products };
}

function describeCatalogChanges(previous, updated) {
  const before = new Map(previous.map(product => [product.id, product]));
  const after = new Map(updated.map(product => [product.id, product]));
  const changes = [];
  const auditText = value => String(value ?? "").replace(/@/g, "@\u200b").replace(/\s+/g, " ").slice(0, 320);

  for (const product of updated) {
    const oldProduct = before.get(product.id);
    if (!oldProduct) {
      changes.push(`➕ Hinzugefügt: **${auditText(product.name)}** — ${product.price.toLocaleString("de-DE")} $ (${product.active ? "aktiv" : "inaktiv"})`);
      continue;
    }
    const differences = [];
    if (oldProduct.name !== product.name) differences.push(`Name: „${auditText(oldProduct.name)}“ → „${auditText(product.name)}“`);
    if (oldProduct.description !== product.description) differences.push(`Beschreibung: „${auditText(oldProduct.description || "—")}“ → „${auditText(product.description || "—")}“`);
    if (oldProduct.price !== product.price) differences.push(`Preis: ${oldProduct.price.toLocaleString("de-DE")} $ → ${product.price.toLocaleString("de-DE")} $`);
    if (oldProduct.image !== product.image) differences.push(`Bild: ${oldProduct.image ? "vorhanden" : "kein Bild"} → ${product.image ? "vorhanden" : "kein Bild"}`);
    if (oldProduct.category !== product.category) differences.push(`Kategorie: ${auditText(oldProduct.category || "Allgemein")} → ${auditText(product.category || "Allgemein")}`);
    if (oldProduct.available !== product.available) differences.push(`Verfügbar: ${oldProduct.available ? "ja" : "nein"} → ${product.available ? "ja" : "nein"}`);
    if (oldProduct.active !== product.active) differences.push(`Status: ${oldProduct.active ? "aktiv" : "inaktiv"} → ${product.active ? "aktiv" : "inaktiv"}`);
    if (differences.length) changes.push(`✏️ Geändert: **${auditText(product.name)}** — ${differences.join("; ")}`);
  }

  for (const product of previous) {
    if (!after.has(product.id)) changes.push(`🗑️ Entfernt: **${auditText(product.name)}** — ${product.price.toLocaleString("de-DE")} $`);
  }
  return changes;
}

function readPendingCatalogAudits() {
  if (!fs.existsSync(CATALOG_AUDIT_PENDING_FILE)) return [];
  const pending = JSON.parse(fs.readFileSync(CATALOG_AUDIT_PENDING_FILE, "utf8"));
  if (!Array.isArray(pending)) throw new Error("Pending catalog audit data must be an array.");
  return pending;
}

function savePendingCatalogAudits(pending) {
  const temporaryFile = `${CATALOG_AUDIT_PENDING_FILE}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(pending, null, 2), { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporaryFile, CATALOG_AUDIT_PENDING_FILE);
}

async function logCatalogChanges(records) {
  for (const record of records) {
    const chunks = [];
    let chunk = "";
    for (const change of record.changes) {
      const nextChunk = chunk ? `${chunk}\n${change}` : change;
      if (nextChunk.length > 3500 && chunk) {
        chunks.push(chunk);
        chunk = change;
      } else {
        chunk = nextChunk;
      }
    }
    if (chunk) chunks.push(chunk);

    for (let index = 0; index < chunks.length; index++) {
      const payload = {
        embeds: [{
          title: `Shop-Katalog geändert (${index + 1}/${chunks.length})`,
          description: chunks[index],
          color: 0xe4e8ee,
          fields: [
            { name: "Geändert von", value: record.adminName, inline: true },
            { name: "Discord-ID", value: record.userId, inline: true },
            { name: "Änderungen", value: `${record.changes.length}`, inline: true }
          ],
          timestamp: record.timestamp
        }],
        allowed_mentions: { parse: [] }
      };
      const result = await postToDiscordChannel(payload, CATALOG_AUDIT_CHANNEL_ID, false);
      if (result.method !== "bot") throw new Error("Discord-Bot ist für das Katalog-Audit nicht konfiguriert.");
    }
  }
}

async function flushPendingCatalogAudits() {
  if (catalogAuditInProgress) return { ok: false, changeCount: 0 };
  catalogAuditInProgress = true;
  try {
    const pending = readPendingCatalogAudits();
    const changeCount = pending.reduce((total, record) => total + record.changes.length, 0);
    if (!pending.length) return { ok: true, changeCount: 0 };
    await logCatalogChanges(pending);
    const sentIds = new Set(pending.map(record => record.id));
    const remaining = readPendingCatalogAudits().filter(record => !sentIds.has(record.id));
    if (remaining.length) savePendingCatalogAudits(remaining);
    else fs.unlinkSync(CATALOG_AUDIT_PENDING_FILE);
    return { ok: true, changeCount };
  } catch (error) {
    console.error(`Katalog-Audit-Warteschlange konnte nicht vollständig verarbeitet werden (${CATALOG_AUDIT_CHANNEL_ID}):`, error.message);
    return { ok: false, changeCount: 0 };
  } finally {
    catalogAuditInProgress = false;
  }
}

const catalogAuditRetryTimer = setInterval(() => {
  void flushPendingCatalogAudits();
}, 60 * 1000);
catalogAuditRetryTimer.unref();

function recoverAdminOrderFromDiscordMessage(orderId, payload) {
  const message = payload.message;
  const embed = message?.embeds?.[0];
  const footer = String(embed?.footer?.text || "");
  const type = footer.includes("Material-Ankauf")
    ? "material"
    : footer.includes("Ankauf")
      ? "sell-offer"
      : footer.includes("Wunsch-Bestellung")
      ? "custom"
      : footer.includes("STANK-Kauf")
        ? "stank"
        : "";
  const channelIds = [ORDER_CHANNEL_ID, STANK_ORDER_CHANNEL_ID, CUSTOM_ORDER_CHANNEL_ID, SELL_OFFER_CHANNEL_ID];
  if (!type || !channelIds.includes(String(payload.channel_id || "")) || !Array.isArray(embed.fields)) return null;

  const fields = new Map(embed.fields.map(field => [String(field.name || ""), String(field.value || "").replace(/\*\*/g, "")]));
  const parseAmount = value => {
    const amount = Number(String(value || "").replace(/[^\d-]/g, ""));
    return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
  };
  const createdAt = typeof embed.timestamp === "string" && !Number.isNaN(Date.parse(embed.timestamp))
    ? embed.timestamp
    : new Date().toISOString();
  const statusValue = String(fields.get("Status") || "Neu").replace(" · Abgeschlossen", "").trim();
  return {
    id: orderId,
    type,
    status: statusValue || "Neu",
    icName: fields.get("Kunde") || fields.get("IC-Name") || "Unbekannt",
    phone: phoneFromEmbed(embed) || fields.get("Telefon") || fields.get("Handynummer") || fields.get("Handynummer / IC") || fields.get("Telefonnummer") || "",
    totalPrice: parseAmount(fields.get("Gesamtsumme") || fields.get("Gesamtpreis")),
    technical: parseAmount(fields.get("Technik") || fields.get("Technische Materialien")),
    medical: parseAmount(fields.get("Medizin") || fields.get("Medizinische Materialien")),
    totalMaterials: parseAmount(fields.get("Stück") || fields.get("Gesamtanzahl")),
    quantity: parseAmount(fields.get("Pflanzen") || fields.get("STANK-Pflanzen")),
    items: [],
    discordDescription: String(embed.description || ""),
    createdAt,
    deliveryStatus: "bot",
    discordChannelId: String(payload.channel_id),
    discordMessageId: String(message.id),
    recoveredFromDiscord: true
  };
}

async function verifyDiscordInteraction(rawBody, signatureHex, timestamp, publicKey) {
  if (!signatureHex || !timestamp || !publicKey) return false;
  try {
    return await verifyKey(rawBody, signatureHex, timestamp, publicKey);
  } catch {
    return false;
  }
}

function memberCanManageOrders(guildId, roleIds, config) {
  return guildId === config.guildId
    && /^\d{17,20}$/.test(config.catalogAdminRoleId)
    && Array.isArray(roleIds)
    && roleIds.includes(config.catalogAdminRoleId);
}

function actorNameFromMember(member) {
  return String(member?.user?.global_name || member?.nick || member?.user?.username || "Discord-Admin").slice(0, 80);
}

function findOrderForButton(orderId, messageId) {
  const orders = readAdminOrders();
  let order = orders.find(entry => entry.id === orderId && entry.discordMessageId === messageId)
    || orders.find(entry => entry.id === orderId)
    || orders.find(entry => entry.discordMessageId === messageId);
  if (order && order.id !== orderId) {
    console.warn(`Discord-Bestellbutton ${orderId} wurde über Nachrichten-ID ${messageId} zugeordnet.`);
  }
  return { orders, order };
}

function applyDiscordOrderStatus(orderId, statusKey, actorName, messageId, payload) {
  const { orders, order: existing } = findOrderForButton(orderId, messageId);
  let order = existing;
  if (!order) {
    order = recoverAdminOrderFromDiscordMessage(orderId, payload);
    if (order) {
      writeAdminOrders([...orders, order]);
      console.warn(`Bestellung ${orderId} wurde aus der Discord-Nachricht wiederhergestellt.`);
    }
  }
  if (!order) {
    const error = new Error("order-not-found");
    error.code = "NOT_FOUND";
    throw error;
  }
  if (isAdminOrderClosed(order)) return order;

  const updated = updateAdminOrder(order.id, {
    status: ORDER_STATUS_LABELS[statusKey],
    updatedAt: new Date().toISOString(),
    updatedBy: actorName
  });
  if (!updated) {
    const error = new Error("order-not-found");
    error.code = "NOT_FOUND";
    throw error;
  }
  return updated;
}

function contactReply(orderId, embed) {
  let phone = phoneFromEmbed(embed);
  if (!phone && orderId) {
    try {
      const order = readAdminOrders().find(entry => entry.id === orderId);
      phone = String(order?.phone || "").trim();
    } catch (error) {
      console.error("Telefonnummer konnte nicht gelesen werden:", error.message);
    }
  }
  return phone
    ? `📞 Kontakt: ${phone}`
    : "Für diese Bestellung ist keine Telefonnummer hinterlegt.";
}

async function editOriginalInteraction(payload, data) {
  const applicationId = payload.application_id;
  const token = payload.token;
  if (!applicationId || !token) throw new Error("Interaction-Token fehlt.");
  let headers;
  let body;
  if (Array.isArray(data.files) && data.files.length) {
    const files = data.files;
    const payloadData = { ...data };
    delete payloadData.files;
    payloadData.attachments = files.map((file, index) => ({ id: index, filename: file.filename }));
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payloadData));
    files.forEach((file, index) => {
      form.append(`files[${index}]`, new Blob([file.buffer], { type: file.contentType }), file.filename);
    });
    body = form;
  } else {
    headers = { "Content-Type": "application/json" };
    body = JSON.stringify(data);
  }
  const response = await discordFetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}/messages/@original`,
    {
      method: "PATCH",
      headers,
      body
    }
  );
  if (!response.ok) {
    const body = parseJson(await response.text());
    throw new Error(body?.message || `Discord-Update fehlgeschlagen (${response.status}).`);
  }
}

async function followupInteraction(payload, content) {
  const applicationId = payload.application_id;
  const token = payload.token;
  if (!applicationId || !token) return;
  try {
    await discordFetch(
      `https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, flags: 64, allowed_mentions: { parse: [] } })
      }
    );
  } catch (error) {
    console.error("Discord-Followup fehlgeschlagen:", error.message);
  }
}

function interactionMessageData(order) {
  const message = buildAdminOrderDiscordPayload(order);
  return {
    content: message.content,
    embeds: message.embeds,
    components: message.components,
    allowed_mentions: message.allowed_mentions
  };
}

async function handleNewFamilyInteraction(interaction) {
  const config = discordConfig();
  if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
    await interaction.reply({
      content: "Dieser Befehl kann nur auf dem konfigurierten Discord-Server verwendet werden.",
      ephemeral: true
    });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "Nur Server-Admins dürfen Familienkanäle erstellen.",
      ephemeral: true
    });
    return;
  }

  const familyName = interaction.options.getString("name", true).trim();
  if (!familySlug(familyName)) {
    await interaction.reply({
      content: "Bitte gib einen gültigen Familiennamen ein.",
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const result = await createFamily(interaction.guild, interaction.user.id, familyName);
  await interaction.editReply({ content: familyCreatedMessage(familyName, result) });
}

async function handleDeleteFamilyInteraction(interaction) {
  const config = discordConfig();
  if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
    await interaction.reply({
      content: "Dieser Befehl kann nur auf dem konfigurierten Discord-Server verwendet werden.",
      ephemeral: true
    });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "Nur Server-Admins dürfen Familien löschen.",
      ephemeral: true
    });
    return;
  }

  const familyName = interaction.options.getString("name", true).trim();
  if (!familySlug(familyName)) {
    await interaction.reply({
      content: "Bitte gib einen gültigen Familiennamen ein.",
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const confirmation = await prepareFamilyDeletion(interaction.guild, familyName, interaction.user.id);
  await interaction.editReply({
    content: familyDeletionPrompt(familyName, confirmation),
    components: familyDeletionButtons(confirmation.token),
    allowedMentions: { parse: [] },
  });
}

async function handleFamilyManagementInteraction(interaction) {
  const config = discordConfig();
  if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
    await interaction.reply({
      content: "Dieser Befehl kann nur auf dem konfigurierten Discord-Server verwendet werden.",
      ephemeral: true
    });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "Nur Server-Admins dürfen Familien verwalten.",
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const commandName = interaction.commandName;
    let content;
    let components = [];
    if (commandName === "famadd" || commandName === "famremove") {
      const familyName = interaction.options.getString("familie", true).trim();
      const member = interaction.options.getUser("mitglied", true);
      const confirmation = await prepareFamilyMemberChange(
        interaction.guild,
        familyName,
        member.id,
        commandName === "famadd",
        interaction.user.id,
        interaction.user.username
      );
      await interaction.editReply({
        content: familyMemberChangePrompt(confirmation),
        components: familyMemberChangeButtons(confirmation.token),
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (commandName === "listfam") {
      const page = await prepareFamilyList(interaction.guild, interaction.user.id);
      content = page.content;
      components = page.components;
    } else if (commandName === "famcheck") {
      content = await checkFamilies(interaction.guild);
    } else if (commandName === "famuebersicht") {
      content = await getFamilyOverview(interaction.guild);
    } else if (commandName === "famrolle") {
      content = await getFamilyRolesPage(interaction.guild, interaction.options.getInteger("seite") || 1);
    } else if (commandName === "famfarbe") {
      content = await setFamilyColor(
        interaction.guild,
        interaction.options.getString("familie", true).trim(),
        interaction.options.getString("farbe", true),
        interaction.user.id
      );
    } else if (commandName === "famtopic") {
      content = await setFamilyTopic(
        interaction.guild,
        interaction.options.getString("familie", true).trim(),
        interaction.options.getString("thema") || "",
        interaction.user.id
      );
    } else if (commandName === "famaktivitaet") {
      content = await getFamilyActivity(interaction.guild, interaction.options.getString("familie", true).trim());
    } else if (commandName === "famaudit") {
      content = getFamilyAudit(
        interaction.options.getString("suche") || "",
        interaction.options.getInteger("anzahl") || 10
      );
    } else if (commandName === "famexport") {
      const exported = await exportFamilies(interaction.guild, interaction.options.getString("format", true));
      await interaction.editReply({
        content: "Familienressourcen wurden exportiert.",
        files: [new AttachmentBuilder(exported.buffer, { name: exported.filename })]
      });
      return;
    } else if (commandName === "faminfo") {
      content = await getFamilyInfo(interaction.guild, interaction.options.getString("name", true).trim());
    } else if (commandName === "famrename") {
      const oldName = interaction.options.getString("alt", true).trim();
      const newName = interaction.options.getString("neu", true).trim();
      content = await renameFamily(interaction.guild, oldName, newName, interaction.user.id);
    }
    await interaction.editReply({ content, components, allowedMentions: { parse: [] } });
  } catch (error) {
    console.error(`Discord-Slash-Command /${interaction.commandName} fehlgeschlagen:`, error.message);
    await interaction.editReply({
      content: `/${interaction.commandName} fehlgeschlagen: ${error.message}`,
      allowedMentions: { parse: [] }
    });
  }
}

function familySlug(familyName) {
  return String(familyName || "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 100);
}

function familyCreatedMessage(familyName, result) {
  return `Familie **${familyName}** wurde eingerichtet: <#${result.channelId}>. Die Rolle <@&${result.roleId}> wurde dir zugewiesen.`;
}

async function logFamilyAudit(action, familyName, actorId, details = "") {
  const suffix = details ? `\n${details}` : "";
  const timestamp = new Date().toISOString();
  try {
    const entries = JSON.parse(fs.readFileSync(FAMILY_AUDIT_FILE, "utf8"));
    if (!Array.isArray(entries)) throw new Error("Die Familien-Audit-Datei enthält keine gültige Liste.");
    entries.unshift({
      id: crypto.randomUUID(),
      action,
      familyName,
      actorId,
      details,
      timestamp
    });
    writeAccountingJson(FAMILY_AUDIT_FILE, entries.slice(0, 5000));
  } catch (error) {
    console.error("Familien-Audit konnte nicht lokal gespeichert werden:", error.message);
  }
  const message = `Familienverwaltung: **${action}**\nFamilie: **${familyName}**\nAusgeführt von: <@${actorId}> (${actorId})\nZeit: ${timestamp}${suffix}`;
  try {
    const result = await postToDiscordChannel(
      { content: message, allowed_mentions: { parse: [] } },
      CATALOG_AUDIT_CHANNEL_ID,
      false
    );
    if (result.method !== "bot") throw new Error("Discord-Bot ist nicht konfiguriert.");
  } catch (error) {
    console.error(`Familien-Audit konnte nicht an Kanal ${CATALOG_AUDIT_CHANNEL_ID} gesendet werden:`, error.message);
  }
}

async function familyEntries(guild, loadMembers = false) {
  const [channels, roles] = await Promise.all([
    guild.channels.fetch(),
    guild.roles.fetch()
  ]);
  const categories = channels.filter(channel =>
    channel?.type === ChannelType.GuildCategory
    && channel.name.toLowerCase() === FAMILY_CATEGORY_NAME.toLowerCase()
  );
  if (categories.size > 1) {
    throw new Error(`Es gibt mehrere Kategorien namens „${FAMILY_CATEGORY_NAME}“. Bitte bereinige die doppelten Kategorien zuerst.`);
  }
  const category = categories.first();
  if (!category) return [];

  const familyChannels = channels.filter(channel =>
    channel?.type === ChannelType.GuildText
    && channel.parentId === category.id
  );
  const familyRoles = roles.filter(role => role.id !== guild.roles.everyone.id && !role.managed);
  if (loadMembers && familyRoles.size) await guild.members.fetch();

  return familyChannels.map(channel => {
    const matchingRoles = familyRoles.filter(role => familySlug(role.name) === channel.name);
    return {
      channel,
      role: matchingRoles.size === 1 ? matchingRoles.first() : null,
      matchingRoles
    };
  }).sort((left, right) => left.channel.name.localeCompare(right.channel.name, "de"));
}

function familyNameFromEntry(entry) {
  return entry.role?.name || entry.channel.name;
}

function familyListLine({ channel, role, matchingRoles }) {
  const roleStatus = matchingRoles?.size > 1
    ? `mehrere passende Rollen (${matchingRoles.size})`
    : role ? `${role.members.size} Mitglied(er)` : "Rolle fehlt";
  return `• **${familyNameFromEntry({ channel, role })}** · <#${channel.id}> · ${roleStatus}`;
}

function familyListPageData(state, index) {
  const start = index * state.pageSize;
  const lines = state.entries.slice(start, start + state.pageSize).map(familyListLine);
  const content = `**Familien (${state.entries.length}) · Seite ${index + 1}/${state.pageCount}**\n${lines.join("\n")}`;
  const components = state.pageCount > 1
    ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`famlist:prev:${state.token}`)
        .setLabel("Zurück")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(index === 0),
      new ButtonBuilder()
        .setCustomId(`famlist:next:${state.token}`)
        .setLabel("Weiter")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(index === state.pageCount - 1)
    )]
    : [];
  return { content, components };
}

async function prepareFamilyList(guild, userId) {
  const entries = await familyEntries(guild, true);
  if (!entries.length) {
    return { content: "Es wurden keine Familienkanäle in der Kategorie „Familien“ gefunden.", components: [] };
  }
  const token = crypto.randomUUID();
  for (const [existingToken, state] of pendingFamilyListPages) {
    if (state.expiresAt <= Date.now()) pendingFamilyListPages.delete(existingToken);
  }
  const state = {
    token,
    guildId: guild.id,
    userId,
    entries,
    pageSize: 8,
    pageCount: Math.ceil(entries.length / 8),
    expiresAt: Date.now() + 5 * 60 * 1000
  };
  pendingFamilyListPages.set(token, state);
  return familyListPageData(state, 0);
}

function moveFamilyListPage(token, direction, guildId, userId) {
  const state = pendingFamilyListPages.get(token);
  if (!state || state.expiresAt <= Date.now()) {
    pendingFamilyListPages.delete(token);
    throw new Error("Diese Familienliste ist abgelaufen. Bitte starte `/listfam` erneut.");
  }
  if (state.guildId !== guildId || state.userId !== userId) {
    throw new Error("Diese Familienliste gehört einer anderen Person oder einem anderen Server.");
  }
  state.page = Math.max(0, Math.min(state.pageCount - 1, (state.page || 0) + direction));
  return familyListPageData(state, state.page);
}

async function checkFamilies(guild) {
  const [channels, roles] = await Promise.all([
    guild.channels.fetch(),
    guild.roles.fetch()
  ]);
  const categories = channels.filter(channel =>
    channel?.type === ChannelType.GuildCategory
    && channel.name.toLowerCase() === FAMILY_CATEGORY_NAME.toLowerCase()
  );
  if (categories.size > 1) {
    throw new Error(`Es gibt mehrere Kategorien namens „${FAMILY_CATEGORY_NAME}“. Bitte bereinige die doppelten Kategorien zuerst.`);
  }
  const category = categories.first();
  if (!category) return `Die Kategorie „${FAMILY_CATEGORY_NAME}“ wurde nicht gefunden. Es wurde keine Prüfung durchgeführt.`;

  const familyChannels = channels.filter(channel =>
    channel?.type === ChannelType.GuildText
    && channel.parentId === category.id
  );
  const familyRoles = roles.filter(role => role.id !== guild.roles.everyone.id && !role.managed);
  if (familyRoles.size) await guild.members.fetch();
  const channelsWithoutRoles = [];
  const emptyFamilies = [];
  const rolesMatchedToChannels = new Set();
  for (const channel of familyChannels.values()) {
    const matchingRoles = familyRoles.filter(role => familySlug(role.name) === channel.name);
    if (matchingRoles.size !== 1) {
      channelsWithoutRoles.push({ channel, duplicateCount: matchingRoles.size });
    } else {
      const familyRole = matchingRoles.first();
      rolesMatchedToChannels.add(familyRole.id);
      if (familyRole.members.size === 0) emptyFamilies.push({ channel, role: familyRole });
    }
  }
  const orphanRoleCandidates = familyRoles.filter(role =>
    !rolesMatchedToChannels.has(role.id)
    && role.hoist === false
    && role.mentionable === false
    && role.permissions.bitfield === 0n
    && role.color === 0
  );
  if (!channelsWithoutRoles.length && !orphanRoleCandidates.length && !emptyFamilies.length) {
    return `Familienprüfung abgeschlossen: ${familyChannels.size} Kanal/Kanäle und passende Rollen gefunden. Keine Abweichungen.`;
  }

  const lines = ["**Familienprüfung: mögliche Abweichungen**"];
  if (channelsWithoutRoles.length) {
    lines.push("", "**Kanäle ohne eindeutige passende Rolle:**");
    lines.push(...channelsWithoutRoles.map(({ channel, duplicateCount }) =>
      duplicateCount
        ? `• <#${channel.id}> (\`${channel.name}\`) · ${duplicateCount} passende Rollen`
        : `• <#${channel.id}> (\`${channel.name}\`) · keine passende Rolle`
    ));
  }
  if (orphanRoleCandidates.length) {
    lines.push("", "**Mögliche verwaiste Familienrollen (bitte manuell prüfen):**");
    lines.push(...orphanRoleCandidates.map(role => `• <@&${role.id}>`));
  }
  if (emptyFamilies.length) {
    lines.push("", "**Leere Familien (keine Mitglieder mit Familienrolle):**");
    lines.push(...emptyFamilies.map(({ channel, role }) =>
      `• **${role.name}** · <#${channel.id}>`
    ));
  }
  lines.push("", "Rollen werden nur als Kandidaten angezeigt, wenn sie den Einstellungen neu erstellter Familienrollen entsprechen. Es werden keine Ressourcen geändert.");
  let content = "";
  let includedLines = 0;
  for (const line of lines) {
    if (content.length + line.length + 1 > 1900) break;
    content += `${content ? "\n" : ""}${line}`;
    includedLines++;
  }
  if (includedLines < lines.length) content += "\n… weitere Einträge wurden zur Einhaltung des Discord-Limits weggelassen.";
  return content;
}

async function getFamilyOverview(guild) {
  const entries = await familyEntries(guild, true);
  const memberCount = entries.reduce((sum, entry) => sum + (entry.role?.members.size || 0), 0);
  const emptyCount = entries.filter(entry => entry.role && entry.role.members.size === 0).length;
  const missingRoleCount = entries.filter(entry => !entry.role).length;
  const duplicateRoleCount = entries.filter(entry => entry.matchingRoles.size > 1).length;
  return [
    "**Familienübersicht**",
    `Familienkanäle: **${entries.length}**`,
    `Mitgliederzuordnungen: **${memberCount}**`,
    `Leere Familien: **${emptyCount}**`,
    `Kanäle ohne eindeutige Rolle: **${missingRoleCount}**`,
    `Familien mit mehrfach passender Rolle: **${duplicateRoleCount}**`
  ].join("\n");
}

async function getFamilyRolesPage(guild, page = 1) {
  if (!Number.isInteger(page) || page < 1) throw new Error("Die Seitennummer muss mindestens 1 sein.");
  const entries = await familyEntries(guild, true);
  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  if (page > pageCount) throw new Error(`Es gibt nur ${pageCount} Seite(n).`);
  const lines = entries.slice((page - 1) * pageSize, page * pageSize).map(entry => {
    const members = entry.role
      ? [...entry.role.members.keys()].sort()
      : [];
    const listedMembers = members.slice(0, 12).map(id => `<@${id}>`).join(", ");
    const remainder = members.length > 12 ? ` · +${members.length - 12} weitere` : "";
    return `**${familyNameFromEntry(entry)}** · ${entry.role ? `<@&${entry.role.id}>` : "Rolle fehlt"} (${members.length})\n${listedMembers || "Keine zugeordneten Mitglieder"}${remainder}`;
  });
  return `**Familienrollen und Mitglieder · Seite ${page}/${pageCount}**\n${lines.join("\n\n") || "Keine Familien gefunden."}`;
}

async function setFamilyColor(guild, familyName, color, actorId) {
  const normalized = String(color || "").trim();
  if (!/^#?[0-9a-f]{6}$/i.test(normalized)) {
    throw new Error("Bitte gib eine HEX-Farbe mit sechs Stellen an, zum Beispiel `#3366ff`.");
  }
  const { role } = await findFamilyResources(guild, familyName);
  if (!role) throw new Error(`Die Familienrolle für „${familyName}“ wurde nicht eindeutig gefunden.`);
  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("Dem Bot fehlt die Serverberechtigung „Rollen verwalten“.");
  }
  const hexColor = `#${normalized.replace(/^#/, "")}`;
  await role.setColor(hexColor, `Rollenfarbe durch Admin ${actorId} geändert`);
  await logFamilyAudit("Rollenfarbe geändert", familyName, actorId, `Farbe: ${hexColor}`);
  return `Die Rolle der Familie **${familyName}** hat jetzt die Farbe ${hexColor}.`;
}

async function setFamilyTopic(guild, familyName, topic, actorId) {
  const normalized = String(topic || "").trim();
  if (normalized.length > 1024) throw new Error("Das Kanalthema darf höchstens 1024 Zeichen lang sein.");
  const { channel } = await findFamilyResources(guild, familyName);
  if (!channel) throw new Error(`Der Familienkanal für „${familyName}“ wurde nicht eindeutig gefunden.`);
  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)
    || !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("Dem Bot fehlt die Serverberechtigung „Kanäle verwalten“.");
  }
  await channel.setTopic(normalized || null, `Kanalthema durch Admin ${actorId} geändert`);
  await logFamilyAudit("Kanalthema geändert", familyName, actorId, `Neues Thema: ${normalized || "(leer)"}`);
  return `Das Thema von <#${channel.id}> wurde aktualisiert.`;
}

async function getFamilyActivity(guild, familyName) {
  const { channel } = await findFamilyResources(guild, familyName);
  if (!channel) throw new Error(`Der Familienkanal für „${familyName}“ wurde nicht eindeutig gefunden.`);
  const botMember = await guild.members.fetchMe();
  if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ViewChannel)
    || !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ReadMessageHistory)) {
    throw new Error("Dem Bot fehlen im Familienkanal „Kanal ansehen“ oder „Nachrichtenverlauf ansehen“.");
  }
  const latest = await channel.messages.fetch({ limit: 1 });
  const lastMessage = latest.first();
  return lastMessage
    ? `Letzte Aktivität in **${familyName}**: ${lastMessage.createdAt.toLocaleString("de-DE")}.\nEs wurden keine Nachrichteninhalte in der Ausgabe angezeigt.`
    : `Im Kanal **${familyName}** wurden keine Nachrichten gefunden.`;
}

function getFamilyAudit(searchTerm = "", limit = 10) {
  const entries = JSON.parse(fs.readFileSync(FAMILY_AUDIT_FILE, "utf8"));
  if (!Array.isArray(entries)) throw new Error("Die Familien-Audit-Datei enthält keine gültige Liste.");
  const query = String(searchTerm || "").trim().toLocaleLowerCase("de");
  const matches = entries.filter(entry => {
    const searchable = `${entry.action} ${entry.familyName} ${entry.actorId} ${entry.details}`.toLocaleLowerCase("de");
    return !query || searchable.includes(query);
  }).slice(0, Math.max(1, Math.min(20, limit)));
  if (!matches.length) return "Keine passenden Familien-Audit-Einträge gefunden.";
  return `**Familien-Audit · ${matches.length} Eintrag/Einträge**\n${matches.map(entry =>
    `• **${entry.action}** · **${entry.familyName}** · <@${entry.actorId}> · ${new Date(entry.timestamp).toLocaleString("de-DE")}${entry.details ? `\n  ${entry.details}` : ""}`
  ).join("\n")}`.slice(0, 1900);
}

function readFamilyApplications() {
  const applications = JSON.parse(fs.readFileSync(FAMILY_APPLICATIONS_FILE, "utf8"));
  if (!Array.isArray(applications)) throw new Error("Die Datei für Familienbeitritte ist ungültig.");
  return applications;
}

function familyApplicationButtons(token) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`famapply:approve:${token}`)
      .setLabel("Annehmen")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`famapply:reject:${token}`)
      .setLabel("Ablehnen")
      .setStyle(ButtonStyle.Danger)
  )];
}

async function requestFamilyMembership(guild, familyName, user) {
  const { role, channel } = await findFamilyResources(guild, familyName);
  if (!role || !channel) throw new Error(`Familie „${familyName}“ wurde nicht eindeutig gefunden.`);
  const member = await guild.members.fetch(user.id);
  if (member.roles.cache.has(role.id)) throw new Error(`Du bist bereits Mitglied von **${familyName}**.`);
  const applications = readFamilyApplications();
  const existing = applications.find(application =>
    application.guildId === guild.id
    && application.userId === user.id
    && application.roleId === role.id
    && application.status === "pending"
  );
  if (existing) throw new Error("Für diese Familie liegt bereits ein offener Antrag von dir vor.");

  const botMember = await guild.members.fetchMe();
  const auditChannel = await discordGatewayClient.channels.fetch(CATALOG_AUDIT_CHANNEL_ID);
  if (!auditChannel?.isTextBased() || !auditChannel.send
    || !auditChannel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages)) {
    throw new Error("Der konfigurierte Audit-Channel ist für den Bot nicht beschreibbar.");
  }
  const application = {
    token: crypto.randomUUID(),
    guildId: guild.id,
    familyName: role.name,
    roleId: role.id,
    channelId: channel.id,
    userId: user.id,
    username: user.tag || user.username,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  applications.unshift(application);
  writeAccountingJson(FAMILY_APPLICATIONS_FILE, applications.slice(0, 1000));
  try {
    await auditChannel.send({
      content: `**Familienbeitritt beantragt**\nFamilie: **${role.name}** · <#${channel.id}>\nMitglied: <@${user.id}> (${user.id})\nZeit: ${application.createdAt}`,
      components: familyApplicationButtons(application.token),
      allowedMentions: { users: [user.id] }
    });
  } catch (error) {
    const savedApplications = readFamilyApplications()
      .filter(saved => saved.token !== application.token);
    writeAccountingJson(FAMILY_APPLICATIONS_FILE, savedApplications);
    throw new Error(`Der Antrag konnte nicht an die Admins gesendet werden: ${error.message}`);
  }
  await logFamilyAudit("Beitritt beantragt", role.name, user.id, `Mitglied: ${user.tag || user.username} (${user.id})`);
  return `Dein Antrag für **${role.name}** wurde an die zuständigen Admins gesendet.`;
}

async function completeFamilyApplication(token, action, actorId, guild) {
  const applications = readFamilyApplications();
  const index = applications.findIndex(application => application.token === token);
  if (index < 0 || applications[index].status !== "pending") {
    throw new Error("Dieser Familienantrag wurde bereits bearbeitet oder ist nicht mehr verfügbar.");
  }
  const application = applications[index];
  if (application.guildId !== guild.id) throw new Error("Dieser Antrag gehört zu einem anderen Server.");
  const member = await guild.members.fetch(actorId);
  const hasAdminRole = Boolean(discordConfig().catalogAdminRoleId
    && member.roles.cache.has(discordConfig().catalogAdminRoleId));
  if (!member.permissions.has(PermissionFlagsBits.Administrator) && !hasAdminRole) {
    throw new Error("Nur Server-Admins oder Katalog-Admins dürfen Familienanträge bearbeiten.");
  }

  if (action === "approve") {
    const role = await guild.roles.fetch(application.roleId);
    if (!role) throw new Error("Die Familienrolle wurde inzwischen gelöscht.");
    const applicant = await guild.members.fetch(application.userId);
    if (!applicant.roles.cache.has(role.id)) {
      const botMember = await guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error("Dem Bot fehlt die Serverberechtigung „Rollen verwalten“.");
      }
      await applicant.roles.add(role, `Familienantrag durch Admin ${actorId} angenommen`);
    }
  }

  application.status = action === "approve" ? "approved" : "rejected";
  application.reviewedAt = new Date().toISOString();
  application.reviewedBy = actorId;
  writeAccountingJson(FAMILY_APPLICATIONS_FILE, applications);
  await logFamilyAudit(
    action === "approve" ? "Beitrittsantrag angenommen" : "Beitrittsantrag abgelehnt",
    application.familyName,
    actorId,
    `Mitglied: ${application.username} (${application.userId})`
  );
  try {
    const applicant = await guild.members.fetch(application.userId);
    await applicant.send(action === "approve"
      ? `Dein Antrag für die Familie **${application.familyName}** wurde angenommen.`
      : `Dein Antrag für die Familie **${application.familyName}** wurde abgelehnt.`);
  } catch (error) {
    console.warn(`Familienantrag wurde bearbeitet, aber die DM an ${application.userId} konnte nicht gesendet werden:`, error.message);
  }
  return action === "approve"
    ? `Der Antrag von <@${application.userId}> für **${application.familyName}** wurde angenommen.`
    : `Der Antrag von <@${application.userId}> für **${application.familyName}** wurde abgelehnt.`;
}

async function exportFamilies(guild, format) {
  const entries = await familyEntries(guild, true);
  const rows = entries.map(entry => ({
    family: familyNameFromEntry(entry),
    channelId: entry.channel.id,
    channelName: entry.channel.name,
    roleId: entry.role?.id || "",
    memberIds: entry.role ? [...entry.role.members.keys()] : [],
    members: entry.role
      ? [...entry.role.members.values()].map(member => ({ id: member.id, name: member.displayName }))
      : []
  }));
  if (format === "json") {
    const result = {
      filename: "familien-export.json",
      contentType: "application/json",
      buffer: Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), families: rows }, null, 2), "utf8")
    };
    if (result.buffer.length > 7_500_000) throw new Error("Der Export ist größer als Discords Dateilimit von 7,5 MB.");
    return result;
  }
  if (format !== "csv") throw new Error("Bitte wähle JSON oder CSV als Exportformat.");
  const escapeCsv = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["Familie", "Kanal-ID", "Kanalname", "Rollen-ID", "Mitglieds-IDs"].map(escapeCsv).join(","),
    ...rows.map(row => [
      row.family,
      row.channelId,
      row.channelName,
      row.roleId,
      row.memberIds.join(";")
    ].map(escapeCsv).join(","))
  ];
  const result = {
    filename: "familien-export.csv",
    contentType: "text/csv; charset=utf-8",
    buffer: Buffer.from(`\uFEFF${lines.join("\r\n")}`, "utf8")
  };
  if (result.buffer.length > 7_500_000) throw new Error("Der Export ist größer als Discords Dateilimit von 7,5 MB.");
  return result;
}

async function handleFamilyApplicationInteraction(interaction) {
  const config = discordConfig();
  if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
    await interaction.reply({
      content: "Dieser Befehl kann nur auf dem konfigurierten Discord-Server verwendet werden.",
      ephemeral: true
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const message = await requestFamilyMembership(
      interaction.guild,
      interaction.options.getString("familie", true).trim(),
      interaction.user
    );
    await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
  } catch (error) {
    await interaction.editReply({ content: error.message, allowedMentions: { parse: [] } });
  }
}

function readTicketConfiguration() {
  const config = JSON.parse(fs.readFileSync(TICKET_CONFIG_FILE, "utf8"));
  if (Array.isArray(config) && config.length === 0) return null;
  if (!config || typeof config !== "object"
    || !/^\d{17,20}$/.test(config.panelChannelId || "")
    || !/^\d{17,20}$/.test(config.categoryId || "")
    || !/^\d{17,20}$/.test(config.adminRoleId || "")
    || !Array.isArray(config.types)
    || config.types.length < 1
    || config.types.length > 25) {
    throw new Error("Die Ticketkonfiguration ist ungültig. Bitte führe `/ticketeinrichten` erneut aus.");
  }
  return config;
}

function ticketPanelComponents(types) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("ticket:types")
    .setPlaceholder("Wähle die passende Ticket-Art")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(types.map((type, index) => ({
      label: type,
      value: String(index),
      description: `Ticket: ${type}`.slice(0, 100)
    })));
  return [new ActionRowBuilder().addComponents(menu)];
}

function ticketCloseComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:close")
      .setLabel("Ticket schließen")
      .setStyle(ButtonStyle.Danger)
  )];
}

async function configureTickets(guild, panelChannel, category, archiveCategory, typeInput) {
  const types = normalizeTicketTypes(typeInput);
  const config = discordConfig();
  if (!config.catalogAdminRoleId || !/^\d{17,20}$/.test(config.catalogAdminRoleId)) {
    throw new Error("DISCORD_CATALOG_ADMIN_ROLE_ID muss gesetzt sein, damit Katalog-Admins Zugriff auf Tickets erhalten.");
  }
  const [botMember, adminRole] = await Promise.all([
    guild.members.fetchMe(),
    guild.roles.fetch(config.catalogAdminRoleId)
  ]);
  if (!adminRole) throw new Error("Die konfigurierte Katalog-Admin-Rolle wurde auf diesem Server nicht gefunden.");
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)
    || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("Dem Bot fehlen „Kanäle verwalten“ oder „Rollen verwalten“.");
  }
  if (!panelChannel?.isTextBased() || !panelChannel.send
    || !panelChannel.permissionsFor(botMember)?.has(PermissionFlagsBits.ViewChannel)
    || !panelChannel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages)) {
    throw new Error("Der ausgewählte Ticket-Panel-Kanal ist für den Bot nicht beschreibbar.");
  }
  if (category?.type !== ChannelType.GuildCategory
    || archiveCategory && archiveCategory.type !== ChannelType.GuildCategory) {
    throw new Error("Bitte wähle für Ticket- und Archivkategorie jeweils eine Kategorie aus.");
  }
  const panel = await panelChannel.send({
    content: "**Support-Tickets**\nWähle eine Ticket-Art aus. Dein Ticket ist nur für dich und die Katalog-Admins sichtbar.",
    components: ticketPanelComponents(types)
  });
  const savedConfig = {
    panelChannelId: panelChannel.id,
    panelMessageId: panel.id,
    categoryId: category.id,
    archiveCategoryId: archiveCategory?.id || null,
    adminRoleId: adminRole.id,
    types,
    configuredAt: new Date().toISOString()
  };
  try {
    writeAccountingJson(TICKET_CONFIG_FILE, savedConfig);
  } catch (error) {
    await panel.delete().catch(deleteError => {
      console.error("Nicht gespeichertes Ticket-Panel konnte nicht entfernt werden:", deleteError.message);
    });
    throw error;
  }
  return `Ticket-System eingerichtet. Panel: <#${panelChannel.id}> · Ticket-Arten: ${types.join(", ")}.`;
}

async function createTicketChannel(guild, userId, selectedType) {
  if (pendingTicketCreations.has(userId)) throw new Error("Deine Ticketerstellung wird bereits verarbeitet.");
  pendingTicketCreations.add(userId);
  try {
    return await createTicketChannelUnlocked(guild, userId, selectedType);
  } finally {
    pendingTicketCreations.delete(userId);
  }
}

async function createTicketChannelUnlocked(guild, userId, selectedType) {
  const config = readTicketConfiguration();
  if (!config) throw new Error("Das Ticketsystem ist noch nicht eingerichtet. Ein Admin muss `/ticketeinrichten` ausführen.");
  const typeIndex = Number(selectedType);
  if (!Number.isInteger(typeIndex) || config.types[typeIndex] === undefined) {
    throw new Error("Diese Ticket-Art ist nicht mehr verfügbar. Bitte nutze das aktuelle Ticket-Panel.");
  }
  const type = config.types[typeIndex];
  const channels = await guild.channels.fetch();
  const existing = channels.find(channel => {
    const ticket = parseTicketTopic(channel?.topic);
    return ticket?.status === "open" && ticket.ownerId === userId;
  });
  if (existing) throw new Error(`Du hast bereits ein offenes Ticket: <#${existing.id}>.`);

  const [botMember, adminRole, owner] = await Promise.all([
    guild.members.fetchMe(),
    guild.roles.fetch(config.adminRoleId),
    guild.members.fetch(userId)
  ]);
  if (!adminRole) throw new Error("Die konfigurierte Katalog-Admin-Rolle wurde gelöscht.");
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("Dem Bot fehlt die Serverberechtigung „Kanäle verwalten“.");
  }
  const category = await guild.channels.fetch(config.categoryId);
  if (category?.type !== ChannelType.GuildCategory) throw new Error("Die konfigurierte Ticket-Kategorie wurde gelöscht.");
  const channelName = `ticket-${ticketChannelSlug(type)}-${ticketChannelSlug(owner.user.username)}`.slice(0, 100);
  const ticket = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: createTicketTopic({
      ownerId: owner.id,
      type,
      status: "open",
      createdAt: new Date().toISOString()
    }),
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: owner.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles
        ]
      },
      {
        id: adminRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages
        ]
      },
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.AttachFiles
        ]
      }
    ],
    reason: `Support-Ticket (${type}) für ${owner.user.tag}`
  });
  try {
    await ticket.send({
      content: `Hallo <@${owner.id}>! Dein Ticket **${type}** wurde erstellt. Beschreibe dein Anliegen hier; die Katalog-Admins helfen dir weiter.`,
      components: ticketCloseComponents(),
      allowedMentions: { users: [owner.id] }
    });
  } catch (error) {
    await ticket.delete("Ticket konnte nicht initialisiert werden").catch(deleteError => {
      console.error("Nicht initialisiertes Ticket konnte nicht entfernt werden:", deleteError.message);
    });
    throw new Error(`Der Ticket-Kanal wurde erstellt, aber die Startnachricht konnte nicht gesendet werden: ${error.message}`);
  }
  return ticket;
}

async function ticketTranscript(channel) {
  const messages = [];
  let before;
  for (let page = 0; page < 10; page++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  messages.sort((left, right) => left.createdTimestamp - right.createdTimestamp);
  const transcriptLines = [
    `Ticket: ${channel.name}`,
    `Channel-ID: ${channel.id}`,
    `Exportiert: ${new Date().toISOString()}`,
    messages.length >= 1000 ? "Hinweis: Der Export ist auf die letzten 1.000 Nachrichten begrenzt." : "",
    "",
    ...messages.map(message => {
      const attachments = [...message.attachments.values()].map(attachment => attachment.url);
      return [
        `[${message.createdAt.toISOString()}] ${message.author.tag} (${message.author.id})`,
        message.content || (attachments.length ? "(Anhang)" : "(keine Textnachricht)"),
        ...attachments.map(url => `Anhang: ${url}`),
        ""
      ].join("\n");
    })
  ];
  let transcript = transcriptLines.join("\n");
  if (transcript.length > 900_000) {
    const omittedCharacters = transcript.length - 900_000;
    const marker = `\n[Transkript gekürzt; ${omittedCharacters} Zeichen ausgelassen]\n`;
    const visibleCharacters = 900_000 - marker.length;
    const beginning = Math.floor(visibleCharacters / 2);
    transcript = `${transcript.slice(0, beginning)}${marker}${transcript.slice(-(visibleCharacters - beginning))}`;
  }
  return Buffer.from(transcript, "utf8");
}

async function closeTicketChannel(channel, actor, guild) {
  const ticket = parseTicketTopic(channel.topic);
  if (!ticket || ticket.status !== "open") throw new Error("Dieser Kanal ist kein offenes Ticket.");
  const config = readTicketConfiguration();
  if (!config) throw new Error("Die Ticketkonfiguration wurde nicht gefunden.");
  const member = await guild.members.fetch(actor.id);
  const canManage = member.permissions.has(PermissionFlagsBits.Administrator)
    || member.roles.cache.has(config.adminRoleId);
  if (ticket.ownerId !== actor.id && !canManage) {
    throw new Error("Nur der Ersteller oder ein Katalog-Admin darf dieses Ticket schließen.");
  }

  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)
    || !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ViewChannel)
    || !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ReadMessageHistory)) {
    throw new Error("Dem Bot fehlen im Ticket „Kanal ansehen“ oder „Nachrichtenverlauf ansehen“ bzw. „Kanäle verwalten“.");
  }
  const auditChannel = await discordGatewayClient.channels.fetch(CATALOG_AUDIT_CHANNEL_ID);
  if (!auditChannel?.isTextBased() || !auditChannel.send
    || !auditChannel.permissionsFor(botMember)?.has(PermissionFlagsBits.ViewChannel)
    || !auditChannel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages)
    || !auditChannel.permissionsFor(botMember)?.has(PermissionFlagsBits.AttachFiles)) {
    throw new Error("Der Audit-Channel ist für den Ticket-Transkriptversand nicht beschreibbar oder der Bot darf keine Dateien anhängen.");
  }
  const archive = config.archiveCategoryId
    ? await guild.channels.fetch(config.archiveCategoryId)
    : null;
  if (config.archiveCategoryId && archive?.type !== ChannelType.GuildCategory) {
    throw new Error("Die konfigurierte Archivkategorie wurde gelöscht.");
  }
  const transcript = await ticketTranscript(channel);
  await auditChannel.send({
    content: `Transkript des geschlossenen Tickets **${channel.name}** · Art: **${ticket.type}** · Ersteller: <@${ticket.ownerId}> (${ticket.ownerId}) · geschlossen von <@${actor.id}>`,
    files: [new AttachmentBuilder(transcript, { name: `transkript-${channel.id}.txt` })],
    allowedMentions: { parse: [] }
  });

  await channel.permissionOverwrites.edit(ticket.ownerId, {
    SendMessages: false,
    AddReactions: false
  });
  await channel.permissionOverwrites.edit(config.adminRoleId, {
    SendMessages: false,
    AddReactions: false
  });
  await channel.setTopic(createTicketTopic({ ...ticket, status: "closed" }), `Ticket durch ${actor.id} geschlossen`);
  if (archive) await channel.setParent(archive.id, { lockPermissions: false });
  if (!channel.name.startsWith("archiviert-")) {
    await channel.setName(`archiviert-${channel.name}`.slice(0, 100));
  }
  return `Ticket archiviert. Das Transkript wurde in <#${CATALOG_AUDIT_CHANNEL_ID}> veröffentlicht.`;
}

async function handleTicketSetupInteraction(interaction) {
  const config = discordConfig();
  if (!interaction.inGuild() || interaction.guildId !== config.guildId
    || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "Nur Server-Admins auf dem konfigurierten Server dürfen das Ticketsystem einrichten.",
      ephemeral: true
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const panel = interaction.options.getChannel("panel", true);
    const category = interaction.options.getChannel("kategorie", true);
    const archive = interaction.options.getChannel("archiv");
    const result = await configureTickets(
      interaction.guild,
      panel,
      category,
      archive,
      interaction.options.getString("ticketarten", true)
    );
    await interaction.editReply({ content: result });
  } catch (error) {
    await interaction.editReply({ content: `Ticket-System konnte nicht eingerichtet werden: ${error.message}` });
  }
}

async function handleTicketSelectInteraction(interaction) {
  if (interaction.guildId !== discordConfig().guildId) {
    await interaction.reply({ content: "Dieses Ticket-Panel gehört nicht zum konfigurierten Server.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const config = readTicketConfiguration();
    if (!config || interaction.channelId !== config.panelChannelId
      || interaction.message?.id !== config.panelMessageId) {
      throw new Error("Dieses Ticket-Panel ist nicht mehr aktuell.");
    }
    const channel = await createTicketChannel(interaction.guild, interaction.user.id, interaction.values[0]);
    await interaction.editReply({ content: `Dein Ticket wurde erstellt: <#${channel.id}>.` });
  } catch (error) {
    await interaction.editReply({ content: error.message, allowedMentions: { parse: [] } });
  }
}

async function handleTicketCloseInteraction(interaction) {
  await interaction.deferUpdate();
  try {
    const content = await closeTicketChannel(interaction.channel, interaction.member, interaction.guild);
    await interaction.editReply({ content, components: [], allowedMentions: { parse: [] } });
  } catch (error) {
    await interaction.followUp({ content: error.message, ephemeral: true, allowedMentions: { parse: [] } });
  }
}

async function handleFamilyApplicationButton(interaction) {
  const match = interaction.customId.match(/^famapply:(approve|reject):([a-f0-9-]{36})$/i);
  if (!match) return false;
  await interaction.deferUpdate();
  try {
    const result = await completeFamilyApplication(
      match[2],
      match[1].toLowerCase(),
      interaction.user.id,
      interaction.guild
    );
    await interaction.editReply({ content: result, components: [], allowedMentions: { parse: [] } });
  } catch (error) {
    await interaction.followUp({ content: error.message, ephemeral: true, allowedMentions: { parse: [] } });
  }
  return true;
}

async function handleHttpTicketSetup(payload, config) {
  const isAdmin = (BigInt(payload.member?.permissions || "0") & PermissionFlagsBits.Administrator) !== 0n;
  if (payload.guild_id !== config.guildId || !isAdmin) {
    throw new Error("Nur Server-Admins auf dem konfigurierten Server dürfen das Ticketsystem einrichten.");
  }
  if (!discordGatewayClient?.isReady()) throw new Error("Der Bot ist noch nicht verbunden.");
  const options = Object.fromEntries((payload.data?.options || []).map(option => [option.name, option.value]));
  const guild = await discordGatewayClient.guilds.fetch(config.guildId);
  const [panel, category, archive] = await Promise.all([
    guild.channels.fetch(options.panel),
    guild.channels.fetch(options.kategorie),
    options.archiv ? guild.channels.fetch(options.archiv) : Promise.resolve(null)
  ]);
  return configureTickets(guild, panel, category, archive, String(options.ticketarten || ""));
}

async function handleHttpFamilyApplication(payload, config) {
  if (payload.guild_id !== config.guildId || !discordGatewayClient?.isReady()) {
    throw new Error("Dieser Befehl kann nur auf dem konfigurierten Discord-Server verwendet werden.");
  }
  const familyName = String(payload.data?.options?.find(option => option.name === "familie")?.value || "").trim();
  const guild = await discordGatewayClient.guilds.fetch(config.guildId);
  return requestFamilyMembership(guild, familyName, payload.member.user);
}

async function handleHttpTicketSelect(payload, config) {
  if (payload.guild_id !== config.guildId || !discordGatewayClient?.isReady()) {
    throw new Error("Dieses Ticket-Panel gehört nicht zum konfigurierten Server.");
  }
  const ticketConfig = readTicketConfiguration();
  if (!ticketConfig
    || payload.channel_id !== ticketConfig.panelChannelId
    || payload.message?.id !== ticketConfig.panelMessageId) {
    throw new Error("Dieses Ticket-Panel ist nicht mehr aktuell.");
  }
  const guild = await discordGatewayClient.guilds.fetch(config.guildId);
  const channel = await createTicketChannel(guild, payload.member.user.id, payload.data?.values?.[0]);
  return `Dein Ticket wurde erstellt: <#${channel.id}>.`;
}
async function renameFamily(guild, oldName, newName, actorId) {
  const oldSlug = familySlug(oldName);
  const newSlug = familySlug(newName);
  if (!oldSlug || !newSlug) throw new Error("Bitte gib gültige alte und neue Familiennamen an.");
  if (newName.length > 100) throw new Error("Der neue Familienname darf höchstens 100 Zeichen lang sein.");

  const { channel, role } = await findFamilyResources(guild, oldName);
  if (!channel || !role) {
    throw new Error("Zum Umbenennen müssen sowohl Familienkanal als auch Familienrolle vorhanden sein.");
  }
  if (oldSlug === newSlug && role.name.toLowerCase() === newName.toLowerCase()) {
    return `Die Familie heißt bereits **${newName}**.`;
  }

  const [channels, roles] = await Promise.all([
    guild.channels.fetch(),
    guild.roles.fetch()
  ]);
  if (channels.some(candidate =>
    candidate?.type === ChannelType.GuildText
    && candidate.parentId === channel.parentId
    && candidate.id !== channel.id
    && candidate.name === newSlug
  )) {
    throw new Error(`Im Familienbereich existiert bereits ein Kanal mit dem Namen „${newSlug}“.`);
  }
  if (roles.some(candidate =>
    candidate.id !== role.id
    && candidate.name.toLowerCase() === newName.toLowerCase()
  )) {
    throw new Error(`Es existiert bereits eine Rolle mit dem Namen „${newName}“.`);
  }

  const botMember = await guild.members.fetchMe();
  const missingPermissions = [
    !botMember.permissions.has(PermissionFlagsBits.ManageChannels) && "Kanäle verwalten",
    !botMember.permissions.has(PermissionFlagsBits.ManageRoles) && "Rollen verwalten"
  ].filter(Boolean);
  if (missingPermissions.length) {
    throw new Error(`Dem Bot fehlen die Serverberechtigungen: ${missingPermissions.join(" und ")}.`);
  }

  await role.setName(newName, `Familie durch Admin ${actorId} umbenannt`);
  try {
    await channel.setName(newSlug, `Familie durch Admin ${actorId} umbenannt`);
  } catch (error) {
    try {
      await role.setName(oldName, `Kanalumbenennung für Familie durch Admin ${actorId} zurückgerollt`);
    } catch (rollbackError) {
      throw new Error(`Die Rolle wurde umbenannt, aber der Kanal nicht; auch das Zurücksetzen der Rolle schlug fehl: ${rollbackError.message}`);
    }
    throw new Error(`Der Kanal konnte nicht umbenannt werden; die Rolle wurde zurückgesetzt: ${error.message}`);
  }
  await logFamilyAudit("Familie umbenannt", newName, actorId, `Vorher: ${oldName} · Kanal: <#${channel.id}> · Rolle: <@&${role.id}>`);
  return `Familie **${oldName}** wurde in **${newName}** umbenannt.`;
}

async function getFamilyInfo(guild, familyName) {
  if (!familySlug(familyName)) throw new Error("Bitte gib einen gültigen Familiennamen ein.");
  const entries = await familyEntries(guild, true);
  const channelName = familySlug(familyName);
  const matchingEntries = entries.filter(entry =>
    entry.channel.name === channelName
    || entry.role?.name.toLowerCase() === familyName.toLowerCase()
  );
  if (matchingEntries.length > 1) {
    throw new Error("Es wurden mehrere passende Familien gefunden. Bitte bereinige die doppelten Ressourcen zuerst.");
  }
  const entry = matchingEntries[0];
  if (!entry) throw new Error(`Die Familie „${familyName}“ wurde nicht gefunden.`);

  const name = familyNameFromEntry(entry);
  const members = entry.role
    ? [...entry.role.members.values()]
      .map(member => member.displayName.replace(/[`*_~|]/g, ""))
      .sort((left, right) => left.localeCompare(right, "de"))
    : [];
  const memberList = entry.role
    ? (members.length ? members.slice(0, 20).join(", ") : "Keine Mitglieder")
    : "Die Familienrolle wurde nicht gefunden.";
  const omittedMembers = members.length > 20 ? `\nWeitere Mitglieder: ${members.length - 20}` : "";
  return `**Familie ${name}**\nKanal: <#${entry.channel.id}>\nRolle: ${entry.role ? `<@&${entry.role.id}>` : "Nicht gefunden"}\nMitglieder: ${entry.role?.members.size ?? 0}\nMitgliederliste: ${memberList}${omittedMembers}`;
}

async function prepareFamilyMemberChange(guild, familyName, userId, add, adminId, adminName) {
  if (!familySlug(familyName)) throw new Error("Bitte gib einen gültigen Familiennamen ein.");
  if (!/^\d{17,20}$/.test(userId)) throw new Error("Bitte gib ein gültiges Discord-Mitglied an.");

  const entries = await familyEntries(guild);
  const channelName = familySlug(familyName);
  const matchingEntries = entries.filter(entry =>
    entry.channel.name === channelName
    || entry.role?.name.toLowerCase() === familyName.toLowerCase()
  );
  if (matchingEntries.length > 1) {
    throw new Error("Es wurden mehrere passende Familien gefunden. Bitte bereinige die doppelten Ressourcen zuerst.");
  }
  const entry = matchingEntries[0];
  if (!entry) throw new Error(`Die Familie „${familyName}“ wurde nicht gefunden.`);
  if (!entry.role) throw new Error(`Für Familie „${familyName}“ wurde keine passende Rolle gefunden.`);

  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("Dem Bot fehlt die Serverberechtigung „Rollen verwalten“.");
  }
  const member = await guild.members.fetch(userId);
  const hasRole = member.roles.cache.has(entry.role.id);
  if (add && hasRole) throw new Error(`${member.user.tag} hat die Familienrolle bereits.`);
  if (!add && !hasRole) throw new Error(`${member.user.tag} hat die Familienrolle nicht.`);

  for (const [token, pending] of pendingFamilyMemberChanges) {
    if (pending.expiresAt <= Date.now()) pendingFamilyMemberChanges.delete(token);
  }
  const token = crypto.randomUUID();
  const confirmation = {
    token,
    guildId: guild.id,
    adminId,
    adminName,
    familyName,
    roleId: entry.role.id,
    memberId: member.id,
    memberName: member.user.tag,
    add,
    expiresAt: Date.now() + 5 * 60 * 1000,
    processing: false
  };
  pendingFamilyMemberChanges.set(token, confirmation);
  return confirmation;
}

function familyMemberChangePrompt(confirmation) {
  const action = confirmation.add ? "hinzufügen" : "entfernen";
  return `**Familienrolle ändern?**\nSoll **${confirmation.memberName}** zur Familie **${confirmation.familyName}** ${action} werden?`;
}

function familyMemberChangeButtons(token) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`famchange:confirm:${token}`)
      .setLabel("Bestätigen")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`famchange:cancel:${token}`)
      .setLabel("Abbrechen")
      .setStyle(ButtonStyle.Secondary)
  )];
}

async function completeFamilyMemberChange(token, action, guildId, adminId, guild) {
  const confirmation = pendingFamilyMemberChanges.get(token);
  if (!confirmation || confirmation.expiresAt <= Date.now()) {
    pendingFamilyMemberChanges.delete(token);
    throw new Error("Diese Bestätigung ist abgelaufen. Bitte starte den Familienbefehl erneut.");
  }
  if (confirmation.guildId !== guildId || confirmation.adminId !== adminId) {
    throw new Error("Diese Bestätigung gehört einer anderen Person oder einem anderen Server.");
  }
  if (confirmation.processing) throw new Error("Diese Änderung wird bereits verarbeitet.");
  confirmation.processing = true;
  try {
    if (action === "cancel") return "Familienänderung abgebrochen. Es wurde nichts geändert.";
    const entries = await familyEntries(guild);
    const family = entries.find(entry =>
      entry.channel.name === familySlug(confirmation.familyName)
      || entry.role?.name.toLowerCase() === confirmation.familyName.toLowerCase()
    );
    if (!family?.role || family.role.id !== confirmation.roleId) {
      throw new Error("Die Familienrolle hat sich seit der Bestätigung geändert. Bitte starte den Befehl erneut.");
    }
    const botMember = await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error("Dem Bot fehlt die Serverberechtigung „Rollen verwalten“.");
    }
    const member = await guild.members.fetch(confirmation.memberId);
    const hasRole = member.roles.cache.has(confirmation.roleId);
    if (confirmation.add && hasRole) throw new Error(`${member.user.tag} hat die Familienrolle inzwischen erhalten.`);
    if (!confirmation.add && !hasRole) throw new Error(`${member.user.tag} hat die Familienrolle inzwischen nicht mehr.`);

    if (confirmation.add) {
      await member.roles.add(family.role, `Mitglied durch /famadd zur Familie ${confirmation.familyName} hinzugefügt`);
    } else {
      await member.roles.remove(family.role, `Mitglied durch /famremove aus der Familie ${confirmation.familyName} entfernt`);
    }
    const actionLabel = confirmation.add ? "Mitglied hinzugefügt" : "Mitglied entfernt";
    await logFamilyAudit(actionLabel, confirmation.familyName, adminId, `Mitglied: ${member.user.tag} (${member.id})`);
    return confirmation.add
      ? `${member.user.tag} wurde zur Familie **${confirmation.familyName}** hinzugefügt.`
      : `${member.user.tag} wurde aus der Familie **${confirmation.familyName}** entfernt.`;
  } finally {
    pendingFamilyMemberChanges.delete(token);
  }
}

async function createFamily(guild, userId, familyName) {
  const channelName = familySlug(familyName);
  const botMember = await guild.members.fetchMe();
  const requiredPermissions = [
    [PermissionFlagsBits.ManageChannels, "Kanäle verwalten"],
    [PermissionFlagsBits.ManageRoles, "Rollen verwalten"]
  ];
  const missingPermissions = requiredPermissions
    .filter(([permission]) => !botMember.permissions.has(permission))
    .map(([, label]) => label);
  if (missingPermissions.length) {
    throw new Error(`Dem Bot fehlen die Serverberechtigungen: ${missingPermissions.join(" und ")}.`);
  }

  const [channels, roles] = await Promise.all([
    guild.channels.fetch(),
    guild.roles.fetch()
  ]);
  const categories = channels.filter(channel =>
    channel?.type === ChannelType.GuildCategory
    && channel.name.toLowerCase() === FAMILY_CATEGORY_NAME.toLowerCase()
  );
  if (categories.size > 1) {
    throw new Error(`Es gibt mehrere Kategorien namens „${FAMILY_CATEGORY_NAME}“. Bitte bereinige die doppelten Kategorien zuerst.`);
  }

  const category = categories.first() || null;
  const existingRole = roles.find(role => role.name.toLowerCase() === familyName.toLowerCase());
  const existingChannel = category
    ? channels.find(channel =>
      channel?.type === ChannelType.GuildText
      && channel.parentId === category.id
      && channel.name === channelName
    )
    : null;
  if (existingRole || existingChannel) {
    const conflicts = [
      existingRole && "eine gleichnamige Rolle",
      existingChannel && "einen gleichnamigen Kanal"
    ].filter(Boolean);
    throw new Error(`Die Familie wurde nicht erstellt: Es gibt bereits ${conflicts.join(" und ")}.`);
  }

  let createdRole;
  let createdChannel;
  try {
    const familyCategory = category || await guild.channels.create({
      name: FAMILY_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      reason: "Kategorie für Familienkanäle"
    });
    createdRole = await guild.roles.create({
      name: familyName,
      mentionable: false,
      hoist: false,
      reason: `Familienrolle für ${familyName}`
    });
    createdChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: familyCategory.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: createdRole.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory
          ]
        },
        {
          id: botMember.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels
          ]
        }
      ],
      reason: `Privater Familienkanal für ${familyName}`
    });
    const member = await guild.members.fetch(userId);
    await member.roles.add(createdRole, `Familienrolle für ${familyName} zugewiesen`);
  } catch (error) {
    if (createdChannel) {
      try {
        await createdChannel.delete("Unvollständige Einrichtung des Familienkanals aufräumen");
      } catch (cleanupError) {
        console.error(`Unvollständiger Familienkanal ${createdChannel.id} konnte nicht entfernt werden:`, cleanupError.message);
      }
    }
    if (createdRole) {
      try {
        await createdRole.delete("Unvollständige Einrichtung der Familienrolle aufräumen");
      } catch (cleanupError) {
        console.error(`Unvollständige Familienrolle ${createdRole.id} konnte nicht entfernt werden:`, cleanupError.message);
      }
    }
    throw error;
  }

  await logFamilyAudit("Familie erstellt", familyName, userId, `Kanal: <#${createdChannel.id}> · Rolle: <@&${createdRole.id}>`);
  return { channelId: createdChannel.id, roleId: createdRole.id };
}

function familyDeletedMessage(familyName, result) {
  const deleted = [];
  if (result.channelDeleted) deleted.push("der Familienkanal");
  if (result.roleDeleted) deleted.push("die Familienrolle");
  return `Familie **${familyName}** wurde gelöscht (${deleted.join(" und ")}).`;
}

async function findFamilyResources(guild, familyName) {
  const channelName = familySlug(familyName);
  const [channels, roles] = await Promise.all([
    guild.channels.fetch(),
    guild.roles.fetch()
  ]);
  const categories = channels.filter(channel =>
    channel?.type === ChannelType.GuildCategory
    && channel.name.toLowerCase() === FAMILY_CATEGORY_NAME.toLowerCase()
  );
  if (categories.size > 1) {
    throw new Error(`Es gibt mehrere Kategorien namens „${FAMILY_CATEGORY_NAME}“. Bitte bereinige die doppelten Kategorien zuerst.`);
  }
  const category = categories.first();
  if (!category) {
    throw new Error(`Die Kategorie „${FAMILY_CATEGORY_NAME}“ wurde nicht gefunden. Es wurde nichts gelöscht.`);
  }

  const matchingRoles = roles.filter(role => role.name.toLowerCase() === familyName.toLowerCase());
  const matchingChannels = channels.filter(channel =>
    channel?.type === ChannelType.GuildText
    && channel.parentId === category.id
    && channel.name === channelName
  );
  if (matchingRoles.size > 1 || matchingChannels.size > 1) {
    throw new Error("Es wurden mehrere passende Familienrollen oder -kanäle gefunden. Bitte bereinige die Duplikate zuerst.");
  }
  const role = matchingRoles.first();
  const channel = matchingChannels.first();
  if (!role && !channel) {
    throw new Error(`Die Familie „${familyName}“ wurde nicht gefunden. Es wurde nichts gelöscht.`);
  }

  const botMember = await guild.members.fetchMe();
  const requiredPermissions = [
    channel && [PermissionFlagsBits.ManageChannels, "Kanäle verwalten"],
    role && [PermissionFlagsBits.ManageRoles, "Rollen verwalten"]
  ].filter(Boolean);
  const missingPermissions = requiredPermissions
    .filter(([permission]) => !botMember.permissions.has(permission))
    .map(([, label]) => label);
  if (missingPermissions.length) {
    throw new Error(`Dem Bot fehlen die Serverberechtigungen: ${missingPermissions.join(" und ")}.`);
  }

  return { channel, role };
}

function familyDeletionPrompt(familyName, confirmation) {
  const resources = [
    confirmation.channelId ? `Kanal <#${confirmation.channelId}>` : "kein Familienkanal gefunden",
    confirmation.roleId ? `Rolle <@&${confirmation.roleId}>` : "keine Familienrolle gefunden"
  ];
  return `**Familie ${familyName} wirklich löschen?**\nDabei werden ${resources.join(" und ")} gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.`;
}

function familyDeletionButtons(token) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`delfam:confirm:${token}`)
      .setLabel("Familie löschen")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`delfam:cancel:${token}`)
      .setLabel("Abbrechen")
      .setStyle(ButtonStyle.Secondary)
  )];
}

async function prepareFamilyDeletion(guild, familyName, userId) {
  const { channel, role } = await findFamilyResources(guild, familyName);
  for (const [token, pending] of pendingFamilyDeletions) {
    if (pending.expiresAt <= Date.now()) pendingFamilyDeletions.delete(token);
  }
  const token = crypto.randomUUID();
  const confirmation = {
    token,
    guildId: guild.id,
    userId,
    familyName,
    channelId: channel?.id || null,
    roleId: role?.id || null,
    expiresAt: Date.now() + 5 * 60 * 1000,
    processing: false
  };
  pendingFamilyDeletions.set(token, confirmation);
  return confirmation;
}

function claimFamilyDeletion(token, guildId, userId) {
  const confirmation = pendingFamilyDeletions.get(token);
  if (!confirmation || confirmation.expiresAt <= Date.now()) {
    pendingFamilyDeletions.delete(token);
    throw new Error("Diese Bestätigung ist abgelaufen. Bitte starte `/delfam` erneut.");
  }
  if (confirmation.guildId !== guildId || confirmation.userId !== userId) {
    throw new Error("Diese Bestätigung gehört einer anderen Person oder einem anderen Server.");
  }
  if (confirmation.processing) {
    throw new Error("Diese Familienlöschung wird bereits verarbeitet.");
  }
  confirmation.processing = true;
  return confirmation;
}

async function deleteFamily(guild, confirmation) {
  const { channel, role } = await findFamilyResources(guild, confirmation.familyName);
  if ((channel?.id || null) !== confirmation.channelId || (role?.id || null) !== confirmation.roleId) {
    throw new Error("Die Familienressourcen haben sich seit der Bestätigung geändert. Bitte starte `/delfam` erneut.");
  }

  let channelDeleted = false;
  if (channel) {
    await channel.delete(`Familie ${confirmation.familyName} durch /delfam gelöscht`);
    channelDeleted = true;
  }
  let roleDeleted = false;
  if (role) {
    try {
      await role.delete(`Familie ${confirmation.familyName} durch /delfam gelöscht`);
      roleDeleted = true;
    } catch (error) {
      if (channelDeleted) {
        throw new Error(`Der Familienkanal wurde gelöscht, aber die Rolle konnte nicht gelöscht werden: ${error.message}`);
      }
      throw error;
    }
  }
  return { channelDeleted, roleDeleted };
}

async function completeFamilyDeletion(token, action, guildId, userId, guild) {
  const confirmation = claimFamilyDeletion(token, guildId, userId);
  try {
    if (action === "cancel") return "Familienlöschung abgebrochen. Es wurde nichts gelöscht.";
    const result = await deleteFamily(guild, confirmation);
    await logFamilyAudit("Familie gelöscht", confirmation.familyName, userId, `Kanal-ID: ${confirmation.channelId || "nicht vorhanden"} · Rollen-ID: ${confirmation.roleId || "nicht vorhanden"}`);
    return familyDeletedMessage(confirmation.familyName, result);
  } finally {
    pendingFamilyDeletions.delete(token);
  }
}

async function handleDeleteFamilyButtonInteraction(interaction) {
  const config = discordConfig();
  const match = interaction.customId.match(/^delfam:(confirm|cancel):([a-f0-9-]{36})$/i);
  if (!match) return;
  if (!interaction.inGuild() || interaction.guildId !== config.guildId
    || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "Nur Server-Admins auf dem konfigurierten Discord-Server dürfen Familien löschen.",
      ephemeral: true
    });
    return;
  }

  await interaction.deferUpdate();
  try {
    const content = await completeFamilyDeletion(
      match[2],
      match[1].toLowerCase(),
      interaction.guildId,
      interaction.user.id,
      interaction.guild
    );
    await interaction.editReply({ content, components: [], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error("Bestätigte Familienlöschung fehlgeschlagen:", error.message);
    await interaction.editReply({
      content: `Die Familie konnte nicht vollständig gelöscht werden: ${error.message}`,
      components: [],
      allowedMentions: { parse: [] }
    });
  }
}

async function handleFamilyManagementButtonInteraction(interaction) {
  const memberChange = interaction.customId.match(/^famchange:(confirm|cancel):([a-f0-9-]{36})$/i);
  const listPage = interaction.customId.match(/^famlist:(prev|next):([a-f0-9-]{36})$/i);
  if (!memberChange && !listPage) return false;

  const config = discordConfig();
  if (!interaction.inGuild() || interaction.guildId !== config.guildId
    || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "Nur Server-Admins auf dem konfigurierten Discord-Server dürfen diese Familienaktion ausführen.",
      ephemeral: true
    });
    return true;
  }

  await interaction.deferUpdate();
  try {
    if (memberChange) {
      const content = await completeFamilyMemberChange(
        memberChange[2],
        memberChange[1].toLowerCase(),
        interaction.guildId,
        interaction.user.id,
        interaction.guild
      );
      await interaction.editReply({ content, components: [], allowedMentions: { parse: [] } });
    } else {
      const page = moveFamilyListPage(
        listPage[2],
        listPage[1].toLowerCase() === "next" ? 1 : -1,
        interaction.guildId,
        interaction.user.id
      );
      await interaction.editReply({ ...page, allowedMentions: { parse: [] } });
    }
  } catch (error) {
    console.error("Familienaktion über Button fehlgeschlagen:", error.message);
    await interaction.editReply({
      content: error.message,
      components: [],
      allowedMentions: { parse: [] }
    });
  }
  return true;
}

async function handleHttpNewFamily(payload, config) {
  const isAdmin = (BigInt(payload.member?.permissions || "0") & PermissionFlagsBits.Administrator) !== 0n;
  const familyName = String(payload.data?.options?.find(option => option.name === "name")?.value || "").trim();
  if (payload.guild_id !== config.guildId || !isAdmin) {
    return "Nur Server-Admins dürfen Familienkanäle erstellen.";
  }
  if (!familySlug(familyName)) return "Bitte gib einen gültigen Familiennamen ein.";
  if (!discordGatewayClient?.isReady()) return "Der Bot ist noch nicht verbunden. Bitte in Kürze erneut versuchen.";
  const guild = await discordGatewayClient.guilds.fetch(config.guildId);
  const result = await createFamily(guild, payload.member.user.id, familyName);
  return familyCreatedMessage(familyName, result);
}

async function handleHttpDeleteFamily(payload, config) {
  const isAdmin = (BigInt(payload.member?.permissions || "0") & PermissionFlagsBits.Administrator) !== 0n;
  const familyName = String(payload.data?.options?.find(option => option.name === "name")?.value || "").trim();
  if (payload.guild_id !== config.guildId || !isAdmin) {
    return "Nur Server-Admins dürfen Familien löschen.";
  }
  if (!familySlug(familyName)) return "Bitte gib einen gültigen Familiennamen ein.";
  if (!discordGatewayClient?.isReady()) return "Der Bot ist noch nicht verbunden. Bitte in Kürze erneut versuchen.";
  const guild = await discordGatewayClient.guilds.fetch(config.guildId);
  const confirmation = await prepareFamilyDeletion(guild, familyName, payload.member.user.id);
  return {
    content: familyDeletionPrompt(familyName, confirmation),
    components: familyDeletionButtons(confirmation.token).map(row => row.toJSON()),
    allowed_mentions: { parse: [] }
  };
}

async function handleHttpFamilyManagement(payload, config) {
  const isAdmin = (BigInt(payload.member?.permissions || "0") & PermissionFlagsBits.Administrator) !== 0n;
  if (payload.guild_id !== config.guildId || !isAdmin) {
    return "Nur Server-Admins auf dem konfigurierten Discord-Server dürfen Familien verwalten.";
  }
  if (!discordGatewayClient?.isReady()) return "Der Bot ist noch nicht verbunden. Bitte in Kürze erneut versuchen.";
  const guild = await discordGatewayClient.guilds.fetch(config.guildId);
  const commandName = payload.data?.name;
  const options = Object.fromEntries((payload.data?.options || []).map(option => [option.name, option.value]));
  const userId = payload.member.user.id;
  if (commandName === "listfam") return prepareFamilyList(guild, userId);
  if (commandName === "famcheck") return checkFamilies(guild);
  if (commandName === "famuebersicht") return getFamilyOverview(guild);
  if (commandName === "famrolle") return getFamilyRolesPage(guild, Number(options.seite || 1));
  if (commandName === "famfarbe") {
    return setFamilyColor(guild, String(options.familie || "").trim(), String(options.farbe || ""), userId);
  }
  if (commandName === "famtopic") {
    return setFamilyTopic(guild, String(options.familie || "").trim(), String(options.thema || ""), userId);
  }
  if (commandName === "famaktivitaet") {
    return getFamilyActivity(guild, String(options.familie || "").trim());
  }
  if (commandName === "famaudit") {
    return getFamilyAudit(String(options.suche || ""), Number(options.anzahl || 10));
  }
  if (commandName === "famexport") {
    const exported = await exportFamilies(guild, String(options.format || "json"));
    return {
      content: "Familienressourcen wurden exportiert.",
      files: [{ filename: exported.filename, contentType: exported.contentType, buffer: exported.buffer }]
    };
  }
  if (commandName === "faminfo") return getFamilyInfo(guild, String(options.name || "").trim());
  if (commandName === "famrename") {
    return renameFamily(guild, String(options.alt || "").trim(), String(options.neu || "").trim(), userId);
  }
  if (commandName === "famadd" || commandName === "famremove") {
    const confirmation = await prepareFamilyMemberChange(
      guild,
      String(options.familie || "").trim(),
      String(options.mitglied || ""),
      commandName === "famadd",
      userId,
      actorNameFromMember(payload.member)
    );
    return {
      content: familyMemberChangePrompt(confirmation),
      components: familyMemberChangeButtons(confirmation.token).map(row => row.toJSON()),
      allowed_mentions: { parse: [] }
    };
  }
  throw new Error("Unbekannter Familienbefehl.");
}

function addManualAccountingEntry(guildId, roleIds, kind, amount, description, bookedBy, sourceId) {
  const config = discordConfig();
  if (!memberCanManageOrders(guildId, roleIds, config)) {
    throw new Error("Nur Mitglieder mit der Katalog-Admin-Rolle dürfen Buchungen erfassen.");
  }
  if (kind !== "income" && kind !== "expense") {
    throw new Error("Buchungsart muss Einnahme oder Ausgabe sein.");
  }
  const entry = accountingLedger.add({
    kind,
    category: "manual",
    amount,
    description,
    source: "manual",
    bookedBy,
    sourceId
  });
  const summary = summarize(accountingLedger.read());
  const label = kind === "income" ? "Einnahme" : "Ausgabe";
  return {
    entry,
    content: `${label} über ${amount.toLocaleString("de-DE")} $ gebucht. Aktueller Saldo: ${summary.net.toLocaleString("de-DE")} $.\nBuchungs-ID: \`${entry.id}\``
  };
}

function accountingCashMessage(period) {
  if (!["heute", "woche", "monat", "gesamt"].includes(period)) {
    throw new Error("Bitte einen gültigen Zeitraum auswählen.");
  }
  const range = periodRange(period, accountingDateKey());
  const entries = accountingLedger.read();
  const summary = summarize(entries, range);
  const lines = [
    `**Kasse · ${range.label}**`,
    `Einnahmen: **${summary.income.toLocaleString("de-DE")} $**`,
    `Ausgaben: **${summary.expense.toLocaleString("de-DE")} $**`,
    `Saldo: **${summary.net.toLocaleString("de-DE")} $**`,
    `${summary.count} aktive Buchung(en)`
  ];
  if (range.from) lines.push(`Zeitraum: ${accountingDateLabel(range.from)}${range.to !== range.from ? `–${accountingDateLabel(range.to)}` : ""}`);
  return lines.join("\n");
}

function formatHealthReport(report) {
  const stateLabel = {
    ok: "bereit",
    degraded: "eingeschränkt",
    unavailable: "nicht verfügbar"
  };
  const checkLabel = {
    discord: "Discord-Bot",
    storage: "Datenspeicher",
    orders: "Bestellversand"
  };
  const lines = [
    `**Serverstatus: ${report.status === "ok" ? "Alles in Ordnung" : "Eingeschränkt"}**`,
    ...Object.entries(report.checks).map(([name, status]) =>
      `${checkLabel[name] || name}: ${stateLabel[status] || status}`
    ),
    `Geprüft: ${new Date(report.checkedAt).toLocaleString("de-DE")}`
  ];
  return lines.join("\n");
}

function healthCommandMessage(commandName) {
  if (commandName === "livez") return "Der Webserver ist erreichbar. Liveness-Prüfung: bereit.";
  return formatHealthReport(getHealthReport());
}

async function handleHealthCommandInteraction(interaction) {
  const config = discordConfig();
  const roleIds = interaction.member?.roles?.cache
    ? [...interaction.member.roles.cache.keys()]
    : [];
  if (!memberCanManageOrders(interaction.guildId, roleIds, config)) {
    await interaction.reply({
      content: "Nur Mitglieder mit der Katalog-Admin-Rolle dürfen den Serverstatus prüfen.",
      ephemeral: true
    });
    return;
  }
  if (interaction.commandName === "livez") {
    await interaction.reply({ content: healthCommandMessage("livez"), ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply({ content: healthCommandMessage("healthz") });
}

function correctManualAccountingEntry(guildId, roleIds, id, reason, replacement, bookedBy) {
  const config = discordConfig();
  if (!memberCanManageOrders(guildId, roleIds, config)) {
    throw new Error("Nur Mitglieder mit der Katalog-Admin-Rolle dürfen Buchungen korrigieren oder stornieren.");
  }
  let result;
  try {
    result = accountingLedger.correctEntry(id, { by: bookedBy, reason, replacement });
  } catch (error) {
    if (error.code && !["NOT_FOUND", "ALREADY_VOIDED"].includes(error.code)) {
      console.error("Buchungskorrektur konnte nicht gespeichert werden:", error.message);
      throw new Error("Die Änderung konnte nicht dauerhaft gespeichert werden. Bitte Admin informieren.");
    }
    throw error;
  }
  return result.corrected
    ? `Buchung korrigiert und nachvollziehbar protokolliert. Neue Buchungs-ID: \`${result.corrected.id}\``
    : `Buchung \`${id}\` wurde mit Grund „${reason.trim()}“ storniert.`;
}

function accountingOptions(payload) {
  return Object.fromEntries((payload.data?.options || []).map(option => [option.name, option.value]));
}

async function handleManualBookingInteraction(interaction) {
  const config = discordConfig();
  const roleIds = interaction.member?.roles?.cache
    ? [...interaction.member.roles.cache.keys()]
    : [];
  if (!memberCanManageOrders(interaction.guildId, roleIds, config)) {
    await interaction.reply({
      content: "Nur Mitglieder mit der Katalog-Admin-Rolle dürfen Buchungen erfassen.",
      ephemeral: true
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const result = addManualAccountingEntry(
    interaction.guildId,
    roleIds,
    interaction.options.getString("art", true),
    interaction.options.getInteger("betrag", true),
    interaction.options.getString("beschreibung", true),
    actorNameFromMember(interaction.member),
    interaction.id
  );
  await interaction.editReply({ content: result.content });
}

async function handleCashInteraction(interaction) {
  const config = discordConfig();
  const roleIds = interaction.member?.roles?.cache
    ? [...interaction.member.roles.cache.keys()]
    : [];
  if (!memberCanManageOrders(interaction.guildId, roleIds, config)) {
    await interaction.reply({
      content: "Nur Mitglieder mit der Katalog-Admin-Rolle dürfen die Kasse einsehen.",
      ephemeral: true
    });
    return;
  }
  const period = interaction.options.getString("zeitraum", true);
  await interaction.reply({ content: accountingCashMessage(period), ephemeral: true });
}

async function handleVoidInteraction(interaction) {
  const roleIds = interaction.member?.roles?.cache
    ? [...interaction.member.roles.cache.keys()]
    : [];
  const id = interaction.options.getString("buchung_id", true).trim();
  const reason = interaction.options.getString("grund", true);
  const amount = interaction.options.getInteger("neuer_betrag");
  const description = interaction.options.getString("neue_beschreibung");
  const kind = interaction.options.getString("neue_art");
  const hasReplacement = amount !== null || description !== null || kind !== null;
  const replacement = hasReplacement ? { amount, description, kind: kind || undefined } : null;
  if (hasReplacement && (!Number.isSafeInteger(amount) || typeof description !== "string" || !description.trim())) {
    await interaction.reply({
      content: "Für eine Korrektur müssen neuer Betrag und neue Beschreibung zusammen angegeben werden.",
      ephemeral: true
    });
    return;
  }
  const content = correctManualAccountingEntry(
    interaction.guildId,
    roleIds,
    id,
    reason,
    replacement,
    actorNameFromMember(interaction.member)
  );
  await interaction.reply({ content, ephemeral: true });
}

async function handleHttpManualBooking(payload) {
  const roleIds = Array.isArray(payload.member?.roles) ? payload.member.roles : [];
  const options = accountingOptions(payload);
  const result = addManualAccountingEntry(
    payload.guild_id,
    roleIds,
    options.art,
    options.betrag,
    options.beschreibung,
    actorNameFromMember(payload.member),
    payload.id
  );
  return result.content;
}

async function handleHttpCash(payload, config) {
  const roleIds = Array.isArray(payload.member?.roles) ? payload.member.roles : [];
  if (!memberCanManageOrders(payload.guild_id, roleIds, config)) {
    throw new Error("Nur Mitglieder mit der Katalog-Admin-Rolle dürfen die Kasse einsehen.");
  }
  const options = accountingOptions(payload);
  return accountingCashMessage(options.zeitraum);
}

async function handleHttpHealthCommand(payload, commandName, config) {
  const roleIds = Array.isArray(payload.member?.roles) ? payload.member.roles : [];
  if (!memberCanManageOrders(payload.guild_id, roleIds, config)) {
    return "Nur Mitglieder mit der Katalog-Admin-Rolle dürfen den Serverstatus prüfen.";
  }
  return healthCommandMessage(commandName);
}

async function handleHttpVoid(payload) {
  const roleIds = Array.isArray(payload.member?.roles) ? payload.member.roles : [];
  const options = accountingOptions(payload);
  const hasReplacement = options.neuer_betrag !== undefined
    || options.neue_beschreibung !== undefined
    || options.neue_art !== undefined;
  if (hasReplacement && (!Number.isSafeInteger(options.neuer_betrag)
    || typeof options.neue_beschreibung !== "string" || !options.neue_beschreibung.trim())) {
    throw new Error("Für eine Korrektur müssen neuer Betrag und neue Beschreibung zusammen angegeben werden.");
  }
  return correctManualAccountingEntry(
    payload.guild_id,
    roleIds,
    String(options.buchung_id || "").trim(),
    options.grund,
    hasReplacement
      ? { amount: options.neuer_betrag, description: options.neue_beschreibung, kind: options.neue_art }
      : null,
    actorNameFromMember(payload.member)
  );
}

async function registerNewFamilyCommand(client, guildId) {
  const familyCommand = new SlashCommandBuilder()
    .setName("newfam")
    .setDescription("Erstellt einen privaten Familienkanal mit passender Rolle.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option =>
      option
        .setName("name")
        .setDescription("Name der Familie")
        .setRequired(true)
        .setMaxLength(100)
    )
    .toJSON();
  const deleteFamilyCommand = new SlashCommandBuilder()
    .setName("delfam")
    .setDescription("Löscht den Familienkanal und die passende Familienrolle.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option =>
      option
        .setName("name")
        .setDescription("Name der zu löschenden Familie")
        .setRequired(true)
        .setMaxLength(100)
    )
    .toJSON();
  const listFamiliesCommand = new SlashCommandBuilder()
    .setName("listfam")
    .setDescription("Zeigt alle eingerichteten Familien mit Kanal, Rolle und Mitgliederzahl.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .toJSON();
  const checkFamiliesCommand = new SlashCommandBuilder()
    .setName("famcheck")
    .setDescription("Sucht mögliche verwaiste Familienkanäle und -rollen.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .toJSON();
  const familyInfoCommand = new SlashCommandBuilder()
    .setName("faminfo")
    .setDescription("Zeigt Kanal, Rolle und Mitglieder einer Familie.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("name")
      .setDescription("Name der Familie")
      .setRequired(true)
      .setMaxLength(100))
    .toJSON();
  const familyAddMemberCommand = new SlashCommandBuilder()
    .setName("famadd")
    .setDescription("Fügt ein Mitglied einer Familie hinzu.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("familie")
      .setDescription("Name der Familie")
      .setRequired(true)
      .setMaxLength(100))
    .addUserOption(option => option
      .setName("mitglied")
      .setDescription("Hinzuzufügendes Mitglied")
      .setRequired(true))
    .toJSON();
  const familyRemoveMemberCommand = new SlashCommandBuilder()
    .setName("famremove")
    .setDescription("Entfernt ein Mitglied aus einer Familie.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("familie")
      .setDescription("Name der Familie")
      .setRequired(true)
      .setMaxLength(100))
    .addUserOption(option => option
      .setName("mitglied")
      .setDescription("Zu entfernendes Mitglied")
      .setRequired(true))
    .toJSON();
  const familyRenameCommand = new SlashCommandBuilder()
    .setName("famrename")
    .setDescription("Benennt eine Familie samt Kanal und Rolle um.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("alt")
      .setDescription("Bisheriger Familienname")
      .setRequired(true)
      .setMaxLength(100))
    .addStringOption(option => option
      .setName("neu")
      .setDescription("Neuer Familienname")
      .setRequired(true)
      .setMaxLength(100))
    .toJSON();
  const familyRolesCommand = new SlashCommandBuilder()
    .setName("famrolle")
    .setDescription("Zeigt Familienrollen und deren Mitglieder an.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addIntegerOption(option => option
      .setName("seite")
      .setDescription("Seitennummer (5 Familien pro Seite)")
      .setMinValue(1))
    .toJSON();
  const familyOverviewCommand = new SlashCommandBuilder()
    .setName("famuebersicht")
    .setDescription("Zeigt Statistiken zu Familien, Mitgliedern und leeren Familien.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .toJSON();
  const familyApplicationCommand = new SlashCommandBuilder()
    .setName("fambeitritt")
    .setDescription("Beantragt die Aufnahme in eine Familie.")
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("familie")
      .setDescription("Name der gewünschten Familie")
      .setRequired(true)
      .setMaxLength(100))
    .toJSON();
  const familyColorCommand = new SlashCommandBuilder()
    .setName("famfarbe")
    .setDescription("Ändert die Farbe der Familienrolle.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("familie")
      .setDescription("Name der Familie")
      .setRequired(true)
      .setMaxLength(100))
    .addStringOption(option => option
      .setName("farbe")
      .setDescription("HEX-Farbwert, z. B. #3366ff")
      .setRequired(true)
      .setMinLength(6)
      .setMaxLength(7))
    .toJSON();
  const familyTopicCommand = new SlashCommandBuilder()
    .setName("famtopic")
    .setDescription("Setzt oder leert das Thema eines Familienkanals.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("familie")
      .setDescription("Name der Familie")
      .setRequired(true)
      .setMaxLength(100))
    .addStringOption(option => option
      .setName("thema")
      .setDescription("Neues Kanalthema (leer zum Entfernen)")
      .setMaxLength(1024))
    .toJSON();
  const familyActivityCommand = new SlashCommandBuilder()
    .setName("famaktivitaet")
    .setDescription("Zeigt den Zeitpunkt der letzten Nachricht ohne deren Inhalt.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("familie")
      .setDescription("Name der Familie")
      .setRequired(true)
      .setMaxLength(100))
    .toJSON();
  const familyExportCommand = new SlashCommandBuilder()
    .setName("famexport")
    .setDescription("Exportiert Familienkanäle, Rollen und Mitglieder.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("format")
      .setDescription("Dateiformat für den Export")
      .setRequired(true)
      .addChoices(
        { name: "JSON", value: "json" },
        { name: "CSV", value: "csv" }
      ))
    .toJSON();
  const familyAuditCommand = new SlashCommandBuilder()
    .setName("famaudit")
    .setDescription("Durchsucht das Familien-Audit nach Aktion, Familie oder Admin-ID.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("suche")
      .setDescription("Optionaler Suchbegriff")
      .setMaxLength(100))
    .addIntegerOption(option => option
      .setName("anzahl")
      .setDescription("Maximale Trefferzahl")
      .setMinValue(1)
      .setMaxValue(20))
    .toJSON();
  const ticketSetupCommand = new SlashCommandBuilder()
    .setName("ticketeinrichten")
    .setDescription("Richtet ein privates Ticketsystem mit konfigurierbaren Arten ein.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addChannelOption(option => option
      .setName("panel")
      .setDescription("Textkanal für das Ticket-Auswahlpanel")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true))
    .addChannelOption(option => option
      .setName("kategorie")
      .setDescription("Kategorie für offene Tickets")
      .addChannelTypes(ChannelType.GuildCategory)
      .setRequired(true))
    .addStringOption(option => option
      .setName("ticketarten")
      .setDescription("Kommagetrennte Arten, z. B. Support, Bewerbung, Sonstiges")
      .setRequired(true)
      .setMaxLength(1000))
    .addChannelOption(option => option
      .setName("archiv")
      .setDescription("Optionale Kategorie für geschlossene Tickets")
      .addChannelTypes(ChannelType.GuildCategory))
    .toJSON();
  const commands = await client.application.commands.fetch({ guildId });
  const manualBookingCommand = new SlashCommandBuilder()
    .setName("buchung")
    .setDescription("Erfasst eine Einnahme oder Ausgabe in der Buchhaltung.")
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("art")
      .setDescription("Einnahme oder Ausgabe")
      .setRequired(true)
      .addChoices(
        { name: "Einnahme", value: "income" },
        { name: "Ausgabe", value: "expense" }
      ))
    .addIntegerOption(option => option
      .setName("betrag")
      .setDescription("Betrag in Dollar, ohne Cent")
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(1_000_000_000))
    .addStringOption(option => option
      .setName("beschreibung")
      .setDescription("Wofür ist die Buchung?")
      .setRequired(true)
      .setMaxLength(100))
    .toJSON();

  const cashCommand = new SlashCommandBuilder()
    .setName("kasse")
    .setDescription("Zeigt Einnahmen, Ausgaben und Saldo der Buchhaltung.")
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("zeitraum")
      .setDescription("Zeitraum für den Kassenstand")
      .setRequired(true)
      .addChoices(
        { name: "Heute", value: "heute" },
        { name: "Diese Woche", value: "woche" },
        { name: "Dieser Monat", value: "monat" },
        { name: "Gesamt", value: "gesamt" }
      ))
    .toJSON();
  const voidCommand = new SlashCommandBuilder()
    .setName("storno")
    .setDescription("Storniert oder korrigiert eine Buchung mit Begründung.")
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("buchung_id")
      .setDescription("ID aus der Buchungsbestätigung oder Admin-Buchhaltung")
      .setRequired(true)
      .setMaxLength(36))
    .addStringOption(option => option
      .setName("grund")
      .setDescription("Warum wird storniert oder korrigiert?")
      .setRequired(true)
      .setMinLength(3)
      .setMaxLength(200))
    .addIntegerOption(option => option
      .setName("neuer_betrag")
      .setDescription("Neuer Betrag bei einer Korrektur")
      .setMinValue(1)
      .setMaxValue(1_000_000_000))
    .addStringOption(option => option
      .setName("neue_beschreibung")
      .setDescription("Neue Beschreibung bei einer Korrektur")
      .setMaxLength(100))
    .addStringOption(option => option
      .setName("neue_art")
      .setDescription("Neue Buchungsart bei einer Korrektur")
      .addChoices(
        { name: "Einnahme", value: "income" },
        { name: "Ausgabe", value: "expense" }
      ))
    .toJSON();
  const livenessCommand = new SlashCommandBuilder()
    .setName("livez")
    .setDescription("Prüft, ob der Webserver erreichbar ist.")
    .setDMPermission(false)
    .toJSON();
  const healthCommand = new SlashCommandBuilder()
    .setName("healthz")
    .setDescription("Prüft Discord, Speicher und den Bestellversand.")
    .setDMPermission(false)
    .toJSON();

  for (const command of [
    familyCommand,
    deleteFamilyCommand,
    listFamiliesCommand,
    checkFamiliesCommand,
    familyInfoCommand,
    familyAddMemberCommand,
    familyRemoveMemberCommand,
    familyRenameCommand,
    familyRolesCommand,
    familyOverviewCommand,
    familyApplicationCommand,
    familyColorCommand,
    familyTopicCommand,
    familyActivityCommand,
    familyExportCommand,
    familyAuditCommand,
    ticketSetupCommand,
    manualBookingCommand,
    cashCommand,
    voidCommand,
    livenessCommand,
    healthCommand
  ]) {
    const existingCommand = commands.find(existing => existing.name === command.name);
    if (existingCommand) {
      await existingCommand.edit(command);
    } else {
      await client.application.commands.create(command, guildId);
    }
  }
}

async function finishStatusButton(payload, orderId, statusKey, actorName) {
  try {
    const order = applyDiscordOrderStatus(orderId, statusKey, actorName, String(payload.message?.id || ""), payload);
    await editOriginalInteraction(payload, interactionMessageData(order));
  } catch (error) {
    if (error.code === "NOT_FOUND") {
      console.warn(`Discord-Bestellbutton ${orderId} konnte keiner gespeicherten Bestellung zugeordnet werden.`);
      await followupInteraction(payload, "Diese Bestellnachricht ist nicht mehr verfügbar.");
      return;
    }
    console.error("Discord-Bestellnachricht und/oder Buchhaltung konnten nicht aktualisiert werden:", error.message);
    await followupInteraction(payload, error.code === "ACCOUNTING_SYNC_FAILED"
      ? error.message
      : "Der Bestellstatus konnte nicht gespeichert werden. Bitte Admin informieren.");
  }
}

async function handleDiscordInteraction(req, res) {
  const config = discordConfig();
  let rawBody = "";
  try {
    rawBody = await readRequestBody(req, 256 * 1024);
  } catch {
    sendJson(res, 413, { error: "Payload too large" });
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch {
    sendJson(res, 400, { error: "Invalid interaction payload" });
    return;
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const verifyRequest = () => verifyDiscordInteraction(
    rawBody,
    String(signature || ""),
    String(timestamp || ""),
    config.publicKey
  );

  if (payload.type === 3 && payload.data?.component_type === 3) {
    sendJson(res, 200, { type: 5, data: { flags: 64 } });
    void (async () => {
      if (!config.publicKey || !await verifyRequest()) {
        console.error("Discord-Auswahlmenü mit ungültiger Signatur oder fehlendem Public Key verworfen.");
        return;
      }
      try {
        const content = await handleHttpTicketSelect(payload, config);
        await editOriginalInteraction(payload, {
          content,
          allowed_mentions: { parse: [] }
        });
      } catch (error) {
        await editOriginalInteraction(payload, {
          content: error.message,
          allowed_mentions: { parse: [] }
        });
      }
    })().catch(error => console.error("Discord-Ticketauswahl fehlgeschlagen:", error.message));
    return;
  }

  if (payload.type === 3 && payload.data?.component_type === 2) {
    const action = parseButtonAction(payload.data.custom_id);
    sendJson(res, 200, { type: 6 });
    void (async () => {
      if (!config.publicKey || !await verifyRequest()) {
        console.error("Discord-Button-Interaction mit ungültiger Signatur oder fehlendem Public Key verworfen.");
        return;
      }

      const familyDeletionButton = String(payload.data.custom_id || "").match(/^delfam:(confirm|cancel):([a-f0-9-]{36})$/i);
      if (familyDeletionButton) {
        const isAdmin = (BigInt(payload.member?.permissions || "0") & PermissionFlagsBits.Administrator) !== 0n;
        if (payload.guild_id !== config.guildId || !isAdmin) {
          await editOriginalInteraction(payload, {
            content: "Nur Server-Admins auf dem konfigurierten Discord-Server dürfen Familien löschen.",
            components: [],
            allowed_mentions: { parse: [] }
          });
          return;
        }
        try {
          const guild = await discordGatewayClient.guilds.fetch(config.guildId);
          const content = await completeFamilyDeletion(
            familyDeletionButton[2],
            familyDeletionButton[1].toLowerCase(),
            payload.guild_id,
            payload.member.user.id,
            guild
          );
          await editOriginalInteraction(payload, { content, components: [], allowed_mentions: { parse: [] } });
        } catch (error) {
          console.error("Bestätigte Familienlöschung fehlgeschlagen:", error.message);
          await editOriginalInteraction(payload, {
            content: `Die Familie konnte nicht vollständig gelöscht werden: ${error.message}`,
            components: [],
            allowed_mentions: { parse: [] }
          });
        }
        return;
      }

      const familyChangeButton = String(payload.data.custom_id || "").match(/^famchange:(confirm|cancel):([a-f0-9-]{36})$/i);
      const familyListButton = String(payload.data.custom_id || "").match(/^famlist:(prev|next):([a-f0-9-]{36})$/i);
      if (familyChangeButton || familyListButton) {
        const isAdmin = (BigInt(payload.member?.permissions || "0") & PermissionFlagsBits.Administrator) !== 0n;
        if (payload.guild_id !== config.guildId || !isAdmin) {
          await followupInteraction(payload, "Nur Server-Admins auf dem konfigurierten Discord-Server dürfen diese Familienaktion ausführen.");
          return;
        }
        try {
          let result;
          if (familyChangeButton) {
            const guild = await discordGatewayClient.guilds.fetch(config.guildId);
            result = {
              content: await completeFamilyMemberChange(
                familyChangeButton[2],
                familyChangeButton[1].toLowerCase(),
                payload.guild_id,
                payload.member.user.id,
                guild
              ),
              components: [],
              allowed_mentions: { parse: [] }
            };
          } else {
            result = moveFamilyListPage(
              familyListButton[2],
              familyListButton[1].toLowerCase() === "next" ? 1 : -1,
              payload.guild_id,
              payload.member.user.id
            );
            result = {
              content: result.content,
              components: result.components.map(row => row.toJSON()),
              allowed_mentions: { parse: [] }
            };
          }
          await editOriginalInteraction(payload, result);
        } catch (error) {
          console.error("Familienaktion über signierte Interaktion fehlgeschlagen:", error.message);
          await editOriginalInteraction(payload, {
            content: error.message,
            components: [],
            allowed_mentions: { parse: [] }
          });
        }
        return;
      }

      const familyApplicationButton = String(payload.data.custom_id || "").match(/^famapply:(approve|reject):([a-f0-9-]{36})$/i);
      if (familyApplicationButton) {
        if (payload.guild_id !== config.guildId) {
          await followupInteraction(payload, "Dieser Antrag gehört nicht zum konfigurierten Server.");
          return;
        }
        try {
          const guild = await discordGatewayClient.guilds.fetch(config.guildId);
          const content = await completeFamilyApplication(
            familyApplicationButton[2],
            familyApplicationButton[1].toLowerCase(),
            payload.member.user.id,
            guild
          );
          await editOriginalInteraction(payload, { content, components: [], allowed_mentions: { parse: [] } });
        } catch (error) {
          await followupInteraction(payload, error.message);
        }
        return;
      }

      if (payload.data.custom_id === "ticket:close") {
        try {
          if (payload.guild_id !== config.guildId || !discordGatewayClient?.isReady()) {
            throw new Error("Dieses Ticket gehört nicht zum konfigurierten Server.");
          }
          const guild = await discordGatewayClient.guilds.fetch(config.guildId);
          const [channel, actor] = await Promise.all([
            guild.channels.fetch(payload.channel_id),
            guild.members.fetch(payload.member.user.id)
          ]);
          const content = await closeTicketChannel(channel, actor, guild);
          await editOriginalInteraction(payload, { content, components: [], allowed_mentions: { parse: [] } });
        } catch (error) {
          await followupInteraction(payload, error.message);
        }
        return;
      }

      if (action.kind === "status") {
        if (!memberCanManageOrders(payload.guild_id, payload.member?.roles, config)) {
          await followupInteraction(payload, "Du hast keine Berechtigung, den Bestellstatus zu ändern.");
          return;
        }
        await finishStatusButton(payload, action.orderId, action.statusKey, actorNameFromMember(payload.member));
        return;
      }

      if (action.kind === "contact") {
        await followupInteraction(payload, contactReply(action.orderId, payload.message?.embeds?.[0]));
        return;
      }

      await followupInteraction(payload, "Unbekannte Bestellaktion.");
    })().catch(error => console.error("Discord-Button-Interaction fehlgeschlagen:", error.message));
    return;
  }

  if (!config.publicKey) {
    sendJson(res, 503, { error: "Discord interaction endpoint not configured." });
    return;
  }

  if (!await verifyRequest()) {
    sendJson(res, 401, { error: "Invalid request signature" });
    return;
  }

  if (payload.type === 1) {
    sendJson(res, 200, { type: 1 });
    return;
  }

  if (payload.type === 2 && payload.data?.name === "newfam") {
    sendJson(res, 200, { type: 5, data: { flags: 64 } });
    void handleHttpNewFamily(payload, config)
      .catch(error => {
        console.error("Discord-Slash-Command fehlgeschlagen:", error.message);
        return `Die Familieneinrichtung ist fehlgeschlagen: ${error.message}`;
      })
      .then(content => editOriginalInteraction(payload, { content, allowed_mentions: { parse: [] } }))
      .catch(error => console.error("Discord-Antwort auf /newfam fehlgeschlagen:", error.message));
    return;
  }

  if (payload.type === 2 && payload.data?.name === "delfam") {
    sendJson(res, 200, { type: 5, data: { flags: 64 } });
    void handleHttpDeleteFamily(payload, config)
      .catch(error => {
        console.error("Discord-Slash-Command fehlgeschlagen:", error.message);
        return `Die Familie konnte nicht vollständig gelöscht werden: ${error.message}`;
      })
      .then(result => editOriginalInteraction(
        payload,
        typeof result === "string" ? { content: result, allowed_mentions: { parse: [] } } : result
      ))
      .catch(error => console.error("Discord-Antwort auf /delfam fehlgeschlagen:", error.message));
    return;
  }

  if (payload.type === 2 && payload.data?.name === "fambeitritt") {
    sendJson(res, 200, { type: 5, data: { flags: 64 } });
    void handleHttpFamilyApplication(payload, config)
      .catch(error => `Familienbeitritt fehlgeschlagen: ${error.message}`)
      .then(content => editOriginalInteraction(payload, { content, allowed_mentions: { parse: [] } }))
      .catch(error => console.error("Discord-Antwort auf /fambeitritt fehlgeschlagen:", error.message));
    return;
  }

  if (payload.type === 2 && payload.data?.name === "ticketeinrichten") {
    sendJson(res, 200, { type: 5, data: { flags: 64 } });
    void handleHttpTicketSetup(payload, config)
      .catch(error => `Ticket-System konnte nicht eingerichtet werden: ${error.message}`)
      .then(content => editOriginalInteraction(payload, { content, allowed_mentions: { parse: [] } }))
      .catch(error => console.error("Discord-Antwort auf /ticketeinrichten fehlgeschlagen:", error.message));
    return;
  }

  const familyManagementCommands = [
    "listfam", "famcheck", "faminfo", "famadd", "famremove", "famrename", "famrolle",
    "famuebersicht", "famfarbe", "famtopic", "famaktivitaet", "famexport", "famaudit"
  ];
  if (payload.type === 2 && familyManagementCommands.includes(payload.data?.name)) {
    sendJson(res, 200, { type: 5, data: { flags: 64 } });
    void handleHttpFamilyManagement(payload, config)
      .catch(error => {
        console.error(`Discord-Slash-Command /${payload.data.name} fehlgeschlagen:`, error.message);
        return `/${payload.data.name} fehlgeschlagen: ${error.message}`;
      })
      .then(result => editOriginalInteraction(
        payload,
        typeof result === "string" ? { content: result, allowed_mentions: { parse: [] } } : result
      ))
      .catch(error => console.error(`Discord-Antwort auf /${payload.data.name} fehlgeschlagen:`, error.message));
    return;
  }

  if (payload.type === 2 && payload.data?.name === "buchung") {
    sendJson(res, 200, { type: 5, data: { flags: 64 } });
    void Promise.resolve()
      .then(() => handleHttpManualBooking(payload))
      .catch(error => {
        console.error("Discord-Buchung fehlgeschlagen:", error.message);
        return `Buchung fehlgeschlagen: ${error.message}`;
      })
      .then(content => editOriginalInteraction(payload, { content, allowed_mentions: { parse: [] } }))
      .catch(error => console.error("Discord-Antwort auf /buchung fehlgeschlagen:", error.message));
    return;
  }

  if (payload.type === 2 && ["kasse", "storno"].includes(payload.data?.name)) {
    sendJson(res, 200, { type: 5, data: { flags: 64 } });
    const handler = payload.data.name === "kasse"
      ? handleHttpCash(payload, config)
      : handleHttpVoid(payload);
    void Promise.resolve(handler)
      .catch(error => {
        console.error(`Discord-Slash-Command /${payload.data.name} fehlgeschlagen:`, error.message);
        return `/${payload.data.name} fehlgeschlagen: ${error.message}`;
      })
      .then(content => editOriginalInteraction(payload, { content, allowed_mentions: { parse: [] } }))
      .catch(error => console.error(`Discord-Antwort auf /${payload.data.name} fehlgeschlagen:`, error.message));
    return;
  }

  if (payload.type === 2 && ["livez", "healthz"].includes(payload.data?.name)) {
    const commandName = payload.data.name;
    sendJson(res, 200, { type: 5, data: { flags: 64 } });
    void Promise.resolve()
      .then(() => handleHttpHealthCommand(payload, commandName, config))
      .then(content => editOriginalInteraction(payload, { content, allowed_mentions: { parse: [] } }))
      .catch(error => console.error(`Discord-Antwort auf /${commandName} fehlgeschlagen:`, error.message));
    return;
  }

  sendJson(res, 200, { type: 4, data: { content: "Interaction verarbeitet.", flags: 64 } });
}

async function postToDiscordChannel(orderMessage, channelId = ORDER_CHANNEL_ID, allowWebhook = true) {
  const config = discordConfig();
  const payload = typeof orderMessage === "string" ? { content: orderMessage, allowed_mentions: { parse: [] } } : orderMessage;

  if (allowWebhook && ORDER_WEBHOOK_URL) {
    const webhookUrl = new URL(ORDER_WEBHOOK_URL);
    webhookUrl.searchParams.set("wait", "true");
    const response = await discordFetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = parseJson(await response.text());
    if (!response.ok) {
      throw new Error(data?.message || "Webhook-Request fehlgeschlagen.");
    }
    return { method: "webhook", channelId: data?.channel_id || channelId, messageId: data?.id || "" };
  }

  if (config.botToken) {
    const response = await discordFetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${config.botToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const data = parseJson(await response.text());
    if (!response.ok) {
      const details = data?.errors ? ` ${JSON.stringify(data.errors)}` : "";
      throw new Error(`${data?.message || "Discord-API fehlgeschlagen."}${details}`);
    }
    return { method: "bot", channelId: data?.channel_id || channelId, messageId: data?.id || "" };
  }

  return { method: "local-only" };
}

async function handleGatewayOrderInteraction(interaction) {
  if (!interaction.isButton()) return;

  if (interaction.customId.startsWith("delfam:")) {
    await handleDeleteFamilyButtonInteraction(interaction);
    return;
  }
  if (interaction.customId.startsWith("famchange:") || interaction.customId.startsWith("famlist:")) {
    await handleFamilyManagementButtonInteraction(interaction);
    return;
  }

  const action = parseButtonAction(interaction.customId);
  if (action.kind === "unknown") return;

  const config = discordConfig();
  const roleIds = interaction.member?.roles?.cache
    ? [...interaction.member.roles.cache.keys()]
    : [];
  if (!memberCanManageOrders(interaction.guildId, roleIds, config)) {
    await interaction.reply({
      content: "Du hast keine Berechtigung, den Bestellstatus zu ändern.",
      ephemeral: true
    });
    return;
  }

  if (action.kind === "contact") {
    await interaction.reply({
      content: contactReply(action.orderId, interaction.message?.embeds?.[0]),
      ephemeral: true
    });
    return;
  }

  // Discord erwartet die erste Antwort innerhalb weniger Sekunden. Das sofortige
  // deferUpdate verhindert den „hat nicht rechtzeitig reagiert“-Fehler, während
  // Datei- und Discord-Updates im Hintergrund verarbeitet werden.
  await interaction.deferUpdate();
  try {
    const payload = {
      message: interaction.message,
      channel_id: interaction.channelId
    };
    const order = applyDiscordOrderStatus(
      action.orderId,
      action.statusKey,
      actorNameFromMember(interaction.member),
      String(interaction.message?.id || ""),
      payload
    );
    await interaction.editReply(interactionMessageData(order));
  } catch (error) {
    console.error("Discord-Button-Interaktion konnte nicht verarbeitet werden:", error.message);
    try {
      await interaction.followUp({
        content: error.code === "NOT_FOUND"
          ? "Diese Bestellnachricht ist nicht mehr verfügbar."
          : error.code === "ACCOUNTING_SYNC_FAILED"
            ? error.message
          : "Der Bestellstatus konnte nicht gespeichert werden. Bitte Admin informieren.",
        ephemeral: true
      });
    } catch (followupError) {
      console.error("Discord-Fehlernachricht konnte nicht gesendet werden:", followupError.message);
    }
  }
}

async function handleMaterialOrder(req, res) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 256000) {
      send(res, 413, JSON.stringify({ ok: false, message: "Anfrage zu groß." }), "application/json; charset=utf-8");
      return;
    }
  }

  let payload = {};
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    send(res, 400, JSON.stringify({ ok: false, message: "Ungültige Formulardaten." }), "application/json; charset=utf-8");
    return;
  }

  const technical = Number(payload.technical ?? 0);
  const medical = Number(payload.medical ?? 0);
  const icName = String(payload.icName || "").trim();
  const phone = String(payload.phone || "").trim();

  if (!Number.isSafeInteger(technical) || !Number.isSafeInteger(medical)
    || technical < 0 || medical < 0 || !icName || icName.length > 80 || !phone || phone.length > 40) {
    send(res, 400, JSON.stringify({ ok: false, message: "Bitte alle Felder korrekt ausfüllen." }), "application/json; charset=utf-8");
    return;
  }

  const totalMaterials = technical + medical;
  const subtotalPrice = technical * 250 + medical * 150;
  if (!Number.isSafeInteger(totalMaterials) || !Number.isSafeInteger(subtotalPrice)) {
    send(res, 400, JSON.stringify({ ok: false, message: "Die Materialmenge oder der Bestellwert ist zu hoch." }), "application/json; charset=utf-8");
    return;
  }

  let pricing;
  try {
    pricing = priceOrderWithCoupon(subtotalPrice, payload.couponCode);
  } catch (error) {
    sendCouponOrderError(res, error, "Material-Coupon konnte nicht geprüft werden");
    return;
  }
  const { totalPrice } = pricing;
  const order = {
    type: "material",
    technical,
    medical,
    icName,
    phone,
    totalMaterials,
    subtotalPrice,
    discountAmount: pricing.discountAmount,
    couponCode: pricing.couponCode,
    couponPercent: pricing.couponPercent,
    totalPrice,
    customerName: icName,
    status: "Neu",
    createdAt: new Date().toISOString(),
    message: `📦 Neue Material-Bestellung\n` +
      `Technische Materialien: ${technical}\n` +
      `Medizinische Materialien: ${medical}\n` +
      `Gesamtanzahl: ${totalMaterials}\n` +
      `IC-Name: ${icName}\n` +
      `Handynummer: ${phone}\n` +
      `${priceBreakdownMessage(pricing)}\n` +
      `Zeitstempel: ${new Date().toLocaleString("de-DE")}`
  };
  Object.assign(order, trackAdminOrder(order));
  respondWithQueuedOrder(res, order, {
    ...couponPriceResponse(pricing),
    orderCount: totalMaterials,
    channelId: ORDER_CHANNEL_ID
  }, `Bestellung gespeichert. ${priceBreakdownMessage(pricing)}`);
}

function readBuybackProducts() {
  const products = JSON.parse(fs.readFileSync(BUYBACK_PRODUCTS_FILE, "utf8"));
  if (!Array.isArray(products) || products.length < 1 || products.length > 100) {
    throw new Error("Buyback product catalog must contain between 1 and 100 products.");
  }

  const ids = new Set();
  for (const product of products) {
    if (!product || typeof product.id !== "string" || !/^[a-z0-9-]{1,80}$/.test(product.id)
      || typeof product.name !== "string" || !product.name.trim() || product.name.length > 80
      || !Number.isSafeInteger(product.price) || product.price < 1 || product.price > 1000000000
      || ids.has(product.id)) {
      throw new Error("Buyback product catalog contains invalid product data.");
    }
    ids.add(product.id);
  }
  return products;
}

async function handleSellOffer(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readRequestBody(req, 256 * 1024));
  } catch (error) {
    const tooLarge = error.message === "Request body too large.";
    send(res, tooLarge ? 413 : 400, JSON.stringify({
      ok: false,
      message: tooLarge ? "Anfrage zu groß." : "Ungültige Formulardaten."
    }), "application/json; charset=utf-8");
    return;
  }

  const icName = String(payload?.icName || "").trim();
  const phone = String(payload?.phone || "").trim();
  if (!icName || icName.length > 80 || !phone || phone.length > 40
    || !Array.isArray(payload?.items) || payload.items.length < 1 || payload.items.length > 100) {
    send(res, 400, JSON.stringify({ ok: false, message: "Bitte mindestens einen Gegenstand auswählen und deine Kontaktdaten korrekt ausfüllen." }), "application/json; charset=utf-8");
    return;
  }

  let products;
  try {
    products = readBuybackProducts();
  } catch (error) {
    console.error("Ankauf-Preisliste konnte nicht gelesen werden:", error.message);
    send(res, 500, JSON.stringify({ ok: false, message: "Die Ankauf-Preisliste ist momentan nicht verfügbar." }), "application/json; charset=utf-8");
    return;
  }

  const productById = new Map(products.map(product => [product.id, product]));
  const seenProductIds = new Set();
  const items = [];
  let totalPrice = 0;
  for (const entry of payload.items) {
    const product = productById.get(entry?.productId);
    const quantity = Number(entry?.quantity);
    if (!product || seenProductIds.has(product.id)
      || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) {
      send(res, 400, JSON.stringify({ ok: false, message: "Eine ausgewählte Position oder Stückzahl ist ungültig." }), "application/json; charset=utf-8");
      return;
    }
    const itemTotal = product.price * quantity;
    if (!Number.isSafeInteger(itemTotal) || !Number.isSafeInteger(totalPrice + itemTotal)) {
      send(res, 400, JSON.stringify({ ok: false, message: "Der Gesamtpreis ist zu hoch." }), "application/json; charset=utf-8");
      return;
    }
    seenProductIds.add(product.id);
    totalPrice += itemTotal;
    items.push({ productId: product.id, name: product.name, quantity, pricePerItem: product.price, totalPrice: itemTotal });
  }

  const sellOffer = {
    type: "sell-offer",
    items,
    icName,
    phone,
    totalPrice,
    status: "Neu",
    createdAt: new Date().toISOString()
  };
  Object.assign(sellOffer, trackAdminOrder(sellOffer));
  respondWithQueuedOrder(res, sellOffer, {}, "Ankauf-Angebot gespeichert.");
}

async function handleStankOrder(req, res) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 256000) {
      send(res, 413, JSON.stringify({ ok: false, message: "Anfrage zu groß." }), "application/json; charset=utf-8");
      return;
    }
  }

  let payload = {};
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    send(res, 400, JSON.stringify({ ok: false, message: "Ungültige Formulardaten." }), "application/json; charset=utf-8");
    return;
  }

  const quantity = Number(payload.quantity);
  const icName = String(payload.icName || "").trim();
  const phone = String(payload.phone || "").trim();
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > Math.floor(Number.MAX_SAFE_INTEGER / 2000)
    || !icName || icName.length > 80 || !phone || phone.length > 40) {
    send(res, 400, JSON.stringify({ ok: false, message: "Bitte alle Felder korrekt ausfüllen." }), "application/json; charset=utf-8");
    return;
  }

  const subtotalPrice = quantity * 2000;
  let pricing;
  try {
    pricing = priceOrderWithCoupon(subtotalPrice, payload.couponCode);
  } catch (error) {
    sendCouponOrderError(res, error, "STANK-Coupon konnte nicht geprüft werden");
    return;
  }
  const { totalPrice, discountAmount, couponCode, couponPercent } = pricing;
  const order = {
    type: "stank",
    quantity,
    icName,
    phone,
    subtotalPrice,
    discountAmount,
    couponCode,
    couponPercent,
    totalPrice,
    customerName: icName,
    status: "Neu",
    createdAt: new Date().toISOString(),
    message: `🌿 Neue STANK-Bestellung\n` +
      `IC-Name: ${icName}\n` +
      `Handynummer / IC: ${phone}\n` +
      `STANK-Pflanzen: ${quantity}\n` +
      `${priceBreakdownMessage(pricing)}`
  };
  Object.assign(order, trackAdminOrder(order));
  respondWithQueuedOrder(res, order, {
    ...couponPriceResponse(pricing),
    orderCount: quantity,
    channelId: STANK_ORDER_CHANNEL_ID
  }, `STANK-Bestellung gespeichert. ${priceBreakdownMessage(pricing)}`);
}

async function handleCustomOrder(req, res) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 256000) {
      send(res, 413, JSON.stringify({ ok: false, message: "Anfrage zu groß." }), "application/json; charset=utf-8");
      return;
    }
  }

  let payload = {};
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    send(res, 400, JSON.stringify({ ok: false, message: "Ungültige Formulardaten." }), "application/json; charset=utf-8");
    return;
  }

  const icName = String(payload.icName || "").trim();
  const phone = String(payload.phone || "").trim();
  if (!icName || icName.length > 80 || !phone || phone.length > 40
    || !Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 10) {
    send(res, 400, JSON.stringify({ ok: false, message: "Bitte Kontaktdaten und 1 bis 10 gültige Positionen angeben." }), "application/json; charset=utf-8");
    return;
  }

  const items = [];
  let totalPrice = 0;
  let catalog;
  try {
    catalog = readShopProducts();
  } catch (error) {
    console.error("Shop-Katalog konnte nicht gelesen werden:", error.message);
    send(res, 500, JSON.stringify({ ok: false, message: "Der Produktkatalog ist momentan nicht verfügbar." }), "application/json; charset=utf-8");
    return;
  }
  for (const entry of payload.items) {
    const type = entry?.type === "catalog" ? "catalog" : entry?.type === "weeklyOffer" ? "weeklyOffer" : "custom";
    const quantity = Number(entry?.quantity);
    let name;
    let pricePerItem;
    if (type === "catalog") {
      const product = catalog.find(item => item.id === entry?.productId && item.active);
      if (!product) {
        send(res, 400, JSON.stringify({ ok: false, message: "Ein ausgewähltes Produkt ist nicht mehr verfügbar." }), "application/json; charset=utf-8");
        return;
      }
      name = product.name;
      pricePerItem = getShopPromotion(product)?.price ?? product.price;
    } else if (type === "weeklyOffer") {
      if (!WEEKLY_BUNDLE || entry?.weeklyOfferId !== WEEKLY_BUNDLE.id) {
        send(res, 400, JSON.stringify({ ok: false, message: "Das Wochenangebot ist nicht mehr verfügbar." }), "application/json; charset=utf-8");
        return;
      }
      name = WEEKLY_BUNDLE.name;
      pricePerItem = WEEKLY_BUNDLE.price;
    } else {
      name = String(entry?.name || "").trim();
      pricePerItem = Number(entry?.pricePerItem);
    }
    if (!name || name.length > 80 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000
      || !Number.isSafeInteger(pricePerItem) || pricePerItem < 1 || pricePerItem > 1000000000) {
      send(res, 400, JSON.stringify({ ok: false, message: "Jede Position braucht einen gültigen Gegenstand, eine Stückzahl und einen gültigen Preis." }), "application/json; charset=utf-8");
      return;
    }
    const itemTotal = quantity * pricePerItem;
    if (!Number.isSafeInteger(itemTotal) || !Number.isSafeInteger(totalPrice + itemTotal)) {
      send(res, 400, JSON.stringify({ ok: false, message: "Der Gesamtpreisvorschlag ist zu hoch." }), "application/json; charset=utf-8");
      return;
    }
    items.push({ type, name, quantity, pricePerItem, totalPrice: itemTotal });
    totalPrice += itemTotal;
  }

  const subtotalPrice = totalPrice;
  let pricing;
  try {
    pricing = priceOrderWithCoupon(subtotalPrice, payload.couponCode);
  } catch (error) {
    sendCouponOrderError(res, error, "Wunsch-Coupon konnte nicht geprüft werden");
    return;
  }
  const { discountAmount, couponCode, couponPercent } = pricing;
  totalPrice = pricing.totalPrice;
  const order = {
    type: "custom",
    icName,
    phone,
    items,
    subtotalPrice,
    discountAmount,
    couponCode,
    couponPercent,
    totalPrice,
    customerName: icName,
    status: "Neu",
    createdAt: new Date().toISOString(),
    message: `🛒 Neue Wunsch-Bestellung\nIC-Name: ${icName}\nHandynummer / IC: ${phone}\n` +
      items.map((item, index) => `${index + 1}. ${item.name}${item.type === "custom" ? " (Wunsch)" : ""} — ${item.quantity} × ${item.pricePerItem} $ = ${item.totalPrice} $`).join("\n") +
      `\n${priceBreakdownMessage(pricing)}`
  };
  Object.assign(order, trackAdminOrder(order));
  respondWithQueuedOrder(res, order, {
    ...couponPriceResponse(pricing),
    orderCount: items.length,
    channelId: CUSTOM_ORDER_CHANNEL_ID
  }, `Wunsch-Bestellung gespeichert. ${priceBreakdownMessage(pricing)}`);
}

function checkHealthStorage() {
  const files = [
    ADMIN_ORDERS_FILE,
    SHOP_COUPONS_FILE,
    CATALOG_FILE,
    CATALOG_AUDIT_PENDING_FILE,
    ACCOUNTING_LEDGER_FILE,
    ACCOUNTING_REPORTS_FILE,
    BUYBACK_PRODUCTS_FILE
  ];
  const directories = new Set([
    ...files.map(file => path.dirname(file)),
    LOCAL_ORDER_LOG_DIR,
    DATA_BACKUP_DIR
  ]);

  try {
    for (const file of files) fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    for (const directory of directories) {
      fs.mkdirSync(directory, { recursive: true });
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
      const probeFile = path.join(directory, `.health-check-${process.pid}-${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(probeFile, "ok", { flag: "wx" });
      } finally {
        try {
          fs.unlinkSync(probeFile);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    return "ok";
  } catch (error) {
    console.error("Speicherprüfung fehlgeschlagen:", error.message);
    return "unavailable";
  }
}

function checkOrderDeliveryHealth() {
  try {
    const orders = JSON.parse(fs.readFileSync(ADMIN_ORDERS_FILE, "utf8"));
    if (!Array.isArray(orders)) throw new Error("Admin-Bestelldatei enthält keine Bestellliste.");
    const now = Date.now();
    const hasDeliveryIssue = orders.some(order => {
      if (order.deliveryStatus === "failed" || order.deliveryStatus === "local-only") return true;
      if (order.deliveryStatus !== "pending") return false;
      const createdAt = Date.parse(order.createdAt);
      return !Number.isFinite(createdAt) || now - createdAt > STALE_ORDER_DELIVERY_TTL;
    });
    return hasDeliveryIssue ? "degraded" : "ok";
  } catch (error) {
    console.error("Bestellversand konnte nicht geprüft werden:", error.message);
    return "unavailable";
  }
}

function getHealthReport() {
  const now = Date.now();
  if (cachedHealthReport && now - cachedHealthReport.checkedAt < HEALTH_CACHE_TTL) {
    return cachedHealthReport.report;
  }

  const config = discordConfig();
  const checks = {
    discord: config.botToken && discordGatewayClient?.isReady() ? "ok" : "unavailable",
    storage: checkHealthStorage(),
    orders: checkOrderDeliveryHealth()
  };
  const report = {
    status: Object.values(checks).every(status => status === "ok") ? "ok" : "degraded",
    checks,
    checkedAt: new Date(now).toISOString()
  };
  cachedHealthReport = { checkedAt: now, report };
  return report;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const config = discordConfig();
  if (req.method === "POST" && pathname === "/api/discord-interactions") {
    await handleDiscordInteraction(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/material-bestellung") {
    await handleMaterialOrder(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/ankauf-angebot") {
    await handleSellOffer(req, res);
    return;
  }
  if (req.method === "GET" && pathname === "/api/ankauf-produkte") {
    try {
      send(res, 200, JSON.stringify({ ok: true, products: readBuybackProducts() }), "application/json; charset=utf-8");
    } catch (error) {
      console.error("Ankauf-Preisliste konnte nicht gelesen werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Die Ankauf-Preisliste ist momentan nicht verfügbar." }), "application/json; charset=utf-8");
    }
    return;
  }
  if (req.method === "POST" && pathname === "/api/stank-bestellung") {
    await handleStankOrder(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/wunsch-bestellung") {
    await handleCustomOrder(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/coupons/validate") {
    let payload;
    try {
      payload = JSON.parse(await readRequestBody(req, 16 * 1024));
    } catch {
      send(res, 400, JSON.stringify({ ok: false, message: "Ungültige Coupon-Prüfung." }), "application/json; charset=utf-8");
      return;
    }
    const subtotal = Number(payload?.subtotal);
    if (!Number.isSafeInteger(subtotal) || subtotal < 1 || typeof payload?.code !== "string" || !payload.code.trim()) {
      send(res, 400, JSON.stringify({ ok: false, message: "Bitte Coupon-Code und Bestellwert prüfen." }), "application/json; charset=utf-8");
      return;
    }
    try {
      const pricing = priceOrderWithCoupon(subtotal, payload.code);
      send(res, 200, JSON.stringify({
        ok: true,
        ...couponPriceResponse(pricing),
        coupon: { code: pricing.couponCode, percent: pricing.couponPercent }
      }), "application/json; charset=utf-8");
    } catch (error) {
      sendCouponOrderError(res, error, "Coupon-Prüfung fehlgeschlagen");
    }
    return;
  }
  const couponPath = pathname.match(/^\/api\/admin\/coupons\/([a-f0-9-]{36})$/i);
  if ((req.method === "GET" && pathname === "/api/admin/coupons")
    || (req.method === "POST" && pathname === "/api/admin/coupons")
    || (req.method === "PATCH" && couponPath)) {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/coupons");
    if (!adminSession) return;
    if (req.method === "GET") {
      try {
        const coupons = readShopCoupons();
        const usageCounts = getCouponUsageCounts(coupons);
        send(res, 200, JSON.stringify({
          ok: true,
          coupons: coupons.map(coupon => couponWithUsage(coupon, usageCounts.get(coupon.code) || 0))
        }), "application/json; charset=utf-8");
      } catch (error) {
        console.error("Coupons konnten nicht geladen werden:", error.message);
        send(res, 500, JSON.stringify({ ok: false, message: "Coupons konnten nicht geladen werden." }), "application/json; charset=utf-8");
      }
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await readRequestBody(req, 16 * 1024));
    } catch {
      send(res, 400, JSON.stringify({ ok: false, message: "Ungültige Coupon-Daten." }), "application/json; charset=utf-8");
      return;
    }
    if (req.method === "POST") {
      let definition;
      try {
        definition = validateCouponDefinition(payload);
      } catch (error) {
        send(res, 400, JSON.stringify({ ok: false, message: error.message }), "application/json; charset=utf-8");
        return;
      }
      try {
        const coupons = readShopCoupons();
        if (coupons.some(coupon => coupon.code === definition.code)) {
          send(res, 409, JSON.stringify({ ok: false, message: "Dieser Coupon-Code ist bereits vergeben." }), "application/json; charset=utf-8");
          return;
        }
        if (coupons.length >= 1000) {
          send(res, 409, JSON.stringify({ ok: false, message: "Es können höchstens 1.000 Coupons gespeichert werden." }), "application/json; charset=utf-8");
          return;
        }
        const coupon = {
          id: crypto.randomUUID(),
          ...definition,
          active: true,
          createdAt: new Date().toISOString(),
          createdBy: String(adminSession.user?.global_name || adminSession.user?.username || "Web-Admin").slice(0, 80)
        };
        writeAccountingJson(SHOP_COUPONS_FILE, [...coupons, coupon]);
        let notificationSent = true;
        try {
          const uses = coupon.maxUses === null ? "Unbegrenzt viele Einlösungen" : `Maximal ${coupon.maxUses} Einlösungen`;
          const result = await postToDiscordChannel(
            `🎟️ Neuer Coupon erstellt\nCode: **${coupon.code}**\nRabatt: **${coupon.percent} %**\n${uses}\nErstellt von: ${coupon.createdBy}`,
            COUPON_NOTIFICATION_CHANNEL_ID,
            false
          );
          if (result.method !== "bot") {
            throw new Error("Discord-Bot ist nicht konfiguriert.");
          }
        } catch (error) {
          notificationSent = false;
          console.error(`Coupon wurde erstellt, konnte aber nicht in Discord-Kanal ${COUPON_NOTIFICATION_CHANNEL_ID} gemeldet werden:`, error.message);
        }
        send(res, 201, JSON.stringify({
          ok: true,
          coupon: couponWithUsage(coupon, 0),
          notificationSent
        }), "application/json; charset=utf-8");
      } catch (error) {
        console.error("Coupon konnte nicht gespeichert werden:", error.message);
        send(res, 500, JSON.stringify({ ok: false, message: "Coupon konnte nicht gespeichert werden." }), "application/json; charset=utf-8");
      }
      return;
    }

    if (typeof payload?.active !== "boolean") {
      send(res, 400, JSON.stringify({ ok: false, message: "Bitte einen gültigen Coupon-Status angeben." }), "application/json; charset=utf-8");
      return;
    }
    try {
      const coupons = readShopCoupons();
      const coupon = coupons.find(item => item.id === couponPath[1]);
      if (!coupon) {
        send(res, 404, JSON.stringify({ ok: false, message: "Coupon nicht gefunden." }), "application/json; charset=utf-8");
        return;
      }
      const usageCounts = getCouponUsageCounts(coupons);
      coupon.active = payload.active;
      coupon.updatedAt = new Date().toISOString();
      coupon.updatedBy = String(adminSession.user?.global_name || adminSession.user?.username || "Web-Admin").slice(0, 80);
      writeAccountingJson(SHOP_COUPONS_FILE, coupons);
      send(res, 200, JSON.stringify({
        ok: true,
        coupon: couponWithUsage(coupon, usageCounts.get(coupon.code) || 0)
      }), "application/json; charset=utf-8");
    } catch (error) {
      console.error("Coupon-Status konnte nicht gespeichert werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Coupon-Status konnte nicht gespeichert werden." }), "application/json; charset=utf-8");
    }
    return;
  }
  const orderStatusPath = pathname.match(/^\/api\/admin\/orders\/([a-f0-9-]{36})$/i);
  if ((req.method === "GET" && pathname === "/api/admin/orders") || (req.method === "PATCH" && orderStatusPath)) {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/orders");
    if (!adminSession) return;
    if (req.method === "GET") {
      try {
        const orders = readAdminOrders().slice().sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
        send(res, 200, JSON.stringify({ ok: true, orders }), "application/json; charset=utf-8");
      } catch (error) {
        console.error("Admin-Bestellübersicht konnte nicht gelesen werden:", error.message);
        send(res, 500, JSON.stringify({ ok: false, message: "Die Bestellübersicht konnte nicht gelesen werden." }), "application/json; charset=utf-8");
      }
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readRequestBody(req, 16 * 1024));
    } catch {
      send(res, 400, JSON.stringify({ ok: false, message: "Ungültige Statusdaten." }), "application/json; charset=utf-8");
      return;
    }
    if (!Object.hasOwn(ORDER_STATUS_LABELS, payload?.status)) {
      send(res, 400, JSON.stringify({ ok: false, message: "Dieser Bestellstatus ist ungültig." }), "application/json; charset=utf-8");
      return;
    }

    let existing;
    try {
      existing = readAdminOrders().find(order => order.id === orderStatusPath[1]);
    } catch (error) {
      console.error("Bestellstatus konnte nicht gespeichert werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Der Bestellstatus konnte nicht gespeichert werden." }), "application/json; charset=utf-8");
      return;
    }
    if (!existing) {
      send(res, 404, JSON.stringify({ ok: false, message: "Bestellung nicht gefunden." }), "application/json; charset=utf-8");
      return;
    }
    if (isAdminOrderClosed(existing)) {
      send(res, 409, JSON.stringify({
        ok: false,
        message: "Diese Bestellung ist bereits abgeschlossen und kann nicht mehr geändert werden.",
        order: existing
      }), "application/json; charset=utf-8");
      return;
    }

    let order;
    try {
      order = updateAdminOrder(orderStatusPath[1], {
        status: ORDER_STATUS_LABELS[payload.status],
        updatedAt: new Date().toISOString(),
        updatedBy: adminSession.discordName || adminSession.username || "Discord-Admin"
      });
    } catch (error) {
      console.error("Bestellstatus konnte nicht gespeichert werden:", error.message);
      send(res, 500, JSON.stringify({
        ok: false,
        message: error.code === "ACCOUNTING_SYNC_FAILED"
          ? error.message
          : "Der Bestellstatus konnte nicht gespeichert werden."
      }), "application/json; charset=utf-8");
      return;
    }
    if (!order) {
      send(res, 404, JSON.stringify({ ok: false, message: "Bestellung nicht gefunden." }), "application/json; charset=utf-8");
      return;
    }

    let discordSynced = false;
    let warning = "";
    if (order.discordChannelId && order.discordMessageId) {
      try {
        const discordResponse = await discordFetch(
          `https://discord.com/api/v10/channels/${encodeURIComponent(order.discordChannelId)}/messages/${encodeURIComponent(order.discordMessageId)}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bot ${config.botToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(buildAdminOrderDiscordPayload(order))
          }
        );
        const responseBody = parseJson(await discordResponse.text());
        if (!discordResponse.ok) {
          throw new Error(`Discord API HTTP ${discordResponse.status}: ${String(responseBody?.message || "Unbekannter Fehler").slice(0, 160)}`);
        }
        discordSynced = true;
      } catch (error) {
        warning = "Status wurde gespeichert, aber die Discord-Nachricht konnte nicht aktualisiert werden.";
        console.error(`Discord-Bestellnachricht ${order.discordMessageId} konnte nicht aktualisiert werden:`, error.message);
      }
    }
    send(res, 200, JSON.stringify({ ok: true, order, discordSynced, warning }), "application/json; charset=utf-8");
    return;
  }
  const accountingEntryMatch = pathname.match(/^\/api\/admin\/accounting\/([a-f0-9-]{36})$/i);
  if ((req.method === "GET" && pathname === "/api/admin/accounting")
    || (req.method === "POST" && pathname === "/api/admin/accounting")
    || (req.method === "PATCH" && accountingEntryMatch)) {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/accounting");
    if (!adminSession) return;
    if (req.method === "POST") {
      let payload;
      try {
        payload = JSON.parse(await readRequestBody(req, 16 * 1024));
      } catch {
        send(res, 400, JSON.stringify({ ok: false, message: "Ungültige oder zu große Buchungsdaten." }), "application/json; charset=utf-8");
        return;
      }
      if (!["income", "expense"].includes(payload?.kind)
        || !Number.isSafeInteger(payload.amount)
        || typeof payload.description !== "string"
        || !payload.description.trim()
        || payload.description.trim().length > 200
        || typeof payload.sourceId !== "string"
        || !/^[a-f0-9-]{36}$/i.test(payload.sourceId)) {
        send(res, 400, JSON.stringify({ ok: false, message: "Bitte Buchungsart, gültigen Betrag, Beschreibung und Buchungskennung prüfen." }), "application/json; charset=utf-8");
        return;
      }
      try {
        const entry = accountingLedger.add({
          kind: payload.kind,
          category: "manual",
          amount: payload.amount,
          description: payload.description,
          source: "manual",
          sourceId: payload.sourceId,
          bookedBy: adminSession.user?.global_name || adminSession.user?.username || "Web-Admin"
        });
        send(res, 201, JSON.stringify({ ok: true, entry }), "application/json; charset=utf-8");
      } catch (error) {
        if (/Betrag|Buchungsart|Beschreibung|Kategorie/.test(error.message)) {
          send(res, 400, JSON.stringify({ ok: false, message: error.message }), "application/json; charset=utf-8");
          return;
        }
        console.error("Web-Buchung konnte nicht gespeichert werden:", error.message);
        send(res, 500, JSON.stringify({ ok: false, message: "Die Buchung konnte nicht gespeichert werden." }), "application/json; charset=utf-8");
      }
      return;
    }
    if (req.method === "PATCH") {
      let payload;
      try {
        payload = JSON.parse(await readRequestBody(req, 16 * 1024));
      } catch {
        send(res, 400, JSON.stringify({ ok: false, message: "Ungültige oder zu große Korrekturdaten." }), "application/json; charset=utf-8");
        return;
      }
      try {
        const hasReplacement = payload?.replacement !== null && payload?.replacement !== undefined;
        if (typeof payload?.reason !== "string"
          || payload.reason.trim().length < 3
          || payload.reason.trim().length > 200
          || (hasReplacement && (!payload.replacement
            || !["income", "expense"].includes(payload.replacement.kind)
            || !Number.isSafeInteger(payload.replacement.amount)
            || typeof payload.replacement.description !== "string"
            || !payload.replacement.description.trim()
            || payload.replacement.description.trim().length > 200))) {
          send(res, 400, JSON.stringify({ ok: false, message: "Bitte Grund und Korrekturdaten prüfen." }), "application/json; charset=utf-8");
          return;
        }
        const result = accountingLedger.correctEntry(accountingEntryMatch[1], {
          by: adminSession.user?.global_name || adminSession.user?.username || "Web-Admin",
          reason: payload.reason,
          replacement: hasReplacement ? payload.replacement : null
        });
        send(res, 200, JSON.stringify({ ok: true, entry: result.entry, corrected: result.corrected }), "application/json; charset=utf-8");
      } catch (error) {
        const status = error.code === "NOT_FOUND" ? 404
          : error.code === "ALREADY_VOIDED" ? 409
            : error.code ? 500 : 400;
        if (status === 500) console.error("Web-Buchungskorrektur konnte nicht gespeichert werden:", error.message);
        const message = status === 500
          ? "Die Änderung konnte nicht dauerhaft gespeichert werden. Bitte Admin informieren."
          : error.message;
        send(res, status, JSON.stringify({ ok: false, message }), "application/json; charset=utf-8");
      }
      return;
    }
    try {
      accountingLedger.syncAllOrders(readAdminOrders());
      const entries = accountingLedger.read();
      const period = url.searchParams.get("period") || "gesamt";
      if (!["heute", "woche", "monat", "gesamt"].includes(period)) {
        send(res, 400, JSON.stringify({ ok: false, message: "Ungültiger Buchhaltungszeitraum." }), "application/json; charset=utf-8");
        return;
      }
      const range = periodRange(period);
      const summary = summarize(entries, range);
      const visibleEntries = entries
        .filter(entry => {
          if (!range.from && !range.to) return true;
          const date = accountingDateKey(new Date(entry.bookedAt));
          return (!range.from || date >= range.from) && (!range.to || date <= range.to);
        })
        .sort((left, right) => Date.parse(right.bookedAt) - Date.parse(left.bookedAt));
      send(res, 200, JSON.stringify({
        ok: true,
        period: range.label,
        summary,
        entries: visibleEntries.slice(0, 500),
        totalEntries: visibleEntries.length
      }), "application/json; charset=utf-8");
    } catch (error) {
      console.error("Buchhaltung konnte nicht geladen werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Die Buchhaltung konnte nicht geladen werden." }), "application/json; charset=utf-8");
    }
    return;
  }
  if (req.method === "GET" && pathname === "/api/shop/products") {
    try {
      const products = readShopProducts()
        .filter(product => product.active && product.available)
        .map(product => ({
          id: product.id,
          name: product.name,
          description: product.description,
          price: product.price,
          image: product.image,
          category: product.category,
          available: product.available,
          promotion: getShopPromotion(product)
        }));
      send(res, 200, JSON.stringify({ ok: true, products, ads: SHOP_CONTENT.ads, weeklyBundle: WEEKLY_BUNDLE }), "application/json; charset=utf-8");
    } catch (error) {
      console.error("Shop-Katalog konnte nicht gelesen werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Der Produktkatalog ist momentan nicht verfügbar." }), "application/json; charset=utf-8");
    }
    return;
  }
  if ((req.method === "GET" || req.method === "PUT") && pathname === "/api/admin/shop-products") {
    const adminSession = await requireCatalogAdmin(req, res, config);
    if (!adminSession) return;
    if (req.method === "GET") {
      try {
        send(res, 200, JSON.stringify({ ok: true, products: readShopProducts() }), "application/json; charset=utf-8");
      } catch (error) {
        console.error("Shop-Katalog konnte nicht gelesen werden:", error.message);
        send(res, 500, JSON.stringify({ ok: false, message: "Der Produktkatalog konnte nicht gelesen werden." }), "application/json; charset=utf-8");
      }
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await readRequestBody(req, 256 * 1024));
    } catch (error) {
      send(res, 400, JSON.stringify({ ok: false, message: "Ungültige oder zu große Produktdaten." }), "application/json; charset=utf-8");
      return;
    }
    const validation = validateShopProducts(payload?.products);
    if (validation.error) {
      send(res, 400, JSON.stringify({ ok: false, message: validation.error }), "application/json; charset=utf-8");
      return;
    }
    let previousProducts;
    try {
      previousProducts = readShopProducts();
    } catch (error) {
      console.error("Vorheriger Shop-Katalog konnte nicht gelesen werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Der aktuelle Produktkatalog konnte nicht gelesen werden." }), "application/json; charset=utf-8");
      return;
    }
    try {
      saveShopProducts(validation.products);
    } catch (error) {
      console.error("Shop-Katalog konnte nicht gespeichert werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Der Produktkatalog konnte nicht gespeichert werden." }), "application/json; charset=utf-8");
      return;
    }
    const changes = describeCatalogChanges(previousProducts, validation.products);
    let auditLogged = false;
    let auditChangeCount = changes.length;
    let warning = "";
    try {
      if (changes.length) {
        const pending = readPendingCatalogAudits();
        pending.push({
          id: crypto.randomUUID(),
          adminName: adminSession.discordName || adminSession.username || "Unbekannt",
          userId: adminSession.userId,
          timestamp: new Date().toISOString(),
          changes
        });
        savePendingCatalogAudits(pending);
      }
      const auditResult = await flushPendingCatalogAudits();
      auditLogged = auditResult.ok;
      auditChangeCount = auditResult.changeCount || changes.length;
      if (!auditLogged) warning = "Änderung gespeichert und zum Audit vorgemerkt. Discord konnte das Protokoll gerade nicht annehmen; der Server versucht es automatisch erneut.";
    } catch (error) {
      warning = "Änderung gespeichert, aber das Audit konnte nicht dauerhaft vorgemerkt werden. Bitte Serverprotokoll und Speicherplatz prüfen.";
      console.error(`Shop-Katalog gespeichert, Audit konnte nicht vorgemerkt werden (${changes.length} Änderung(en)) für Channel ${CATALOG_AUDIT_CHANNEL_ID}:`, error.message);
    }
    send(res, 200, JSON.stringify({
      ok: true,
      products: validation.products,
      auditLogged,
      auditChangeCount,
      warning
    }), "application/json; charset=utf-8");
    return;
  }
  if ((req.method === "GET" || req.method === "PUT") && pathname === "/api/admin/buyback-products") {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/buyback");
    if (!adminSession) return;
    if (req.method === "GET") {
      try {
        send(res, 200, JSON.stringify({ ok: true, products: readBuybackProducts() }), "application/json; charset=utf-8");
      } catch (error) {
        console.error("Ankauf-Preisliste konnte nicht gelesen werden:", error.message);
        send(res, 500, JSON.stringify({ ok: false, message: "Die Ankauf-Preisliste konnte nicht gelesen werden." }), "application/json; charset=utf-8");
      }
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await readRequestBody(req, 64 * 1024));
    } catch {
      send(res, 400, JSON.stringify({ ok: false, message: "Ungültige oder zu große Produktdaten." }), "application/json; charset=utf-8");
      return;
    }
    const validation = validateBuybackProducts(payload?.products);
    if (validation.error) {
      send(res, 400, JSON.stringify({ ok: false, message: validation.error }), "application/json; charset=utf-8");
      return;
    }
    try {
      saveBuybackProducts(validation.products);
      send(res, 200, JSON.stringify({ ok: true, products: validation.products }), "application/json; charset=utf-8");
    } catch (error) {
      console.error("Ankauf-Preisliste konnte nicht gespeichert werden:", error.message);
      send(res, 500, JSON.stringify({ ok: false, message: "Die Ankauf-Preisliste konnte nicht gespeichert werden." }), "application/json; charset=utf-8");
    }
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Methode nicht erlaubt");
    return;
  }
  if (pathname === "/livez") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (pathname === "/healthz") {
    const report = getHealthReport();
    sendJson(res, report.status === "ok" ? 200 : 503, report);
    return;
  }
  if (pathname === "/login") {
    const title = url.searchParams.get("admin") === "1" ? "Admin Panel" : "Produktionsrechner";
    send(res, 200, loginPage(url.searchParams.get("error") || "", title), "text/html; charset=utf-8");
    return;
  }
  if (pathname === "/auth/discord") {
    await beginLogin(req, res, config);
    return;
  }
  if (pathname === "/auth/callback") {
    await finishLogin(req, res, url, config);
    return;
  }
  if (pathname === "/logout") {
    const id = cookies(req).olymp_session;
    if (id) sessions.delete(id);
    clearCookie(res, "olymp_session");
    redirect(res, "/login");
    return;
  }
  if (pathname === "/admin/catalog" || pathname === "/admin/catalog.js") {
    const adminSession = await requireCatalogAdmin(req, res, config);
    if (!adminSession) return;
    serveStatic(req, res, pathname);
    return;
  }
  if (pathname === "/admin/buyback" || pathname === "/admin/buyback.js") {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/buyback");
    if (!adminSession) return;
    serveStatic(req, res, pathname);
    return;
  }
  if (pathname === "/admin/orders" || pathname === "/admin/orders.js") {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/orders");
    if (!adminSession) return;
    serveStatic(req, res, pathname);
    return;
  }
  if (pathname === "/admin/accounting" || pathname === "/admin/accounting.js") {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/accounting");
    if (!adminSession) return;
    serveStatic(req, res, pathname);
    return;
  }
  if (pathname === "/admin/coupons" || pathname === "/admin/coupons.js") {
    const adminSession = await requireCatalogAdmin(req, res, config, "/admin/coupons");
    if (!adminSession) return;
    serveStatic(req, res, pathname);
    return;
  }
  if (pathname === "/" || pathname === "/index.html" || pathname === "/ankauf.html" || pathname === "/ankauf.js" || pathname === "/material-ankauf.html" || pathname === "/material-ankauf.js" || pathname === "/stank-kauf.html" || pathname === "/stank-kauf.js" || pathname === "/freie-bestellung.html" || pathname === "/freie-bestellung.js" || pathname === "/theme.css" || pathname === "/shop.css" || pathname === "/forms.css" || pathname === "/bg.js" || pathname.startsWith("/img/")) {
    serveStatic(req, res, pathname === "/index.html" ? "/index.html" : pathname);
    return;
  }
  if (!staticFile(pathname)) {
    send(res, 404, "Nicht gefunden");
    return;
  }
  if (!configIsReady(config)) {
    redirect(res, "/login?error=setup");
    return;
  }
  let session;
  try {
    session = await authorizedSession(req, config);
  } catch (error) {
    console.error("Discord-Rollenprüfung fehlgeschlagen:", error.message);
    send(res, 502, "Die Discord-Rollenprüfung ist momentan nicht erreichbar.");
    return;
  }
  if (!session) {
    redirect(res, "/login");
    return;
  }
  serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error("HTTP-Anfrage fehlgeschlagen:", error.message);
    if (!res.headersSent) send(res, 500, "Interner Fehler");
    else res.destroy();
  });
});

function startDiscordWelcomeBot() {
  const config = discordConfig();
  if (!config.botToken || !/^\d{17,20}$/.test(config.guildId)) {
    console.warn("Discord-Willkommensbot nicht gestartet: Bot-Token oder Server-ID fehlt.");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      ...(process.env.DISCORD_MESSAGE_CONTENT_INTENT === "true"
        ? [GatewayIntentBits.MessageContent]
        : [])
    ]
  });
  if (process.env.DISCORD_MESSAGE_CONTENT_INTENT !== "true") {
    console.warn("Discord Message Content Intent ist deaktiviert; Tickettranskripte enthalten keine Nachrichtentexte. Zum Aktivieren DISCORD_MESSAGE_CONTENT_INTENT=true setzen und den Intent im Developer Portal freischalten.");
  }
  discordGatewayClient = client;
  client.once(Events.ClientReady, readyClient => {
    console.log(`Discord-Willkommensbot verbunden als ${readyClient.user.tag}.`);
    registerNewFamilyCommand(readyClient, config.guildId).then(() => {
      console.log("Discord-Slash-Commands für Familienverwaltung, Ticketsystem, Buchhaltung und Status sind registriert.");
    }).catch(error => {
      console.error("Discord-Slash-Commands konnten nicht registriert werden:", error.message);
    });
  });
  client.on(Events.Error, error => {
    console.error("Discord-Willkommensbot-Verbindung fehlgeschlagen:", error.message);
  });
  client.on(Events.InteractionCreate, interaction => {
    const isNewFamilyCommand = interaction.isChatInputCommand() && interaction.commandName === "newfam";
    const isDeleteFamilyCommand = interaction.isChatInputCommand() && interaction.commandName === "delfam";
    const isFamilyManagementCommand = interaction.isChatInputCommand()
      && [
        "listfam", "famcheck", "faminfo", "famadd", "famremove", "famrename", "famrolle",
        "famuebersicht", "famfarbe", "famtopic", "famaktivitaet", "famexport", "famaudit"
      ].includes(interaction.commandName);
    const isFamilyApplicationCommand = interaction.isChatInputCommand() && interaction.commandName === "fambeitritt";
    const isFamilyApplicationButton = interaction.isButton() && interaction.customId.startsWith("famapply:");
    const isTicketSetupCommand = interaction.isChatInputCommand() && interaction.commandName === "ticketeinrichten";
    const isTicketSelect = interaction.isStringSelectMenu() && interaction.customId === "ticket:types";
    const isTicketCloseButton = interaction.isButton() && interaction.customId === "ticket:close";
    const isManualBookingCommand = interaction.isChatInputCommand() && interaction.commandName === "buchung";
    const isCashCommand = interaction.isChatInputCommand() && interaction.commandName === "kasse";
    const isVoidCommand = interaction.isChatInputCommand() && interaction.commandName === "storno";
    const isLivenessCommand = interaction.isChatInputCommand() && interaction.commandName === "livez";
    const isHealthCommand = interaction.isChatInputCommand() && interaction.commandName === "healthz";
    const handleInteraction = isNewFamilyCommand
      ? handleNewFamilyInteraction(interaction)
      : isDeleteFamilyCommand
        ? handleDeleteFamilyInteraction(interaction)
      : isFamilyApplicationCommand
        ? handleFamilyApplicationInteraction(interaction)
      : isFamilyApplicationButton
        ? handleFamilyApplicationButton(interaction)
      : isTicketSetupCommand
        ? handleTicketSetupInteraction(interaction)
      : isTicketSelect
        ? handleTicketSelectInteraction(interaction)
      : isTicketCloseButton
        ? handleTicketCloseInteraction(interaction)
      : isFamilyManagementCommand
        ? handleFamilyManagementInteraction(interaction)
      : isManualBookingCommand
        ? handleManualBookingInteraction(interaction)
        : isCashCommand
          ? handleCashInteraction(interaction)
          : isVoidCommand
            ? handleVoidInteraction(interaction)
            : isLivenessCommand || isHealthCommand
              ? handleHealthCommandInteraction(interaction)
        : handleGatewayOrderInteraction(interaction);
    handleInteraction.catch(error => {
      const isSlashCommand = isNewFamilyCommand || isDeleteFamilyCommand || isFamilyManagementCommand
        || isFamilyApplicationCommand || isTicketSetupCommand || isManualBookingCommand || isCashCommand
        || isVoidCommand || isLivenessCommand || isHealthCommand;
      const context = isSlashCommand ? "Discord-Slash-Command fehlgeschlagen" : "Discord-Button-Interaktion fehlgeschlagen";
      console.error(`${context}:`, error.message);
      if (interaction.isRepliable() && !interaction.replied) {
        const content = isNewFamilyCommand
          ? `Die Familieneinrichtung ist fehlgeschlagen: ${error.message}`
          : isDeleteFamilyCommand
            ? `Die Familie konnte nicht vollständig gelöscht werden: ${error.message}`
          : isFamilyManagementCommand
            ? `Familienbefehl fehlgeschlagen: ${error.message}`
          : isManualBookingCommand
            ? `Buchung fehlgeschlagen: ${error.message}`
            : isCashCommand
              ? `Kasse fehlgeschlagen: ${error.message}`
              : isVoidCommand
                ? `Storno/Korrektur fehlgeschlagen: ${error.message}`
            : "Der Bot konnte diese Bestellaktion nicht verarbeiten. Bitte die Bestellübersicht öffnen oder den Server-Admin informieren.";
        const reply = isSlashCommand
          ? (interaction.deferred ? interaction.editReply({ content }) : interaction.reply({ content, ephemeral: true }))
          : (interaction.deferred
            ? interaction.followUp({ content, ephemeral: true })
            : interaction.reply({ content, ephemeral: true }));
        reply.catch(replyError => {
          console.error("Discord-Fehlerantwort konnte nicht gesendet werden:", replyError.message);
        });
      }
    });
  });
  client.on(Events.GuildMemberAdd, async member => {
    if (member.guild.id !== config.guildId) return;

    try {
      await member.roles.add(UNVERIFIED_ROLE_ID, "Neue Mitglieder erhalten automatisch die Unverified-Rolle.");
      const channel = await client.channels.fetch(WELCOME_CHANNEL_ID);
      if (!channel?.isTextBased() || !channel.send) {
        throw new Error("Der konfigurierte Willkommenskanal ist nicht beschreibbar.");
      }

      const attachment = new AttachmentBuilder(path.join(ROOT, "img", "willkommen.png"), { name: "willkommen.png" });
      const embed = new EmbedBuilder()
        .setColor(0x3976d2)
        .setTitle(`Willkommen auf ${member.guild.name}!`)
        .setDescription(`Hallo <@${member.id}>! Du hast automatisch die Unverified-Rolle erhalten. Bitte folge den Hinweisen auf dem Server.`)
        .setImage("attachment://willkommen.png")
        .setFooter({ text: "OLYMP • Willkommen" })
        .setTimestamp();

      await channel.send({
        embeds: [embed],
        files: [attachment],
        allowedMentions: { users: [member.id] }
      });
    } catch (error) {
      console.error(`Willkommensablauf für ${member.id} fehlgeschlagen:`, error.message);
    }
  });
  client.login(config.botToken).catch(error => {
    console.error("Discord-Willkommensbot konnte sich nicht verbinden:", error.message);
  });
}

setInterval(() => {
  void runDailyAccountingReport();
}, 60 * 1000);

setInterval(retryPendingOrderDeliveries, 30 * 1000);
setInterval(runDailyDataBackup, 60 * 60 * 1000);

server.listen(PORT, HOST, () => {
  console.log(`Olymp Rechner läuft auf http://${HOST}:${PORT}`);
  if (!configIsReady(discordConfig())) console.log("Discord OAuth ist noch nicht konfiguriert. Bitte .env ausfüllen.");
  startDiscordWelcomeBot();
  try {
    const syncedOrders = accountingLedger.syncAllOrders(readAdminOrders());
    if (syncedOrders) console.log(`${syncedOrders} bestehende Bestellung(en) in die Buchhaltung übernommen.`);
  } catch (error) {
    console.error("Bestehende Bestellungen konnten nicht mit der Buchhaltung synchronisiert werden:", error.message);
  }
  retryPendingOrderDeliveries();
  void runDailyAccountingReport();
  runDailyDataBackup();
});
