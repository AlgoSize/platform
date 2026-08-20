# Claude Design Prompt — Algosize Account Management

## Context

Algosize is a dark-themed B2B security/cost-audit product (dependency-vulnerability
scanning, cloud cost estimation) sold on three seat-based plans — Solo, Practice, Firm
— billed monthly or annually through Stripe. Auth is magic-link email or Google OAuth
only; there is no password. Accounts are organisations: one or more people share seats,
an owner/admin/member role model, and a single Stripe subscription. Today all billing
(card entry, invoice history, plan switch, cancel) happens inside Stripe's hosted
Customer Portal — the product has never built its own billing UI. The one paid feature
already shipped in this space is report-level white-labeling on the Firm tier: an org
can set a company name and an https logo URL that appear on audit reports generated
for their own clients. There is no referral program, no credit system, and no
product-level custom-domain or theme branding yet — all three are new for this design.

Visual language: near-black background (`#0a0d14`) with a slightly lighter elevated
surface (`#11151e`) for cards, a cool grey-blue border (`#1e2532`), near-white text
(`#f1f3f6`) with a muted grey-blue secondary (`#8a93a3`), a teal accent (`#5eead4`)
as the primary interactive color, a secondary green (`#34d399`) for success/positive
states, and amber (`#f59e0b`) reserved for warnings. Buttons are rounded with a solid
teal primary and a bordered ghost secondary. Cards are rounded panels with a header/
body split. There is no light mode — design dark-only. The existing dashboard's
Algorithm Optimizer tool sets the tone worth matching: dark background, monospace/
code-style input areas, small rounded teal badges, rounded cards with generous
internal padding. Navigation today is a flat tab strip (Workspace / Monitors & CI /
Team) that hash-routes within one dashboard page — Account Management should read as
a clearly separate area from that strip, not a fourth tab bolted onto it.

---

## Prompt

Design a complete Account Management area for Algosize. This is a settings surface
the user reaches deliberately from the main dashboard — visually and structurally
distinct from the Workspace / Monitors / Team working area, the way a "Settings" page
is distinct from an app's main canvas in any modern SaaS product. Use the dark theme,
teal accent, rounded-card and pill-badge language already established in the product
(near-black background, elevated card surfaces, teal primary actions, monospace
touches where content is technical). There is no light mode; do not design one.

Structure the area with a persistent left sidebar (collapsing to a top tab bar on
narrow viewports) containing these sections, in this order:

1. Profile
2. Security
3. Billing & Plan
4. Invoices
5. Branding
6. Referrals & Credits
7. Team
8. API Keys
9. Notifications
10. Danger Zone

Design each section as follows:

