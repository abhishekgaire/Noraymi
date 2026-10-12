import { assertOutsideTransaction } from "@west4/db";
import type { TwilioAccount } from "./venue.js";

/**
 * Register for texts (O-12; spec 17 · Step details 11; runbook texts-10dlc): the venue's 10DLC
 * brand, sent to Twilio on the venue's own subaccount through Trust Hub's ISV flow. A secondary
 * customer profile (the business, its EIN, its authorized representative and address, tied to
 * our primary profile), an A2P trust product, then the brand registration. The campaign follows
 * once the brand is approved, as M8-22's check already reads it.
 *
 * Never inside a database transaction; every request carries an idempotency token made from the
 * registration's id, so a retry of the same registration can't make a second one. The EIN goes in
 * exactly one request body (the business information end user) and is never returned, stored or
 * logged: errors name the step and Twilio's status, never a body.
 */
export const SECONDARY_PROFILE_POLICY = "RNdfbf3fae0e1107f8aded0e7cead80bf5";
export const A2P_TRUST_PRODUCT_POLICY = "RNb0d4771c2c98518d916a3d4cd70a8f8b";

export interface BrandSettings {
  readonly apiBase: string;
  readonly trusthubBase: string;
  readonly messagingBase: string;
  /** Our own (ISV) primary customer profile in Trust Hub; null until we have one. */
  readonly primaryProfileSid: string | null;
  /** The ISV email Trust Hub asks for on each profile (ours, never the venue's). */
  readonly isvEmail: string | null;
}

export function loadBrandSettings(
  source: Record<string, string | undefined> = process.env,
): BrandSettings {
  return {
    apiBase: source["TWILIO_API_BASE"] ?? "https://api.twilio.com",
    trusthubBase: source["TWILIO_TRUSTHUB_BASE"] ?? "https://trusthub.twilio.com",
    messagingBase: source["TWILIO_MESSAGING_BASE"] ?? "https://messaging.twilio.com",
    primaryProfileSid: source["TWILIO_PRIMARY_PROFILE_SID"] || null,
    isvEmail: source["TWILIO_ISV_EMAIL"] || null,
  };
}

export interface BrandForm {
  readonly legalName: string;
  readonly ein: string;
  readonly businessType: string;
  readonly websiteUrl: string;
  readonly street: string;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly rep: {
    readonly firstName: string;
    readonly lastName: string;
    readonly email: string;
    readonly phone: string;
    readonly title: string;
    readonly position: string;
  };
}

export interface BrandResult {
  readonly customerProfileSid: string;
  readonly trustProductSid: string;
  readonly brandSid: string;
}

/** A Twilio step that answered with an error: the step and the status, nothing that was sent. */
export class BrandStepFailed extends Error {
  constructor(
    readonly step: string,
    readonly status: number,
  ) {
    super(`Twilio answered ${status} at ${step}`);
  }
}

