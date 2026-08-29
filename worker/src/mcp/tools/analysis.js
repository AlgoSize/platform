// The analyzer tools. Every one of these is metered except the fix generator
// and the provider catalog, and each description says so in its own words —
// a model that does not know a call costs something will happily re-run an
// analysis it already has the answer to.
//
// Nothing here imports a handler, an analyzer, or `enforceQuota`. The route
// and its middleware chain come from mcp/chains.js, which is the one place
// allowed to know them — so a tool physically cannot drop the quota wrapper
// off a metered route, and `test-mcp-purity.mjs` can enforce that by import
// analysis alone.

import { callHandler } from "../dispatch.js";
import { CHAINS } from "../chains.js";
import { SCOPES, failureOf, describeCounts, FILES_SCHEMA, READ_ONLY, MUTATING, clip } from "./_shared.js";

// The five input formats the estimator accepts. Duplicated from
// handlers/estimate.js as a literal rather than imported, because importing a
// handler module into tools/ is exactly what the purity guard forbids —
// test-mcp-tools.mjs asserts this list still matches INPUT_TYPES, so a drift
// fails the build instead of reaching a model as a wrong enum.
const ESTIMATE_INPUT_TYPES = ["kubernetes", "compose", "terraform-plan", "manual", "normalized"];

