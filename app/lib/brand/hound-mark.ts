// PLACEHOLDER MARK. Foxhound's logo mark until Dustin picks the real logo
// (capsomer #65 item 15; Dustin: "we will have to do logos later but you can
// just use a hound head or body or something for now").
//
// A hound's head in side profile, facing right: long muzzle, one drooping ear,
// the eye and the ear's front edge cut out. One color, solid shapes, drawn to
// read at 16px.
//
// This module is the ONE source of the mark. Everything else is drawn from it:
//   - HoundMark (app/components/hound-mark.tsx) draws it inline in
//     currentColor, as on the admin shell's family strip;
//   - scripts/build-icons.mjs writes public/favicon.svg from it (the mark in
//     the header band's amber on the dark rounded square), which the footer,
//     the blog author box and the JSON-LD logo point at, and rasterizes that
//     to public/favicon.png and public/apple-touch-icon.png (512, as legacy),
//     which the route splash and the RSS channel image point at.
// The real logo replaces this file and the icons are rebuilt in one change.

/** The mark's own drawing box: a square around the head, on a 32 grid. */
export const HOUND_MARK_VIEWBOX = "6 5 24 24";

/** The head (outer outline), the eye and the ear's front edge, filled evenodd
 *  so the last two cut out of the first. */
export const HOUND_MARK_PATH =
  "M9 9C11 6.4 15 5.8 17.6 7.4C18.6 8 19.2 9 19.8 9.6L26.2 10.6C27.2 9.9 28.8 10.2 29.2 11.6" +
  "C29.5 12.6 29.3 13.6 28.6 14.2C28.9 15.4 28.5 16.6 27.4 17C25.6 17.6 23.8 17.7 22.4 17.5" +
  "C21.4 19.7 19.2 20.1 17.8 19L15 19.2C14.8 22.2 14.2 25 12.9 26.8C11.7 28.4 9.4 28.4 8.4 26.7" +
  "C7 24.1 6.5 19 6.9 14.6C7.1 12.1 7.8 10.4 9 9Z" +
  "M18.4 11.4a1.15 1.15 0 1 0 0.01 0Z" +
  "M12.3 10.6C13.6 13.4 14.1 16.3 13.6 19.5L15 19.3C15.5 16.2 15.1 13.1 13.8 10.2Z";
