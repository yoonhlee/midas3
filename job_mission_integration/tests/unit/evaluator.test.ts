import { test } from "node:test";
import assert from "node:assert/strict";
import { supportsTemperature } from "../../src/lib/evaluator/evaluateAnswer.js";

test("gpt-5·o 계열에는 temperature를 보내지 않는다", () => {
  for (const model of ["gpt-5-nano", "gpt-5.4-nano", "GPT-5", "o3-mini", "o4-mini"]) assert.equal(supportsTemperature(model), false, model);
  for (const model of ["gpt-4o-mini", "gpt-4.1"]) assert.equal(supportsTemperature(model), true, model);
});
