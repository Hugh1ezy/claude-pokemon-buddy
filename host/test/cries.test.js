import { test } from "node:test";
import assert from "node:assert/strict";

import { CRIES, cryFor, EEVEE_IDLE_CRY } from "../src/pet/cries.js";

test("Eevee idle cry is species themed", () => {
  assert.equal(EEVEE_IDLE_CRY, "Bui!");
});

test("EEVEE_IDLE_CRY tracks CRIES.eevee", () => {
  assert.equal(EEVEE_IDLE_CRY, CRIES.eevee);
});

test("cryFor returns the species-specific cry", () => {
  assert.equal(cryFor("bulbasaur"), "Dane!");
  assert.equal(cryFor("eevee"), "Bui!");
  assert.equal(cryFor("charizard"), "Gaoo!");
});

test("cryFor falls back to a neutral note for unknown species", () => {
  assert.equal(cryFor("不存在"), "♪");
  assert.equal(cryFor(undefined), "♪");
});

test("cryFor returns happy/strained variants by mood", () => {
  assert.equal(cryFor("eevee", "happy"), "Bui♪");
  assert.equal(cryFor("eevee", "strained"), "bui…");
  assert.equal(cryFor("charmander", "happy"), "Kage♪");
});

test("cryFor maps fainted/shocked to strained, focused to idle", () => {
  assert.equal(cryFor("vaporeon", "fainted"), "shawa…");
  assert.equal(cryFor("vaporeon", "shocked"), "shawa…");
  assert.equal(cryFor("vaporeon", "focused"), "Shawa!");
  assert.equal(cryFor("vaporeon"), "Shawa!"); // 无 mood -> idle
});

test("cries are Japanese-name syllables: X! / X♪ / x…", () => {
  assert.equal(cryFor("poliwag"), "Nyoro!");
  assert.equal(cryFor("poliwag", "happy"), "Nyoro♪");
  assert.equal(cryFor("poliwag", "strained"), "nyoro…");
});

test("cryFor unknown species still falls back to ♪ regardless of mood", () => {
  assert.equal(cryFor("不存在", "happy"), "♪");
});
