// Advisory diffing — the rule that decides whether a monitor run is worth an
// email.
//
// Pure functions, no IO. The whole value of scheduled monitoring rests on
// this being right: a monitor that re-sends last night's advisories every
// night gets filtered to spam within a week, and then the one night it has
// something genuinely new to say, nobody reads it.

/**
 * Identity of an advisory for diffing purposes: the advisory, the ecosystem,
 * and the package it was found in.
 *
 * Deliberately EXCLUDES the installed version. If a package moves 4.17.20 →
 * 4.17.21 and the advisory still applies, that is the same problem the org
 * already knows about — re-alerting on it because the version string moved
 * would punish them for a patch bump that happened to not be the fix. When
 * the upgrade IS the fix, the advisory stops being reported at all and
 * disappears from the set on its own.
 *
 * The same advisory affecting two different packages is two identities,
 * because they need two different fixes.
 */
export function advisoryKey(advisory) {
  if (!advisory || typeof advisory !== "object") return null;
  const id  = advisory.id || "unknown";
  const eco = advisory.ecosystem || "unknown";
  const pkg = advisory.package || "unknown";
  return `${id}/${eco}/${pkg}`;
}

/** Sorted, de-duplicated identity list for a run's advisories. */
export function advisoryKeySet(advisories) {
  const keys = new Set();
  for (const a of advisories || []) {
    const k = advisoryKey(a);
    if (k) keys.add(k);
  }
  return [...keys].sort();
}

/**
 * Stable fingerprint of a run's advisory set.
 *
 * Only used as a fast "nothing whatsoever changed" short-circuit before the
 * real diff. It is not a security primitive and does not need to be a
 * cryptographic hash — collisions here would suppress an alert, so it is
 * built from the full sorted key list rather than something lossy, and the
 * per-key diff below is what actually decides the email.
 */
export function hashKeySet(keys) {
  const joined = keys.join("\n");
  // FNV-1a, 32-bit. Deterministic across runs and isolates, unlike anything
  // seeded by the runtime.
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${keys.length}:${h.toString(16)}`;
}

/**
 * Compare this run's advisories against the previous run's identity list.
 *
 * `previousKeys` is null for a monitor that has never completed a run. That
 * is treated as a BASELINE: everything found is reported, and `isBaseline`
 * says so, because a monitor whose very first run silently swallows a
 * critical is worse than one extra email. Every run after that reports only
 * what appeared since.
 *
 * Returns:
 *   newAdvisories  full advisory objects that weren't in the previous set
 *   resolvedKeys   identities that were there last time and are now gone —
 *                  not emailed (nobody needs a nightly "still fixed"), but
 *                  carried so the caller can log what improved
 *   currentKeys    this run's identity set, to persist as the next baseline
 *   shouldAlert    whether this run warrants an email at all
 *   isBaseline     whether this was the monitor's first completed run
 */
export function diffAdvisories(advisories, previousKeys) {
  const currentKeys = advisoryKeySet(advisories);
  const isBaseline  = previousKeys === null || previousKeys === undefined;

  if (isBaseline) {
    return {
      newAdvisories: [...(advisories || [])],
      resolvedKeys:  [],
      currentKeys,
      shouldAlert:   (advisories || []).length > 0,
      isBaseline:    true,
    };
  }

  const previous = new Set(previousKeys);
  const current  = new Set(currentKeys);

  const newAdvisories = (advisories || []).filter((a) => {
    const k = advisoryKey(a);
    return k && !previous.has(k);
  });
  const resolvedKeys = previousKeys.filter((k) => !current.has(k));

  return {
    newAdvisories,
    resolvedKeys,
    currentKeys,
    // Resolved-only runs are deliberately silent. "Something you already
    // fixed is still fixed" is not news, and making it an email would put
    // this back in the nightly-noise category the diff exists to escape.
    shouldAlert: newAdvisories.length > 0,
    isBaseline:  false,
  };
}

/** Severity counts for a list of advisories, highest-severity keys first. */
export function countBySeverityOrdered(advisories) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const a of advisories || []) {
    const s = a && a.severity;
    if (counts[s] !== undefined) counts[s]++;
    else counts.unknown++;
  }
  return counts;
}

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "unknown"];

/** Group advisories by severity, in descending severity order. */
export function groupBySeverity(advisories) {
  const groups = [];
  for (const severity of SEVERITY_ORDER) {
    const items = (advisories || []).filter((a) => (a && a.severity) === severity);
    if (items.length) groups.push({ severity, items });
  }
  // Anything with an unrecognised severity string would otherwise vanish
  // from the email entirely — collect the stragglers under "unknown".
  const known = new Set(SEVERITY_ORDER);
  const strays = (advisories || []).filter((a) => !known.has(a && a.severity));
  if (strays.length) {
    const existing = groups.find((g) => g.severity === "unknown");
    if (existing) existing.items.push(...strays);
    else groups.push({ severity: "unknown", items: strays });
  }
  return groups;
}
