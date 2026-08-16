/*
 * Canonical terms/privacy document text — the single source of truth for
 * both what the accept-terms page renders and the contentHash sent to
 * POST /v1/me/terms/accept. The backend (packages/db/migrations/
 * 0068_v1_l02_seed_terms_documents.sql) seeds terms_documents rows whose
 * content_hash must exactly match SHA256_HEX below for each document, or
 * app_private.accept_terms_document rejects the acceptance
 * ("terms document is not active or hash does not match").
 *
 * Terms of Service text is ported verbatim from the legacy BharatStudio
 * Alerts web app (apps/web/src/app/accept-terms/page.tsx) — not authored
 * fresh here. Privacy Notice text matches the already-published
 * bharatstudio-marketing /legal/privacy/ page for this same product.
 *
 * IMPORTANT: this content is carried forward from what already shipped in
 * the legacy app / marketing site, not newly drafted legal language — but
 * per governance (do not approve legal/privacy conclusions from
 * unsupported assumptions), it still requires dated legal/privacy review
 * before this exact text is treated as final for production launch. Both
 * documents are versioned 'v1.0' so a reviewed replacement is a new
 * version, not a silent edit — see packages/db/migrations/
 * 0068_v1_l02_seed_terms_documents.sql's header comment.
 */

export type TermsDocumentKey = 'terms_of_service' | 'privacy_notice';

export type TermsSection = { title: string; body: string };

export type TermsDocument = {
  documentKey: TermsDocumentKey;
  version: string;
  effectiveDate: string;
  heading: string;
  sections: TermsSection[];
  // SHA-256 hex digest of `${heading}\n${effectiveDate}\n` + each section's
  // "title\nbody" joined by "\n\n" — computed once by
  // scripts/compute-terms-hash.ts and must match the seed migration.
  sha256Hex: string;
};

export const TERMS_OF_SERVICE: TermsDocument = {
  documentKey: 'terms_of_service',
  version: 'v1.0',
  effectiveDate: '1 August 2025',
  heading: 'Terms of Service',
  sections: [
    {
      title: '1. Service Overview',
      body: 'BharatStudio Alerts ("the Service") enables livestream creators to receive and display real-time donation alerts from their viewers. By using the Service, you agree to these Terms.',
    },
    {
      title: '2. Creator Eligibility',
      body: 'You must be 18 years of age or older, legally able to enter into contracts in your jurisdiction, and the owner or authorised operator of the livestream channel you connect to this Service.',
    },
    {
      title: '3. Prohibited Conduct',
      body: 'You may not use the Service to facilitate fraud, money laundering, abuse, harassment, or any activity that violates applicable law. We reserve the right to suspend accounts at our sole discretion pending investigation of suspected violations.',
    },
    {
      title: '4. Payments and Fees',
      body: 'The Free tier is provided at no charge. Paid plans (Pro, Creator, Studio) are billed monthly or annually as displayed on the pricing page. All fees are non-refundable except as required by applicable law or as described in our Refund Policy.',
    },
    {
      title: '5. Intellectual Property',
      body: 'You retain all rights to your content. You grant BharatStudio Alerts a limited licence to display your content (username, avatar, stream title) solely to provide the Service. We do not claim ownership of your streamed content.',
    },
    {
      title: '6. Privacy',
      body: 'We collect only the data necessary to operate the Service. Your data is processed in accordance with our Privacy Notice. We do not sell your personal data.',
    },
    {
      title: '7. Disclaimer of Warranties',
      body: 'THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. WE DO NOT GUARANTEE UNINTERRUPTED OR ERROR-FREE OPERATION. USE AT YOUR OWN RISK.',
    },
    {
      title: '8. Limitation of Liability',
      body: "TO THE MAXIMUM EXTENT PERMITTED BY LAW, BHARATSTUDIO ALERTS' TOTAL LIABILITY TO YOU SHALL NOT EXCEED THE AMOUNT YOU PAID US IN THE 12 MONTHS PRECEDING THE CLAIM.",
    },
    {
      title: '9. Governing Law',
      body: 'These Terms are governed by the laws of India. Any disputes shall be resolved under the jurisdiction of courts in Bengaluru, Karnataka.',
    },
    {
      title: '10. Changes to Terms',
      body: 'We may update these Terms. Material changes will be communicated via email and/or an in-app notice at least 30 days before they take effect. Continued use after the effective date constitutes acceptance of the updated Terms.',
    },
  ],
  sha256Hex: 'd2d0468e95108f2cd1185147ae3b06ced6eb354ca01c16a239897956d5702080',
};

export const PRIVACY_NOTICE: TermsDocument = {
  documentKey: 'privacy_notice',
  version: 'v1.0',
  effectiveDate: 'Launch preparation',
  heading: 'Privacy Notice',
  sections: [
    {
      title: 'Information categories',
      body: 'Depending on the surface you use, BharatStudio may process account and session information, channel configuration, alert and queue records, payment references, device/session state, support communications and operational security logs.',
    },
    {
      title: 'Purpose and access',
      body: 'Information is used to authenticate accounts, provide Alerts and Companion, protect the service, maintain payment and alert history, provide support, handle disputes and meet applicable obligations. Access is role-scoped and operational logs are minimised.',
    },
    {
      title: 'Account closure',
      body: 'When an account is closed, access is deactivated and personal information is stopped from normal product and marketing use. Limited information may remain restricted and audited where required for payments, taxes, fraud prevention, disputes, security or legal obligations. Requests for access, correction, erasure or restriction are reviewed against those obligations.',
    },
    {
      title: 'Contact',
      body: 'Do not email passwords, overlay tokens, payment credentials or provider secrets. Use privacy@bharatstudio.in with the minimum information needed to locate the request.',
    },
  ],
  sha256Hex: '737151cee175eefd4f76b93ee8bb325cf07798a28c7ffda8d8a35d1256ffcd87',
};

export const ACTIVE_DOCUMENTS: TermsDocument[] = [TERMS_OF_SERVICE, PRIVACY_NOTICE];

/** Deterministic canonical serialization — must match scripts/compute-terms-hash.ts exactly. */
export function canonicalText(doc: Pick<TermsDocument, 'heading' | 'effectiveDate' | 'sections'>): string {
  const header = `${doc.heading}\n${doc.effectiveDate}\n`;
  const body = doc.sections.map((s) => `${s.title}\n${s.body}`).join('\n\n');
  return `${header}\n${body}`;
}
