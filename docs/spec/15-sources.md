## Sources

Product decisions, New York rules and prices come from the [blueprint](../blueprint.md), and [decisions](../decisions.md) records each decision and why. The Sep 26 fixes came from the [gap review](../archive/gap-review-sep26.md), and the Sep 29 revision from the [fix brief](../archive/fix-brief-sep28.md) and the Sep 28 reviews of [completeness](../archive/review-completeness-sep28.md), [flows](../archive/review-flows-sep28.md) and [competitors](../archive/review-competitive-sep28.md). The GA- codes are the items of the [Karaoke bar POS gap analysis](../archive/research/karaoke-bar-pos-gap-analysis.md). The Stripe details below were checked against Stripe's docs on Sep 26, 2026.

**Stripe**

- [Use Terminal with Connect: direct charges](https://docs.stripe.com/terminal/features/connect?connect-charge-type=direct)
- [Connect and the Accounts v2 API](https://docs.stripe.com/connect/accounts-v2) and [US tax reporting for Connect platforms](https://docs.stripe.com/connect/tax-reporting)
- [Set up a server-driven integration](https://docs.stripe.com/terminal/payments/setup-integration?terminal-sdk-platform=server-driven) and [collect card payments, server-driven](https://docs.stripe.com/terminal/payments/collect-card-payment?terminal-sdk-platform=server-driven)
- [Design a Terminal integration](https://docs.stripe.com/terminal/designing-integration)
- [Configure the cellular network](https://docs.stripe.com/terminal/fleet/cellular) and [network transitions on cellular readers](https://docs.stripe.com/terminal/features/operate-offline/network-transitions)
- [Incremental authorizations](https://docs.stripe.com/terminal/features/incremental-authorizations) and [extended authorizations](https://docs.stripe.com/terminal/features/extended-authorizations)
- [On-reader tips](https://docs.stripe.com/terminal/features/collecting-tips/on-reader) and [on-receipt tips](https://docs.stripe.com/terminal/features/collecting-tips/on-receipt)
- [Collect on-screen inputs, server-driven](https://docs.stripe.com/terminal/features/collect-inputs?terminal-sdk-platform=server-driven)
- [Save card details after a payment](https://docs.stripe.com/terminal/features/saving-payment-details/save-after-payment?terminal-sdk-platform=server-driven) and [save a card during payment](https://docs.stripe.com/payments/save-during-payment?payment-ui=elements)
- [Collect surcharges](https://docs.stripe.com/payments/cards/surcharge)
- [Offline payments on smart readers](https://docs.stripe.com/terminal/features/operate-offline/overview?reader-type=internet) and [collecting card payments while offline](https://docs.stripe.com/terminal/features/operate-offline/collect-card-payments?terminal-sdk-platform=android)
- [Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [Connect webhooks](https://docs.stripe.com/connect/webhooks) and [receiving webhooks](https://docs.stripe.com/webhooks)
- [Restricted API keys](https://docs.stripe.com/keys/restricted-api-keys) and [API key best practices](https://docs.stripe.com/keys-best-practices)
- [Refunds](https://docs.stripe.com/refunds), [disputes through the API](https://docs.stripe.com/disputes/api) and [card testing](https://docs.stripe.com/disputes/prevention/card-testing)
- [Payout reconciliation through the API](https://docs.stripe.com/payouts/reconciliation)
- [Rate limits](https://docs.stripe.com/rate-limits)
- [In-person payments without code](https://docs.stripe.com/no-code/in-person)
- [PCI compliance for Stripe Terminal](https://support.stripe.com/questions/pci-compliance-for-stripe-terminal)
- [Stripe Billing subscriptions](https://docs.stripe.com/billing/subscriptions/overview)
- [Stripe pricing](https://stripe.com/pricing)

**Laws and standards**

- New York: [ABC Law §106](https://www.nysenate.gov/legislation/laws/ABC/106), [§117-a](https://www.nysenate.gov/legislation/laws/ABC/117-A) and [§65-b](https://www.nysenate.gov/legislation/laws/ABC/65-B); [GBL §518](https://www.nysenate.gov/legislation/laws/GBS/518), [§396-ii](https://www.nysenate.gov/legislation/laws/GBS/396-II), [§399-z](https://www.nysenate.gov/legislation/laws/GBS/399-Z), [§899-aa](https://www.nysenate.gov/legislation/laws/GBS/899-AA) and [§899-bb](https://www.nysenate.gov/legislation/laws/GBS/899-BB); [credit card surcharge guidance](https://dos.ny.gov/credit-card-surcharge-guidance)
- New York tax and wages: [sales by restaurants and bars](https://www.tax.ny.gov/pubs_and_bulls/tg_bulletins/st/sales_by_restaurants.htm), [card convenience fees](https://tax.ny.gov/pdf/advisory_opinions/sales/a18_1s.pdf), [filing periods](https://www.tax.ny.gov/pubs_and_bulls/tg_bulletins/st/filing_period_indicators_on_final_sales_tax_returns.htm); Hospitality Wage Order [146-2.14](https://www.law.cornell.edu/regulations/new-york/12-NYCRR-146-2.14), [146-2.17](https://www.law.cornell.edu/regulations/new-york/12-NYCRR-146-2.17) and [146-2.18](https://www.law.cornell.edu/regulations/new-york/12-NYCRR-146-2.18)
- New York labor: [Labor Law §201-a](https://www.nysenate.gov/legislation/laws/LAB/201-A), which bars requiring employees to be fingerprinted
- Federal: [IRS tip recordkeeping](https://www.irs.gov/businesses/small-businesses-self-employed/tip-recordkeeping-and-reporting) and [Rev. Rul. 2012-18](https://www.irs.gov/pub/irs-drop/rr-12-18.pdf); [47 CFR 64.1200](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200); [ADA web guidance](https://www.ada.gov/resources/web-guidance/)
- Standards: [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/), [PCI SSC on SAQ A](https://blog.pcisecuritystandards.org/important-updates-announced-for-merchants-validating-to-self-assessment-questionnaire-a), [WCAG 2.2](https://www.w3.org/TR/WCAG22/)

**Other**

- [PostgreSQL 16: row security policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html), [NOTIFY](https://www.postgresql.org/docs/16/sql-notify.html) and [invalid or ambiguous timestamps](https://www.postgresql.org/docs/16/datetime-invalid-input.html); [PgBouncer features](https://www.pgbouncer.org/features.html)
- [Star CloudPRNT](https://star-m.jp/products/s_print/CloudPRNTSDK/Documentation/en/index.html) and [Epson Server Direct Print](https://download4.epson.biz/sec_pubs/pos/reference_en/technology/server_direct_print.html)
- [Twilio: preventing messaging fraud](https://www.twilio.com/docs/messaging/guides/preventing-messaging-fraud) and [A2P 10DLC for software platforms](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [AWS us-east-1 event summary](https://aws.amazon.com/message/101925/)

**Staff screens research**

- The full study: [Staff-first bar POS design](../archive/research/staff-first-bar-pos-design.md)
- Noise: [Scott 2018, noise in New York City restaurants and bars](https://file.scirp.org/Html/5-1761957_86590.htm)
- Wet screens: [Tung, Goel, Zinda and Wobbrock, ICMI 2018](https://faculty.washington.edu/wobbrock/pubs/icmi-18.01.pdf)
- Sign-in time: [Harbach et al., SOUPS 2014](https://www.usenix.org/system/files/conference/soups2014/soups14-paper-harbach.pdf); tap latency: [Jota et al., CHI 2013](https://www.tactuallabs.com/papers/howFastIsFastEnoughCHI13.pdf)
- Turnover: [BLS JOLTS, quits by industry](https://www.bls.gov/news.release/jolts.t18.htm)
- Badges: [NXP NTAG 424 DNA](https://www.nxp.com/products/NTAG424DNA)
- How others do it: Toast on [held cards](https://support.toasttab.com/en/article/Card-Pre-Authorization-FAQs), [quick cash](https://support.toasttab.com/en/article/Taking-Payments) and [tips on closed checks](https://support.toasttab.com/en/article/Adjust-Tips-on-a-Closed-Check); Square on [bar-tab holds](https://squareup.com/help/us/en/article/8455-enable-and-configure-preauthorization-for-bar-tabs) and [settling tips](https://squareup.com/help/us/en/article/8375-settle-payments-and-manage-tips)
