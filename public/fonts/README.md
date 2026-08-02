# Display font

The GTA VI wordmark uses a proprietary custom typeface. It is not distributed,
cannot be licensed for a public web project through any normal channel, and is
not included here.

The default stand-in is **Archivo Black** — a heavy geometric grotesque with
wide apertures and the same poster weight — loaded from Google Fonts, with
**Anton** behind it as a narrower alternative.

## Using a font you are licensed for

1. Put the file here, e.g. `public/fonts/display.woff2`
2. Add to the top of `app/globals.css`:

   ```css
   @font-face {
     font-family: 'Display';
     src: url('/fonts/display.woff2') format('woff2');
     font-weight: 400 900;
     font-display: swap;
   }
   ```

3. Put it first in the stack, in the `:root` block:

   ```css
   --font-display: 'Display', 'Archivo Black', 'Anton', Impact, sans-serif;
   ```

Nothing else changes — the wordmark, stage titles and picker headings all read
from that one variable.

## What it drives

    .wordmark        the WINDLAB mark on the first stage
    h2.stage-title   every stage heading
    .picker-card .t  output names on the picker
