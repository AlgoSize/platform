# Visual audits

Two scripts that open the real dashboard in a real browser and measure it.

```
node tests/e2e/visual/audit.mjs           # every view, four widths
node tests/e2e/visual/account-spacing.mjs # the ten Account sections
```

Both need Playwright and a Chromium. This repo already has both under
`tests/e2e`, so run them from there, or set `CHROMIUM_PATH` to a browser
binary:

```
cd tests/e2e
CHROMIUM_PATH=/opt/pw-browsers/chromium node visual/audit.mjs
```

## Why a browser

Horizontal overflow is emergent. It comes from a long unbreakable string,
inside a `white-space: pre` block, inside a grid item whose `min-width`
defaults to `auto` — no single declaration is wrong, and reading the
stylesheet does not find it. The bug that shipped before these existed put
the CI wizard 600px past a phone's viewport, and the scorecard took the whole
page sideways with it. Both were invisible to every existing test.

## Why the fixtures are generated

`tests/fixtures/ui-payloads.json` comes from
`worker/scripts/gen-ui-fixtures.mjs`, which calls each handler through its
real entry point against the real migrations.

This is not fastidiousness. The first version of these audits used
hand-written fixtures, and five of the ten Account sections were rendering
*"this section could not be displayed"* because a payload field is called
`profile` and the fixture said `user`. Every spacing assertion passed —
against error panels. The audits now fail if any panel renders an error,
and the fixtures cannot drift from the handlers without the generator
noticing.

Regenerate after changing any handler's response shape:

```
node worker/scripts/gen-ui-fixtures.mjs
```

## What is asserted

`audit.mjs`, at 360 / 390 / 768 / 1280px, for all eight views:

1. every panel rendered (no error states)
2. the page does not scroll sideways
3. no element spills past the viewport that no ancestor scrolls
4. every control is at least 40px tall — on touch pointers only, since the
   floor is about fingers, not screen width
5. the header is one row, tabs left, quota right-aligned beneath the actions

`account-spacing.mjs`, at 390 and 1280px, for all ten sections:

1. every section rendered
2. every block shares one left edge
3. no two blocks are closer than 8px
4. the vertical rhythm comes from at most two gap values
5. horizontal padding is symmetric
6. nothing overflows the content pane

Deliberately not asserted: pixel positions, screenshots, font sizes. Those
fail on every legitimate design change and teach people to ignore the suite.
