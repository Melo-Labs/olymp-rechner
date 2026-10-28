"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { writeJsonAtomically } = require("./json-store");

const MAX_AMOUNT = 1_000_000_000;
const MAX_BALANCE = 1_000_000_000_000;
const MAX_TRANSACTIONS = 500;

function createFamilyTreasury(file) {
  function read() {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
    if (Array.isArray(value) && value.length === 0) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Die Datei der Familienkassen ist ungültig.");
    }
    return value;
  }

  function getAccount(key) {
    const account = read()[key];
    return account
      ? { name: account.name, balance: account.balance, transactions: account.transactions }
      : { name: "", balance: 0, transactions: [] };
  }

  function book(key, name, type, amount, description, actor) {
    if (!key) throw new Error("Ungültige Familie.");
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
      throw new Error("Der Betrag muss eine ganze Zahl zwischen 1 und 1.000.000.000 sein.");
    }
    const accounts = read();
    const account = accounts[key] || { name, balance: 0, transactions: [] };
    const balance = type === "deposit" ? account.balance + amount : account.balance - amount;
    if (balance < 0) throw new Error(`Die Familienkasse reicht nicht aus. Aktueller Stand: ${account.balance.toLocaleString("de-DE")} $.`);
    if (balance > MAX_BALANCE) throw new Error("Die Familienkasse darf höchstens 1.000.000.000.000 $ enthalten.");
    const transaction = {
      id: crypto.randomUUID(),
      type,
      amount,
      description: String(description || "").trim().slice(0, 100),
      actorId: String(actor?.id || ""),
      actorName: String(actor?.name || "").slice(0, 80),
      timestamp: new Date().toISOString(),
      balanceAfter: balance
    };
    accounts[key] = {
      name,
      balance,
      transactions: [transaction, ...account.transactions].slice(0, MAX_TRANSACTIONS)
    };
    writeJsonAtomically(file, accounts);
    return { balance, transaction };
  }

  function deposit(key, name, amount, description, actor) {
    return book(key, name, "deposit", amount, description, actor);
  }

  function withdraw(key, name, amount, description, actor) {
    return book(key, name, "withdrawal", amount, description, actor);
  }

  function remove(key) {
    const accounts = read();
    const account = accounts[key];
    if (!account) return null;
    delete accounts[key];
    writeJsonAtomically(file, accounts);
    return account;
  }

  function rename(oldKey, newKey, newName) {
    const accounts = read();
    const account = accounts[oldKey];
    if (!account) return false;
    if (newKey !== oldKey && accounts[newKey]) {
      throw new Error("Für den neuen Familiennamen existiert bereits eine Familienkasse.");
    }
    delete accounts[oldKey];
    accounts[newKey] = { ...account, name: newName };
    writeJsonAtomically(file, accounts);
    return true;
  }

  return { deposit, getAccount, read, remove, rename, withdraw };
}

module.exports = { createFamilyTreasury };
