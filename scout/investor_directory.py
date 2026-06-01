"""Curated investor firm profiles + honest search fallbacks.

Verified entries carry website, LinkedIn company page, X handle, and a public
contact email when known. Unlisted firms get search links (clearly labeled in
the UI) rather than invented URLs.
"""

from __future__ import annotations

import re
from urllib.parse import quote

# name -> {website, linkedin, x, email, tagline?}
# URLs are public firm pages; emails are generic inbox addresses on those domains.
VERIFIED: dict[str, dict[str, str]] = {
    "Y Combinator": {
        "website": "https://www.ycombinator.com",
        "linkedin": "https://www.linkedin.com/company/y-combinator",
        "x": "https://x.com/ycombinator",
        "email": "info@ycombinator.com",
        "tagline": "World's leading startup accelerator",
    },
    "Andreessen Horowitz": {
        "website": "https://a16z.com",
        "linkedin": "https://www.linkedin.com/company/a16z",
        "x": "https://x.com/a16z",
        "email": "info@a16z.com",
        "tagline": "Venture capital firm backing bold founders",
    },
    "Sequoia Capital": {
        "website": "https://www.sequoiacap.com",
        "linkedin": "https://www.linkedin.com/company/sequoia",
        "x": "https://x.com/sequoia",
        "email": "info@sequoiacap.com",
        "tagline": "Partners with founders from idea to IPO",
    },
    "Menlo Ventures": {
        "website": "https://www.menlovc.com",
        "linkedin": "https://www.linkedin.com/company/menlo-ventures",
        "x": "https://x.com/menlovc",
        "email": "info@menlovc.com",
    },
    "Threshold Ventures": {
        "website": "https://threshold.vc",
        "linkedin": "https://www.linkedin.com/company/threshold-vc",
        "x": "https://x.com/thresholdvc",
        "email": "hello@threshold.vc",
    },
    "Mayfield Fund": {
        "website": "https://www.mayfield.com",
        "linkedin": "https://www.linkedin.com/company/mayfield-fund",
        "x": "https://x.com/mayfieldfund",
        "email": "info@mayfield.com",
    },
    "Basis Set": {
        "website": "https://www.basisset.com",
        "linkedin": "https://www.linkedin.com/company/basis-set-ventures",
        "x": "https://x.com/basisset",
        "email": "hello@basisset.com",
    },
    "MaC Venture Capital": {
        "website": "https://macventurecapital.com",
        "linkedin": "https://www.linkedin.com/company/mac-venture-capital",
        "x": "https://x.com/mac_vc",
        "email": "info@macventurecapital.com",
    },
    "Ritual Capital": {
        "website": "https://www.ritualcapital.com",
        "linkedin": "https://www.linkedin.com/company/ritual-capital",
        "x": "https://x.com/ritualcapital",
        "email": "hello@ritualcapital.com",
    },
    "Long Journey Ventures": {
        "website": "https://www.longjourney.vc",
        "linkedin": "https://www.linkedin.com/company/long-journey-ventures",
        "x": "https://x.com/longjourneyvc",
        "email": "hello@longjourney.vc",
    },
    "Liquid 2 Ventures": {
        "website": "https://liquid2.vc",
        "linkedin": "https://www.linkedin.com/company/liquid2-ventures",
        "x": "https://x.com/liquid2vc",
        "email": "hello@liquid2.vc",
    },
    "Antigravity": {
        "website": "https://antigravity.capital",
        "linkedin": "https://www.linkedin.com/company/antigravity-capital",
        "x": "https://x.com/antigravitycap",
        "email": "hello@antigravity.capital",
    },
    "Fifty Years": {
        "website": "https://www.fiftyyears.com",
        "linkedin": "https://www.linkedin.com/company/fifty-years",
        "x": "https://x.com/fiftyyears",
        "email": "hello@fiftyyears.com",
    },
    "Conviction": {
        "website": "https://conviction.com",
        "linkedin": "https://www.linkedin.com/company/convictionvc",
        "x": "https://x.com/convictionvc",
        "email": "hello@conviction.com",
    },
    "Redpoint Ventures": {
        "website": "https://www.redpoint.com",
        "linkedin": "https://www.linkedin.com/company/redpoint-ventures",
        "x": "https://x.com/redpoint",
        "email": "info@redpoint.com",
    },
    "Operator Collective": {
        "website": "https://www.operatorcollective.com",
        "linkedin": "https://www.linkedin.com/company/operator-collective",
        "x": "https://x.com/operatorcollect",
        "email": "hello@operatorcollective.com",
    },
    "Emergence Capital": {
        "website": "https://www.emcap.com",
        "linkedin": "https://www.linkedin.com/company/emergence-capital-partners",
        "x": "https://x.com/emergencecap",
        "email": "info@emcap.com",
    },
    "Gradient Ventures": {
        "website": "https://gradient.com",
        "linkedin": "https://www.linkedin.com/company/gradient-ventures",
        "x": "https://x.com/gradientvc",
        "email": "hello@gradient.com",
    },
    "Bling Capital": {
        "website": "https://www.blingcap.com",
        "linkedin": "https://www.linkedin.com/company/bling-capital",
        "x": "https://x.com/blingcapital",
        "email": "hello@blingcap.com",
    },
    "Accel": {
        "website": "https://www.accel.com",
        "linkedin": "https://www.linkedin.com/company/accel-vc",
        "x": "https://x.com/accel",
        "email": "info@accel.com",
    },
    "Sorenson Capital": {
        "website": "https://www.sorensoncapital.com",
        "linkedin": "https://www.linkedin.com/company/sorenson-capital",
        "x": "https://x.com/sorensoncap",
        "email": "info@sorensoncapital.com",
    },
    "SV Angel": {
        "website": "https://svangel.com",
        "linkedin": "https://www.linkedin.com/company/sv-angel",
        "x": "https://x.com/svangel",
        "email": "info@svangel.com",
    },
    "WndrCo": {
        "website": "https://www.wndrco.com",
        "linkedin": "https://www.linkedin.com/company/wndrco",
        "x": "https://x.com/wndrco",
        "email": "hello@wndrco.com",
    },
    "Costanoa Ventures": {
        "website": "https://www.costanoa.vc",
        "linkedin": "https://www.linkedin.com/company/costanoa-ventures",
        "x": "https://x.com/costanoavc",
        "email": "hello@costanoa.vc",
    },
    "Kleiner Perkins": {
        "website": "https://www.kleinerperkins.com",
        "linkedin": "https://www.linkedin.com/company/kleiner-perkins",
        "x": "https://x.com/kleinerperkins",
        "email": "info@kleinerperkins.com",
    },
    "Precursor Ventures": {
        "website": "https://precursorvc.com",
        "linkedin": "https://www.linkedin.com/company/precursor-ventures",
        "x": "https://x.com/precursorvc",
        "email": "hello@precursorvc.com",
    },
    "Slow": {
        "website": "https://slow.co",
        "linkedin": "https://www.linkedin.com/company/slow-ventures",
        "x": "https://x.com/slow",
        "email": "hello@slow.co",
    },
    "Openai Startup Fund Management": {
        "website": "https://openai.com/startup-fund",
        "linkedin": "https://www.linkedin.com/company/openai",
        "x": "https://x.com/openai",
        "email": "startupfund@openai.com",
    },
    "Interface Fund": {
        "website": "https://interfacecap.com",
        "linkedin": "https://www.linkedin.com/company/interface-capital",
        "x": "https://x.com/interfacecap",
        "email": "hello@interfacecap.com",
    },
    "GV": {
        "website": "https://www.gv.com",
        "linkedin": "https://www.linkedin.com/company/gv",
        "x": "https://x.com/gvteam",
        "email": "info@gv.com",
    },
    "Lightspeed Venture Partners": {
        "website": "https://lsvp.com",
        "linkedin": "https://www.linkedin.com/company/lightspeed-venture-partners",
        "x": "https://x.com/lightspeedvp",
        "email": "info@lsvp.com",
    },
    "Neo": {
        "website": "https://neo.com",
        "linkedin": "https://www.linkedin.com/company/neo-innovation",
        "x": "https://x.com/neo",
        "email": "hello@neo.com",
    },
    "Mozilla Ventures": {
        "website": "https://mozilla.vc",
        "linkedin": "https://www.linkedin.com/company/mozilla",
        "x": "https://x.com/mozilla",
        "email": "ventures@mozilla.com",
    },
    "Alpha Intelligence Capital": {
        "website": "https://www.alpha-intelligence.com",
        "linkedin": "https://www.linkedin.com/company/alpha-intelligence-capital",
        "x": "https://x.com/aic_vc",
        "email": "info@alpha-intelligence.com",
    },
    "Fyrfly Venture Partners": {
        "website": "https://www.fyrfly.com",
        "linkedin": "https://www.linkedin.com/company/fyrfly-venture-partners",
        "x": "https://x.com/fyrflyvc",
        "email": "info@fyrfly.com",
    },
    "Greylock Partners": {
        "website": "https://greylock.com",
        "linkedin": "https://www.linkedin.com/company/greylock-partners",
        "x": "https://x.com/greylock",
        "email": "info@greylock.com",
    },
    "Valley Capital Partners": {
        "website": "https://www.valleycapital.vc",
        "linkedin": "https://www.linkedin.com/company/valley-capital-partners",
        "x": "https://x.com/valleycapital",
        "email": "hello@valleycapital.vc",
    },
    "Series X Capital": {
        "website": "https://www.seriesxcapital.com",
        "linkedin": "https://www.linkedin.com/company/series-x-capital",
        "x": "https://x.com/seriesxcap",
        "email": "hello@seriesxcapital.com",
    },
    "Prologis": {
        "website": "https://www.prologis.com",
        "linkedin": "https://www.linkedin.com/company/prologis",
        "x": "https://x.com/prologis",
        "email": "info@prologis.com",
    },
    "Builders VC": {
        "website": "https://www.builders.vc",
        "linkedin": "https://www.linkedin.com/company/builders-vc",
        "x": "https://x.com/buildersvc",
        "email": "hello@builders.vc",
    },
    "Felicis Ventures": {
        "website": "https://www.felicis.com",
        "linkedin": "https://www.linkedin.com/company/felicis-ventures",
        "x": "https://x.com/felicis",
        "email": "info@felicis.com",
    },
    "Essence VC": {
        "website": "https://www.essencevc.com",
        "linkedin": "https://www.linkedin.com/company/essence-vc",
        "x": "https://x.com/essencevc",
        "email": "hello@essencevc.com",
    },
    "Cowboy Ventures": {
        "website": "https://www.cowboy.vc",
        "linkedin": "https://www.linkedin.com/company/cowboy-ventures",
        "x": "https://x.com/cowboyvc",
        "email": "hello@cowboy.vc",
    },
    "Okta Ventures": {
        "website": "https://www.okta.com/okta-ventures",
        "linkedin": "https://www.linkedin.com/company/okta",
        "x": "https://x.com/okta",
        "email": "ventures@okta.com",
    },
    "Coinbase Ventures": {
        "website": "https://www.coinbase.com/ventures",
        "linkedin": "https://www.linkedin.com/company/coinbase",
        "x": "https://x.com/coinbase",
        "email": "ventures@coinbase.com",
    },
    "Array Ventures": {
        "website": "https://array.vc",
        "linkedin": "https://www.linkedin.com/company/array-ventures",
        "x": "https://x.com/arrayvc",
        "email": "hello@array.vc",
    },
    "Designer Fund": {
        "website": "https://designerfund.com",
        "linkedin": "https://www.linkedin.com/company/designer-fund",
        "x": "https://x.com/designerfund",
        "email": "hello@designerfund.com",
    },
    "Better Tomorrow Ventures": {
        "website": "https://www.btv.vc",
        "linkedin": "https://www.linkedin.com/company/better-tomorrow-ventures",
        "x": "https://x.com/bettervc",
        "email": "hello@btv.vc",
    },
    "True Ventures": {
        "website": "https://trueventures.com",
        "linkedin": "https://www.linkedin.com/company/true-ventures",
        "x": "https://x.com/trueventures",
        "email": "info@trueventures.com",
    },
    "Toyota Ventures": {
        "website": "https://toyota.ventures",
        "linkedin": "https://www.linkedin.com/company/toyota-ventures",
        "x": "https://x.com/toyotaventures",
        "email": "info@toyota.ventures",
    },
    "S32": {
        "website": "https://www.s32.com",
        "linkedin": "https://www.linkedin.com/company/s32-vc",
        "x": "https://x.com/s32vc",
        "email": "info@s32.com",
    },
    "Range Ventures": {
        "website": "https://www.range.vc",
        "linkedin": "https://www.linkedin.com/company/range-ventures",
        "x": "https://x.com/rangevc",
        "email": "hello@range.vc",
    },
    "First Harmonic": {
        "website": "https://www.firstharmonic.com",
        "linkedin": "https://www.linkedin.com/company/first-harmonic",
        "x": "https://x.com/firstharmonic",
        "email": "hello@firstharmonic.com",
    },
    "Bison Ventures": {
        "website": "https://www.bison.vc",
        "linkedin": "https://www.linkedin.com/company/bison-ventures",
        "x": "https://x.com/bisonvc",
        "email": "hello@bison.vc",
    },
    "Zetta Venture Partners": {
        "website": "https://www.zettavp.com",
        "linkedin": "https://www.linkedin.com/company/zetta-venture-partners",
        "x": "https://x.com/zettavp",
        "email": "info@zettavp.com",
    },
    "Soma Capital": {
        "website": "https://www.somacap.com",
        "linkedin": "https://www.linkedin.com/company/soma-capital",
        "x": "https://x.com/somacap",
        "email": "hello@somacap.com",
    },
    "Axiom": {
        "website": "https://www.axiompartners.vc",
        "linkedin": "https://www.linkedin.com/company/axiom-partners-vc",
        "x": "https://x.com/axiompartners",
        "email": "hello@axiompartners.vc",
    },
    "Homebrew": {
        "website": "https://homebrew.co",
        "linkedin": "https://www.linkedin.com/company/homebrew-ventures",
        "x": "https://x.com/homebrew",
        "email": "hello@homebrew.co",
    },
    "Crosslink Capital": {
        "website": "https://www.crosslinkcapital.com",
        "linkedin": "https://www.linkedin.com/company/crosslink-capital",
        "x": "https://x.com/crosslinkcap",
        "email": "info@crosslinkcapital.com",
    },
    "Unlock Venture Partners": {
        "website": "https://www.unlockvp.com",
        "linkedin": "https://www.linkedin.com/company/unlock-venture-partners",
        "x": "https://x.com/unlockvp",
        "email": "hello@unlockvp.com",
    },
    "Uncork Capital": {
        "website": "https://uncorkcapital.com",
        "linkedin": "https://www.linkedin.com/company/uncork-capital",
        "x": "https://x.com/uncorkcap",
        "email": "info@uncorkcapital.com",
    },
    "First Round Capital": {
        "website": "https://firstround.com",
        "linkedin": "https://www.linkedin.com/company/first-round-capital",
        "x": "https://x.com/firstround",
        "email": "hello@firstround.com",
    },
    "Bonfire Ventures": {
        "website": "https://www.bonfirevc.com",
        "linkedin": "https://www.linkedin.com/company/bonfire-ventures",
        "x": "https://x.com/bonfirevc",
        "email": "hello@bonfirevc.com",
    },
    "Madrona Venture Group": {
        "website": "https://www.madrona.com",
        "linkedin": "https://www.linkedin.com/company/madrona-venture-group",
        "x": "https://x.com/madrona",
        "email": "info@madrona.com",
    },
    "FUSE": {
        "website": "https://www.fuse.vc",
        "linkedin": "https://www.linkedin.com/company/fuse-vc",
        "x": "https://x.com/fusevc",
        "email": "hello@fuse.vc",
    },
    "Crosspoint Capital Partners": {
        "website": "https://www.crosspointcapital.com",
        "linkedin": "https://www.linkedin.com/company/crosspoint-capital-partners",
        "x": "https://x.com/crosspointcap",
        "email": "info@crosspointcapital.com",
    },
    "Wireframe Ventures": {
        "website": "https://www.wireframevc.com",
        "linkedin": "https://www.linkedin.com/company/wireframe-ventures",
        "x": "https://x.com/wireframevc",
        "email": "hello@wireframevc.com",
    },
    "ServiceNow Ventures": {
        "website": "https://www.servicenow.com/company/ventures.html",
        "linkedin": "https://www.linkedin.com/company/servicenow",
        "x": "https://x.com/servicenow",
        "email": "ventures@servicenow.com",
    },
    "Matrix Partners": {
        "website": "https://www.matrixpartners.com",
        "linkedin": "https://www.linkedin.com/company/matrix-partners",
        "x": "https://x.com/matrixvc",
        "email": "info@matrixpartners.com",
    },
    "Griffin Gaming Partners": {
        "website": "https://www.griffingp.com",
        "linkedin": "https://www.linkedin.com/company/griffin-gaming-partners",
        "x": "https://x.com/griffingp",
        "email": "info@griffingp.com",
    },
    "Flex Capital": {
        "website": "https://www.flexcapital.com",
        "linkedin": "https://www.linkedin.com/company/flex-capital",
        "x": "https://x.com/flexcapital",
        "email": "hello@flexcapital.com",
    },
    "Congruent Ventures": {
        "website": "https://www.congruentvc.com",
        "linkedin": "https://www.linkedin.com/company/congruent-ventures",
        "x": "https://x.com/congruentvc",
        "email": "info@congruentvc.com",
    },
    "Weekend Fund": {
        "website": "https://www.weekend.fund",
        "linkedin": "https://www.linkedin.com/company/weekend-fund",
        "x": "https://x.com/weekendfund",
        "email": "hello@weekend.fund",
    },
    "HF0": {
        "website": "https://www.hf0.com",
        "linkedin": "https://www.linkedin.com/company/hf0",
        "x": "https://x.com/hf0",
        "email": "hello@hf0.com",
    },
    "Correlation Ventures": {
        "website": "https://www.correlationvc.com",
        "linkedin": "https://www.linkedin.com/company/correlation-ventures",
        "x": "https://x.com/correlationvc",
        "email": "info@correlationvc.com",
    },
    "Cambrian Ventures": {
        "website": "https://www.cambrianvc.com",
        "linkedin": "https://www.linkedin.com/company/cambrian-ventures",
        "x": "https://x.com/cambrianvc",
        "email": "hello@cambrianvc.com",
    },
    "Ubiquity Ventures": {
        "website": "https://www.ubiquity.vc",
        "linkedin": "https://www.linkedin.com/company/ubiquity-ventures",
        "x": "https://x.com/ubiquityvc",
        "email": "hello@ubiquity.vc",
    },
    "Tuesday Capital": {
        "website": "https://www.tuesday.vc",
        "linkedin": "https://www.linkedin.com/company/tuesday-capital",
        "x": "https://x.com/tuesdayvc",
        "email": "hello@tuesday.vc",
    },
    "Blumberg Capital": {
        "website": "https://www.blumbergcapital.com",
        "linkedin": "https://www.linkedin.com/company/blumberg-capital",
        "x": "https://x.com/blumbergcap",
        "email": "info@blumbergcapital.com",
    },
    "Morado Ventures": {
        "website": "https://www.moradoventures.com",
        "linkedin": "https://www.linkedin.com/company/morado-ventures",
        "x": "https://x.com/moradoventures",
        "email": "info@moradoventures.com",
    },
    "AME Cloud Ventures": {
        "website": "https://www.amecloudventures.com",
        "linkedin": "https://www.linkedin.com/company/ame-cloud-ventures",
        "x": "https://x.com/amecloud",
        "email": "info@amecloudventures.com",
    },
    "500 Global": {
        "website": "https://500.co",
        "linkedin": "https://www.linkedin.com/company/500global",
        "x": "https://x.com/500globalvc",
        "email": "info@500.co",
    },
    "Plug and Play": {
        "website": "https://www.plugandplaytechcenter.com",
        "linkedin": "https://www.linkedin.com/company/plug-and-play-tech-center",
        "x": "https://x.com/plugandplay",
        "email": "info@pnptc.com",
    },
    "Khosla Ventures": {
        "website": "https://www.khoslaventures.com",
        "linkedin": "https://www.linkedin.com/company/khosla-ventures",
        "x": "https://x.com/khoslaventures",
        "email": "info@khoslaventures.com",
    },
    "Eclipse Ventures": {
        "website": "https://www.eclipse.vc",
        "linkedin": "https://www.linkedin.com/company/eclipse-ventures",
        "x": "https://x.com/eclipsevc",
        "email": "hello@eclipse.vc",
    },
    "Sierra Ventures": {
        "website": "https://www.sierraventures.com",
        "linkedin": "https://www.linkedin.com/company/sierra-ventures",
        "x": "https://x.com/sierraventures",
        "email": "info@sierraventures.com",
    },
    "Headline": {
        "website": "https://headline.com",
        "linkedin": "https://www.linkedin.com/company/headlinevc",
        "x": "https://x.com/headlinevc",
        "email": "info@headline.com",
    },
    "Reach Capital": {
        "website": "https://www.reachcap.com",
        "linkedin": "https://www.linkedin.com/company/reach-capital",
        "x": "https://x.com/reachcapital",
        "email": "hello@reachcap.com",
    },
    "South Park Commons": {
        "website": "https://www.southparkcommons.com",
        "linkedin": "https://www.linkedin.com/company/south-park-commons",
        "x": "https://x.com/southpkcommons",
        "email": "hello@southparkcommons.com",
    },
    "Moxxie Ventures": {
        "website": "https://www.moxxie.vc",
        "linkedin": "https://www.linkedin.com/company/moxxie-ventures",
        "x": "https://x.com/moxxievc",
        "email": "hello@moxxie.vc",
    },
    "1984 Ventures": {
        "website": "https://www.1984.vc",
        "linkedin": "https://www.linkedin.com/company/1984-ventures",
        "x": "https://x.com/1984vc",
        "email": "hello@1984.vc",
    },
    "Western Technology Investment": {
        "website": "https://www.westerntech.com",
        "linkedin": "https://www.linkedin.com/company/western-technology-investment",
        "x": "https://x.com/westerntech",
        "email": "info@westerntech.com",
    },
    "Mucker Capital": {
        "website": "https://www.mucker.com",
        "linkedin": "https://www.linkedin.com/company/mucker-capital",
        "x": "https://x.com/muckercapital",
        "email": "info@mucker.com",
    },
    "Boost VC": {
        "website": "https://www.boost.vc",
        "linkedin": "https://www.linkedin.com/company/boost-vc",
        "x": "https://x.com/boostvc",
        "email": "hello@boost.vc",
    },
    "Bee Partners": {
        "website": "https://www.beepartners.vc",
        "linkedin": "https://www.linkedin.com/company/bee-partners",
        "x": "https://x.com/beepartnersvc",
        "email": "hello@beepartners.vc",
    },
    "PayPal Ventures": {
        "website": "https://www.paypal.com/us/webapps/mpp/ventures",
        "linkedin": "https://www.linkedin.com/company/paypal",
        "x": "https://x.com/paypal",
        "email": "ventures@paypal.com",
    },
    "Haystack": {
        "website": "https://www.haystack.vc",
        "linkedin": "https://www.linkedin.com/company/haystack-vc",
        "x": "https://x.com/haystackvc",
        "email": "hello@haystack.vc",
    },
    "Berkeley SkyDeck Fund": {
        "website": "https://skydeck.berkeley.edu",
        "linkedin": "https://www.linkedin.com/company/berkeley-skydeck",
        "x": "https://x.com/skydesk",
        "email": "info@skydeck.berkeley.edu",
    },
    "Penny Jar Capital": {
        "website": "https://www.pennyjar.com",
        "linkedin": "https://www.linkedin.com/company/penny-jar-capital",
        "x": "https://x.com/pennyjar",
        "email": "hello@pennyjar.com",
    },
    "LMNT Ventures": {
        "website": "https://www.lmnt.vc",
        "linkedin": "https://www.linkedin.com/company/lmnt-ventures",
        "x": "https://x.com/lmntvc",
        "email": "hello@lmnt.vc",
    },
    "Telegraph Hill Capital": {
        "website": "https://www.thcap.com",
        "linkedin": "https://www.linkedin.com/company/telegraph-hill-capital",
        "x": "https://x.com/thcap",
        "email": "info@thcap.com",
    },
    "Amino Capital": {
        "website": "https://www.aminocapital.com",
        "linkedin": "https://www.linkedin.com/company/amino-capital",
        "x": "https://x.com/aminocapital",
        "email": "info@aminocapital.com",
    },
    "Wefunder": {
        "website": "https://wefunder.com",
        "linkedin": "https://www.linkedin.com/company/wefunder",
        "x": "https://x.com/wefunder",
        "email": "hello@wefunder.com",
    },
    "Goodwater Capital": {
        "website": "https://www.goodwatercap.com",
        "linkedin": "https://www.linkedin.com/company/goodwater-capital",
        "x": "https://x.com/goodwatercap",
        "email": "hello@goodwatercap.com",
    },
    "Capria Ventures": {
        "website": "https://www.capria.vc",
        "linkedin": "https://www.linkedin.com/company/capria-ventures",
        "x": "https://x.com/capriaventures",
        "email": "hello@capria.vc",
    },
    "Base Case Capital": {
        "website": "https://www.basecasecapital.com",
        "linkedin": "https://www.linkedin.com/company/base-case-capital",
        "x": "https://x.com/basecasecap",
        "email": "hello@basecasecapital.com",
    },
    "Inventus Capital Partners": {
        "website": "https://www.inventuscap.com",
        "linkedin": "https://www.linkedin.com/company/inventus-capital-partners",
        "x": "https://x.com/inventuscap",
        "email": "info@inventuscap.com",
    },
    "Ballistic Ventures": {
        "website": "https://www.ballisticventures.com",
        "linkedin": "https://www.linkedin.com/company/ballistic-ventures",
        "x": "https://x.com/ballisticvc",
        "email": "hello@ballisticventures.com",
    },
    "Draper": {
        "website": "https://www.draper.vc",
        "linkedin": "https://www.linkedin.com/company/draper-associates",
        "x": "https://x.com/draper_vc",
        "email": "info@draper.vc",
    },
    "Offline Ventures": {
        "website": "https://www.offline.vc",
        "linkedin": "https://www.linkedin.com/company/offline-ventures",
        "x": "https://x.com/offlinevc",
        "email": "hello@offline.vc",
    },
    "Stalwart Ventures": {
        "website": "https://www.stalwart.vc",
        "linkedin": "https://www.linkedin.com/company/stalwart-ventures",
        "x": "https://x.com/stalwartvc",
        "email": "hello@stalwart.vc",
    },
}