export async function registerBrand(
  account: TwilioAccount,
  form: BrandForm,
  settings: BrandSettings,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BrandResult> {
  assertOutsideTransaction("text");
  if (!settings.primaryProfileSid || !settings.isvEmail)
    throw new BrandStepFailed("our primary profile isn't set", 0);
  const auth = `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString("base64")}`;
  let n = 0;
  const post = async (step: string, url: string, params: Record<string, string>) => {
    n += 1;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/x-www-form-urlencoded",
        "i-twilio-idempotency-token": `${key}:${n}`,
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!response.ok) throw new BrandStepFailed(step, response.status);
    const sid = ((await response.json()) as { sid?: string }).sid;
    if (!sid) throw new BrandStepFailed(step, response.status);
    return sid;
  };
  const hub = settings.trusthubBase;
  const name = form.legalName;

  // 1. The secondary customer profile, with the business (and its EIN), its representative and
  //    address, and our primary profile; evaluated and sent for review.
  const profile = await post("customer profile", `${hub}/v1/CustomerProfiles`, {
    FriendlyName: `${name} · customer profile`,
    Email: settings.isvEmail,
    PolicySid: SECONDARY_PROFILE_POLICY,
  });
  const assign = (base: string, sid: string, objectSid: string, step: string) =>
    post(step, `${hub}/v1/${base}/${sid}/EntityAssignments`, { ObjectSid: objectSid });
  const business = await post("business information", `${hub}/v1/EndUsers`, {
    Type: "customer_profile_business_information",
    FriendlyName: `${name} · business`,
    Attributes: JSON.stringify({
      business_name: name,
      business_identity: "direct_customer",
      business_type: form.businessType,
      business_industry: "HOSPITALITY",
      business_registration_identifier: "EIN",
      business_registration_number: form.ein,
      business_regions_of_operation: "USA_AND_CANADA",
      website_url: form.websiteUrl,
    }),
  });
  await assign("CustomerProfiles", profile, business, "business assignment");
  const rep = await post("authorized representative", `${hub}/v1/EndUsers`, {
    Type: "authorized_representative_1",
    FriendlyName: `${name} · representative`,
    Attributes: JSON.stringify({
      first_name: form.rep.firstName,
      last_name: form.rep.lastName,
      email: form.rep.email,
      phone_number: form.rep.phone,
      business_title: form.rep.title,
      job_position: form.rep.position,
    }),
  });
  await assign("CustomerProfiles", profile, rep, "representative assignment");
  const address = await post(
    "address",
    `${settings.apiBase}/2010-04-01/Accounts/${encodeURIComponent(account.accountSid)}/Addresses.json`,
    {
      FriendlyName: `${name} · address`,
      CustomerName: name,
      Street: form.street,
      City: form.city,
      Region: form.region,
      PostalCode: form.postalCode,
      IsoCountry: "US",
    },
  );
  const document = await post("address document", `${hub}/v1/SupportingDocuments`, {
    Type: "customer_profile_address",
    FriendlyName: `${name} · address`,
    Attributes: JSON.stringify({ address_sids: [address] }),
  });
  await assign("CustomerProfiles", profile, document, "address assignment");
  await assign("CustomerProfiles", profile, settings.primaryProfileSid, "primary profile");
  await post("profile evaluation", `${hub}/v1/CustomerProfiles/${profile}/Evaluations`, {
    PolicySid: SECONDARY_PROFILE_POLICY,
  });
  await post("profile review", `${hub}/v1/CustomerProfiles/${profile}`, {
    Status: "pending-review",
  });

  // 2. The A2P trust product: the messaging profile, tied to the customer profile.
  const product = await post("trust product", `${hub}/v1/TrustProducts`, {
    FriendlyName: `${name} · A2P`,
    Email: settings.isvEmail,
    PolicySid: A2P_TRUST_PRODUCT_POLICY,
  });
  const messaging = await post("messaging profile", `${hub}/v1/EndUsers`, {
    Type: "us_a2p_messaging_profile_information",
    FriendlyName: `${name} · messaging profile`,
    Attributes: JSON.stringify({ company_type: "private" }),
  });
  await assign("TrustProducts", product, messaging, "messaging assignment");
  await assign("TrustProducts", product, profile, "profile assignment");
  await post("product evaluation", `${hub}/v1/TrustProducts/${product}/Evaluations`, {
    PolicySid: A2P_TRUST_PRODUCT_POLICY,
  });
  await post("product review", `${hub}/v1/TrustProducts/${product}`, {
    Status: "pending-review",
  });

  // 3. The brand registration itself.
  const brand = await post(
    "brand registration",
    `${settings.messagingBase}/v1/a2p/BrandRegistrations`,
    {
      CustomerProfileBundleSid: profile,
      A2PProfileBundleSid: product,
    },
  );
  return { customerProfileSid: profile, trustProductSid: product, brandSid: brand };
}
