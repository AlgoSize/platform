// CycloneDX 1.5 SBOM from a stored dependency audit.
//
// Why an SBOM at all: increasingly the customer's customer asks for one, and
// "we scanned it, trust us" is not an answer a procurement questionnaire
// accepts. CycloneDX is the format those questionnaires name, and 1.5 is the
// version with a first-class `vulnerabilities` array — which means one file
// can carry both the inventory and what we found in it, rather than shipping
// an SBOM and a separate report that have to be correlated by hand.
//
// Spec: https://cyclonedx.org/docs/1.5/json/
//
// Built from `result.packages`, the list the audit actually queried OSV with.
// That is deliberate: the SBOM and the findings then describe exactly the same
// set of components, so a reader can never find a vulnerability referencing a
// component the inventory does not list.

const SPEC_VERSION = "1.5";

// CycloneDX's severity enum. Ours maps one-to-one except that we have to say
// "unknown" out loud rather than picking a number we do not have.
const SEVERITY = {
  critical: "critical",
  high:     "high",
  medium:   "medium",
  low:      "low",
  unknown:  "unknown",
};

// `ratings[].method` enum. Which CVSS revision produced the score matters:
// the same vector scores differently under v2 and v3, so a consumer that
// re-derives has to know which equations to use.
const METHOD_BY_CVSS_VERSION = {
  "2.0": "CVSSv2",
  "3.0": "CVSSv3",
  "3.1": "CVSSv31",
  "4.0": "CVSSv4",
};

/**
 * purl (package URL) for a component.
 *
 * Spec: https://github.com/package-url/purl-spec. The per-ecosystem quirks
 * that matter here:
 *   npm       scoped packages keep their `@scope/name` shape; the `@` is
 *             percent-encoded because an unescaped one would be read as the
 *             start of the version.
 *   Go        module paths contain slashes and they are part of the name —
 *             `github.com/foo/bar` stays as it is.
 *   RubyGems  purl type is `gem`, not `rubygems`.
 *
 * Returns null for anything we cannot name confidently, and the caller omits
 * `purl` rather than emitting a wrong one — a purl that resolves to the wrong
 * package is worse than an absent purl, because tooling downstream will
 * happily look it up.
 */
export function purlFor(ecosystem, name, version) {
  if (!name || !version) return null;
  const type = {
    npm:       "npm",
    PyPI:      "pypi",
    RubyGems:  "gem",
    Go:        "golang",
  }[ecosystem];
  if (!type) return null;

  // Path segments are encoded individually so the separators survive.
  const encoded = String(name)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");

  return `pkg:${type}/${encoded}@${encodeURIComponent(String(version))}`;
}

/** Stable bom-ref for a component: its purl when we have one, else name@version. */
function bomRefFor(pkg) {
  return purlFor(pkg.ecosystem, pkg.name, pkg.version) || `${pkg.name}@${pkg.version}`;
}

function componentFor(pkg) {
  const purl = purlFor(pkg.ecosystem, pkg.name, pkg.version);
  return {
    type: "library",
    "bom-ref": bomRefFor(pkg),
    name: pkg.name,
    version: pkg.version,
    ...(purl ? { purl } : {}),
    // Scope "required" would claim we know it is a direct, non-optional
    // dependency. A lockfile flattens that away, so we say nothing.
  };
}

function ratingsFor(advisory) {
  const ratings = [];
  const source = { name: "OSV", url: advisory.advisoryUrl || "https://osv.dev" };

  if (advisory.cvssVector) {
    ratings.push({
      source,
      ...(typeof advisory.cvssScore === "number" ? { score: advisory.cvssScore } : {}),
      severity: SEVERITY[advisory.severity] || SEVERITY.unknown,
      method: METHOD_BY_CVSS_VERSION[advisory.cvssVersion] || "other",
      vector: advisory.cvssVector,
    });
  } else {
    // No vector: still record the qualitative severity, with no method or
    // score attached, so a consumer cannot mistake our judgement for arithmetic.
    ratings.push({ source, severity: SEVERITY[advisory.severity] || SEVERITY.unknown });
  }
  return ratings;
}

