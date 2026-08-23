---
layout: page
title: Privacy Policy
description: How Algosize collects, uses, and protects your information — and the rights you can exercise, most of them directly from your account.
permalink: /privacy/
---

**Last Updated: August 22, 2026**
**Effective Date: August 22, 2026**

## 1. Introduction

This Privacy Policy describes how Algosize ("Algosize," "we," "us," or "our") collects, uses, and protects information about you when you visit algosize.com or use our services (collectively, the "Service"). The Service helps developers and organizations estimate cloud costs, find dependency vulnerabilities, analyze architecture, and measure algorithm complexity.

Two design decisions shape everything in this policy, so we state them first:

- **We never connect to your cloud accounts.** There is no cloud-account connector anywhere in the Service. Cost estimates are computed from configuration text you paste or from files committed in your repository — never from credentials, which we refuse and do not store if we detect one in your input.
- **We are passwordless.** Sign-in is by emailed magic link or Google sign-in. We never ask for, receive, or store a password for your Algosize account.

## 2. Who We Are (Data Controller)

For account, billing, and usage data, the data controller is:

**[Algosize Legal Entity Name]**
[Registered Address]
Email: privacy@algosize.com

For code, configuration files, and repository content you submit for analysis ("Customer Content"), **you** (or your organization) are the controller and Algosize acts as your **processor**, handling that content only to deliver the analysis you requested. A Data Processing Addendum incorporating the European Commission's Standard Contractual Clauses is available on request at privacy@algosize.com.

## 3. Information We Collect

### 3.1 Information you provide

- **Account information:** email address, optional display name and avatar URL, organization name, and role within your organization. No passwords — see Section 1.
- **Billing information:** handled by our payment processor, Stripe. We store your Stripe customer identifier, plan, and subscription status; we never see or store full card numbers.
- **Customer Content:** code snippets and sample inputs you submit to the algorithm optimizer; configuration files (Docker Compose, Kubernetes manifests, Terraform plan JSON, manual resource specs) you submit to the cost estimator; manifests and lockfiles you submit to the architecture and vulnerability analyzers; and repository URLs and branch names you place under scheduled monitoring.
- **Referral bookkeeping:** email addresses you choose to note as people you shared your referral link with. This is your own record-keeping; we do not email those addresses.
- **Communications:** support requests and other messages you send us.

### 3.2 Information collected automatically

- **Run history:** which analyses you ran, when, their headline results, and the reports they produced — so your dashboard has a history and your CI results have somewhere to land.
- **Security and account history:** sign-in events, active sessions (visible and revocable from your account), and an audit log of privileged actions (API key creation and revocation, membership changes, monitor changes, plan changes, email changes). The audit log exists so *you* can see what happened in your account.
- **Operational logs:** timestamps, request identifiers, error events, and email delivery outcomes, kept to run and debug the Service.
- **Aggregate product analytics:** when enabled, we use privacy-respecting, cookieless analytics (Plausible) that records page views and feature-level events (for example "an algorithm run happened") with **no user identifier, no email, and no cross-site tracking**. We honor the Global Privacy Control and Do Not Track browser signals by disabling these events entirely — see Section 8.

### 3.3 Information from third parties

- **Google sign-in** (if you choose it): your email address and Google account identifier.
- **Stripe:** transaction status, card brand and last four digits, country of the card, and fraud signals.
- **Public repository content:** for repositories you place under monitoring, we fetch **committed files only** (lockfiles, root manifests, a committed compose file, `optimizer.config.json`) from GitHub's public raw-content service. We use no repository credentials and cannot read private content.

### 3.4 What we deliberately do not collect

No cloud-provider credentials. No passwords. No advertising identifiers. No cross-site tracking cookies. No biometric, health, or precise-location data. Configuration you submit to the cost estimator is scanned for credential-shaped strings at the boundary and **refused** — the input is rejected with a pointer to the offending line and is not retained.

## 4. How We Use Your Information