export const ANALYSIS_TOOLS = [
  {
    name: "algosize_analyze_vulnerabilities",
    title: "Scan dependencies for vulnerabilities",
    description:
      "Audit a project's dependencies against known advisories. Give it a GitHub repository URL " +
      "and it fetches and parses the lockfiles itself; that is the accurate path and the one to prefer. " +
      "CONSUMES ONE RUN from the organisation's monthly allowance. Before calling it, check " +
      "algosize_list_runs for a recent 'vuln' run on the same repository — repeating an audit that " +
      "has not changed wastes the allowance.",
    scope: SCOPES.ANALYZE,
    paidOnly: false,
    metered: true,
    annotations: MUTATING,
    inputSchema: {
      type: "object",
      properties: {
        repoUrl: {
          type: "string",
          description: "A GitHub repository URL, e.g. https://github.com/owner/name. Preferred over `files`.",
        },
        files: FILES_SCHEMA,
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        counts:   { type: "object" },
        summary:  { type: "string" },
        packagesScanned: { type: "number" },
        fixCommand: { type: "string" },
        runId: { type: "string" },
      },
    },
    async run({ args, request, env, ctx }) {
      if (!args.repoUrl && !args.files) {
        return {
          text: "Provide either `repoUrl` (preferred) or `files` containing the project's lockfiles.",
          isError: true, errorCode: "invalid_params",
        };
      }
      const res = await callHandler(CHAINS.analyzeVuln.chain, {
        method: CHAINS.analyzeVuln.method, path: CHAINS.analyzeVuln.path,
        body: args.repoUrl ? { repoUrl: args.repoUrl } : { files: args.files },
        request, env, ctx,
      });
      const fail = failureOf(res, "The dependency scan");
      if (fail) return fail;

      const d = res.json || {};
      const counts = d.counts || {};
      const scanned = d.scanned || {};
      return {
        text:
          `Dependency audit of ${d.repoUrl || "the supplied files"}: ${describeCounts(counts)}.\n` +
          `Scanned ${scanned.totalPackages ?? "?"} packages across ` +
          `${(scanned.manifests || []).length} manifest(s).\n` +
          (d.summary ? `${d.summary}\n` : "") +
          (d.fixCommand ? `Suggested fix: ${d.fixCommand}` : ""),
        structured: {
          counts,
          summary: d.summary || null,
          packagesScanned: scanned.totalPackages ?? null,
          fixCommand: d.fixCommand || null,
        },
      };
    },
  },

  {
    name: "algosize_analyze_cost",
    title: "Analyse cloud spend",
    description:
      "Find savings in an existing cloud bill. Takes a list of running services with their monthly " +
      "cost and returns ranked reduction opportunities. This analyses spend you ALREADY have — to " +
      "price infrastructure you have not built yet, use algosize_estimate_infrastructure instead. " +
      "CONSUMES ONE RUN.",
    scope: SCOPES.ANALYZE,
    paidOnly: false,
    metered: true,
    annotations: MUTATING,
    inputSchema: {
      type: "object",
      properties: {
        services: {
          type: "array",
          description: "The services making up the current bill.",
          items: {
            type: "object",
            properties: {
              name:         { type: "string", description: "Service name, e.g. \"RDS\"." },
              monthlyCost:  { type: "number", description: "Current monthly cost in USD." },
              region:       { type: "string" },
              utilization:  { type: "number", description: "Average utilisation 0-1, when known." },
            },
            required: ["name", "monthlyCost"],
            additionalProperties: false,
          },
          minItems: 1,
        },
      },
      required: ["services"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        currentSpend: { type: "number" },
        totalSavingsPct: { type: "number" },
        suggestions: { type: "array" },
      },
    },
    async run({ args, request, env, ctx }) {
      const res = await callHandler(CHAINS.analyzeCost.chain, {
        method: CHAINS.analyzeCost.method, path: CHAINS.analyzeCost.path, body: { services: args.services },
        request, env, ctx,
      });
      const fail = failureOf(res, "The cost analysis");
      if (fail) return fail;

      const d = res.json || {};
      const suggestions = d.suggestions || [];
      return {
        text:
          `Current spend $${d.currentSpend ?? "?"}/month. ` +
          `${suggestions.length} savings opportunit${suggestions.length === 1 ? "y" : "ies"} found, ` +
          `worth about ${d.totalSavingsPct ?? 0}% of the bill.\n` +
          suggestions.slice(0, 10)
            .map((s) => `• ${s.title} (${s.service || "general"}) — saves ~$${s.savingsEstimate ?? "?"}/mo`)
            .join("\n"),
        structured: {
          currentSpend: d.currentSpend ?? null,
          totalSavingsPct: d.totalSavingsPct ?? null,
          suggestions,
        },
      };
    },
  },

  {
    name: "algosize_analyze_complexity",
    title: "Measure algorithmic complexity",
    description:
      "Run a JavaScript function against generated inputs, measure how its runtime grows, and infer " +
      "its Big-O complexity, with a suggested rewrite when a better one exists. The code is executed " +
      "in an isolated sandbox, so it must be self-contained and must not need network or filesystem " +
      "access. CONSUMES ONE RUN.",
    scope: SCOPES.ANALYZE,
    paidOnly: false,
    metered: true,
    annotations: MUTATING,
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "A self-contained JavaScript function, including its declaration. No imports, no I/O.",
        },
        sampleInput: {
          description: "Optional representative input used to seed the measurement.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        bigO: { type: "string" }, wallTimeMs: { type: "number" }, suggestion: { type: "string" },
      },
    },
    async run({ args, request, env, ctx }) {
      const body = { code: args.code };
      if (args.sampleInput !== undefined) body.sampleInput = args.sampleInput;
      const res = await callHandler(CHAINS.analyzeAlgo.chain, {
        method: CHAINS.analyzeAlgo.method, path: CHAINS.analyzeAlgo.path, body, request, env, ctx,
      });
      const fail = failureOf(res, "The complexity analysis");
      if (fail) return fail;

      const d = res.json || {};
      return {
        text:
          `Measured complexity: ${d.bigO || d.currentComplexity || "unknown"}.` +
          (typeof d.wallTimeMs === "number" ? ` Wall time ${d.wallTimeMs}ms.` : "") +
          (d.suggestion ? `\n\n${clip(d.suggestion)}` : "") +
          (d.reason ? `\n\nNot determined: ${d.reason}` : ""),
        structured: {
          bigO: d.bigO || d.currentComplexity || null,
          wallTimeMs: typeof d.wallTimeMs === "number" ? d.wallTimeMs : null,
          suggestion: d.suggestion || null,
        },
      };
    },
  },

  {
    name: "algosize_analyze_architecture",
    title: "X-ray a system's architecture",
    description:
      "Build a dependency graph of a system from its configuration files — wrangler.toml, " +
      "docker-compose.yml, Kubernetes manifests, Terraform — and report structural findings. Send " +
      "the config files, not application source: source contributes almost nothing to the graph and " +
      "costs context. CONSUMES ONE RUN.",
    scope: SCOPES.ANALYZE,
    paidOnly: false,
    metered: true,
    annotations: MUTATING,
    inputSchema: {
      type: "object",
      properties: { files: FILES_SCHEMA },
      required: ["files"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        nodes: { type: "number" }, edges: { type: "number" },
        findings: { type: "array" }, complete: { type: "boolean" },
      },
    },
    async run({ args, request, env, ctx }) {
      const res = await callHandler(CHAINS.analyzeArchitecture.chain, {
        method: CHAINS.analyzeArchitecture.method, path: CHAINS.analyzeArchitecture.path, body: { files: args.files },
        request, env, ctx,
      });
      const fail = failureOf(res, "The architecture analysis");
      if (fail) return fail;

      const d = res.json || {};
      const s = d.summary || {};
      const findings = d.findings || [];
      return {
        text:
          `Architecture graph: ${s.nodes ?? 0} components, ${s.edges ?? 0} dependencies, ` +
          `${findings.length} finding(s).\n` +
          // `complete: false` means files were skipped or dropped. Saying so
          // matters: a graph missing a third of the system looks identical to
          // a complete one, and a model asked "is anything a SPOF" would
          // answer from the fragment without knowing it is a fragment.
          (s.complete === false
            ? "NOTE: the graph is incomplete — some files were skipped or too large, so absent components may still exist.\n"
            : "") +
          findings.slice(0, 12)
            .map((f) => `• [${f.severity || "info"}] ${f.title || f.id}`)
            .join("\n"),
        structured: {
          nodes: s.nodes ?? 0, edges: s.edges ?? 0,
          findings, complete: s.complete !== false,
        },
      };
    },
  },

  {
    name: "algosize_estimate_infrastructure",
    title: "Estimate infrastructure cost",
    description:
      "Price infrastructure from its definition — a Terraform plan, docker-compose file, Kubernetes " +
      "manifest, or a manual resource list — across cloud providers, using published list prices. " +
      "This prices what you are ABOUT TO build; to find savings in a bill you already pay, use " +
      "algosize_analyze_cost. Nothing is contacted at any cloud provider and no credentials are ever " +
      "needed. CONSUMES ONE RUN.",
    scope: SCOPES.ANALYZE,
    paidOnly: false,
    metered: true,
    annotations: MUTATING,
    inputSchema: {
      type: "object",
      properties: {
        inputType: {
          type: "string",
          enum: [...ESTIMATE_INPUT_TYPES],
          description: "Which format `content` is in.",
        },
        content: {
          description: "The plan, manifest or resource list. A string for text formats, an object for JSON ones.",
        },
        providers: {
          type: "array", items: { type: "string" },
          description: "Optional provider ids to price against. Omit to price all of them.",
        },
        region: { type: "string", description: "Optional region hint, e.g. \"us-east-1\"." },
      },
      required: ["inputType", "content"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { providers: { type: "array" }, warnings: { type: "array" }, currency: { type: "string" } },
    },
    async run({ args, request, env, ctx }) {
      const options = {};
      if (args.providers) options.providers = args.providers;
      if (args.region)    options.region    = args.region;
      const res = await callHandler(CHAINS.estimate.chain, {
        method: CHAINS.estimate.method, path: CHAINS.estimate.path,
        body: { inputType: args.inputType, content: args.content, options },
        request, env, ctx,
      });
      const fail = failureOf(res, "The infrastructure estimate");
      if (fail) return fail;

      const d = res.json || {};
      const providers = d.providers || [];
      return {
        text:
          `Estimated monthly cost by provider (${d.currency || "USD"}, list prices — not a quote):\n` +
          providers
            .map((p) => `• ${p.name || p.id}: ${p.monthlyTotal ?? p.total ?? "?"}`)
            .join("\n") +
          (d.warnings && d.warnings.length
            ? `\n\nWarnings:\n${d.warnings.map((w) => `• ${w.message || w}`).join("\n")}`
            : "") +
          `\n\n${(d.disclaimer && d.disclaimer.estimate) || "List prices only; your negotiated rates may differ."}`,
        structured: {
          providers, warnings: d.warnings || [],
          currency: d.currency || "USD",
          pricingCatalogVersion: d.pricingCatalogVersion || null,
        },
      };
    },
  },

  {
    name: "algosize_list_cost_providers",
    title: "List priceable cloud providers",
    description:
      "List the cloud providers algosize_estimate_infrastructure can price against, with each one's " +
      "regions and how fresh its price data is. Free and read-only — call it before an estimate when " +
      "you need to know which provider ids are valid.",
    scope: SCOPES.READ,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: { providers: { type: "array" }, catalogVersion: { type: "string" } } },
    async run({ request, env, ctx }) {
      const res = await callHandler(CHAINS.estimateProviders.chain, {
        method: CHAINS.estimateProviders.method, path: CHAINS.estimateProviders.path, request, env, ctx,
      });
      const fail = failureOf(res, "Listing cost providers");
      if (fail) return fail;

      const d = res.json || {};
      const providers = d.providers || [];
      return {
        text:
          `${providers.length} provider(s) priceable, catalog ${d.catalogVersion || "unknown"}:\n` +
          providers.map((p) => `• ${p.id} — ${p.name} (${p.category}, ${p.billingModel})`).join("\n"),
        structured: { providers, catalogVersion: d.catalogVersion || null },
      };
    },
  },

  {
    name: "algosize_generate_fix",
    title: "Generate a fix for a finding",
    description:
      "Produce a concrete remediation for one finding produced by another Algosize tool. Free — it " +
      "does NOT consume a run. Pass the finding as it was returned rather than a paraphrase; the " +
      "generator keys off its exact fields.",
    scope: SCOPES.ANALYZE,
    paidOnly: false,
    // /api/fix is registered WITHOUT enforceQuota in index.js — deliberately,
    // since it explains a finding the customer already paid a run to produce.
    // Claiming metered:true here would make the tool description lie and would
    // put a quota warning in front of a free action.
    metered: false,
    annotations: MUTATING,
    inputSchema: {
      type: "object",
      properties: {
        kind:    { type: "string", description: "The finding's kind, exactly as returned by the analyzer." },
        finding: { type: "object", description: "The finding object, passed through unchanged." },
      },
      required: ["kind", "finding"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { kind: { type: "string" }, fix: {} } },
    async run({ args, request, env, ctx }) {
      const res = await callHandler(CHAINS.fix.chain, {
        method: CHAINS.fix.method, path: CHAINS.fix.path, body: { kind: args.kind, ...args.finding },
        request, env, ctx,
      });
      const fail = failureOf(res, "Generating a fix");
      if (fail) return fail;
      const d = res.json || {};
      return {
        text: clip(typeof d.fix === "string" ? d.fix : JSON.stringify(d.fix, null, 2)),
        structured: { kind: d.kind || args.kind, fix: d.fix ?? null },
      };
    },
  },
];