function vulnerabilityFor(advisory, refsByPackage) {
  const ref = refsByPackage.get(`${advisory.ecosystem}/${advisory.package}@${advisory.installedVersion}`);
  return {
    "bom-ref": `${advisory.id}/${advisory.ecosystem || "unknown"}/${advisory.package}`,
    id: advisory.id,
    source: { name: "OSV", url: advisory.advisoryUrl || `https://osv.dev/vulnerability/${encodeURIComponent(advisory.id)}` },
    ratings: ratingsFor(advisory),
    ...(advisory.aliases && advisory.aliases.length
      ? { references: advisory.aliases.map((a) => ({ id: a, source: { name: "OSV" } })) }
      : {}),
    ...(advisory.summary ? { description: advisory.summary } : {}),
    recommendation: advisory.fixedIn
      ? `Upgrade ${advisory.package} to ${advisory.fixedIn} or later.`
      : `No fixed version is published. Remove the dependency, pin to an unaffected major, or apply the workaround in the advisory.`,
    // `affects` is what ties the finding to the inventory. When the advisory's
    // package is somehow not in the component list we still emit the entry
    // with an empty affects rather than dropping the vulnerability — losing a
    // finding to make a document tidier is the wrong trade.
    affects: ref ? [{ ref }] : [],
  };
}

/**
 * Build a CycloneDX 1.5 BOM from a stored vuln-audit result.
 *
 * `serialNumber` and `timestamp` are injectable so tests can assert on a fixed
 * document; in production both come from the run itself.
 *
 * Anything missing degrades to an empty-but-valid BOM rather than throwing,
 * for the same reason toSarif does: a download button that 500s is a button
 * people stop pressing.
 */
export function toCycloneDX(result, { runId = null, siteOrigin = "", serialNumber = null, timestamp = null, projectName = null } = {}) {
  const packages   = Array.isArray(result && result.packages) ? result.packages : [];
  const advisories = Array.isArray(result && result.advisories) ? result.advisories : [];
  const scanned    = (result && result.scanned) || {};

  // Dedupe on the ref: the same package can legitimately appear in two
  // lockfiles (a repo shipping both package-lock.json and yarn.lock), and one
  // component listed twice makes the inventory count wrong.
  const componentsByRef = new Map();
  const refsByPackage   = new Map();
  for (const p of packages) {
    if (!p || !p.name || !p.version) continue;
    const ref = bomRefFor(p);
    refsByPackage.set(`${p.ecosystem}/${p.name}@${p.version}`, ref);
    if (!componentsByRef.has(ref)) componentsByRef.set(ref, componentFor(p));
  }

  const vulnerabilities = advisories
    .filter((a) => a && a.id)
    .map((a) => vulnerabilityFor(a, refsByPackage));

  // Did the audit see everything? `packagesFound` counts what was in the
  // lockfiles; `totalPackages` counts what we audited after the cap.
  const found    = typeof scanned.packagesFound === "number" ? scanned.packagesFound : componentsByRef.size;
  const complete = found <= componentsByRef.size;

  return {
    bomFormat: "CycloneDX",
    specVersion: SPEC_VERSION,
    ...(serialNumber ? { serialNumber } : {}),
    version: 1,
    metadata: {
      ...(timestamp ? { timestamp } : {}),
      tools: {
        components: [{
          type: "application",
          name: "Algosize",
          ...(siteOrigin ? { externalReferences: [{ type: "website", url: siteOrigin }] } : {}),
        }],
      },
      component: {
        type: "application",
        "bom-ref": runId ? `algosize-run-${runId}` : "algosize-audit",
        name: projectName || "audited-project",
      },
      properties: [
        ...(runId ? [{ name: "algosize:runId", value: String(runId) }] : []),
        { name: "algosize:manifests", value: (scanned.manifests || []).map((m) => m.filename).join(", ") },
        // Said in the document rather than only in our UI: an SBOM that is
        // silently partial is worse than no SBOM, because it will be treated
        // as an inventory.
        { name: "algosize:complete", value: String(complete) },
        ...(complete ? [] : [{
          name: "algosize:completenessCaveat",
          value: `The lockfiles contained ${found} packages and this audit covered ${componentsByRef.size}. ` +
                 `This inventory is a subset — re-run against a narrower scope for a complete SBOM.`,
        }]),
      ],
    },
    components: [...componentsByRef.values()],
    vulnerabilities,
  };
}
