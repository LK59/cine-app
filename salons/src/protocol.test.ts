import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanName, parseClientMessage, SHARED_OBJECTS } from "./protocol.ts";

test("les messages reconnus", () => {
  assert.deepEqual(parseClientMessage('{"t":"ping","c":12.5}'), { t: "ping", c: 12.5 });
  assert.deepEqual(parseClientMessage('{"t":"create","visibility":"private","name":"  Ciné\\n  du soir "}'), { t: "create", visibility: "private", name: "Ciné du soir" });
  assert.deepEqual(parseClientMessage('{"t":"join","code":"abc234"}'), { t: "join", code: "ABC234" });
  assert.deepEqual(parseClientMessage('{"t":"set","key":"feu","value":true}'), { t: "set", key: "feu", value: true });
});

test("le reste est illisible", () => {
  for (const raw of ["", "nul", "[]", '{"t":"inconnu"}', '{"t":"ping"}', '{"t":"create","visibility":"secret"}', '{"t":"join","code":"ABC"}', '{"t":"join","code":"ABCD0O"}', '{"t":"set","key":"feu"}']) {
    assert.equal(parseClientMessage(raw), null, raw);
  }
});

test("un nom : texte brut, sans caractères de contrôle, borné", () => {
  assert.equal(cleanName("a\u0000b‮c  d", 40), "abc d");
  assert.equal(cleanName("x".repeat(100), 40).length, 40);
  assert.equal(cleanName(42, 40), "");
});

test("les objets partagés n'acceptent que leur forme", () => {
  assert.equal(SHARED_OBJECTS.feu(true), true);
  assert.equal(SHARED_OBJECTS.feu("oui"), false);
  assert.equal(SHARED_OBJECTS.musique({ on: true, track: 1, since: 1000 }), true);
  assert.equal(SHARED_OBJECTS.musique({ on: true, track: 99, since: 1000 }), false);
  assert.equal(SHARED_OBJECTS.musique({ on: true }), false);
});
