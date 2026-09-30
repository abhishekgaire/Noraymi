import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { CredentialRow } from "@west4/db";
import type { AuthConfig } from "../config.js";
import { ApiError } from "../http/errors.js";

/**
 * Passkeys (WebAuthn) for owners and managers, with user verification
 * required: the phone or laptop asks for its own unlock (Face ID, Touch ID,
 * Windows Hello or the device PIN) every time, so a passkey is two factors on
 * its own. The relying party id is the staff app's domain.
 */
export class Passkeys {
  constructor(private readonly config: AuthConfig) {}

  private get rpId(): string {
    if (!this.config.rpId)
      throw new ApiError(
        "internal",
        "passkeys need WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS on this server",
        {
          retryable: false,
        },
      );
    return this.config.rpId;
  }

  registrationOptions(input: {
    userId: string;
    userName: string;
    displayName: string;
    existing: readonly CredentialRow[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.rpId,
      userID: new TextEncoder().encode(input.userId),
      userName: input.userName,
      userDisplayName: input.displayName,
      attestationType: "none",
      excludeCredentials: input.existing
        .filter((c) => c.kind === "passkey" && c.credentialId)
        .map((c) => ({
          id: c.credentialId!,
          ...(c.transports ? { transports: c.transports } : {}),
        })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
  }

  async verifyRegistration(input: { response: unknown; expectedChallenge: string }): Promise<{
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports: string[] | null;
  }> {
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: input.response as RegistrationResponseJSON,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: [...this.config.origins],
        expectedRPID: this.rpId,
        requireUserVerification: true,
      });
    } catch (error) {
      throw new ApiError(
        "unauthorized",
        `the passkey couldn't be registered: ${(error as Error).message}`,
      );
    }
    if (!verified.verified)
      throw new ApiError("unauthorized", "the passkey couldn't be registered");
    const { credential } = verified.registrationInfo;
    return {
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      signCount: credential.counter,
      transports: credential.transports ?? null,
    };
  }

  authenticationOptions(input: {
    allow: readonly CredentialRow[];
  }): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
      rpID: this.rpId,
      userVerification: "required",
      allowCredentials: input.allow
        .filter((c) => c.kind === "passkey" && c.credentialId)
        .map((c) => ({
          id: c.credentialId!,
          ...(c.transports ? { transports: c.transports } : {}),
        })),
    });
  }

  /** The challenge the browser signed, read from the response so the stored one can be found. */
  static challengeOf(response: unknown): string | null {
    const r = response as { response?: { clientDataJSON?: unknown } } | null;
    const raw = r?.response?.clientDataJSON;
    if (typeof raw !== "string") return null;
    try {
      const data = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
        challenge?: unknown;
      };
      return typeof data.challenge === "string" ? data.challenge : null;
    } catch {
      return null;
    }
  }

  static credentialIdOf(response: unknown): string | null {
    const r = response as { id?: unknown } | null;
    return typeof r?.id === "string" ? r.id : null;
  }

  async verifyAuthentication(input: {
    response: unknown;
    expectedChallenge: string;
    credential: CredentialRow;
  }): Promise<{ newCounter: number }> {
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response: input.response as AuthenticationResponseJSON,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: [...this.config.origins],
        expectedRPID: this.rpId,
        requireUserVerification: true,
        credential: {
          id: input.credential.credentialId!,
          publicKey: new Uint8Array(Buffer.from(input.credential.publicKey!, "base64url")),
          counter: input.credential.signCount,
          ...(input.credential.transports ? { transports: input.credential.transports } : {}),
        },
      });
    } catch (error) {
      throw new ApiError("unauthorized", `the passkey didn't verify: ${(error as Error).message}`);
    }
    if (!verified.verified) throw new ApiError("unauthorized", "the passkey didn't verify");
    return { newCounter: verified.authenticationInfo.newCounter };
  }
}
