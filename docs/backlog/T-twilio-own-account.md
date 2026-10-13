# T · Each venue's own Twilio account

Oct 12, 2026 · the tickets for [D123](../decisions.md): every venue texts only from its own Twilio account, which its owner or manager connects in the app; we hold no Twilio account for venues and are never the in-between. Before a venue's texts are live, codes and invites go by email.

**Goal (usable when done):** a venue's owner opens a Twilio account, registers its brand and campaign in Twilio's console ([texts-10dlc.md](../runbooks/texts-10dlc.md)), pastes its Account SID and Auth Token in Admin → Phone & texts or Set up your venue's step 11, picks its number and messaging service, and sees Connected · waiting for approval, then Approved; nobody on our team runs a command or holds a Twilio account for it.

**Done when:**

- A venue connects, checks again, replaces keys and disconnects its own Twilio account from the staff app, in English and Spanish, with no ops command.
- Every text a venue sends (guest texts, phone codes, PIN-reset links, invites, the order-waiting alert) goes from its own account, and inbound texts and status callbacks are checked with its own Auth Token.
- A venue whose texts aren't live gets its codes, links and invites by email; nothing waits on a Twilio account of ours.
- `twilio:subaccount`, Register for texts and `TWILIO_PRIMARY_PROFILE_SID` / `TWILIO_ISV_EMAIL` are gone; the compliance rules (campaign approval in production, STOP and HELP, marketing rules, +1 only, `TEXT_ALLOW_LIST` on staging) are unchanged.

**Depends on:** M2-09, M2-22, M2-23, M8-22, O-11, O-12. **Size:** 4 tickets (2 S, 2 M).

Definition of done: see CLAUDE.md.

## Tickets

### T-01 · Connect a venue's own Twilio account: the server

- **Status:** done
- **Size:** M
- **Depends on:** M2-09 (the venue's `integrations` row, the encrypted token), M8-22 (the campaign check)
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) · Texts through Twilio (Accounts); [D123](../decisions.md)
- **Build:**
  - Owner or manager (Admin, passkey), every route walled by venue:
    - `GET /v1/venues/{v}/texts/twilio`: the connection (state, the account's last four characters and name, trial or not, the number, the messaging service, the campaign's status and when it was read, whether texts are live). Never the token.
    - `POST /v1/venues/{v}/texts/twilio/check` `{ account_sid, auth_token }`: a read-only call to Twilio (the account, its +1 SMS numbers and its messaging services); saves nothing.
    - `POST /v1/venues/{v}/texts/twilio` `{ account_sid, auth_token, number_sid, service_sid }`: checks again, points the number's incoming texts at `/v1/hooks/twilio` (when the server has a public address), puts the number in the messaging service and lets the number's webhook win, reads the service campaign's status, then stores the connection with the token encrypted (`encryptSecret` with `AUTH_SECRET_KEY`). Connecting again replaces the keys.
    - `POST /v1/venues/{v}/texts/twilio/refresh`: Check again, the campaign's status read with the stored keys.
    - `POST /v1/venues/{v}/texts/twilio/disconnect`: Disconnect; the token, number and account are forgotten at once.
  - Every Twilio call outside a transaction, writes carrying an idempotency token; errors name the step and Twilio's status, never a body.
  - An account or number already connected to another venue is refused (`account_in_use`, `number_in_use`); wrong keys answer `twilio_refused`.
  - Locally and in tests (no `GUEST_TEXTS=twilio`), an in-process fake Twilio: any well-formed Account SID and Auth Token pass, an Auth Token of 32 zeros is refused, each account has one number and one messaging service, and its campaign reads pending at Connect and approved on Check again.
- **Acceptance:**
  - [x] Check lists the account's +1 numbers and services and stores nothing; wrong keys are refused with `twilio_refused`.
  - [x] Connect sets the number's incoming-texts address, adds it to the service, reads the campaign and stores the connection; Check again moves pending to approved.
  - [x] The token is in no response, no log line, and no table except encrypted in `integrations`.
  - [x] Disconnect forgets the keys; an account or number connected to another venue is refused.
  - [x] Only an owner or manager can call the routes; every route is in the principal suite and the venue-wall suite.
- **Notes:**
  - Built in `apps/api/src/routes/texts-twilio.ts` (routes), `apps/api/src/texts/connect.ts` (Twilio's calls, `HttpTwilioAdmin`, and `FakeTwilioAdmin` used wherever `GUEST_TEXTS` isn't `twilio`), and `connectTwilio` / `disconnectTwilio` in `packages/db/src/texts.ts` (the existing `integrations` row; no migration). Tests: `texts-twilio.int.test.ts` (a stand-in Twilio; the token in no response, log line or other table), plus the principal and wall suites, which pick the new routes up from the registry.
  - Cautious defaults: the venue pastes its **Account SID and Auth Token**, not an API key: Twilio recommends API keys for REST calls, but it signs every webhook (incoming texts, status callbacks) with the Auth Token, so we need it anyway. A messaging service is required at Connect, since a 10DLC campaign lives on one. One Twilio account and one number per venue (the existing unique indexes): a second venue on the same account is refused with `account_in_use` before anything at Twilio changes; Twilio subaccounts (the venue's own) are the answer for an owner with two venues.
  - Connect also turns on the service's "use the number's own webhook", so incoming texts reach us whatever the service was set to. Locally (no `PUBLIC_API_URL`) the number's address isn't set.
  - Disconnect doesn't touch the venue's Twilio account (its number still points at us; texts to it are then refused as unknown); the venue changes that in Twilio if it wants. After a disconnect the 30-day body redaction at Twilio can't run for older texts.
  - `twilioIntegration` now reads only a `connected` row. `twilio_error` (502) is a new error code.

### T-02 · Connect your Twilio account on screen: Admin → Phone & texts and step 11

- **Status:** done
- **Size:** M
- **Depends on:** T-01; O-12
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) · Accounts; [Owner onboarding](../spec/17-onboarding.md) · Step details 11; [screens](../screens.md) AdminDesk 33 and Setup 11; [glossary](../glossary.md) · Twilio account
- **Build:**
  - One panel, **Connect your Twilio account**, in Admin → Phone & texts and in step 11 (replacing the Register for texts form): Account SID and Auth Token, **Check**, a number and a messaging service picked from Twilio's lists, **Connect**; then **Not connected**, **Connected · waiting for approval** with **Check again**, or **Approved**, the number, the account's last four characters, a trial warning, **Replace keys** and **Disconnect** (confirmed).
  - The texting number is the connected number, shown, not typed; Admin → Phone & texts keeps the call number.
  - Loading, empty, error and in-use states; English and Spanish; 44 px targets; a link to the venue's guide.