- Provide, operate, and secure the Service, including authentication and session management;
- Run the analyses you request and return and retain your results;
- Run the scheduled monitors you configure and email you their findings;
- Process payments, manage subscriptions, and apply referral credit;
- Send transactional email (sign-in links, security notices, monitor alerts, billing notices) and, separately and with controls in your notification settings, product updates;
- Debug, measure, and improve the Service using operational logs and aggregate analytics;
- Detect, prevent, and address fraud, abuse, and security incidents;
- Comply with legal obligations.

We do **not** sell personal information, and we do not share it for cross-context behavioral advertising.

## 5. Legal Bases for Processing (GDPR / UK GDPR)

| Processing | Legal basis |
|---|---|
| Account creation, sign-in, running analyses, monitors, reports | Performance of a contract (Art. 6(1)(b)) |
| Billing, invoicing, tax records | Contract and legal obligation (Art. 6(1)(b), (c)) |
| Security logging, audit log, fraud and abuse prevention | Legitimate interests (Art. 6(1)(f)) — keeping the Service and your account safe |
| Aggregate, cookieless product analytics | Legitimate interests (Art. 6(1)(f)); disabled for browsers signaling GPC/DNT |
| Product-update email | Consent (Art. 6(1)(a)) — controlled in your notification settings; withdrawable at any time |
| AI refactor suggestions (sending a submitted snippet to an AI provider) | Performance of a contract — the feature exists only to answer your request, and can be disabled |

You may object to processing based on legitimate interests (Section 12). We perform no automated decision-making with legal or similarly significant effects.

## 6. How We Share Information

We share personal data only with the sub-processors needed to run the Service:

| Sub-processor | Purpose |
|---|---|
| Cloudflare | Hosting and edge compute (Workers), database (D1), queues, DDoS protection |
| Stripe | Payment processing, invoicing, fraud prevention |
| Google | Sign-in (if you choose Google), transactional email delivery |
| GitHub | Public raw-content fetches for monitored repositories; site hosting |
| Plausible | Aggregate, cookieless analytics (no user identifiers sent) |
| Sentry-compatible error monitoring | Error events and stack traces for debugging |
| OSV.dev | Vulnerability database queries — receives package names and versions from submitted lockfiles, never your identity |
| AI provider (OpenAI or Cloudflare Workers AI, when the refactor feature is enabled) | Receives only the code snippet you submitted to the optimizer, solely to produce the suggestion returned to you |

A current sub-processor list is available at privacy@algosize.com; we will notify account owners before adding a sub-processor that processes Customer Content. We may also disclose information if required by law, and in a merger or acquisition (with prior notice before your data becomes subject to a different policy).

## 7. Customer Content

- Code submitted to the optimizer runs in an **isolated sandbox**, is measured, and the result is returned to you. The snippet and result are kept in your run history so your reports work; delete a run or your account and they go with it.
- Cost-estimator input is processed **in memory** for the single request and is not stored server-side; exports of the result are generated in your browser from the response.
- Monitored-repository fetches read committed files only, by well-known filename, from the branch you configured.
- We do **not** use Customer Content to train machine-learning models — ours or anyone else's — and our AI provider agreements do not permit them to train on it either.
- You are responsible for having the right to submit the content and for not submitting third-party personal data without a valid legal basis.

## 8. Cookies, Tracking, and Privacy Signals

We set exactly two first-party cookies:

- **`algosize_session`** (strictly necessary): your sign-in session. HttpOnly, Secure. Without it the dashboard cannot work.
- **`algosize_ref`** (functional, 30 days): set only if you arrive through someone's referral link, so the referral can be credited if you sign up. It carries an attribution code, not an identity, and no authority.

There are no third-party cookies, no advertising cookies, and no cross-site tracking. Our analytics are cookieless and aggregate.

**Global Privacy Control and Do Not Track:** if your browser sends the GPC signal or has Do Not Track enabled, we disable analytics events for your visit entirely. We treat GPC as a valid opt-out request under the California Consumer Privacy Act and similar U.S. state laws.

## 9. Data Retention

