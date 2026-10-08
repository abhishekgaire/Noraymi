# A sign-in from a new country

**Rule:** `signin-new-country` · pages us · clears when acknowledged (one page per sign-in).

**What fired.** An owner or manager signed in (passkey or authenticator app) from a country they have never signed in from before. The country is the one CloudFront saw (`CloudFront-Viewer-Country`, kept on `auth_sessions.country`). A person's first sign-in with a known country only sets their baseline; it never pages.

**Why it matters.** A stolen session or a phished authenticator code usually signs in from somewhere new. Owners and managers can refund, change settings and approve.

## First five minutes

1. Acknowledge the page. The summary names the user id, the new country and the countries seen before.
2. Look up the person and their venue in the Console. Is the owner travelling, or on a VPN? Ask them on a channel you already know (their phone on file), not by replying to anything the session sent.
3. List their open sessions: `select id, client, assurance, country, started_at from auth_sessions where user_id = '<id>' and ended_at is null`.

## Fix

- **Expected** (travel, VPN): note it on the page and move on.
- **Not them, or nobody answers within 30 minutes**: with the venue owner's consent (support grant, or the emergency path if the owner is the one compromised), end the sessions and have the person enrol a new passkey; offboarding in one step (Admin → Team) revokes everything for a staff member. Then follow [the breach runbook](breach.md) if anything was read or changed.

**Over when** acknowledged.
