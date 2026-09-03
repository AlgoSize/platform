// The control catalog — framework text, and what this platform can see of it.
//
// A code constant, not database rows, for the same reasons AUDIT_ACTIONS,
// SCORECARD_COLUMNS and the MIGRATIONS manifest are: the Worker bundle has no
// filesystem, framework wording is legally load-bearing and belongs in a
// reviewed diff, and a DB-seeded library drifts per organisation — org A and
// org B would answer "what does PW.7.2 say" differently depending on when they
// signed up, and "what did version 2 say" becomes unanswerable.
//
// The database stores only per-org STATE (attestations). A published audit
// denormalizes each control's title and text into its own row, so bumping
// CATALOG_VERSION can never retroactively rewrite what a frozen pack said.
//
// ---------------------------------------------------------------------------
// `coverage` is the load-bearing field, and it is a claim about THIS TOOL
// ---------------------------------------------------------------------------
// "automated"   an analyzer this platform runs produces an artifact that bears
//               on the control. It does not mean the control passes.
// "attested"    no analyzer can see it, but a human can sign a claim about it
//               with an owner and an end date.
// "not_covered" this platform has no artifact for it and never will from a
//               repository scan. `why` says so in one sentence.
//
// "not_covered" is a statement about Algosize, not a finding about the
// customer. It must never be rendered as a failure, and a control marked
// "not_covered" has no result at all — see resolve.js, which makes `met`
// structurally unreachable for it.
//
// This module is PURE DATA. It imports nothing, so an MCP tool may import it
// without tripping the purity guard (scripts/test-mcp-purity.mjs).

// Bump on ANY wording, coverage or collector-key change. Frozen audits record
// the version they were cut against.
export const CATALOG_VERSION = "2026-09-03.1";

export const EVIDENCE_STATES = Object.freeze(["automated", "attested", "not_covered"]);

// Results. `insufficient_evidence` is the honest middle, and it is reached far
// more often than `not_met` — most of the time the answer is "we looked and
// what we saw does not settle it", which is a different claim from "this is
// broken".
export const RESULTS = Object.freeze([
  "met", "not_met", "insufficient_evidence", "not_applicable", "attestation_expired",
]);

// ---------------------------------------------------------------------------
// NIST SSDF — Secure Software Development Framework, SP 800-218 v1.1
// ---------------------------------------------------------------------------
//
// Chosen as the first framework over SOC 2 and ISO 27001 deliberately. Those
// are dominated by HR, physical, vendor and access-management controls this
// platform holds no artifact for — shipping them would put a well-known
// certification name beside a screen that is ~90% "not covered", which is the
// highest overclaim risk in this feature. SSDF is public, free, relevant to US
// federal procurement, has no certifying body, and its practices map to code
// artifacts almost one to one.
//
// `collector` names a function in evidence.js. A control with a collector is
// "automated"; one without is "attested" or "not_covered".

export const SSDF_GROUPS = Object.freeze([
  { code: "PO", name: "Prepare the Organization" },
  { code: "PS", name: "Protect the Software" },
  { code: "PW", name: "Produce Well-Secured Software" },
  { code: "RV", name: "Respond to Vulnerabilities" },
]);