**Profile & identity** — name, email, avatar, company name, and role, editable where
it makes sense. A change-email flow that requires verifying the new address before it
takes effect (show the "check your inbox" pending state). A change-password control
does NOT belong here — Algosize has no password, only magic-link email and Google
OAuth — instead show which method(s) are connected to the account (e.g. "Signed in
with Google" or "Magic link to name@company.com") with a way to see connected OAuth
accounts. Do not design a password field anywhere in this prompt.

**Security** — active sessions/devices with the ability to revoke any session other
than the current one, showing device/browser and last-active time. Design an optional
login-history list (timestamp, method, rough location/IP) as a secondary, collapsed
element — not the headline of the page. Because there is no password, do not include
2FA/TOTP setup unless you frame it as a forward-looking placeholder clearly marked
"coming soon" rather than a working control — do not imply it functions today.

**Billing & Plan** — current plan name, price, billing interval, and renewal date;
usage relevant to Algosize itself (e.g. monthly scan runs used vs. the plan's limit,
shown as a simple progress indicator); clear upgrade/downgrade and cancel actions.
Stripe Customer Portal is the actual system of record for payment method, invoice
history, and plan changes — so do NOT design a card-entry form, a payment method
editor, or a from-scratch plan-switcher with its own checkout flow. Instead design a
"Manage billing" entry point (a prominent button or panel) that clearly states it
opens Stripe's secure billing portal, plus a lightweight summary card showing the
last-4 of the card on file and its expiry (data Algosize already has) so the user
doesn't have to leave the page just to see what's on file. Cancellation should be
initiated here with a confirmation step that includes one retention message (e.g. "are
you sure? here's what you lose") before handing off to the portal to complete it.
Show a billing address / tax ID summary as a static display with an edit action that
also hands off to the portal, since that data lives in Stripe.

**Invoices** — a list of past invoices: date, amount, status (paid/failed/refunded),
and a PDF download action per row. Design the empty state for a brand-new account
with zero invoices. Design a secondary "billing email" field for organizations that
want invoices routed to a finance inbox distinct from the account owner's login
email.

**Branding** — logo upload with a live preview shown against actual product
components (a sample report header, a sample email) in both a light and dark
preview frame, not isolated swatches. A color picker for an accent color, previewed
the same way — against real buttons and badges, not swatches — understanding this is
a new capability beyond today's name+logo-only white-labeling. A custom-domain field
with visible verification states: unset, DNS pending, verified, failed — each
needing its own distinct visual treatment (not just a color change on one badge).
A "preview as your client sees it" panel showing a sample report or shared page
fully branded. A reset-to-default action, styled as a lower-emphasis destructive
action (not full danger-zone red, but clearly not a primary action either). Note in
the design that this section is currently gated to the top ("Firm") plan — show what
a lower-tier account sees here (an upsell/locked state), not just the unlocked view.

**Referrals & Credits** — this is credit-only; there are no cash payouts, and that
must be stated explicitly and prominently in the UI, not just in fine print. A
referral link/code with copy and share actions. A status list of referrals: invited,
signed up, converted, credited — each with a date. A credit balance shown prominently
near the top of this section (this is new value the user is earning, it should not
read like a footnote) with the "credits reduce your Algosize bill — not withdrawable
as cash or transferable" statement inline, not hidden in a tooltip. A short inline
explanation of the earning rule (e.g. "$X credit when your referral's first invoice
is paid"). An expiration policy if credits expire — design for both the case where
they do and where they don't. A history list of credit events (earned / applied to
an invoice / expired). Design the empty state for an account with no referrals yet —
lead with the call to action to share the link, not with an empty table.

**Team** — Algosize accounts are organisations with seat-based plans, so this section
is included. Member list with role (owner/admin/member) and status. An invite flow
with role selection (member or admin) and visible remaining-seat count. Seat count
vs. plan limit shown as a simple usage indicator, with an upgrade prompt when seats
are exhausted rather than a dead-end error. Design the pending-invite state
distinctly from an active member row (outstanding invites consume a seat, and that
should be visually legible, not just implied).

**API Keys** — list of keys by name and creation date, with a create action and a
revoke action per key. Present rotation as revoke-old-then-create-new rather than
implying in-place key rotation, since that is what the system actually supports.
Do not design a scopes/permissions picker — keys today are all-or-nothing per
organization, not scoped.

**Notifications** — separate toggle groups for billing notifications (payment
failed, invoice paid, plan changed) and product notifications (scan complete, new
finding severity thresholds, monitor alerts). Channel toggles per notification type:
email always available; design in-app and Slack-webhook toggles as available but
visually secondary to email, since email is the only channel guaranteed to exist for
every account.

**Danger Zone** — visually separated from every other section (a red/warning-bordered
container, not just a red button inside a normal card). Cancel subscription (can
link back to the Billing & Plan flow rather than duplicating it). Export account data
as a self-serve download action. Delete account with an explicit confirmation step
that lists real consequences (loses access to reports, cancels any active
subscription, is not reversible) and requires typing the org name or similar
deliberate confirmation before the action enables.

## Design requirements

- Match the existing dark theme exactly: near-black background, elevated card
  surfaces, teal primary accent, rounded cards and buttons, monospace touches on
  technical content (API keys, DNS records) — the Algorithm Optimizer tool's visual
  treatment is the closest existing reference.
- At the very top of the Account Management area, design a single-pane account
  summary: current plan, next billing date and amount, credit balance, and one
  primary call-to-action (e.g. "Manage billing" or "Upgrade") — visible before the
  user drills into any section below.
- Every irreversible action (cancel subscription, delete account, revoke a session,
  revoke an API key, remove a team member) requires an explicit confirmation step and
  is visually distinguished with warning/red styling — never a plain button doing a
  destructive thing silently.
- Keep billing/payment structurally separate from identity/profile — a user should
  never wonder whether editing their name touches their card on file.
- Design empty states for every list that can start empty: no invoices yet, no
  referrals yet, no team members beyond the owner, no API keys yet.
- Design error/failure states: a failed payment on the billing summary, an invalid/
  expired card, a failed DNS verification on a custom domain, a referral link that
  has hit its limit (if one exists — design this state even if the limit is
  generous).
- Fully responsive: sidebar collapses to a top tab bar or menu on mobile; every
  table becomes a stacked card list on narrow viewports rather than a horizontally
  scrolling table.
- Accessible: sufficient contrast against the dark background for all text and
  status colors, full keyboard navigation through sidebar and forms, alt text on
  the logo preview and any status icons.
- Progressive disclosure: each section leads with a summary (current plan, balance,
  member count, key count) and puts full detail — history tables, full member
  lists, full invoice lists — one level down, not all expanded by default.

## Screens and states to produce

1. Account Management — overview (top summary pane + sidebar, default landing)
2. Profile — default state
3. Profile — change-email pending verification state
4. Security — sessions list with a revoke confirmation open
5. Billing & Plan — default state
6. Billing & Plan — payment failed state
7. Billing & Plan — cancel confirmation (retention step)
8. Invoices — default state (populated list)
9. Invoices — empty state (new account)
10. Branding — default state (Firm tier, unlocked)
11. Branding — locked/upsell state (lower tier)
12. Branding — custom domain pending verification state
13. Branding — custom domain verification failed state
14. Referrals — default state (populated history + balance)
15. Referrals — empty state
16. Referrals — link-limit-reached error state
17. Team — member list with a pending invite visible
18. Team — seats exhausted / upgrade prompt state
19. API Keys — default state with a create-key confirmation showing the one-time
    secret
20. Notifications — default state
21. Danger Zone — delete-account confirmation with consequences listed and
    confirmation text input

## Explicit constraint

Do not design a payment form, card-entry UI, or checkout flow from scratch anywhere
in this area — Stripe Customer Portal and Stripe Checkout are already integrated and
handle all of that. Wherever payment details would normally be edited, design an
entry point (a button or a summary panel with a clear "Manage in Stripe" action) that
links out to the existing Stripe-hosted flow instead.
