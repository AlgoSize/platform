// Terraform adapter — plan JSON only.
//
// HCL IS DELIBERATELY NOT SUPPORTED. Reading `.tf` source correctly means
// evaluating variables, locals, `count`/`for_each`, module wiring and provider
// defaults — i.e. reimplementing Terraform's evaluator. A partial HCL reader
// silently produces a graph missing every resource whose size came from a
// variable, and an estimate that is quietly missing half the fleet is worse
// than a refusal. `terraform show -json` has already done that evaluation, so
// the honest move is to ask for its output.
//
// (architecture/graph.js does regex `.tf` files, but only for `resource "type"
// "name"` headers to draw a topology — it never reads attributes, and is not a
// foundation to price from.)
//
// Nothing here executes Terraform, shells out, or contacts a provider API.

import { EstimatorError, rejectSecrets, MILLI } from "../spec.js";

/** Instance-shape table. Only what can be sized without calling a provider API. */
const INSTANCE_SHAPES = Object.freeze({
  "t3.micro":   { vcpu: 2, memoryGiB: 1 },
  "t3.small":   { vcpu: 2, memoryGiB: 2 },
  "t3.medium":  { vcpu: 2, memoryGiB: 4 },
  "t3.large":   { vcpu: 2, memoryGiB: 8 },
  "m5.large":   { vcpu: 2, memoryGiB: 8 },
  "m5.xlarge":  { vcpu: 4, memoryGiB: 16 },
  "m5.2xlarge": { vcpu: 8, memoryGiB: 32 },
  "c5.large":   { vcpu: 2, memoryGiB: 4 },
  "c5.xlarge":  { vcpu: 4, memoryGiB: 8 },
  "r5.large":   { vcpu: 2, memoryGiB: 16 },
});

const COMPUTE_TYPES = new Set([
  "aws_instance", "aws_spot_instance_request",
  "google_compute_instance", "azurerm_linux_virtual_machine",
  "azurerm_windows_virtual_machine", "digitalocean_droplet", "hcloud_server",
]);
const STORAGE_TYPES = new Set([
  "aws_ebs_volume", "google_compute_disk", "azurerm_managed_disk", "digitalocean_volume", "hcloud_volume",
]);

/** Terraform marks computed values as unknown; both shapes appear in the wild. */
function isUnknown(v) {
  return v === null || v === undefined ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
}

/**
 * Walk `root_module` and every nested `child_modules` entry.
 *
 * Recursion is bounded: a plan is a tree, but a malformed one submitted by a
 * user should not be able to blow the stack.
 */
function collectResources(module, path, out, warnings, depth = 0) {
  if (!module || typeof module !== "object" || depth > 25) {
    if (depth > 25) warnings.push({ code: "module_depth_exceeded", message: "Module nesting deeper than 25 levels was not traversed." });
    return;
  }
  const address = module.address ? String(module.address) : path;
  for (const r of Array.isArray(module.resources) ? module.resources : []) {
    out.push({ ...r, _modulePath: address });
  }
  for (const child of Array.isArray(module.child_modules) ? module.child_modules : []) {
    collectResources(child, `${address}/child`, out, warnings, depth + 1);
  }
}

/**
 * Parse `terraform show -json` output into ResourceSpec[].
 *
 * Reads `planned_values` (post-evaluation desired state) rather than
 * `resource_changes`, because planned_values is what the infrastructure will
 * look like — which is the question a cost estimate answers.
 */
export function adaptTerraformPlan(text, opts = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw new EstimatorError("empty_input", "No Terraform plan JSON was provided.", "content");
  }
  rejectSecrets(text);

  const trimmed = text.trim();
  // A `.tf` file is not JSON; catch that before JSON.parse produces a message
  // that means nothing to someone who pasted HCL.
  if (!trimmed.startsWith("{")) {
    throw new EstimatorError("terraform_hcl_not_supported",
      "This looks like Terraform HCL rather than plan JSON. Run `terraform show -json <planfile> > plan.json` and submit that instead — evaluating HCL requires Terraform itself, and a partial read would silently miss resources sized by variables.",
      "content");
  }

  let plan;
  try { plan = JSON.parse(trimmed); }
  catch {
    throw new EstimatorError("malformed_document", "Plan JSON could not be parsed. Ensure the file is the complete output of `terraform show -json`.", "content");
  }
  if (!plan || typeof plan !== "object") {
    throw new EstimatorError("malformed_document", "Plan JSON did not contain an object.", "content");
  }

  const root = plan.planned_values && plan.planned_values.root_module;
  if (!root) {
    throw new EstimatorError("malformed_document",
      "Plan JSON has no `planned_values.root_module`. This is usually a `terraform show -json` of state rather than of a plan file.", "content");
  }

  const warnings = [];
  const raw = [];
  collectResources(root, "root_module", raw, warnings);

  const resources = [];
  for (const r of raw) {
    const type = String(r.type || "");
    const values = r.values && typeof r.values === "object" ? r.values : {};
    const id = String(r.address || `${type}.${r.name || "unnamed"}`).slice(0, 120);

    if (COMPUTE_TYPES.has(type)) {
      const instanceType = values.instance_type || values.machine_type || values.size || values.server_type;
      if (isUnknown(instanceType)) {
        warnings.push({ code: "unknown_instance_type", message: `"${id}" has a computed or unknown instance type, so its size is not known until apply. Reported as unsupported rather than guessed.` });
        resources.push({ id, type: "compute", quantity: 1 });
        continue;
      }
      const shape = INSTANCE_SHAPES[String(instanceType)];
      if (!shape) {
        warnings.push({ code: "unmapped_instance_type", message: `Instance type "${String(instanceType).slice(0, 40)}" for "${id}" is not in the shape table, so its CPU and memory are unknown.` });
        resources.push({ id, type: "compute", quantity: 1 });
        continue;
      }
      const countRaw = values.count;
      const quantity = Number.isInteger(countRaw) && countRaw > 0 ? countRaw : 1;
      resources.push({
        id, type: "compute", quantity,
        cpuMilli: shape.vcpu * MILLI,
        memoryMilliGiB: shape.memoryGiB * MILLI,
        region: typeof values.region === "string" ? values.region : null,
      });
      continue;
    }

    if (STORAGE_TYPES.has(type)) {
      const size = values.size;
      if (isUnknown(size) || typeof size !== "number") {
        warnings.push({ code: "unknown_volume_size", message: `"${id}" has a computed or missing volume size and was not priced.` });
        resources.push({ id, type: "storage", quantity: 1 });
        continue;
      }
      resources.push({
        id, type: "storage", quantity: 1,
        storageGiB: size,
        iops: Number.isInteger(values.iops) ? values.iops : undefined,
        region: typeof values.region === "string" ? values.region : null,
      });
      continue;
    }

    warnings.push({ code: "unpriced_resource_type", message: `Resource type "${type.slice(0, 60)}" has no pricing model in this catalog and was skipped.` });
  }

  if (resources.length === 0) {
    throw new EstimatorError("empty_input", "No priceable compute or storage resources were found in the plan.", "content");
  }
  return { resources, warnings };
}
