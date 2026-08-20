// What Algosize tells you about, and on which channel.
//
// The catalog lives in code rather than in the database on purpose. A
// notification type is a product decision: it gets added, renamed and
// re-defaulted as the product changes, and every one of those is a deploy,
// not a data migration. The database (notification_prefs, migrations/0015)
// stores only the DIFFERENCES from these defaults, so adding a row here ships
// with its intended default for everyone instead of arriving switched off for
// every existing user because nobody wrote a backfill.
//
// ---------------------------------------------------------------------------
// The locked rows
// ---------------------------------------------------------------------------
// Two billing notifications cannot be silenced on email, and that is a
// deliberate refusal rather than an oversight.
//
// Email is the only channel guaranteed to exist for every account. In-app
// needs someone signed in and looking; Slack needs a webhook that can be
// deleted from the Slack side without telling us. A failed payment that
// nobody hears about does not stay a failed payment — it becomes a lapsed
// account, a dead CI pipeline and a support ticket that opens with "why did
// you cut us off". Letting someone switch that off is offering them a setting
// whose only possible effect is harm.
//
// So the write path REFUSES a request that would turn one off, rather than
// accepting it and quietly ignoring it. A toggle that reports success and
// changes nothing is worse than one that says no.

/**
 * Channels a notification can be delivered on, in display order.
 *
 * `slack` is listed but requires an org-level webhook (organisations
 * .slack_webhook_url); with none configured the toggle is still settable and
 * simply has nothing to deliver to. That is reported to the UI as a separate
 * fact — "you have this on, and it is currently going nowhere" — rather than
 * being hidden, because a silently undelivered alert is the failure this
 * whole screen exists to prevent.
 */
export const CHANNELS = Object.freeze(["email", "inapp", "slack"]);

/**
 * The catalog, grouped as the settings screen renders it.
 *
 *   id        stable key, written to notification_prefs.pref_id. Never reuse
 *             an id for a different meaning — a stored row would silently
 *             carry the old choice onto the new notification.
 *   label     what the row is called on screen
 *   hint      one sentence saying exactly when it fires, so nobody has to
 *             guess whether "scan complete" means every run or just failures
 *   on        channels enabled by default
 *   lockEmail email cannot be switched off (see the header)
 */
export const NOTIFICATION_GROUPS = Object.freeze([
  {
    id: "billing",
    title: "Billing",
    description:
      "Money and access. Email cannot be switched off for the first two — a missed decline becomes a lapsed account.",
    rows: Object.freeze([
      { id: "pay_failed", label: "Payment failed",
        hint: "Sent on each Stripe retry, with the deadline.",
        on: ["email", "inapp"], lockEmail: true },
      { id: "plan_changed", label: "Plan or seats changed",
        hint: "Upgrade, downgrade, seat add-on, cancellation.",
        on: ["email"], lockEmail: true },
      { id: "invoice_paid", label: "Invoice paid",
        hint: "Receipt to your billing email.",
        on: ["email"] },
    ]),
  },
  {
    id: "product",
    title: "Product",
    description:
      "Scans and findings. Silence any of these without losing billing notices.",
    rows: Object.freeze([
      { id: "scan_done", label: "Scan complete",
        hint: "Every finished run, CI or manual.",
        on: ["inapp"] },
      { id: "severity", label: "New finding at or above high",
        hint: "Threshold: high. Critical always notifies.",
        on: ["email", "inapp", "slack"] },
      { id: "monitor", label: "Monitor alerts",
        hint: "A scheduled sweep failed, or a delta appeared.",
        on: ["email"] },
    ]),
  },
]);

/** Every row, flattened — the lookup most callers actually want. */
export const NOTIFICATIONS = Object.freeze(
  NOTIFICATION_GROUPS.flatMap((g) => g.rows.map((r) => Object.freeze({ ...r, group: g.id }))),
);

const BY_ID = new Map(NOTIFICATIONS.map((n) => [n.id, n]));

/** The catalog entry for an id, or null. */
export function notificationById(id) {
  return BY_ID.get(id) || null;
}

/** Whether (id, channel) may ever be false. */
export function isLocked(prefId, channel) {
  const row = BY_ID.get(prefId);
  return !!(row && channel === "email" && row.lockEmail);
}

