# Design canvas

Sep 29, 2026 · The 27 clickable prototype boards in [`canvas/`](canvas/): how to open them, how each file works, and why they are frozen.

## The canvas is frozen

The canvas is frozen at v39 ([D78](../docs/decisions.md)). Its 27 boards stay as they are, and they were drawn before the Sep 28 decisions.

- **Build to the spec.** Where a board and the [spec](../docs/spec/README.md) differ, the spec wins.
- **The differences are written down.** [Screens](../docs/screens.md) has a section for every board: what it becomes in the product, and build notes that say what to change. Read a board's section before you build its screen. The screens and states the canvas never drew are listed there too, under [Not on the canvas](../docs/screens.md#not-on-the-canvas--build-from-the-spec), each with a spec link.
- **Don't edit or add files in `canvas/`.** If a board is wrong, the fix goes in the spec or in [screens](../docs/screens.md).
- **The boards show an older Friday.** Build and test with the [demo seed](../docs/demo-seed.md). Its section [Where the frozen canvas differs](../docs/demo-seed.md#where-the-frozen-canvas-differs) lists the names and numbers that don't match.
- **Words.** Where a board's wording differs from the [glossary](../docs/glossary.md), use the glossary.

## Open the boards

You need Python 3 and a browser. From the repo root:

```sh
cd design/canvas
python3 -m http.server 8765
```

Then open <http://localhost:8765/Board.dc.html>. If port 8765 is busy, use another number and change the address to match.

Where to start:

- **Desktop app:** `Board.dc.html`. Its left rail links to the other desktop boards.
- **Staff phone:** `Pin.dc.html` (sign in), which leads to `Staff.dc.html`, and from there to Room, Calendar, Messages and Reports.
- **Guest website:** `Main.dc.html`. It links to Menu, Waitlist and Parties.
- **Reached from one or two boards:** Order (from Room), Setup (from Console) and SiteBuilder (from AdminDesk and Setup).
- **Linked from no board:** Rooms, Book, Manage, Admin (phone) and Console. Open them by address, for example `http://localhost:8765/Manage.dc.html`. Rooms and Book are sections of the home page, drawn on their own.

Good to know:

- **Phone boards fill the window.** They are drawn for 390 px wide. Use your browser's phone view, or narrow the window, to see them as drawn. **Desktop boards are fixed** at 1280 × 800 (Bar is 900 × 640) and don't resize, so use a window at least that big.
- **Fonts come from Google Fonts.** Offline, the boards fall back to system fonts.
- **Some pictures are missing.** Main, Menu, Rooms, Setup, SiteBuilder and AdminDesk point at photos and a menu PDF under `/_blob/`. Those files are not in the folder, so the pictures don't show and the menu PDF button goes nowhere.
- **It is all demo data.** The data is typed into each file. Nothing is saved, nothing calls a server, and a reload resets the board. A control that exists only for the demo says "Demo:" on it (for example "Demo: a drawer per person" on Board). Don't build those controls.
- **Some boards read the device clock.** Main's "Open now" and Book's "Tonight" use the real date and time when you open them, so they can show a night that isn't the demo Friday. The product always uses the venue's clock (see F40 in the [finding map](../docs/screens.md#finding-map)).

## The 27 boards

| File | Canvas title | Size | Becomes | Build notes |
| --- | --- | --- | --- | --- |
| **Guest website** | | | | |
| [`Main.dc.html`](canvas/Main.dc.html) | A · Downstairs · phone | 390 × 6400 | Guest web | [Main](../docs/screens.md#main) |
| [`Rooms.dc.html`](canvas/Rooms.dc.html) | A · Section · The rooms | 390 × 1040 | Guest web | [Rooms](../docs/screens.md#rooms) |
| [`Book.dc.html`](canvas/Book.dc.html) | A · Section · Three taps | 390 × 1300 | Guest web | [Book](../docs/screens.md#book) |
| [`Menu.dc.html`](canvas/Menu.dc.html) | A · Menu · phone | 390 × 4800 | Guest web | [Menu](../docs/screens.md#menu) |
| [`Manage.dc.html`](canvas/Manage.dc.html) | A · Change or cancel a booking | 390 × 1100 | Guest web | [Manage](../docs/screens.md#manage) |
| [`Waitlist.dc.html`](canvas/Waitlist.dc.html) | A · Walk-in waitlist · door QR | 390 × 1000 | Guest web | [Waitlist](../docs/screens.md#waitlist) |
| [`Parties.dc.html`](canvas/Parties.dc.html) | A · Private parties | 390 × 4400 | Guest web | [Parties](../docs/screens.md#parties) |
| **Guest phone** | | | | |
| [`Order.dc.html`](canvas/Order.dc.html) | M · Guest · order from the room | 390 × 1180 | Guest web | [Order](../docs/screens.md#order) |
| **Staff phones** | | | | |
| [`Pin.dc.html`](canvas/Pin.dc.html) | M · Staff sign-in | 390 × 760 | Staff app, phone and desktop | [Pin](../docs/screens.md#pin) |
| [`Staff.dc.html`](canvas/Staff.dc.html) | M · Staff portal · tonight | 390 × 1320 | Staff app, phone layout | [Staff](../docs/screens.md#staff) |
| [`Room.dc.html`](canvas/Room.dc.html) | M · Room tab and clock | 390 × 1180 | Staff app, phone layout | [Room](../docs/screens.md#room) |
| [`Calendar.dc.html`](canvas/Calendar.dc.html) | M · Calendar · bookings ahead | 390 × 1180 | Staff app, phone layout | [Calendar](../docs/screens.md#calendar) |
| [`Messages.dc.html`](canvas/Messages.dc.html) | M · Messages · texts | 390 × 1180 | Staff app, phone layout | [Messages](../docs/screens.md#messages) |
| [`Reports.dc.html`](canvas/Reports.dc.html) | M · Reports | 390 × 1180 | Staff app, phone layout | [Reports](../docs/screens.md#reports) |
| [`Admin.dc.html`](canvas/Admin.dc.html) | M · Admin · moved to the desktop app | 390 × 760 | Staff app, phone layout | [Admin](../docs/screens.md#admin) |
| **Desktop app** | | | | |
| [`Board.dc.html`](canvas/Board.dc.html) | D · Desktop app · Tonight board | 1280 × 800 | Staff app in the Electron shell | [Board](../docs/screens.md#board) |
| [`AdminDesk.dc.html`](canvas/AdminDesk.dc.html) | D · Desktop app · Admin | 1280 × 800 | Staff app, desktop layout (Admin) | [AdminDesk](../docs/screens.md#admindesk) |
| [`Night.dc.html`](canvas/Night.dc.html) | D · Desktop app · Close the night | 1280 × 800 | Staff app in the Electron shell | [Night](../docs/screens.md#night) |
| [`Bar.dc.html`](canvas/Bar.dc.html) | D · Bar orders screen · room orders by age | 900 × 640 | Staff app in the Electron shell | [Bar](../docs/screens.md#bar) |
| [`Rail.dc.html`](canvas/Rail.dc.html) | D · Desktop app · Bar POS | 1280 × 800 | Staff app in the Electron shell | [Rail](../docs/screens.md#rail) |
| [`DeskRoom.dc.html`](canvas/DeskRoom.dc.html) | D · Desktop app · Room tab and clock | 1280 × 800 | Staff app in the Electron shell | [DeskRoom](../docs/screens.md#deskroom) |
| [`DeskCalendar.dc.html`](canvas/DeskCalendar.dc.html) | D · Desktop app · Calendar | 1280 × 800 | Staff app in the Electron shell | [DeskCalendar](../docs/screens.md#deskcalendar) |
| [`DeskMessages.dc.html`](canvas/DeskMessages.dc.html) | D · Desktop app · Messages | 1280 × 800 | Staff app in the Electron shell | [DeskMessages](../docs/screens.md#deskmessages) |
| [`DeskReports.dc.html`](canvas/DeskReports.dc.html) | D · Desktop app · Reports | 1280 × 800 | Staff app in the Electron shell | [DeskReports](../docs/screens.md#deskreports) |
| **Product for other venues** | | | | |
| [`Setup.dc.html`](canvas/Setup.dc.html) | P · New venue setup wizard | 1280 × 800 | Staff app and Admin (phase 2) | [Setup](../docs/screens.md#setup) |
| [`SiteBuilder.dc.html`](canvas/SiteBuilder.dc.html) | P · Website builder | 1280 × 800 | Admin (phase 2) | [SiteBuilder](../docs/screens.md#sitebuilder) |
| [`Console.dc.html`](canvas/Console.dc.html) | P · Our control panel · venues, plans, modules | 1280 × 800 | The internal Console | [Console](../docs/screens.md#console) |

Sizes are width × height in pixels, from `canvas/boards.json`. The first letter of a title groups the boards: A is the guest website, M is a phone screen (the guest's Order screen and the staff phone), D is the desktop app and P is the product for other venues.

`boards.json` has two keys: `boards` (the title, width and height of each file) and `order` (the order the boards were laid out on the canvas). No board reads it. Four boards (Admin, Manage, Parties and Pin) carry a different preview height in their own props; use the size in the table.

## Planned but never drawn

The [fix brief](../docs/archive/fix-brief-sep28.md#5-new-boards-file-names-fixed-now-so-everyone-can-link-to-them) named four more boards. They were never drawn, so the folder has no such files. Build each one from the spec.

| File | Planned title | Planned size | Build from |
| --- | --- | --- | --- |
| `SingQueue.dc.html` | A · Bar mode · singer's phone | 390 × 1180 | [N9, the singer's queue page](../docs/screens.md#n9-the-singers-queue-page) |
| `UpNext.dc.html` | D · Up next TV at the bar | 1280 × 720 | [N28, Up next TV](../docs/screens.md#n28-up-next-tv) |
| `Receipt.dc.html` | M · Receipts · printed and web | 390 × 1400 | [N2, receipts, printed and web](../docs/screens.md#n2-receipts-printed-and-web) |
| `KJ.dc.html` | D · Desktop app · Song queue (bar mode) | 1280 × 800 | [N27, KJ song-queue screen](../docs/screens.md#n27-kj-song-queue-screen) |

The same brief planned the guest's join flow, Your bill and Pay my share as states inside Order, and Book's details, consent, payment and confirmation as states inside Book. Those states are not on the boards either. They are [N3](../docs/screens.md#n3-join-a-room), [N5](../docs/screens.md#n5-your-bill), [N6](../docs/screens.md#n6-pay-my-share) and [N1](../docs/screens.md#n1-booking-steps-after-the-price) in screens.

## How a board file works

Each board is one `.dc.html` file: a small component that draws one screen from demo data. All 27 load `support.js`, which holds React and the code that turns a `.dc.html` file into a page. Don't edit it.

A file has three parts: the script tag in the head, the markup inside `<x-dc>`, and a script with the logic. This is the shape, simplified from `Rooms.dc.html` and `Admin.dc.html`:

```html
<head>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=...">
  <style> ...the board's CSS... </style>
</helmet>
<div style="--acc: {{accent}}">
  <div>{{count}} people</div>
  <button onClick="{{inc}}">+</button>
  <sc-if value="{{vip}}"><div>The VIP room, 20 to 40</div></sc-if>
  <sc-for list="{{dots}}" as="d"><span style="{{d.style}}"></span></sc-for>
  <a href="Staff.dc.html">Back to tonight</a>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"accent":{"editor":"color","default":"#D4FF3F"},"$preview":{"width":390,"height":1040}}'>
class Component extends DCLogic {
  constructor() { super(...arguments); this.state = { count: 8 }; }
  renderVals() {
    const count = this.state.count;
    return {
      accent: this.props.accent ?? "#D4FF3F",
      count,
      vip: count >= 20,
      dots: [ /* ...one { style } per dot... */ ],
      inc: () => this.setState({ count: count + 1 })
    };
  }
}
</script>
</body>
```

The rules:

- **`{{holes}}` are plain lookups.** Each one reads a value that `renderVals()` returns. There are no expressions inside `{{ }}`: work everything out in `renderVals()`. A dotted name such as `{{d.style}}` reads a field of the current `<sc-for>` item.
- **`<sc-if value="{{flag}}">`** shows its content when the value is true. **`<sc-for list="{{rows}}" as="r">`** repeats its content for each item. The `hint-placeholder-*` attributes are only for the design tool's preview; ignore them.
- **Events are `onClick="{{fn}}"`.** `fn` is a function that `renderVals()` returns. It usually calls `this.setState(...)`, which redraws the board from a fresh `renderVals()`.
- **Links are plain `<a href="Other.dc.html">`.** There are no imports.
- **Demo data sits in the constructor** (`this.state`). It is typed in, not fetched. To find where something on screen comes from, search the file for the text you see.
- **Settings sit in `static` blocks at the top of the class**, each with the comment "Comes from Admin → <section>. In the app every screen reads the same saved setting." `AdminDesk.dc.html` has `HOURS`, `PHONE`, `PAY`, `CARD_RULES` and `FEATURES`. In the product these values come from the saved Admin settings, never from code.
- **`data-props` lists the knobs the design tool showed.** Every board has `accent`. AdminDesk also has `plan` (Bar, Rooms or Rooms + Kitchen) and Main has `catalog` (the song list from Playbox loaded or not). `$preview` is the frame size. A plain server uses each prop's `default`. To see another state, copy the board and `support.js` to a folder outside the repo and change the `default`.
- **Desktop boards** have a fixed root, and scroll inside their panels, never the page. **Phone boards** are 390 wide and fluid.

## The look on the boards

The spec doesn't describe the look, so this is what the boards use.

- **Fonts,** all from Google Fonts: Bricolage Grotesque for headlines (weight 800, narrow, uppercase, tight), Instrument Sans for text and Space Mono for small labels.
- **Colors:** page `#0b0a0d` (`#07060a` on Rooms and Book), text `#F4F1EA`, muted text `#8E8994`. The Menu board is the exception: white with dark text.
- **Accent:** lime `#D4FF3F`. Every board takes an `accent` prop, and the other options are pink `#FF3DA6`, cyan `#3DF2FF` and amber `#FFB13D`.
- **Amber is a warning and pink is urgent.** On the Board, a room that must wrap up is amber, and a room that is needed now or closed is pink. Order ages follow the same rule: amber at 2 minutes and pink at 4 (see [the escalation sentence](../docs/glossary.md#the-escalation-sentence)).
