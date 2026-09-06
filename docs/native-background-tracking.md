# Background tracking: what it would take to make the app work like Life360

Written September 2026, after HR asked why the km stops when an engineer closes
the app.

## The short version

The app is a web page. Life360 and Find My are native apps. A web page cannot
be granted the permission that lets those two follow a phone with the screen
off, on either platform — so this is not something that can be fixed in
`index.html`. It needs the app to stop being only a web page.

The cheapest route that actually works is an **Android-only Capacitor wrapper**,
distributed as an APK straight to engineers. No app store, no yearly fee,
nothing recurring. iPhone is the expensive part and the decision worth taking
separately.

## Why the current app stops

| Platform | What happens when the app is closed or the screen locks |
|---|---|
| iOS (Safari / home-screen app) | JavaScript is suspended. `watchPosition` stops firing. Apple has never shipped background geolocation for web apps and there is no API to request it. |
| Android (Chrome / installed PWA) | The page is suspended the same way. Service workers — the only thing that keeps running — have **no access to the Geolocation API**. Periodic Background Sync exists but grants no location and fires at intervals measured in hours. |

The app already takes a **screen wake lock** during a trip, which keeps the
screen on and the page in the foreground. That is the whole of the current
defence, and it holds until the engineer switches to another app or pockets the
phone.

Since the change of September 2026 the app at least *notices*: it records how
long tracking stopped and how far the phone moved in a straight line, tells the
engineer on his way back in, and shows HR a "Not tracked" column so a short
trip is explained rather than quietly wrong. That distance is never added to
the paid figure — see the note on guessing, below.

## What a wrapper changes

[Capacitor](https://capacitorjs.com/) packages the existing `index.html` as a
real native app. The web code is kept exactly as it is; it gains the ability to
call native APIs. A background-geolocation plugin then holds the same
"Always Allow" permission Life360 uses, and keeps delivering positions with the
app closed and the screen off.

Nothing in `shared/report-logic.js` changes. `trackingStep` still decides what
counts as driving; it simply starts receiving fixes it currently never sees.

## The work, honestly

This is a project, not an afternoon.

1. **Add Capacitor to the repo.** This introduces `package.json`, a build step
   and a `node_modules` — the first the project has had. Worth knowing, because
   "no build step" is currently one of its better properties, and the web app
   should keep deploying to Vercel exactly as it does now.
2. **Pick and wire a background-geolocation plugin.** The plugin delivers
   positions to the same code path `watchPosition` feeds today, so
   `trackingStep` needs no changes.
3. **Handle the permission conversation.** Android requires an explicit
   "Allow all the time" grant, shows a persistent notification while tracking,
   and periodically reminds the user. This is by design and cannot be hidden —
   plan on telling the engineers what the app does rather than hoping they do
   not notice.
4. **Battery.** Continuous background GPS is the heaviest thing a phone does.
   Expect real complaints unless the plugin's distance filter and accuracy are
   tuned down from their defaults.
5. **Test on real handsets.** Chinese Android skins (Xiaomi, Oppo, Vivo,
   Realme — very common on field staff phones) kill background services
   aggressively and each needs the app whitelisted in its own battery settings
   screen. This is usually the largest single source of "it stopped working"
   after launch.
6. **Distribution and updates.** An APK sent directly means you also own
   getting the next version onto forty phones. The web app updates itself on
   refresh; a native app does not.

## Cost

| | Android | iPhone |
|---|---|---|
| Developer account | Not needed for direct APK. Google Play is a one-time registration fee (about $25) only if you want store distribution. | **Apple Developer Program, about $99 a year.** Required to put an app on an iPhone at all — there is no free path. |
| Recurring cost | **None** | **Yearly, forever** |

Verify both figures before committing; they are stable but not fixed by law.

The iPhone line is the one that conflicts with the decision taken earlier this
year to keep the app free of recurring costs. If the field engineers are on
Android — which is worth confirming before anything else — the whole problem
can be solved for nothing ongoing.

## What to check before starting

1. **What phones do the field engineers actually carry?** If they are all
   Android, this is a contained project with no recurring cost. If some are on
   iPhone, decide whether those engineers keep using the web app (with the
   wake lock and the gap warnings) while Android gets background tracking.
2. **Is the gap actually costing much?** The "Not tracked" column now measures
   this. A month of it will say whether the losses justify the project, or
   whether telling engineers to keep the screen open was enough.

That second point is the reason the gap measurement shipped first. It turns
"the km looks low" into a number, and a number is what should decide whether
to spend the effort.

## What will not change, whatever is built

The straight-line distance across a gap stays out of the paid figure. Nobody
measured that stretch — not the route taken, not whether the engineer drove out
and came back to nearly the same place — and a figure that becomes somebody's
reimbursement should not be a guess. A native app removes most gaps; it does
not make the remaining ones measurable after the fact.
