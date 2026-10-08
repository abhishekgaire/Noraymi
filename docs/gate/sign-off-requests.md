# The sign-off requests (M9-13)

Ready for the founder to send on day one, one per adviser. Each asks for the answer **in writing**, and says what we built while waiting so the adviser can say "keep it" or "change it". Fill in the adviser's name and the date when sending, and set the rows in [sign-offs.md](sign-offs.md) to `sent`. These letters ask; they don't answer anything.

## To the accountant

We're opening a point-of-sale system at West 4 Boho Karaoke (186 W 4th St, New York). Before the first live night we need your written answer to two questions. While we wait, the system does what's in brackets.

1. **S1.** Are room time, damage fees, kept deposits and no-show charges taxable, is the gratuity exempt, and does each kept deposit need its own check number? [Room time, drinks and damage are taxed at 8.875%; kept deposits and no-show charges are not; the automatic gratuity is not; each kept deposit is its own check with its own number.]
2. **S2.** Which business date gets sales made after midnight on the nights a sales-tax quarter ends (Nov 30, Feb 28 or 29, May 31, Aug 31)? [They belong to the business date they were sold on, the night before, and the quarter report shows them on their own line.]

## To the lawyer

The same system, at the same venue. Seven questions, each answered in writing; while we wait, the system does what's in brackets.

1. **S3.** How is drinking-up time measured: from the county close (4 AM) even when the house last call is earlier, and for how long? [30 minutes, counted from the earlier of 4 AM and the house's own last call.]
2. **S4.** Do NYC's proposed junk-fee rules cover an automatic gratuity? [Prices on the site and the booking page read "plus tax and gratuity".]
3. **S5.** Can gratuity refunded after a pool was paid out come off the next pool? [No: the house absorbs it.]
4. **S6.** Which occupations share tips at West 4, in what shares, and is checking tip-credit coverage our report or payroll's job? [One pool split by minutes worked among eligible staff; the payroll export marks any shift whose tips fall under the tip credit, for payroll to check.]
5. **S7.** May the automatic room gratuity be pooled by hours across all eligible staff, given that 146-2.18 ties a gratuity to the employees who provided the service? [It's pooled by hours worked at West 4; the venue can switch to "the room's server" from the next business date.]
6. **S8.** How long may scanned ID fields be kept, may they be shared (is handing them to NYPD "dissemination" under §65-b?), and may a banned list use them? [Name, date of birth, ID number and expiry are kept 7 days, encrypted, then deleted; they're never shared and no banned list uses them.]
7. **S9.** Who tells whom after a breach, as written into the data processing addendum? [We tell the venue's owner immediately, within 72 hours at most; the venue tells affected New York residents and the state within 30 days (GBL §899-aa).]

## To the PCI assessor (QSA)

1. **S10.** Which PCI validation do we file, and what script-protection confirmation do we give venues? [Card readers are Stripe Terminal, server-driven, and card data never reaches our servers; online payments use Stripe's Payment Element on its own origin. Our draft: SAQ P2PE for the readers, SAQ A online, and a written confirmation of the payment page's script protection for each venue (`docs/security/pci-responsibility.md`).]
