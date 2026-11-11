import { test } from "node:test";
import assert from "node:assert/strict";
import { PASS_TEST_VECTOR, signPass, verifyPass } from "./pass.ts";

const { key, claims, token } = PASS_TEST_VECTOR;
const now = 1_800_000_000_000;

test("le vecteur partagé avec l'application : même jeton, même charge", () => {
  assert.equal(signPass(claims, key), token);
  assert.deepEqual(verifyPass(token, key, now), claims);
});

test("une signature fausse, une autre clé, une charge retouchée : refusés", () => {
  assert.equal(verifyPass(token.slice(0, -2) + "AA", key, now), null);
  assert.equal(verifyPass(token, key + "x", now), null);
  const [v, payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...claims, admin: true })).toString("base64url");
  assert.notEqual(forged, payload);
  assert.equal(verifyPass(`${v}.${forged}.${sig}`, key, now), null);
});

test("expiré : refusé", () => {
  assert.equal(verifyPass(token, key, claims.exp), null);
  assert.equal(verifyPass(token, key, claims.exp + 1), null);
});

test("n'importe quoi : refusé sans lever", () => {
  for (const bad of ["", "v1.", "v1..", "v2.abc.def", "v1.%%%.%%%", "x".repeat(5000)]) assert.equal(verifyPass(bad, key, now), null);
  // Signée, mais une charge qui n'est pas la bonne forme.
  assert.equal(verifyPass(signPass({ ...claims, sub: "" }, key), key, now), null);
});