/** Whether (id, channel) is on when the user has never expressed a view. */
export function defaultFor(prefId, channel) {
  const row = BY_ID.get(prefId);
  if (!row) return false;
  if (channel === "email" && row.lockEmail) return true;
  return (row.on || []).indexOf(channel) !== -1;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Read a user's effective preferences.
 *
 * Returns a map keyed `"<prefId>:<channel>"` → boolean, covering EVERY row in
 * the catalog: stored overrides layered over the defaults, with locked
 * channels forced on regardless of what a stale row says. Callers never have
 * to remember which of the three sources applies.
 *
 * A database that cannot be read falls back to the defaults rather than to
 * "everything off". Someone whose preference row is briefly unreachable
 * should get one email too many, never one too few — the failure mode has to
 * point at delivering the payment-failed notice, not at dropping it.
 */
export async function readNotificationPrefs(env, userId) {
  const effective = {};
  for (const n of NOTIFICATIONS) {
    for (const ch of CHANNELS) effective[`${n.id}:${ch}`] = defaultFor(n.id, ch);
  }
  if (!env || !env.DB || !userId) return { prefs: effective, stored: false };

  let rows = [];
  try {
    const res = await env.DB
      .prepare("SELECT pref_id, channel, enabled FROM notification_prefs WHERE user_id = ?")
      .bind(userId)
      .all();
    rows = (res && res.results) || [];
  } catch {
    // Pre-0015 database, or D1 unavailable. Defaults stand, and `stored`
    // says the answer did not come from a saved preference.
    return { prefs: effective, stored: false };
  }

  for (const r of rows) {
    const key = `${r.pref_id}:${r.channel}`;
    if (!(key in effective)) continue;         // a row for a retired notification
    if (isLocked(r.pref_id, r.channel)) continue;  // stored row cannot unlock a locked channel
    effective[key] = r.enabled === 1 || r.enabled === true;
  }
  return { prefs: effective, stored: true };
}

/**
 * One question the delivery path asks: should this notification go to this
 * user on this channel right now?
 *
 * Deliberately takes the user id rather than a preloaded prefs map, so a call
 * site cannot accidentally check one user's preferences while sending to
 * another.
 */
export async function shouldNotify(env, userId, prefId, channel) {
  if (isLocked(prefId, channel)) return true;
  const { prefs } = await readNotificationPrefs(env, userId);
  return prefs[`${prefId}:${channel}`] === true;
}

/**
 * Persist a set of changes.
 *
 * `changes` is `{ "<prefId>:<channel>": boolean }`, normally the whole map the
 * settings screen is showing. Rows that match the default are DELETED rather
 * than written as a matching row, so the table stays a diff and a later change
 * to a default reaches everyone who never disagreed with it.
 *
 * Returns `{ written, cleared, refused }`. `refused` names any (id, channel)
 * the caller tried to switch off that cannot be — the caller is expected to
 * surface it, not swallow it.
 */
export async function writeNotificationPrefs(env, userId, changes) {
  const result = { written: 0, cleared: 0, refused: [] };
  if (!env || !env.DB || !userId || !changes) return result;

  const now = Math.floor(Date.now() / 1000);
  const statements = [];

  for (const key of Object.keys(changes)) {
    const sep = key.lastIndexOf(":");
    if (sep < 1) continue;
    const prefId  = key.slice(0, sep);
    const channel = key.slice(sep + 1);
    if (!BY_ID.has(prefId) || CHANNELS.indexOf(channel) === -1) continue;

    const wanted = changes[key] === true;

    if (isLocked(prefId, channel)) {
      // Only a request to turn it OFF is a refusal. Re-sending "on" for a
      // locked row is what the settings screen does on every save, and
      // refusing that would make every save look like a failure.
      if (!wanted) result.refused.push(key);
      continue;
    }

    if (wanted === defaultFor(prefId, channel)) {
      statements.push(env.DB
        .prepare("DELETE FROM notification_prefs WHERE user_id = ? AND pref_id = ? AND channel = ?")
        .bind(userId, prefId, channel));
      result.cleared += 1;
    } else {
      statements.push(env.DB
        .prepare(
          `INSERT INTO notification_prefs (user_id, pref_id, channel, enabled, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (user_id, pref_id, channel)
           DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`)
        .bind(userId, prefId, channel, wanted ? 1 : 0, now));
      result.written += 1;
    }
  }

  if (statements.length) await env.DB.batch(statements);
  return result;
}

/**
 * The catalog plus a user's current answers, in the shape the settings screen
 * renders: groups → rows → per-channel state, with `locked` on the channels
 * that cannot move. Assembling it here rather than in the handler keeps the
 * lock rule in one place — the UI cannot draw an unlocked switch for a
 * channel the write path would refuse.
 */
export function describePrefs(prefs) {
  return NOTIFICATION_GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
    rows: g.rows.map((r) => ({
      id: r.id,
      label: r.label,
      hint: r.hint,
      channels: CHANNELS.reduce((acc, ch) => {
        acc[ch] = {
          on: isLocked(r.id, ch) ? true : prefs[`${r.id}:${ch}`] === true,
          locked: isLocked(r.id, ch),
        };
        return acc;
      }, {}),
    })),
  }));
}