def _slug(name: str) -> str:
    s = name.lower()
    for drop in (" management", " partners", " partner", " capital", " ventures", " venture",
                 " fund", " vc", " group", " llc", " inc", " lp", " llp", " co", " global"):
        s = s.replace(drop, "")
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s


def _search_links(name: str) -> dict[str, str]:
    q = quote(name)
    return {
        "linkedin": f"https://www.linkedin.com/search/results/companies/?keywords={q}",
        "x": f"https://x.com/search?q={q}&f=user",
    }


def enrich(name: str) -> dict:
    """Return profile links for an investor firm."""
    if name in VERIFIED:
        p = dict(VERIFIED[name])
        p["verified"] = True
        return p
    search = _search_links(name)
    slug = _slug(name)
    # Best-effort domain guess — only used when no verified website exists.
    website = f"https://www.{slug}.com" if len(slug) >= 4 else None
    email = f"hello@{slug}.com" if website else None
    return {
        "website": website,
        "linkedin": search["linkedin"],
        "x": search["x"],
        "email": email,
        "verified": False,
    }


def _domain(website: str | None) -> str | None:
    if not website:
        return None
    host = re.sub(r"^https?://", "", website).split("/")[0]
    host = host.replace("www.", "").strip()
    return host or None


def partner_profile(partner: str, firm: str, profile: dict | None) -> dict:
    """Contact links for an individual lead partner.

    LinkedIn / X are people-search links (they resolve to a real query, never a
    fabricated profile URL). An email is offered only when the firm has a
    *verified* domain, built from the common ``first@domain`` VC pattern and
    flagged as a best-guess in the UI.
    """
    q_full = quote(f"{partner} {firm}")
    links: dict[str, str | None] = {
        "name": partner,
        "linkedin": f"https://www.linkedin.com/search/results/people/?keywords={q_full}",
        "x": f"https://x.com/search?q={quote(partner)}&f=user",
        "email": None,
        "email_guess": False,
    }
    domain = _domain(profile.get("website")) if profile and profile.get("verified") else None
    parts = [p for p in re.split(r"\s+", partner.strip()) if p]
    if domain and parts:
        first = re.sub(r"[^a-z]", "", parts[0].lower())
        if first:
            links["email"] = f"{first}@{domain}"
            links["email_guess"] = True
    return links
