---
layout: page
title: Terms of Service
description: The terms that govern your use of Algosize.
permalink: /terms/
---

**Last Updated: August 22, 2026**
**Effective Date: August 22, 2026**

## 1. Acceptance of Terms

These Terms of Service ("Terms") form a legal agreement between you ("you," "Customer," or "User") and **[Algosize Legal Entity Name]** ("Algosize," "we," "us," or "our") regarding your use of algosize.com and our services (collectively, the "Service").

By creating an account, accessing, or using the Service, you agree to these Terms and to our [Privacy Policy](/privacy/). If you do not agree, do not use the Service. If you use the Service on behalf of an organization, you represent that you have authority to bind that organization, and "you" refers to both you and that organization.

## 2. The Service

Algosize provides analysis tools for software teams: a cloud cost analyzer and forward-looking infrastructure cost estimator, a dependency-vulnerability scanner, an architecture analyzer, an algorithm complexity optimizer, scheduled repository monitors, and CI integrations, together with a dashboard, APIs, and documentation.

Three product rules are part of the deal, not marketing:

- **No cloud-account access.** The Service never asks for, receives, or stores credentials to your cloud accounts. Estimates are computed from configuration text you provide or from files committed in your repository.
- **Estimates are not bills.** Cost estimates are calculated from the configuration you provide, using published list prices. They are not a bill, a quote, or a prediction of your actual invoice, and every estimate says so.
- **Findings are not advice.** Vulnerability, architecture, and complexity findings are analysis output for your engineering judgment — not legal, security, or compliance advice (Section 8).

We may update, modify, or discontinue features at any time. Changes that materially reduce paid functionality will be communicated at least 30 days in advance.

## 3. Eligibility

You must be at least 16 years old (or older where required by local law) to use the Service, and your use must comply with the laws that apply to you.

## 4. Accounts and Organizations

- Sign-in is passwordless (emailed magic link or Google sign-in). You are responsible for the security of your email account and Google account, and for all activity under your Algosize account.
- Accounts belong to organizations with owner, admin, and member roles. Owners and admins are responsible for the people they invite, the API keys they mint, and the monitors they configure.
- API keys authenticate your pipelines as your organization. Treat them as secrets; revoke them immediately if exposed (Team → API keys). The full key is shown exactly once.
- Notify us of unauthorized access at security@algosize.com. Your account page lists active sessions and sign-in history, and lets you revoke sessions.
- We may suspend or terminate accounts that violate these Terms or applicable law.

## 5. Subscriptions, Billing, and Refunds

### 5.1 Plans and fees

