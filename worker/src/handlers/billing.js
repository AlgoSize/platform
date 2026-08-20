// POST /api/billing/portal — open the Stripe-hosted Customer Portal.
//
// The portal lets users update their card, download invoices, switch plans,
// or cancel — all without us building any billing UI of our own. Stripe
// hosts the entire experience; we just mint a one-shot session URL keyed
// to the user's saved `stripeCustomerId` and redirect.
//
// Auth: gated by `requireAuth` in the router, which attaches
// `request.user = { userId, email, subStatus }` after verifying the JWT.
// We re-read from USERS KV so we always have the latest stripeCustomerId
// (the JWT payload doesn't carry it) and so we can 400 cleanly if the user
// has no Stripe customer attached (e.g. legacy free-tier rows from a
// future Task #19, or a corrupted record).
//
// State changes triggered inside the portal (cancel, payment-method swap)
// arrive back as Stripe webhooks → handlers/webhook.js, which is already
// wired to flip subStatus on `customer.subscription.deleted`. The dashboard
// re-hydrates from /api/me on next page load and reflects the new state.

import { stripeFetch } from "../stripe.js";
import { getActiveOrg, listMembers, getOrgBillingEmail } from "./_orgs.js";
import { resolveEntitlementForOrg } from "../entitlement.js";
import { tierForOrg } from "../reports/branding.js";
import { creditBalance, formatCents } from "../credits.js";
import { auditFromRequest, AUDIT_ACTIONS } from "../audit.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;