| Data | Retention |
|---|---|
| Account and organization data | Until you delete your account/organization |
| Run history and reports | Until you delete the run or your account |
| Monitor configuration and baselines | Until you remove the monitor or delete your organization |
| Cost-estimator input | Not stored (processed in memory per request) |
| Billing and tax records | As required by tax and accounting law (typically 5–10 years) |
| Audit log | Retained for the life of the organization; entries about an organization survive its deletion so that the deletion itself, and who performed it, remains accountable |
| Operational and email logs | Up to 12 months |

Organization deletion is self-service (Account → Danger zone). It cancels the Stripe subscription **first** — deletion aborts if the cancellation fails, so you can never delete your data and keep getting billed — then removes the organization's data.

## 10. International Data Transfers

The Service runs on Cloudflare's global edge network, and data may be processed outside your country, including in the United States and the European Union. Where personal data of EEA, UK, or Swiss residents is transferred to countries without an adequacy decision, we rely on the European Commission's Standard Contractual Clauses (with the UK International Data Transfer Addendum where applicable) and supplementary measures. Details for residents of Brazil and China are in Sections 12.3 and 12.4.

## 11. Security

- TLS for all traffic; encryption at rest for stored data;
- Passwordless authentication (short-lived, single-use magic links; Google sign-in) — there is no password database to breach;
- Isolated sandboxing for all submitted code;
- Credential detection at the estimator boundary — inputs containing secret-shaped strings are refused, not stored;
- API keys shown once, stored hashed, revocable, and never placed in logs or audit metadata (key prefixes only);
- Role-based access within organizations; an append-only audit log of privileged actions;
- Sessions listed and revocable from your account; sign-in history visible to you.

No system is perfectly secure. If we become aware of a personal-data breach creating risk to you, we will notify affected customers without undue delay, and where GDPR applies we will notify the competent supervisory authority within 72 hours of becoming aware, as required by Article 33. Report vulnerabilities to security@algosize.com — see our [security page](/security/).

## 12. Your Rights

Most rights below are self-service, and the in-product route is faster than email:

| Right | In-product route |
|---|---|
| Access / portability | Account → Danger zone → **Export account data** (machine-readable JSON) |
| Rectification | Account → Profile (name, avatar); verified email change from the same area |
| Erasure | Account → Danger zone → **Delete organisation** |
| Restriction / objection | Account → Notifications (email controls); privacy@algosize.com for the rest |
| Withdraw consent | Account → Notifications, at any time |

For anything not covered in-product, email **privacy@algosize.com**. We respond within 30 days (or the shorter period your law requires), and we verify requests against the account email before acting. You may use an authorized agent where your law provides for one; we will verify the agent's authority. We never discriminate — in price, features, or service level — for exercising a privacy right.

### 12.1 European Economic Area, United Kingdom, and Switzerland (GDPR / UK GDPR)

You have the rights of access, rectification, erasure, restriction, portability, and objection (Articles 15–21), and the right not to be subject to solely automated decisions with legal effect (Article 22 — we make none). Where processing rests on consent you may withdraw it at any time without affecting prior processing. You may lodge a complaint with your local supervisory authority; we would appreciate the chance to resolve concerns first at privacy@algosize.com.

### 12.2 United States (California CCPA/CPRA and other state laws)

This section applies to residents of California and, where their laws apply, of Virginia, Colorado, Connecticut, Utah, Texas, Oregon, Montana, and other states with comprehensive privacy laws.

**Categories of personal information we collect** (and disclosed above in Section 3): identifiers (email, account IDs); commercial information (subscription and billing status); internet activity (run history, operational logs); professional information (organization and role). We collect **no** sensitive personal information as defined by the CPRA beyond your account log-in (which is passwordless), no biometric or geolocation data, and no information about minors.

