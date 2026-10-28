"use strict";

const FAMILY_RANKS = Object.freeze({
  boss: "Boss",
  unterboss: "Unterboss"
});
const ROLE_NAME_LIMIT = 100;

function familyRankRoleName(familyName, rank) {
  if (!Object.hasOwn(FAMILY_RANKS, rank)) throw new Error("Ungültiger Familienrang.");
  const name = `${String(familyName).trim()} | ${FAMILY_RANKS[rank]}`;
  if (name.length > ROLE_NAME_LIMIT) {
    throw new Error(`Der Familienname ist zu lang für Rangrollen (höchstens ${ROLE_NAME_LIMIT - FAMILY_RANKS.unterboss.length - 3} Zeichen).`);
  }
  return name;
}

module.exports = { FAMILY_RANKS, familyRankRoleName };