- **Acceptance:**
  - [x] In the demo, a manager connects with test keys, sees waiting for approval, then Approved after Check again, then disconnects (Playwright).
  - [x] Step 11 shows the same panel and the guide link; nothing asks for an EIN.
  - [x] Wrong keys show the error and keep what was typed; the token field is empty after saving.
- **Notes:**
  - Built as one component, `apps/staff/src/screens/admin/TwilioConnect.tsx`, used by Admin → Phone & texts (`Phone.tsx`) and step 11 (`TextsStep.tsx`, whose Register for texts form and its 44 strings are gone). Browser tests: `setup.staff.spec.ts` (step 11: wrong keys, Check, Connect, Check again, Disconnect, no EIN asked) and `staff.spec.ts` (Admin → Phone & texts).
  - The "Text number" field is gone from Admin → Phone & texts: the texting number is the connected one. The `phone.textNumber` setting stays in the schema (nothing reads it any more), so older saved settings still load.
  - The guide is inline (a "How to set up Twilio" list in the panel), since the runbook isn't hosted anywhere a venue can open; the full guide is [texts-10dlc.md](../runbooks/texts-10dlc.md).
  - Disconnect is `POST …/texts/twilio/disconnect` (the staff app's API client has no DELETE).
  - The marketing campaign can't be connected here (Marketing texts stays off until the lawyer answers); its status still shows while that module is on.

### T-03 · Codes, invites and staff texts from the venue's own Twilio, by email until it's live

- **Status:** todo
- **Size:** M
- **Depends on:** T-01; M1-23, O-11, M3-16, M6-20
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) · Accounts; [Tenancy and access](../spec/02-tenancy-access.md) · PINs
- **Build:**
  - The `text.send` job (phone codes, PIN-reset links, invite links, order waiting) sends from the venue's own account and number, through its messaging service, as guest texts do; never from an account of ours.
  - "Texts are live" means connected, and its service campaign approved where the server waits for one (production), and the number allowed (`TEXT_ALLOW_LIST` on staging).
  - Until then: the invite page's phone code goes to the invite's email ("We emailed a code to …"); a PIN reset goes by email; a phone-only team invite is refused (`texts_not_live`: "Add an email · this venue's texts aren't connected yet"); the order-waiting alert goes to the manager on duty as a push; a singer added by staff at the bar is confirmed at once, and the public join page answers `texts_not_live` ("Ask at the bar to join the queue").
  - The demo seed gives West 4 a demo connection (fake account, its texting number, approved), so the demo and the browser tests keep texting through the fake; `scripts/demo-text.mjs` signs with the venue's stored token, and `scripts/demo-codes.sh` still shows every code, texted or emailed.
- **Acceptance:**
  - [ ] With a live connection, a code goes from the venue's own account (its SID and number); without one it goes by email.
  - [ ] A phone-only invite is refused without a live connection; a PIN reset goes by email.
  - [ ] The order-waiting alert goes as a push without a live connection; a staff-added singer is confirmed; a guest's own join is refused with the reason.
  - [ ] The new venue in the browser onboarding test joins with an emailed code.
- **Notes:**

### T-04 · Retire the platform's Twilio pieces

- **Status:** todo
- **Size:** S
- **Depends on:** T-01, T-02, T-03
- **Spec:** [D123](../decisions.md)
- **Build:**
  - Remove Register for texts (`POST /setup/texts/register`, the Trust Hub ISV flow), `TWILIO_PRIMARY_PROFILE_SID`, `TWILIO_ISV_EMAIL`, `twilio:subaccount` and the platform's Twilio account as a sender for venues. The migrations stay as they are; the old `text_registrations` table is left unused.
  - Our own on-call pages (M8-17) text only if `PAGING_TWILIO_ACCOUNT_SID`, `PAGING_TWILIO_AUTH_TOKEN` and `PAGING_TWILIO_FROM_NUMBER` are set; otherwise they go by email, on every server.
  - `twilio:campaign` re-reads a connected venue's campaign with its stored keys (`--venue` only).
  - `.env.example`, CLAUDE.md's commands, the staging secret placeholder and the docs say so.
- **Acceptance:**
  - [ ] No code path reads `TWILIO_PRIMARY_PROFILE_SID`, `TWILIO_ISV_EMAIL` or the platform's `TWILIO_ACCOUNT_SID` for a venue's text.
  - [ ] A server with no Twilio variables at all starts in every environment, and pages go by email.
  - [ ] `pnpm check` and the full browser suite pass.
- **Notes:**