- **We do not sell personal information and do not share it for cross-context behavioral advertising**, and have not done so in the preceding 12 months. Because there is no sale or sharing, there is nothing to opt out of — and as a belt-and-braces measure we still honor the **Global Privacy Control** as an opt-out signal (Section 8).
- You have the rights to **know**, **access**, **correct**, **delete**, and to **limit use of sensitive personal information** (not applicable — we collect none beyond log-in), with the in-product routes in the table above.
- **Non-discrimination:** exercising any right never changes your price or service.
- **Appeals** (Virginia, Colorado, Connecticut, and similar): if we decline a request, we will explain why, and you may appeal by replying to our decision; if we deny the appeal we will provide a way to contact your state Attorney General.
- California residents may request the disclosures described in Civil Code §1798.110 and §1798.115 at privacy@algosize.com. We do not respond to "Shine the Light" requests separately because we do not disclose personal information to third parties for their direct marketing — there is nothing to report.

### 12.3 Brazil (LGPD)

We process personal data of Brazilian users under the legal bases of Article 7 of the Lei Geral de Proteção de Dados — principally performance of a contract, compliance with legal obligations, and legitimate interests as described in Section 5. You have the rights in Article 18: confirmation of processing, access, correction, anonymization or deletion of unnecessary data, portability, information about sharing, and revocation of consent. Requests go to privacy@algosize.com, which also reaches our appointed **encarregado** (data protection officer for LGPD purposes). Data is processed outside Brazil under the international-transfer safeguards of Article 33; you may also petition the Autoridade Nacional de Proteção de Dados (ANPD).

### 12.4 China (PIPL)

The Service is provided from infrastructure **outside the People's Republic of China**, and personal information of users in China is transferred to and processed outside China as described in this policy. Where the Personal Information Protection Law applies, we rely on your **separate consent** to this cross-border transfer, which you give when creating an account after reading this policy; you may withdraw it at any time by deleting your account or writing to privacy@algosize.com. You have the rights under Chapter IV of the PIPL to access, copy, correct, and delete your personal information, to restrict or refuse processing, and to ask us to explain our processing rules. We collect the minimum information necessary for the purposes stated (Section 3), and we do not provide personal information to other handlers except the sub-processors in Section 6.

### 12.5 Turkey (KVKK)

Under Law No. 6698 (KVKK), data subjects may learn whether their personal data is processed, request information about the processing, request correction or deletion, and complain to the Kişisel Verileri Koruma Kurumu. Contact privacy@algosize.com.

## 13. AI Features (EU AI Act Transparency)

The Service includes one generative-AI feature and several measurement features that involve no AI. We keep them visibly distinct, and this section is our transparency notice under Article 50 of the EU Artificial Intelligence Act:

- **The refactor suggestion in the Algorithm Optimizer is AI-generated.** When enabled, the code snippet you submitted is sent to a third-party AI model (OpenAI or Cloudflare Workers AI) and the returned advice and rewritten function are shown to you **labeled as AI-generated, at the moment they are shown**. When the feature is disabled, the interface says so plainly rather than substituting anything.
- **Every number is measured, not generated.** Big-O grades, timings, cost estimates, and vulnerability findings come from sandboxed execution, static analysis, and published data sources — no AI model produces or edits them. The "Measure the rewrite" control exists so an AI suggestion is never accepted on trust: it is graded by the same sandbox as your original, and a suggestion that measures worse is reported as plainly as one that measures better.
- **Human oversight by construction:** AI output in the Service is always a *suggestion* presented for your review; nothing is applied automatically, to your code or anywhere else.
- **Risk classification:** the Service's AI feature is a code-suggestion tool. It is not a prohibited practice under Article 5 and is not a high-risk system within the meaning of Annex III of the AI Act — it makes no decisions about people. We perform no emotion recognition, biometric categorization, or social scoring.
- We do not use your content to train models (Section 7). Questions or complaints about AI features: privacy@algosize.com.

## 14. Children's Privacy

The Service is not intended for individuals under 16, and we do not knowingly collect their data. If you believe a child has provided us data, contact privacy@algosize.com and we will delete it.

## 15. Changes to This Policy

Material changes will be announced by email or in-product notice at least 30 days before taking effect. The "Last Updated" date reflects the latest revision.

## 16. Contact

- **Privacy requests and DPO:** privacy@algosize.com
- **Security:** security@algosize.com
- **Mail:** [Algosize Legal Entity Name], [Registered Address]
