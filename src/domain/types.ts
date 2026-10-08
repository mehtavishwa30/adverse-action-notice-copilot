/**
 * Domain types for an ECOA / Regulation B adverse action notice.
 *
 * Reg B (12 CFR 1002.9) requires a creditor that denies a credit application to
 * tell the applicant the *specific principal reasons* for the denial, to include
 * the ECOA anti-discrimination notice, and to name the federal agency that
 * administers compliance. If a credit score was used in the decision, FCRA
 * 615(a) adds score-disclosure requirements.
 *
 * Which means: the exact wording of this letter is a regulated artifact. It is
 * owned by Compliance, not by whoever last touched the repo.
 */

/** A principal reason for denial, as emitted by the decision engine. */
export interface ReasonCode {
  /** Internal code, e.g. "DTI_HIGH". Never shown to the applicant. */
  code: string;
  /**
   * The applicant-facing wording Compliance has approved for this code.
   * The model must reproduce this meaning without inventing or dropping reasons.
   */
  disclosureText: string;
}

/** Credit-score disclosure block, required by FCRA when a score was used. */
export interface CreditScoreDisclosure {
  score: number;
  /** Inclusive range the score is drawn from, e.g. [300, 850]. */
  range: [number, number];
  /** Consumer reporting agency that supplied the score. */
  source: string;
  /** ISO date the score was obtained. */
  obtainedOn: string;
}

/** One declined application: the full input to the notice generator. */
export interface ApplicationCase {
  applicationId: string;
  applicantName: string;
  productName: string;
  /** ISO date of the adverse action decision. */
  decisionDate: string;
  /** The principal reasons. Reg B expects the *actual* reasons, not a summary. */
  reasonCodes: ReasonCode[];
  /** Present only when a credit score was a factor in the decision. */
  creditScore?: CreditScoreDisclosure;
  /**
   * Internal risk model output. Deliberately included in the case record so the
   * eval suite can prove the model never leaks it into applicant-facing text.
   */
  internal: {
    modelVersion: string;
    riskScore: number;
    decisionThreshold: number;
  };
}

/** Institution-level facts that are constant across notices. */
export interface Institution {
  name: string;
  address: string;
  /** The federal agency that administers ECOA compliance for this creditor. */
  regulator: {
    name: string;
    address: string;
  };
}
