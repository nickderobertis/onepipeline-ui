/**
 * The instant the screenshot tier's corpus is written at, and the instant the
 * browser photographing it believes it is.
 *
 * screencomp gates on the content hash of every image, so two captures of one build
 * have to be byte-identical. Three clocks otherwise reach the pixels, and this
 * constant is what replaces all three with one number: the corpus writer's
 * (`fixtures/runs.mjs` stamps the live run a few minutes before "now"), the
 * browser's (a relative reading is computed against `Date.now()`, and a column's
 * clock time against whether that stamp is today), and — indirectly — the server's,
 * because the graph timeline plots an unsettled run out to whichever is later of its
 * last recorded stamp and the `observed_at` the read carried.
 *
 * That last one is why the instant is in the **future** rather than at some tidy date
 * in the past, and it is the whole reason this value looks the way it does. The read
 * API stamps `observed_at` from its own wall clock and there is no flag anywhere that
 * changes that — the surface is held to `docs/contract.md`, and a switch added for a
 * screenshot's convenience would be a contract change rather than a capture decision.
 * So the capture cannot make `observed_at` stand still; what it can do is put the
 * corpus entirely ahead of it, at which point the plotted range is the corpus's own
 * last stamp on every host and the channel's "how long has this been waiting" reading
 * clamps to nothing waiting at all. A near-future instant would do that until the day
 * it passed and then start drifting silently, which is the failure a hash gate is
 * least able to explain, so the instant is far enough out that no host running this
 * can be behind it.
 *
 * Nothing about the year is visible in a shot. Every rendered reading is relative to
 * this same instant — "3 minutes ago", "2 months ago", `Jul 26, 09:00:00` — because
 * `fixtures/runs.mjs` derives the settled runs' age from it too, and a formatter only
 * spells a year out when the stamp is not in the browser's current one. The date and
 * time of day are chosen so the corpus reads exactly as it does under a wall clock:
 * the settled runs land on a round 09:00 two months back.
 */
export const CAPTURE_INSTANT = "2099-09-23T09:00:00.000Z";

/** The same instant as epoch milliseconds, for the browser clock that is set to it. */
export const CAPTURE_INSTANT_MS = Date.parse(CAPTURE_INSTANT);