const SSDF_CONTROLS = [
  // ----- PO — Prepare the Organization ------------------------------------
  { id: "PO.1.1", group: "PO", coverage: "not_covered",
    title: "Identify and document security requirements for the development infrastructure",
    why: "Infrastructure requirements are an organizational document; nothing in a repository scan reads them." },
  { id: "PO.1.2", group: "PO", coverage: "attested",
    title: "Identify and document security requirements for organization-developed software" },
  { id: "PO.1.3", group: "PO", coverage: "not_covered",
    title: "Communicate requirements to third parties who provide components",
    why: "Vendor communication leaves no artifact in code." },
  { id: "PO.2.1", group: "PO", coverage: "not_covered",
    title: "Create new roles and alter responsibilities as needed",
    why: "HR and role definitions are outside the codebase." },
  { id: "PO.2.2", group: "PO", coverage: "attested",
    title: "Provide role-based training for all personnel with SDLC responsibilities" },
  { id: "PO.2.3", group: "PO", coverage: "not_covered",
    title: "Obtain upper management commitment to secure development",
    why: "Management commitment is not a code artifact." },
  { id: "PO.3.1", group: "PO", coverage: "not_covered",
    title: "Specify which tools must or should be included in each toolchain",
    why: "The toolchain policy itself is a document; only its output is visible here." },
  { id: "PO.3.2", group: "PO", coverage: "not_covered",
    title: "Follow recommended security practices to deploy, operate and maintain tools",
    why: "Tool operation happens outside the repository." },
  { id: "PO.3.3", group: "PO", coverage: "automated", collector: "toolchainArtifacts",
    title: "Configure tools to generate artifacts of their support of secure development" },
  { id: "PO.4.1", group: "PO", coverage: "attested",
    title: "Define criteria for software security checks and track throughout the SDLC" },
  { id: "PO.4.2", group: "PO", coverage: "not_covered",
    title: "Implement processes and mechanisms to gather and safeguard the information supporting the criteria",
    why: "The process is organizational; the scanner sees its output, not the process." },
  { id: "PO.5.1", group: "PO", coverage: "not_covered",
    title: "Separate and protect each environment involved in software development",
    why: "Environment separation is infrastructure the analyzer never touches." },
  { id: "PO.5.2", group: "PO", coverage: "not_covered",
    title: "Secure and harden development endpoints",
    why: "Developer laptops are not in the repository." },

  // ----- PS — Protect the Software ----------------------------------------
  { id: "PS.1.1", group: "PS", coverage: "attested",
    title: "Store all forms of code based on the principle of least privilege" },
  { id: "PS.2.1", group: "PS", coverage: "not_covered",
    title: "Make software integrity verification information available to acquirers",
    why: "Signing and publication of checksums happen in release infrastructure, not in the scanned tree." },
  { id: "PS.3.1", group: "PS", coverage: "not_covered",
    title: "Securely archive the files and supporting data for each software release",
    why: "Release archives are outside the scan." },
  { id: "PS.3.2", group: "PS", coverage: "automated", collector: "sbomProvenance",
    title: "Collect, safeguard, maintain and share provenance data for all components of each release" },

  // ----- PW — Produce Well-Secured Software -------------------------------
  { id: "PW.1.1", group: "PW", coverage: "not_covered",
    title: "Use forms of risk modeling — threat modeling, attack modeling — to assess risk",
    why: "Threat modelling is a design activity. No analyzer here performs or detects it." },
  // Attested, not automated — and it took a dead end to notice.
  //
  // This was `automated`, on the `designRecord` collector, which read the
  // architecture map and then hardcoded `insufficient_evidence` with the
  // rationale "attest this control to say who owns that record". But an
  // automated control never consults an attestation, and the API refuses to
  // create one for it: "An attestation cannot override a measurement". The
  // product was instructing an action it forbids, and the control could not
  // be answered by anybody, ever.
  //
  // The collector's own text had it right and the classification had it
  // wrong. Tracking requirements, risks and design decisions is a records
  // practice; a dependency graph describes what the system IS, not which
  // risks were weighed against it. PW.1.1 next door is already `not_covered`
  // for exactly this reason. So this joins the controls where a signed human
  // claim is the evidence — and the claim has something to point at, because
  // the standing threat model it names now exists.
  //
  // Cost, accepted knowingly: the attested branch of the resolver reads only
  // the attestation, so the architecture map is no longer attached as
  // supporting material. The map is still one click away in the product; the
  // threat model is the artifact this control is actually about.
  { id: "PW.1.2", group: "PW", coverage: "attested",
    title: "Track and maintain the software's security requirements, risks and design decisions" },
  { id: "PW.1.3", group: "PW", coverage: "not_covered",
    title: "Build in support for standardized security features and services",
    why: "Whether a design chose standard features is a review judgment, not a scan output." },
  { id: "PW.2.1", group: "PW", coverage: "not_covered",
    title: "Have one or more qualified people review the software design",
    why: "Design review leaves no artifact the analyzer reads." },
  { id: "PW.4.1", group: "PW", coverage: "automated", collector: "componentHealth",
    title: "Acquire and maintain well-secured software components from third parties" },
  { id: "PW.4.4", group: "PW", coverage: "automated", collector: "componentVerification",
    title: "Verify that acquired third-party components comply with requirements" },
  { id: "PW.5.1", group: "PW", coverage: "automated", collector: "secureCoding",
    title: "Follow all secure coding practices appropriate to the development languages" },
  { id: "PW.6.1", group: "PW", coverage: "not_covered",
    title: "Use build tools that offer features to improve executable security",
    why: "Compiler and build flags are not read by the scanner." },
  { id: "PW.6.2", group: "PW", coverage: "not_covered",
    title: "Determine which build features to use and how to configure them",
    why: "Build configuration policy is outside scope." },
  { id: "PW.7.1", group: "PW", coverage: "attested",
    title: "Determine whether code review and/or code analysis should be used" },
  { id: "PW.7.2", group: "PW", coverage: "automated", collector: "codeAnalysisPerformed",
    title: "Perform code review and/or code analysis against secure coding standards" },
  { id: "PW.8.1", group: "PW", coverage: "not_covered",
    title: "Determine if executable code testing should be performed",
    why: "Test strategy is a decision, not an artifact." },
  { id: "PW.8.2", group: "PW", coverage: "not_covered",
    title: "Scope, design and perform executable code testing",
    why: "Dynamic testing is not something this platform does. It reads code; it does not run it." },
  { id: "PW.9.1", group: "PW", coverage: "automated", collector: "secureBaseline",
    title: "Define a secure baseline for how to configure each software feature" },
  { id: "PW.9.2", group: "PW", coverage: "not_covered",
    title: "Implement the default settings and document them for acquirers",
    why: "Documentation for acquirers is outside the tree." },

  // ----- RV — Respond to Vulnerabilities ----------------------------------
  { id: "RV.1.1", group: "RV", coverage: "automated", collector: "advisoryIntake",
    title: "Gather information on potential vulnerabilities from public sources" },
  { id: "RV.1.2", group: "RV", coverage: "automated", collector: "repeatedReview",
    title: "Review, analyze and test the code to identify previously undetected vulnerabilities" },
  { id: "RV.1.3", group: "RV", coverage: "attested",
    title: "Have a policy that addresses vulnerability disclosure and remediation" },
  { id: "RV.2.1", group: "RV", coverage: "automated", collector: "riskInformation",
    title: "Analyze each vulnerability to gather sufficient information about risk" },
  { id: "RV.2.2", group: "RV", coverage: "not_covered",
    title: "Plan and implement risk responses for vulnerabilities",
    why: "A response plan is a decision record. Whether fixes shipped is visible in PW.4.1; whether they were planned is not." },
  { id: "RV.3.1", group: "RV", coverage: "not_covered",
    title: "Analyze identified vulnerabilities to determine their root causes",
    why: "Root-cause analysis is human work with no code artifact." },
  { id: "RV.3.2", group: "RV", coverage: "not_covered",
    title: "Analyze root causes over time to identify patterns",
    why: "Pattern analysis across incidents happens outside the repository." },
  { id: "RV.3.3", group: "RV", coverage: "automated", collector: "classSweep",
    title: "Review the software for similar vulnerabilities to eliminate a class" },
  { id: "RV.3.4", group: "RV", coverage: "not_covered",
    title: "Review the SDLC process and update it to prevent recurrence",
    why: "Process review is organizational." },
];

