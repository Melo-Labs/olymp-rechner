"use strict";

const fs = require("node:fs");
const { ChannelType, PermissionFlagsBits } = require("discord.js");
const { writeJsonAtomically } = require("./json-store");

const LOCKED_PERMISSIONS = [
  ["SendMessages", PermissionFlagsBits.SendMessages],
  ["SendMessagesInThreads", PermissionFlagsBits.SendMessagesInThreads]
];
const TEXT_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

function readLockdownState(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (state?.version !== 1 || typeof state.guildId !== "string" || !Array.isArray(state.channels)) {
    throw new Error("Die gespeicherte Lockdown-Konfiguration ist ungültig. Bitte nicht manuell löschen.");
  }
  return state;
}

function permissionState(overwrite, permission) {
  if (!overwrite) return "inherit";
  if (overwrite.allow.has(permission)) return "allow";
  if (overwrite.deny.has(permission)) return "deny";
  return "inherit";
}

function permissionValue(state) {
  if (state === "allow") return true;
  if (state === "deny") return false;
  return null;
}

function lockdownChannels(guild) {
  return [...guild.channels.cache.values()]
    .filter(channel => TEXT_CHANNEL_TYPES.has(channel.type));
}

function assertCanManageChannels(guild, channels) {
  if (!guild.members.me) throw new Error("Die Bot-Mitgliedschaft konnte nicht geladen werden.");
  const inaccessible = channels.find(channel =>
    !channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageChannels)
  );
  if (inaccessible) {
    throw new Error(`Dem Bot fehlt „Kanäle verwalten“ in #${inaccessible.name}; es wurde nichts geändert.`);
  }
}

async function activateLockdown(guild, filePath) {
  const existingState = readLockdownState(filePath);
  if (existingState) {
    throw new Error("Der Lockdown ist bereits aktiv. Zum Wiederherstellen /lockdown aktion:aufheben verwenden.");
  }

  const channels = lockdownChannels(guild);
  if (channels.length === 0) throw new Error("Auf diesem Server wurden keine Text- oder Ankündigungskanäle gefunden.");
  assertCanManageChannels(guild, channels);

  const everyoneId = guild.roles.everyone.id;
  const state = {
    version: 1,
    guildId: guild.id,
    channels: channels.map(channel => {
      const overwrites = [...channel.permissionOverwrites.cache.values()];
      if (!overwrites.some(overwrite => overwrite.id === everyoneId)) {
        overwrites.push({ id: everyoneId, allow: { has: () => false }, deny: { has: () => false } });
      }
      return {
        id: channel.id,
        overwrites: overwrites.map(overwrite => ({
          id: overwrite.id,
          hadOverwrite: channel.permissionOverwrites.cache.has(overwrite.id),
          permissions: Object.fromEntries(LOCKED_PERMISSIONS.map(([name, flag]) => [
            name,
            permissionState(overwrite, flag)
          ]))
        }))
      };
    })
  };
  writeJsonAtomically(filePath, state);

  let locked = 0;
  try {
    for (const channel of channels) {
      const snapshot = state.channels.find(entry => entry.id === channel.id);
      for (const overwrite of snapshot.overwrites) {
        await channel.permissionOverwrites.edit(overwrite.id, {
          SendMessages: false,
          SendMessagesInThreads: false
        }, "Temporärer, durch Admin bestätigter Server-Lockdown");
      }
      locked++;
    }
  } catch (error) {
    throw new Error(
      `Lockdown nur teilweise angewendet (${locked}/${channels.length} Kanäle). ` +
      "Der gespeicherte Zustand bleibt erhalten; /lockdown aktion:aufheben stellt die Berechtigungen wieder her. " +
      `Discord-Fehler: ${error.message}`
    );
  }
  return locked;
}

async function restoreLockdown(guild, filePath) {
  const state = readLockdownState(filePath);
  if (!state) throw new Error("Es ist kein aktiver Lockdown gespeichert.");
  if (state.guildId !== guild.id) throw new Error("Der gespeicherte Lockdown gehört zu einem anderen Server.");

  const channels = lockdownChannels(guild);
  const snapshots = new Map(state.channels.map(snapshot => [snapshot.id, snapshot]));
  const affectedChannels = channels.filter(channel => snapshots.has(channel.id));
  assertCanManageChannels(guild, affectedChannels);

  const everyoneId = guild.roles.everyone.id;
  let restored = 0;
  for (const channel of affectedChannels) {
    const snapshot = snapshots.get(channel.id);
    for (const savedOverwrite of snapshot.overwrites) {
      await channel.permissionOverwrites.edit(savedOverwrite.id, {
        SendMessages: permissionValue(savedOverwrite.permissions?.SendMessages),
        SendMessagesInThreads: permissionValue(savedOverwrite.permissions?.SendMessagesInThreads)
      }, "Lockdown aufgehoben; ursprüngliche Schreibrechte wiederhergestellt");

      if (!savedOverwrite.hadOverwrite) {
        const overwrite = channel.permissionOverwrites.cache.get(savedOverwrite.id);
        if (overwrite && overwrite.allow.bitfield === 0n && overwrite.deny.bitfield === 0n) {
          await overwrite.delete("Leeren Permission-Overwrite nach Lockdown-Wiederherstellung entfernen");
        }
      }
    }
    restored++;
  }

  fs.unlinkSync(filePath);
  return restored;
}

module.exports = { activateLockdown, restoreLockdown };
