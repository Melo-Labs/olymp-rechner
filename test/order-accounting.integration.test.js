"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

function berlinDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output.join("")}`);
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Server did not start in time: ${output.join("")}`);
}

async function waitFor(predicate, message, diagnostics = () => "") {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${message} ${diagnostics()}`);
}

test("completes discounted order through signed status changes and ledger rollback", { timeout: 30_000 }, async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "olymp-order-flow-"));
  const dataDirectory = path.join(temporaryDirectory, "data");
  const archiveDirectory = path.join(temporaryDirectory, "order-archives");
  const backupDirectory = path.join(temporaryDirectory, "backups");
  fs.mkdirSync(dataDirectory, { recursive: true });

  const files = {
    orders: path.join(dataDirectory, "admin-orders.json"),
    coupons: path.join(dataDirectory, "coupons.json"),
    products: path.join(dataDirectory, "products.json"),
    audit: path.join(dataDirectory, "audit.json"),
    ledger: path.join(dataDirectory, "ledger.json"),
    reports: path.join(dataDirectory, "reports.json")
  };
  fs.writeFileSync(files.orders, "[]");
  fs.writeFileSync(files.coupons, JSON.stringify([{
    id: "c067bd27-34b8-4a56-a49e-963f7a4aa70c",
    code: "FLOW10",
    percent: 10,
    maxUses: 1,
    active: true,
    createdAt: new Date().toISOString(),
    createdBy: "Integrationtest"
  }]));
  fs.writeFileSync(files.products, "[]");
  fs.writeFileSync(files.audit, "[]");
  fs.writeFileSync(files.ledger, "[]");
  fs.writeFileSync(files.reports, JSON.stringify({
    startedOn: berlinDateKey(),
    sentDates: [],
    sentWeeks: [],
    sentMonths: []
  }));

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DISCORD_BOT_TOKEN: "",
      DISCORD_ORDER_WEBHOOK_URL: "",
      DISCORD_GUILD_ID: "22222222222222222",
      DISCORD_CATALOG_ADMIN_ROLE_ID: "11111111111111111",
      DISCORD_PUBLIC_KEY: publicKeyHex,
      ADMIN_ORDERS_FILE: files.orders,
      SHOP_COUPONS_FILE: files.coupons,
      CATALOG_FILE: files.products,
      CATALOG_AUDIT_PENDING_FILE: files.audit,
      ACCOUNTING_LEDGER_FILE: files.ledger,
      ACCOUNTING_REPORTS_FILE: files.reports,
      LOCAL_ORDER_LOG_DIR: archiveDirectory,
      DATA_BACKUP_DIR: backupDirectory
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  child.stdout.on("data", chunk => output.push(chunk.toString()));
  child.stderr.on("data", chunk => output.push(chunk.toString()));

  try {
    await waitForServer(baseUrl, child, output);
    await waitFor(() => fs.readdirSync(backupDirectory).some(name => name.startsWith("backup-")), "Startup backup was not created.");

    const livenessResponse = await fetch(`${baseUrl}/livez`);
    assert.equal(livenessResponse.status, 200);
    assert.deepEqual(await livenessResponse.json(), { status: "ok" });

    const initialHealthResponse = await fetch(`${baseUrl}/healthz`);
    assert.equal(initialHealthResponse.status, 503);
    const initialHealth = await initialHealthResponse.json();
    assert.equal(initialHealth.status, "degraded");
    assert.deepEqual(initialHealth.checks, {
      discord: "unavailable",
      storage: "ok",
      orders: "ok"
    });

    const orderResponse = await fetch(`${baseUrl}/api/material-bestellung`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        technical: 1,
        medical: 0,
        icName: "Testkunde",
        phone: "555-0100",
        couponCode: "FLOW10"
      })
    });
    const orderResult = await orderResponse.json();
    assert.equal(orderResponse.status, 202);
    assert.equal(orderResult.subtotal, 250);
    assert.equal(orderResult.discountAmount, 25);
    assert.equal(orderResult.total, 225);
    assert.equal(orderResult.savedLocally, true);
    assert.equal(orderResult.deliveryStatus, "pending");
    assert.match(orderResult.message, /Discord-Bot-Konfiguration fehlt/);

    const orders = JSON.parse(fs.readFileSync(files.orders, "utf8"));
    assert.equal(orders.length, 1);
    const orderId = orders[0].id;
    assert.equal(orders[0].totalPrice, 225);
    await waitFor(() => {
      const currentOrder = JSON.parse(fs.readFileSync(files.orders, "utf8"))[0];
      return currentOrder.deliveryStatus === "local-only"
        && fs.existsSync(path.join(archiveDirectory, "material-bestellungen.json"));
    }, "Order delivery did not finish in the background.");
    const localOrderCopy = JSON.parse(fs.readFileSync(path.join(archiveDirectory, "material-bestellungen.json"), "utf8"));
    assert.equal(localOrderCopy[0].id, orderId);
    const orderHealthResponse = await fetch(`${baseUrl}/healthz`);
    assert.equal(orderHealthResponse.status, 503);
    assert.equal((await orderHealthResponse.json()).checks.orders, "degraded");

    const exhaustedCouponResponse = await fetch(`${baseUrl}/api/material-bestellung`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        technical: 1,
        medical: 0,
        icName: "Zweiter Kunde",
        phone: "555-0101",
        couponCode: "FLOW10"
      })
    });
    assert.equal(exhaustedCouponResponse.status, 400);
    assert.equal(JSON.parse(fs.readFileSync(files.orders, "utf8")).length, 1);

    async function changeStatus(statusKey, roles = ["11111111111111111"]) {
      const actorName = `Integration-${statusKey}-${crypto.randomUUID().slice(0, 8)}`;
      const payload = {
        type: 3,
        guild_id: "22222222222222222",
        member: {
          roles,
          user: { username: actorName }
        },
        data: {
          component_type: 2,
          custom_id: `order_status:${orderId}:${statusKey}`
        },
        message: { id: "" }
      };
      const body = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto.sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
      const response = await fetch(`${baseUrl}/api/discord-interactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-signature-ed25519": signature,
          "x-signature-timestamp": timestamp
        },
        body
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { type: 6 });
      return actorName;
    }

    await changeStatus("accepted", []);
    assert.equal(JSON.parse(fs.readFileSync(files.orders, "utf8"))[0].status, "Neu");

    const acceptedBy = await changeStatus("accepted");
    await waitFor(() => {
      const currentOrders = JSON.parse(fs.readFileSync(files.orders, "utf8"));
      const entries = JSON.parse(fs.readFileSync(files.ledger, "utf8"));
      return currentOrders[0].status === "Angenommen"
        && currentOrders[0].updatedBy === acceptedBy
        && entries.length === 1;
    }, "Accepted order was not synchronized to the ledger.");

    let ledgerEntries = JSON.parse(fs.readFileSync(files.ledger, "utf8"));
    assert.equal(ledgerEntries[0].amount, 225);
    assert.equal(ledgerEntries[0].kind, "income");
    assert.equal(ledgerEntries[0].category, "material");

    const repeatedAcceptanceBy = await changeStatus("accepted");
    await waitFor(() => {
      const currentOrder = JSON.parse(fs.readFileSync(files.orders, "utf8"))[0];
      return currentOrder.status === "Angenommen" && currentOrder.updatedBy === repeatedAcceptanceBy;
    }, "Repeated status update was not processed.", () => JSON.stringify({
      order: JSON.parse(fs.readFileSync(files.orders, "utf8"))[0],
      ledger: JSON.parse(fs.readFileSync(files.ledger, "utf8")),
      logs: output.join("")
    }));
    ledgerEntries = JSON.parse(fs.readFileSync(files.ledger, "utf8"));
    assert.equal(ledgerEntries.length, 1);

    const rejectedBy = await changeStatus("rejected");
    await waitFor(() => {
      const currentOrders = JSON.parse(fs.readFileSync(files.orders, "utf8"));
      const entries = JSON.parse(fs.readFileSync(files.ledger, "utf8"));
      return currentOrders[0].status === "Abgelehnt"
        && currentOrders[0].updatedBy === rejectedBy
        && Boolean(entries[0].voided);
    }, "Rejected order was not voided in the ledger.");
    ledgerEntries = JSON.parse(fs.readFileSync(files.ledger, "utf8"));
    assert.equal(ledgerEntries[0].voided.action, "voided");

    const damagedArchiveContent = "";
    fs.writeFileSync(path.join(archiveDirectory, "material-bestellungen.json"), damagedArchiveContent);
    const archiveFailureResponse = await fetch(`${baseUrl}/api/material-bestellung`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        technical: 1,
        medical: 0,
        icName: "Archivtest",
        phone: "555-0102"
      })
    });
    const archiveFailureResult = await archiveFailureResponse.json();
    assert.equal(archiveFailureResponse.status, 202);
    assert.equal(archiveFailureResult.deliveryStatus, "pending");
    await waitFor(
      () => output.join("").toLowerCase().includes("zusätzliche lokale archivkopie"),
      "Archive failure was not reported.",
      () => output.join("")
    );
    assert.equal(fs.readFileSync(path.join(archiveDirectory, "material-bestellungen.json"), "utf8"), damagedArchiveContent);
    assert.equal(JSON.parse(fs.readFileSync(files.orders, "utf8")).length, 2);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once("close", resolve));
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
