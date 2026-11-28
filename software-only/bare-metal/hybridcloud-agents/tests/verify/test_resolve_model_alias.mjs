// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Zero-dependency Node.js unit tests for llm-router-v1 resolve_model_alias.js.
// Run with: node --test tests/verify/test_resolve_model_alias.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(
  __dirname,
  "../../apigee/proxies/llm-router-v1/apiproxy/resources/jsc/resolve_model_alias.js"
);
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, "utf8");

function runPolicy(initialVars) {
  const vars = Object.assign(
    {
      "request.header.x-data-classification": "sovereign",
      "verifyapikey.VerifyAPIKey-1.apiproduct.allow_cloud_burst": "false",
      "verifyapikey.VerifyAPIKey-1.apiproduct.allowed_models":
        "enterprise-sovereign,google/gemma-4-31B-it",
      "private.kvm_alias_sovereign": "google/gemma-4-31B-it",
      "private.kvm_alias_flash": "google/gemini-3.5-flash",
      "private.kvm_canary_weight": "0",
      "private.kvm_canary_target": "google/gemma-4-31B-it",
    },
    initialVars
  );

  const context = {
    getVariable(name) {
      return Object.prototype.hasOwnProperty.call(vars, name)
        ? vars[name]
        : null;
    },
    setVariable(name, value) {
      vars[name] = value;
    },
  };

  vm.runInNewContext(SCRIPT_SOURCE, { context });
  return vars;
}

test("accepts omitted stream and routes sovereign alias to local-vllm", () => {
  const payload = JSON.stringify({
    model: "enterprise-sovereign",
    messages: [{ role: "user", content: "Hello" }],
  });
  const vars = runPolicy({ "request.content": payload });

  assert.equal(vars.invalid_json_body, "false");
  assert.equal(vars.invalid_stream_value, "false");
  assert.equal(vars.model_not_authorized, "false");
  assert.equal(vars.cloud_burst_forbidden, "false");
  assert.equal(vars.is_sse_stream, "false");
  assert.equal(vars.resolved_llm_model, "google/gemma-4-31B-it");
  assert.equal(vars.llm_target_tier, "local-vllm");

  const rewritten = JSON.parse(vars["request.content"]);
  assert.equal(rewritten.model, "google/gemma-4-31B-it");
  assert.equal(rewritten.stream_options, undefined);
});

test("accepts boolean stream=true and forces stream_options.include_usage", () => {
  const payload = JSON.stringify({
    model: "enterprise-sovereign",
    messages: [{ role: "user", content: "Count to 5." }],
    stream: true,
  });
  const vars = runPolicy({ "request.content": payload });

  assert.equal(vars.invalid_json_body, "false");
  assert.equal(vars.invalid_stream_value, "false");
  assert.equal(vars.is_sse_stream, "true");

  const rewritten = JSON.parse(vars["request.content"]);
  assert.deepEqual(rewritten.stream_options, { include_usage: true });

  const failover = JSON.parse(vars.failover_vllm_payload);
  assert.equal(failover.stream, false);
  assert.equal(failover.stream_options, undefined);
});

test("accepts boolean stream=false without forcing SSE", () => {
  const payload = JSON.stringify({
    model: "enterprise-sovereign",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
  });
  const vars = runPolicy({ "request.content": payload });

  assert.equal(vars.invalid_json_body, "false");
  assert.equal(vars.invalid_stream_value, "false");
  assert.equal(vars.is_sse_stream, "false");
});

test("replaces non-object stream_options when stream=true", () => {
  const payload = JSON.stringify({
    model: "enterprise-sovereign",
    messages: [{ role: "user", content: "Hello" }],
    stream: true,
    stream_options: ["bad"],
  });
  const vars = runPolicy({ "request.content": payload });

  assert.equal(vars.invalid_stream_value, "false");
  assert.equal(vars.is_sse_stream, "true");
  const rewritten = JSON.parse(vars["request.content"]);
  assert.deepEqual(rewritten.stream_options, { include_usage: true });
});

for (const badStream of ["true", "false", 1, 0, null, [], {}]) {
  test(`rejects non-boolean stream=${JSON.stringify(badStream)} with invalid_stream_value`, () => {
    const payload = JSON.stringify({
      model: "enterprise-sovereign",
      messages: [{ role: "user", content: "Count to 50." }],
      stream: badStream,
    });
    const vars = runPolicy({ "request.content": payload });

    assert.equal(vars.invalid_json_body, "false");
    assert.equal(vars.invalid_stream_value, "true");
    assert.equal(vars.is_sse_stream, "false");
    assert.equal(vars["request.content"], payload);
  });
}

for (const badBody of [
  '{"model": "enterprise-sovereign", "messages": [',
  "not json at all",
  "",
  "   ",
  "null",
  "[]",
  "123",
  '"hello"',
  "true",
]) {
  test(`rejects malformed or non-object body ${JSON.stringify(badBody)} with invalid_json_body`, () => {
    const vars = runPolicy({ "request.content": badBody });

    assert.equal(vars.invalid_json_body, "true");
    assert.equal(vars.invalid_stream_value, "false");
    assert.equal(vars.is_sse_stream, "false");
    assert.equal(vars.failover_vllm_payload, undefined);
  });
}

test("rejects unauthorized model alias for sovereign product", () => {
  const payload = JSON.stringify({
    model: "enterprise-flash",
    messages: [{ role: "user", content: "Hello" }],
  });
  const vars = runPolicy({ "request.content": payload });

  assert.equal(vars.invalid_json_body, "false");
  assert.equal(vars.invalid_stream_value, "false");
  assert.equal(vars.model_not_authorized, "true");
});

test("routes cloud-eligible enterprise-flash to vertex-gemini with local failover copy", () => {
  const payload = JSON.stringify({
    model: "enterprise-flash",
    messages: [{ role: "user", content: "Hello" }],
  });
  const vars = runPolicy({
    "request.content": payload,
    "request.header.x-data-classification": "cloud-eligible",
    "verifyapikey.VerifyAPIKey-1.apiproduct.allow_cloud_burst": "true",
    "verifyapikey.VerifyAPIKey-1.apiproduct.allowed_models":
      "enterprise-sovereign,enterprise-flash,google/gemma-4-31B-it,google/gemini-3.5-flash",
  });

  assert.equal(vars.invalid_json_body, "false");
  assert.equal(vars.invalid_stream_value, "false");
  assert.equal(vars.model_not_authorized, "false");
  assert.equal(vars.cloud_burst_forbidden, "false");
  assert.equal(vars.llm_target_tier, "vertex-gemini");
  assert.equal(vars.resolved_llm_model, "google/gemini-3.5-flash");

  const failover = JSON.parse(vars.failover_vllm_payload);
  assert.equal(failover.model, "google/gemma-4-31B-it");
  assert.equal(failover.stream, false);
});