export async function billingPortalHandler(request, env) {
  const sessionUser = request.user || {};
  if (!sessionUser.userId) {
    // requireAuth should have short-circuited — defensive belt-and-braces.
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // The Stripe customer belongs to the organisation, not the user
  // (migrations/0004) — on a seated plan several people share one customer,
  // and the portal is that customer's.
  const active = await getActiveOrg(env, sessionUser.userId);
  if (!active || !active.org.stripeCustomerId) {
    return jsonResponse(
      {
        error:   "no_stripe_customer",
        message: "No Stripe customer is attached to this account. Contact support if this is unexpected.",
      },
      400,
    );
  }
  const user = { stripeCustomerId: active.org.stripeCustomerId };

  let session;
  try {
    session = await stripeFetch(env, "/billing_portal/sessions", {
      method: "POST",
      body: {
        customer:   user.stripeCustomerId,
        return_url: `${env.SITE_ORIGIN}/dashboard/`,
      },
    });
  } catch (err) {
    // Full Stripe error is logged for operators but kept out of the client
    // response — users only need a friendly generic message, not Stripe's
    // raw "No configuration provided…" debug strings.
    console.error("billing/portal: stripe error", err);
    return jsonResponse(
      {
        error:   "portal_failed",
        message: "Could not open the billing portal right now. Please try again or contact support.",
      },
      err.status && err.status >= 400 && err.status < 500 ? 400 : 502,
    );
  }

  if (!session || !session.url) {
    return jsonResponse({ error: "portal_failed", message: "no url returned" }, 502);
  }

  return jsonResponse({ url: session.url });
}

// ---------------------------------------------------------------------------
// GET /api/billing/summary — what the Billing & Plan section shows
// ---------------------------------------------------------------------------
//
// Everything here that is money comes from Stripe, live, on every request.
// The local row carries `price_id`, `seats_purchased`, `sub_status` and
// `current_period_end` and deliberately does NOT carry the amount, the
// currency or the interval (see migrations/0003) — so there is no cached
// price to render, and that is the right shape: a cached price is a number
// that can disagree with the invoice, and the first time it does the customer
// is looking at two different figures for the same subscription.
//
// The cost of that choice is that this endpoint fails when Stripe does. It
// fails LOUDLY and partially: the plan, seats and entitlement come from our
// own database and always render, and the Stripe-derived block reports
// `reason` instead of quietly showing nothing. `null` and `[]` are never used
// interchangeably here — null means "could not look", not "there is none".
//
// Card details are read-only. There is no way to change one through this API
// and there should not be: Algosize never sees a card number, and the update
// path is Stripe's hosted portal (POST /api/billing/portal above).
export async function billingSummaryHandler(request, env, ctx) {
  const sessionUser = request.user || {};
  if (!sessionUser.userId) return jsonResponse({ error: "unauthorized" }, 401);

  const active = await getActiveOrg(env, sessionUser.userId);
  if (!active) {
    return jsonResponse({
      error: "no_organisation",
      message: "This account is not a member of any organisation.",
    }, 404);
  }
  const { org, role } = active;

  const [entitlement, members, credit, billingEmail] = await Promise.all([
    resolveEntitlementForOrg(env, org.orgId, { request, ctx }).catch(() => null),
    listMembers(env, org.orgId).catch(() => []),
    creditBalance(env, org.orgId),
    org.billingEmail ? Promise.resolve(org.billingEmail) : getOrgBillingEmail(env, org.orgId).catch(() => null),
  ]);

  const base = {
    org: {
      orgId: org.orgId,
      name:  org.name,
      role,
      tier:  tierForOrg(env, org),
      plan:  org.plan,
      subStatus: org.subStatus,
      seatsPurchased: org.seatsPurchased,
      seatsUsed: members.length,
    },
    entitlement: entitlement ? {
      active: entitlement.active,
      reason: entitlement.reason,
      currentPeriodEnd: entitlement.currentPeriodEnd,
    } : null,
    billingEmail: {
      address: billingEmail || null,
      // Whether it was set deliberately or is just the owner's login address.
      // The form needs to know: an empty field with a placeholder showing the
      // owner's email is a different thing from a field with a value in it.
      explicit: !!org.billingEmail,
    },
    credit: {
      balanceCents: credit.balanceCents,
      balance: formatCents(credit.balanceCents),
      known: credit.complete,
    },
  };

  if (!org.stripeCustomerId) {
    return jsonResponse({
      ...base,
      subscription: null,
      paymentMethod: null,
      billingAddress: null,
      reason: "no_stripe_customer",
      message: "This organisation has never been through checkout, so there is nothing on file with Stripe yet.",
    });
  }
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse({
      ...base,
      subscription: null, paymentMethod: null, billingAddress: null,
      reason: "stripe_not_configured",
    });
  }

  const cus = encodeURIComponent(org.stripeCustomerId);
  let customer = null, subs = null;
  try {
    [customer, subs] = await Promise.all([
      // Expanding the default payment method is what turns "there is a card"
      // into "Visa ending 4242, expires 04/2028" without a second round trip.
      stripeFetch(env, `/customers/${cus}?expand[]=invoice_settings.default_payment_method`, { method: "GET" }),
      stripeFetch(env, `/subscriptions?customer=${cus}&status=all&limit=1`, { method: "GET" }),
    ]);
  } catch (err) {
    console.error("billing/summary: stripe error", err);
    return jsonResponse({
      ...base,
      subscription: null, paymentMethod: null, billingAddress: null,
      reason: "stripe_unreachable",
      message: "Could not reach Stripe. Your plan and seats above are from our own records and are accurate.",
    });
  }

  const sub = (subs && subs.data && subs.data[0]) || null;
  const item = sub && sub.items && sub.items.data && sub.items.data[0];
  const price = item && item.price;

  // Stripe's default payment method may be unset even on a paying customer
  // (a subscription can carry its own). Falling back to the subscription's is
  // what makes the card shown here the card that will actually be charged.
  let pm = (customer && customer.invoice_settings
            && customer.invoice_settings.default_payment_method) || null;
  if (pm && typeof pm === "string") pm = null;   // unexpanded id, not useful
  const card = pm && pm.card ? pm.card : null;

  const now = Math.floor(Date.now() / 1000);
  const cardExpired = card && (
    card.exp_year < new Date(now * 1000).getUTCFullYear() ||
    (card.exp_year === new Date(now * 1000).getUTCFullYear() &&
     card.exp_month < new Date(now * 1000).getUTCMonth() + 1)
  );

  return jsonResponse({
    ...base,
    subscription: sub ? {
      id: sub.id,
      status: sub.status,
      // Stripe moved this onto the item; read both so the answer does not
      // depend on which API version created the subscription.
      currentPeriodEnd: sub.current_period_end || (item && item.current_period_end) || null,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      trialEnd: sub.trial_end || null,
      quantity: item ? item.quantity : null,
      amountCents: price && typeof price.unit_amount === "number" ? price.unit_amount : null,
      amount: price && typeof price.unit_amount === "number" ? formatCents(price.unit_amount) : null,
      currency: price ? price.currency : null,
      interval: price && price.recurring ? price.recurring.interval : null,
      priceId: price ? price.id : null,
    } : null,
    paymentMethod: card ? {
      brand: card.brand,
      last4: card.last4,
      expMonth: card.exp_month,
      expYear: card.exp_year,
      // Computed here rather than in the UI so the "declined" styling and the
      // dunning email cannot disagree about whether a card is dead.
      expired: !!cardExpired,
    } : null,
    billingAddress: customer && customer.address ? {
      line1: customer.address.line1 || null,
      line2: customer.address.line2 || null,
      city: customer.address.city || null,
      state: customer.address.state || null,
      postalCode: customer.address.postal_code || null,
      country: customer.address.country || null,
      name: customer.name || null,
    } : null,
    // Stripe returns tax ids on a sub-resource; one extra round trip for a
    // line of text nobody edits here is not worth it, so the UI links to the
    // portal for this rather than rendering a value it cannot refresh.
    reason: null,
  });
}