// ---------------------------------------------------------------------------
// EU Cyber Resilience Act — Annex I, Part II
// ---------------------------------------------------------------------------
// Eight vulnerability-handling obligations. Three are genuinely automated, and
// the SBOM one is exactly what analyzers/cyclonedx.js already produces.

export const CRA_GROUPS = Object.freeze([
  { code: "II", name: "Vulnerability handling requirements" },
]);

const CRA_CONTROLS = [
  { id: "II.1", group: "II", coverage: "automated", collector: "sbomProvenance",
    title: "Identify and document vulnerabilities and components, including a software bill of materials" },
  { id: "II.2", group: "II", coverage: "automated", collector: "componentHealth",
    title: "Address and remediate vulnerabilities without delay, including by providing security updates" },
  { id: "II.3", group: "II", coverage: "automated", collector: "codeAnalysisPerformed",
    title: "Apply effective and regular tests and reviews of the security of the product" },
  { id: "II.4", group: "II", coverage: "not_covered",
    title: "Once a security update is available, share and publicly disclose information about fixed vulnerabilities",
    why: "Publication happens on a website or advisory feed, not in the scanned tree." },
  { id: "II.5", group: "II", coverage: "attested",
    title: "Put in place and enforce a policy on coordinated vulnerability disclosure" },
  { id: "II.6", group: "II", coverage: "not_covered",
    title: "Take measures to facilitate the sharing of information about potential vulnerabilities",
    why: "A contact channel is an organizational arrangement with no code artifact." },
  { id: "II.7", group: "II", coverage: "not_covered",
    title: "Provide for mechanisms to securely distribute updates to address vulnerabilities",
    why: "Update distribution is release infrastructure the scanner does not reach." },
  { id: "II.8", group: "II", coverage: "not_covered",
    title: "Ensure that security patches or updates are disseminated without delay and free of charge",
    why: "Dissemination timing and pricing are commercial facts, not code." },
];

// ---------------------------------------------------------------------------
// Frameworks
// ---------------------------------------------------------------------------

export const FRAMEWORKS = Object.freeze([
  Object.freeze({
    id: "ssdf-1.1",
    name: "NIST SSDF",
    version: "SP 800-218 v1.1",
    short: "SSDF",
    note: "Public, free to reference, no certifying body. Its practices map to code artifacts more directly than any certification framework.",
    groups: SSDF_GROUPS,
    controls: Object.freeze(SSDF_CONTROLS.map((c) => Object.freeze(c))),
  }),
  Object.freeze({
    id: "cra-annex1-ii",
    name: "EU Cyber Resilience Act",
    version: "Annex I, Part II",
    short: "CRA II",
    note: "The vulnerability-handling half of Annex I. Three of its eight obligations are evidenced by artifacts this platform already produces.",
    groups: CRA_GROUPS,
    controls: Object.freeze(CRA_CONTROLS.map((c) => Object.freeze(c))),
  }),
]);

export function getFramework(id) {
  return FRAMEWORKS.find((f) => f.id === id) || null;
}

/** Every control in a framework, or [] for an unknown id — never a throw: an
 *  unknown framework is a 404 at the handler, not a 500 in the catalog. */
export function controlsFor(frameworkId) {
  const f = getFramework(frameworkId);
  return f ? f.controls : [];
}

export function getControl(frameworkId, controlId) {
  return controlsFor(frameworkId).find((c) => c.id === controlId) || null;
}

/** The distinct collectors a framework needs, so evidence.js gathers each
 *  input once rather than once per control that cites it. */
export function collectorsFor(frameworkId) {
  const set = new Set();
  for (const c of controlsFor(frameworkId)) if (c.collector) set.add(c.collector);
  return [...set];
}
