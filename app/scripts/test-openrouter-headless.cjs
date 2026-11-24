const assert = require("node:assert/strict");
const { test } = require("node:test");
const Ajv2020 = require("ajv/dist/2020");
const pack = require("../distribution/local-packages/packs/openrouter-headless.json");
const { compileSetupPlan } = require("../cli/setup.cjs");
const provider = require("../../registry/interface/world_provider_openrouter/interface.json");
const search = require("../../registry/tool/web.search/tool.json");
const searchDoor = require("../../registry/interface/system_web_search/life.json");

test("the headless pack installs the reviewed dependencies and selects OpenRouter chat and search", () => {
  const validate = new Ajv2020({ strict: false }).compile(require("../schemas/local_application_pack.schema.json"));
  assert.equal(validate(pack), true, JSON.stringify(validate.errors));
  const providerId = pack.workspace_setup.home.provider_interface_id;
  const model = pack.workspace_setup.home.default_model;
  assert.equal(provider.id, providerId);
  assert.equal(model, "deepseek/deepseek-v4.1-flash-1017");
  assert.ok(provider.interface_policy.variables.models.default.includes(model));
  const config = provider.interface_driver_config.private_config;
  assert.ok(config.model_catalog.some((entry) => entry.model === model && entry.supports_tools && entry.show_in_picker));
  assert.ok(config.opencodex.model_catalog.models.some((entry) => entry.slug === model && entry.supported_in_api));

  const included = new Set(pack.components.map((row) => row.package_id));
  const components = pack.components.map((component) => {
    const manifest = require(`../distribution/local-packages/packages/${component.package_id}.json`);
    for (const dependency of manifest.required_packages ?? []) {
      assert.ok(included.has(dependency), `${component.package_id} requires ${dependency}`);
    }
    return { ...component, product_id: manifest.product_id, product_kind: manifest.product_kind, source_digest: "a".repeat(64) };
  });
  const plan = compileSetupPlan({ ...pack, components, manifest_digest: "b".repeat(64) }, {
    operationId: "test-openrouter-headless", workspaceName: "Octopus", workspaceGoal: "Run Octopus",
    projects: [{ name: "Telegram" }], model, reasoningEffort: "none", recommended: [],
    requiredState: "credential_configured",
  });
  assert.equal(plan.provider.interface_id, providerId);
  assert.deepEqual(plan.workspace.request.home.selectedWorkerEnvironmentKinds, ["system_room", "web_search"]);
  assert.deepEqual(plan.workspace.request.task.selectedWorkerEnvironmentKinds, ["system_room", "web_search"]);
  assert.ok(plan.packages.some((row) => row.id === "world_telegram"));

  const backend = search.handler_config.providers.openrouter;
  assert.equal(backend.auth.env, provider.interface_driver_config.transport.auth_env_key);
  for (const name of [backend.auth.env, search.handler_config.default_provider_env]) {
    assert.ok(search.process.inherit_env.includes(name));
    assert.ok(searchDoor.processes[0].inherit_env.includes(name));
  }
});
