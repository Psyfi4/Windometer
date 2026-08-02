# Display font

## What ships

**Jost** — an open, OFL-licensed geometric in the Futura lineage, loaded from
Google Fonts, with **Poppins** behind it. Weight 700 by default.

## What does not, and why

The GTA Art Deco family (drawn by Colophon Foundry for Rockstar Games,
(c) November 2023) carries this in its own `name` table, ID 13:

> By using GTAArtDeco you agree to their use solely on Rockstar Games, Inc.
> related brand materials and will not use them for any other purpose
> whatsoever.
>
> You must not modify, adapt, alter, convert, translate or otherwise change
> GTAArtDeco font software.
>
> You must not send or share GTAArtDeco with any persons or organisation, or
> any third party who is not commissioned by, or directly associated with,
> Rockstar Games, Inc.

Adding it to this project would breach all three: the project is not Rockstar
brand material, converting TTF to woff2 is prohibited, and committing it to a
public repository served over the web redistributes it to every visitor.

Do not add it.

## Matching the proportions

Measured from the original, if you are evaluating another face:

    O advance          0.788 em     near-square, the geometric signature
    H advance          0.666 em
    M advance          0.778 em
    W advance          0.908 em
    cap height         0.700 em
    x-height           0.520 em
    x-height / cap     0.743        low; grotesques sit nearer 0.80

A low x-height-to-cap ratio with a circular O is what separates a deco
geometric from a grotesque like Archivo Black. Jost, Poppins, Outfit and
Questrial are all in the right family; Montserrat and Archivo are not.

Colophon Foundry sell retail faces in the same idiom if you want something
closer and are willing to license it properly.

## Using a face you are licensed for

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

3. Put it first in the stack, in `:root`:

   ```css
   --font-display: 'Display', 'Jost', 'Poppins', system-ui, sans-serif;
   ```

Tracking and weight are separate variables, since a licensed face may want
different values:

    --display-weight: 700;
    --display-track: -0.01em;

## What it drives

    .wordmark        the WINDLAB mark on the first stage
    h2.stage-title   every stage heading
    .picker-card .t  output names on the picker
