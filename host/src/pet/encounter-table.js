// Runtime access to the encounter table. Split from encounter.js on purpose:
// that file is the mechanism and is meant to be read, this one reaches for the
// content, and the content is a surprise the owner asked to keep.
//
// Nothing here logs, prints, or summarises what it loaded. The table goes from
// the file straight into rollEncounter() and never passes through anything a
// human reads -- no "loaded N species", no error message quoting an entry. A
// crash report naming what was in the table would spoil it just as thoroughly
// as printing it on purpose.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ENCOUNTER_DEFAULTS } from "./encounter.js";

const TABLE_PATH = fileURLToPath(new URL("../../seed/encounters.json", import.meta.url));

let cached = null;

export function loadEncounterTable({ path = TABLE_PATH } = {}) {
  if (cached) return cached;
  cached = readTable(path);
  return cached;
}

// Tests and the simulator want a fresh read; the host wants one read for the
// life of the process.
export function resetEncounterTableCache() {
  cached = null;
}

function readTable(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // Deliberately not including the parse error: a JSON syntax message quotes
    // the offending text, which here is table content.
    throw new Error(`encounter table could not be read (${error.code ?? "invalid"})`);
  }

  if (!Array.isArray(parsed?.species) || parsed.species.length === 0) {
    throw new Error("encounter table has no species list");
  }

  return {
    species: parsed.species,
    caughtWeight: Number.isFinite(parsed.caughtWeight)
      ? parsed.caughtWeight
      : ENCOUNTER_DEFAULTS.caughtWeight,
  };
}
