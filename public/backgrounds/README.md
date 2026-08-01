# Backdrop photographs (optional)

The backdrop draws a vector wind-turbine scene for each station by default.
No photographs ship with this project: a photograph of a specific wind farm
carries licensing that would have to travel with the repository, and the drawn
scenes let each station take its own palette.

If you hold rights to photographs you would rather use, put them here as
`<slug>.jpg` and list the slugs in `manifest.json`:

    public/backgrounds/
      manifest.json      ["tuticorin", "mormugao"]
      tuticorin.jpg
      mormugao.jpg

Slugs, matching the six stations in the study:

    tuticorin  calcutta  ahmedabad  jaipur  madras  mormugao

Any station listed in the manifest uses its photograph; the rest keep the drawn
scene, so a partial set is fine. Landscape images around 1600×900 or larger
work best — they are cropped to fill and sit behind a heavy scrim, so fine
detail is lost either way.

Without a `manifest.json` the app makes one request, gets a 404, and quietly
uses the drawn scenes.
