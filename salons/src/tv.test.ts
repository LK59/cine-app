import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLook, SharedTv, START_LEAD_MS } from "./tv.ts";

test("préparer, attendre tous les présents, partir ensemble ; la position avance avec le temps", () => {
  const tv = new SharedTv("item", "Film", 30, 0);
  assert.equal(tv.phase, "preparing");
  assert.equal(tv.markReady("a", tv.epoch, ["a", "b"]), false);
  assert.equal(tv.markReady("b", tv.epoch - 1, ["a", "b"]), false, "un « prêt » d'une préparation passée ne compte pas");
  assert.equal(tv.markReady("b", tv.epoch, ["a", "b"]), true);
  tv.start(1000);
  assert.equal(tv.anchor, 1000 + START_LEAD_MS);
  assert.equal(tv.positionAt(1000 + START_LEAD_MS + 10_000), 40);
});

test("pause : la position se fige ; reprendre rouvre une préparation à cette position", () => {
  const tv = new SharedTv("item", "Film", 0, 0);
  tv.start(0);
  tv.pause(START_LEAD_MS + 5000);
  assert.equal(tv.phase, "paused");
  assert.equal(tv.positionAt(999_999), 5);
  const epoch = tv.epoch;
  tv.prepare(tv.position, 20_000);
  assert.equal(tv.phase, "preparing");
  assert.equal(tv.epoch, epoch + 1);
  assert.equal(tv.view().ready.length, 0);
});

test("une apparence : quatre entiers dans leurs bornes, rien d'autre", () => {
  assert.deepEqual(parseLook([3, 1, -1, 1]), [3, 1, -1, 1]);
  for (const bad of [[3, 1, -1], [10, 0, 0, 0], [0, 4, 0, 0], [0, 0, -2, 0], [0, 0, 0, 2], [0.5, 0, 0, 0], "rouge"]) assert.equal(parseLook(bad), null);
});