The Service offers free and paid plans; fees, features, and limits are described at [algosize.com/#pricing](/#pricing) or in your order form. Free-tier usage is metered; the dashboard shows your remaining runs.

### 5.2 Billing and auto-renewal

Paid subscriptions are billed in advance through Stripe, monthly or annually, and renew automatically unless canceled before renewal. Cancel any time from the dashboard; cancellation takes effect at the end of the current billing period.

### 5.3 Referral credit

Referral credit reduces your Algosize bill. It is not withdrawable as cash, cannot be transferred, is earned only when a referred organization's first invoice is paid, and expires 12 months after issuance. Referral links carry a signup allowance to prevent abuse; we may adjust or revoke credit obtained through fraud, self-referral, or circumvention of the allowance.

### 5.4 Refunds

Except where required by law, fees are non-refundable and no credits are given for partial periods, unused features, or downgrades. We may issue prorated refunds at our discretion in exceptional circumstances. Nothing in this section limits non-waivable consumer rights, including EU withdrawal rights where they apply.

### 5.5 Price changes and taxes

Price changes apply to future billing periods and will be communicated at least 30 days in advance. Fees exclude taxes; you are responsible for applicable sales, use, VAT, or similar taxes other than taxes on our net income.

## 6. Acceptable Use

You agree NOT to:

- Submit code, payloads, or scans designed to harm, compromise, or test systems you do not own or lack explicit written permission to test;
- Use the Service to develop, distribute, or operate malware, exploit kits, ransomware, or other tools targeting third parties without authorization;
- Attempt to escape, probe, or overload the analysis sandbox, or circumvent rate limits, quotas, monitor caps, referral allowances, or access controls;
- Point monitors at repositories you have no right to analyze;
- Reverse-engineer or extract the source code of the Service except as expressly permitted by law;
- Resell, sublicense, white-label, or provide the Service to third parties as a service without our prior written consent (report sharing and white-label reports within your plan are permitted uses);
- Upload personal data of third parties without a valid legal basis;
- Impersonate any person or entity;
- Use the Service in violation of applicable law or third-party rights, or interfere with its integrity or performance.

We may suspend or terminate access for suspected violations.

## 7. Customer Content

### 7.1 Ownership

You retain all rights in the code, configurations, repository references, and other materials you submit, and in the reports generated for you ("Customer Content"). Algosize claims no ownership of Customer Content.

### 7.2 License to Algosize

You grant Algosize a worldwide, non-exclusive, royalty-free license to host, copy, transmit, display, and process Customer Content solely to (a) operate, secure, and support the Service for you, (b) prevent and address abuse, and (c) maintain service reliability in aggregated, de-identified form. This license ends when you delete the content or your organization, except for backups and logs handled per the [Privacy Policy](/privacy/).

### 7.3 No AI training

We do not use Customer Content to train machine-learning models — ours or any third party's. When the AI refactor feature is enabled, your submitted snippet is sent to the AI provider solely to produce the suggestion returned to you, under terms that prohibit the provider from training on it.

### 7.4 Your responsibilities

You represent and warrant that you have the rights needed to submit Customer Content; that our processing of it as described breaks no law, contract, or third-party right; and that it contains no malware intended for systems other than your own test environments.

## 8. Analysis Output — Findings, Estimates, Grades, and Monitors

- **Verify before acting.** Findings, estimates, and grades are produced by automated analysis and are provided "as is." You are responsible for verifying them, deciding on remediation, coordinating any disclosure, and complying with laws governing security research.
- **Absence of a finding is not absence of a problem.** The vulnerability scanner reads your lockfiles against public advisory data; the architecture analyzer reads the manifests you provide; neither sees code paths, runtime behavior, or systems outside their inputs.
- **Cost estimates carry their assumptions.** Every estimate shows its ranges, its named assumptions, and the verification status of its pricing catalog. An estimate whose catalog is marked unverified is provisional and says so.
- **Complexity grades are measurements** at specific input sizes on our sandbox hardware, subject to timing noise; that is why CI ceilings default to one bucket above the measured grade.
- **Monitors are best-effort scheduled checks**, not a guarantee of detection or of uninterrupted nightly execution. A skipped night (upstream throttling, outages) leaves your baselines unchanged and is not a breach of these Terms.
- **CI integrations are designed to fail safe:** a missing API key makes our workflows skip with a notice rather than fail your build. You remain responsible for your own CI configuration.

## 9. AI Features

Where the Service offers AI-generated content (currently the optimizer's refactor suggestion):

- AI output is **labeled as AI-generated** where it appears, in accordance with Article 50 of the EU AI Act, and is a suggestion for your review — never applied automatically.
- AI output may be wrong, insecure, or unsuitable for your context. The Service offers measured verification ("Measure the rewrite"); using AI output without verification is at your own risk.
- As between you and Algosize, you own the AI-generated suggestions returned for your submissions, to the extent permitted by applicable law and the underlying provider's terms.
- The feature can be unavailable (disabled by configuration); the Service will say so rather than substitute unlabeled output.
- Our AI features make no decisions about people and are not designed for use as a safety component of any system. Do not use them where output errors could endanger life, health, or fundamental rights.

## 10. Intellectual Property of Algosize; Feedback

The Service — software, design, trademarks, documentation — is owned by Algosize or its licensors. We grant you a limited, non-exclusive, non-transferable, revocable license to use it per these Terms; all other rights reserved. If you send Feedback, you grant us a perpetual, irrevocable, worldwide, royalty-free license to use it with no obligation to you.

## 11. Third-Party Services

The Service depends on third parties (Cloudflare, Stripe, GitHub, Google, OSV.dev, AI providers). Their services are governed by their own terms; we are not responsible for them. Public data sources (advisory databases, published pricing) may be incomplete or delayed.

## 12. Data Protection

Our collection and use of personal data is described in the [Privacy Policy](/privacy/), which includes our commitments under the GDPR/UK GDPR, U.S. state privacy laws including the CCPA/CPRA, Brazil's LGPD, China's PIPL, Turkey's KVKK, and the transparency requirements of the EU AI Act. For Customer Content, Algosize acts as your processor; a Data Processing Addendum with the EU Standard Contractual Clauses is available at privacy@algosize.com and is incorporated into these Terms where the GDPR applies to your use.

## 13. Disclaimers

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE." TO THE MAXIMUM EXTENT PERMITTED BY LAW, ALGOSIZE DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, AND ANY WARRANTY THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE, OR THAT FINDINGS, ESTIMATES, GRADES, OR AI SUGGESTIONS WILL BE COMPLETE, ACCURATE, OR FIT FOR ANY DECISION. YOU ASSUME ALL RESPONSIBILITY FOR DECISIONS MADE BASED ON THE SERVICE'S OUTPUT.

## 14. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW: ALGOSIZE WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE, DATA, BUSINESS, OR GOODWILL; AND ALGOSIZE'S TOTAL CUMULATIVE LIABILITY WILL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID ALGOSIZE IN THE TWELVE (12) MONTHS BEFORE THE EVENT GIVING RISE TO LIABILITY OR (B) ONE HUNDRED U.S. DOLLARS (USD 100). Some jurisdictions do not allow these limitations; there, they apply to the fullest extent permitted. Nothing in these Terms excludes liability that cannot be excluded by law, including for gross negligence, willful misconduct, or death or personal injury caused by negligence.

## 15. Indemnification

You will indemnify, defend, and hold harmless Algosize and its officers, directors, employees, and agents from claims, damages, liabilities, and expenses (including reasonable attorneys' fees) arising out of (a) your use of the Service, (b) your Customer Content, (c) your breach of these Terms, or (d) your violation of law or third-party rights — including any unauthorized security testing performed with the Service's output.

## 16. Termination

You may stop using the Service at any time and may delete your organisation from the dashboard (Account → Danger zone → Delete organisation); deletion cancels the Stripe subscription first and then removes your data as described in the [Privacy Policy](/privacy/). We may suspend or terminate access for breach, non-payment, suspected fraud or abuse, risk to the Service or other users, or as required by law. Sections 7.2 (as limited there), 10, 13, 14, 15, 17, and 19 survive termination.

## 17. Governing Law and Dispute Resolution

These Terms are governed by the laws of **[Jurisdiction — e.g., the Republic of Turkey / State of Delaware, USA / England and Wales]**, without regard to conflict-of-law rules. Disputes will be resolved exclusively in the competent courts of **[City, Jurisdiction]**. To the extent permitted by applicable law, you waive participation in class actions. Nothing in this section limits non-waivable consumer rights in your country of residence, including the right of EU consumers to sue in their home courts.

## 18. Export Controls and Sanctions

You will comply with applicable export-control and sanctions laws (including those of the United States, the European Union, and the United Kingdom). You represent that you are not located in a comprehensively embargoed territory and are not on any restricted-party list.

## 19. Miscellaneous

- **Entire agreement.** These Terms, the Privacy Policy, any Data Processing Addendum, and any signed order forms are the entire agreement and supersede prior agreements on this subject.
- **Severability; no waiver.** Unenforceable provisions are severed; failure to enforce is not waiver.
- **Assignment.** You may not assign these Terms without our written consent; we may assign to an affiliate or in a merger, acquisition, or asset sale.
- **Force majeure.** Neither party is liable for delay or failure caused by events beyond its reasonable control.
- **Notices.** We give notice by email, in-product message, or posting to the Service; you give notice at legal@algosize.com.

## 20. Contact

- **Legal:** legal@algosize.com
- **Support:** support@algosize.com
- **Privacy:** privacy@algosize.com
- **Mail:** [Algosize Legal Entity Name], [Registered Address]