// ---------------------------------------------------------------------------
// GET /api/billing/invoices — the customer's own invoice history
// ---------------------------------------------------------------------------
//
// The same Stripe call the admin panel already makes, scoped to the caller's
// own org instead of an arbitrary one. Owner-gated: an invoice names what the
// company pays, and a member who can run scans has no reason to see it.
//
// `invoices: null` and `invoices: []` mean different things and are never
// swapped — empty is "this account has never been invoiced", null is "we
// could not look". Rendering the second as the first would tell a customer
// with six invoices that they have none.
export async function billingInvoicesHandler(request, env) {
  const sessionUser = request.user || {};
  if (!sessionUser.userId) return jsonResponse({ error: "unauthorized" }, 401);

  const active = await getActiveOrg(env, sessionUser.userId);
  if (!active) {
    return jsonResponse({ error: "no_organisation", message: "This account is not a member of any organisation." }, 404);
  }
  if (active.role !== "owner") {
    return jsonResponse({
      error: "forbidden",
      message: "Only the owner can see invoices for this organisation.",
      role: active.role,
    }, 403);
  }
  const { org } = active;

  if (!org.stripeCustomerId) {
    return jsonResponse({
      invoices: [], reason: "no_stripe_customer",
      message: "No invoice has been raised yet — this organisation has not been through checkout.",
    });
  }
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse({ invoices: null, reason: "stripe_not_configured" });
  }

  try {
    const list = await stripeFetch(
      env,
      `/invoices?customer=${encodeURIComponent(org.stripeCustomerId)}&limit=24`,
      { method: "GET" },
    );
    const invoices = (list.data || []).map((inv) => ({
      id: inv.id,
      number: inv.number || null,
      amountDue: inv.amount_due,
      amountPaid: inv.amount_paid,
      amount: formatCents(typeof inv.amount_paid === "number" && inv.amount_paid > 0
        ? inv.amount_paid : inv.amount_due),
      currency: inv.currency,
      status: inv.status,
      created: inv.created,
      // Both links, because they do different jobs: the PDF is the document
      // finance files, the hosted page is where an unpaid invoice gets paid.
      pdfUrl: inv.invoice_pdf || null,
      hostedInvoiceUrl: inv.hosted_invoice_url || null,
      attemptCount: typeof inv.attempt_count === "number" ? inv.attempt_count : null,
    }));
    const paidCents = invoices
      .filter((i) => i.status === "paid")
      .reduce((sum, i) => sum + (i.amountPaid || 0), 0);
    return jsonResponse({
      invoices,
      totalPaid: formatCents(paidCents),
      totalPaidCents: paidCents,
      reason: null,
    });
  } catch (err) {
    console.error("billing/invoices: stripe error", err);
    return jsonResponse({
      invoices: null, reason: "stripe_unreachable",
      message: "Could not reach Stripe to load your invoices. Try again, or open the Stripe portal.",
    });
  }
}

// ---------------------------------------------------------------------------
// PUT /api/billing/email — where invoices and dunning go
// ---------------------------------------------------------------------------
//
// Stored on the organisation, not the user: the invoice belongs to the
// company, and if the owner leaves the finance contact must not leave with
// them. Owner-only for the same reason.
//
// Setting this does NOT redirect dunning away from the owner — it adds a
// recipient. A finance inbox nobody reads is exactly how a card decline
// becomes a lapsed account, so the person whose access is at stake keeps
// getting told regardless of what is configured here.
export async function updateBillingEmailHandler(request, env, ctx) {
  const sessionUser = request.user || {};
  if (!sessionUser.userId) return jsonResponse({ error: "unauthorized" }, 401);

  const active = await getActiveOrg(env, sessionUser.userId);
  if (!active) {
    return jsonResponse({ error: "no_organisation", message: "This account is not a member of any organisation." }, 404);
  }
  if (active.role !== "owner") {
    return jsonResponse({
      error: "forbidden",
      message: "Only the owner can change where invoices are sent.",
      role: active.role,
    }, 403);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Body must be JSON." }, 400); }

  const raw = body && body.email;
  let value = null;
  if (raw !== null && raw !== "") {
    if (typeof raw !== "string" || raw.trim().length > MAX_EMAIL_LEN || !EMAIL_RE.test(raw.trim())) {
      return jsonResponse({ error: "invalid_email", message: "Enter a valid email address, or send null to clear it." }, 400);
    }
    value = raw.trim().toLowerCase();
  }

  await env.DB.prepare("UPDATE organisations SET billing_email = ?, updated_at = ? WHERE org_id = ?")
    .bind(value, Math.floor(Date.now() / 1000), active.org.orgId).run();

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.BILLING_EMAIL_UPDATED,
    targetType: "org", targetId: active.org.orgId, orgId: active.org.orgId,
    metadata: { to: value },
  });

  const fallback = value ? null : await getOrgBillingEmail(env, active.org.orgId).catch(() => null);
  return jsonResponse({
    ok: true,
    billingEmail: { address: value || fallback, explicit: !!value },
    note: value
      ? "Invoices and payment-failure notices go to this address and to the owner."
      : "Cleared. Invoices now go to the owner's login email.",
  });
}
