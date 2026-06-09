// Static outlet → political-lean lookup, derived from AllSides / Ad Fontes
// public ratings. Used to label sources so the sidebar can show spectrum
// diversity. Outlets not in this table fall back to "Unrated".

const LEAN_BY_DOMAIN = {
  // Wire services
  "apnews.com": "Center",
  "reuters.com": "Center",
  "afp.com": "Center",
  "upi.com": "Center",

  // Broadcast / radio
  "abcnews.go.com": "Lean Left",
  "cbsnews.com": "Lean Left",
  "nbcnews.com": "Lean Left",
  "today.com": "Lean Left",
  "cnn.com": "Lean Left",
  "msnbc.com": "Left",
  "foxnews.com": "Right",
  "foxbusiness.com": "Lean Right",
  "oann.com": "Right",
  "newsmax.com": "Right",
  "pbs.org": "Center",
  "npr.org": "Lean Left",
  "cspan.org": "Center",
  "bbc.com": "Center",
  "bbc.co.uk": "Center",
  "sky.com": "Center",
  "aljazeera.com": "Lean Left",
  "dw.com": "Center",

  // Major national print / digital
  "nytimes.com": "Lean Left",
  "washingtonpost.com": "Lean Left",
  "wsj.com": "Lean Right",
  "usatoday.com": "Center",
  "nypost.com": "Lean Right",
  "washingtontimes.com": "Lean Right",

  // Digital-native news
  "axios.com": "Center",
  "thehill.com": "Center",
  "politico.com": "Lean Left",
  "bloomberg.com": "Lean Left",
  "time.com": "Lean Left",
  "newsweek.com": "Center",
  "businessinsider.com": "Lean Left",
  "cnbc.com": "Center",
  "marketwatch.com": "Center",
  "realclearpolitics.com": "Lean Right",

  // Center / investigative
  "propublica.org": "Center",
  "csmonitor.com": "Center",
  "economist.com": "Center",
  "ft.com": "Center",
  "militarytimes.com": "Center",
  "stateline.org": "Center",

  // Lean Left
  "theguardian.com": "Lean Left",
  "theatlantic.com": "Lean Left",
  "newyorker.com": "Lean Left",
  "latimes.com": "Lean Left",
  "slate.com": "Lean Left",
  "vice.com": "Lean Left",
  "buzzfeednews.com": "Lean Left",
  "rollingstone.com": "Lean Left",
  "vanityfair.com": "Lean Left",
  "wired.com": "Lean Left",
  "huffpost.com": "Left",
  "miamiherald.com": "Lean Left",
  "bostonglobe.com": "Lean Left",
  "seattletimes.com": "Lean Left",
  "startribune.com": "Lean Left",
  "baltimoresun.com": "Lean Left",
  "sfgate.com": "Lean Left",
  "oregonlive.com": "Lean Left",
  "tampabay.com": "Center",
  "dallasnews.com": "Center",
  "chicagotribune.com": "Center",
  "denverpost.com": "Center",

  // Left
  "vox.com": "Left",
  "salon.com": "Left",
  "motherjones.com": "Left",
  "thenation.com": "Left",
  "theintercept.com": "Left",
  "dailykos.com": "Left",
  "commondreams.org": "Left",
  "truthout.org": "Left",
  "democracynow.org": "Left",
  "jacobinmag.com": "Left",
  "alternet.org": "Left",

  // Lean Right
  "nationalreview.com": "Lean Right",
  "forbes.com": "Lean Right",
  "washingtonexaminer.com": "Lean Right",
  "reason.com": "Lean Right",
  "thedispatch.com": "Lean Right",
  "spectator.org": "Lean Right",
  "americanthinker.com": "Lean Right",
  "hotair.com": "Lean Right",
  "pjmedia.com": "Lean Right",
  "theepochtimes.com": "Lean Right",

  // Right
  "breitbart.com": "Right",
  "dailywire.com": "Right",
  "thefederalist.com": "Right",
  "townhall.com": "Right",
  "redstate.com": "Right",
  "westernjournal.com": "Right",
  "gatewaypundit.com": "Right",
  "wnd.com": "Right",
  "twitchy.com": "Right",

  // Sports (lean labels reflect political bias in non-sports coverage; sports
  // outlets are rated Center as they have no meaningful political lean)
  "espn.com": "Center",
  "nba.com": "Center",
  "nfl.com": "Center",
  "mlb.com": "Center",
  "nhl.com": "Center",
  "sports.yahoo.com": "Center",
  "sportingnews.com": "Center",
  "bleacherreport.com": "Center",
  "theathletic.com": "Lean Left",
  "cbssports.com": "Center",
  "nbcsports.com": "Center",
  "foxsports.com": "Center",
  "si.com": "Center",
  "mysanantonio.com": "Center",
  "statesman.com": "Center",
  "expressnews.com": "Center",

  // International
  "spiegel.de": "Lean Left",
  "lemonde.fr": "Lean Left",
  "telegraph.co.uk": "Lean Right",
  "dailymail.co.uk": "Right",
  "independent.co.uk": "Lean Left",
  "thesun.co.uk": "Right",
};

// Domains that count as primary sources: government data, official wire
// services (origin of record for breaking news), and authoritative
// intergovernmental bodies. Media outlets — even reliable ones — do not
// qualify regardless of reputation.
const PRIMARY_SOURCE_DOMAINS = [
  // Wire services (origin-of-record for news)
  "apnews.com",
  "reuters.com",
  // US government
  ".gov",
  // Academic / research
  ".edu",
  // Intergovernmental bodies
  "who.int",
  "un.org",
  "worldbank.org",
  "imf.org",
  "icrc.org",
  // Legal / regulatory primary documents
  "courtlistener.com",
  "congress.gov",
  "supremecourt.gov",
  "federalregister.gov",
  "sec.gov",
  // Official statistical agencies (also covered by .gov, belt+suspenders)
  "census.gov",
  "bls.gov",
  "cdc.gov",
  "nih.gov",
];

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getLean(url) {
  const domain = getDomain(url);
  return LEAN_BY_DOMAIN[domain] || "Unrated";
}

function isPrimarySource(url) {
  const domain = getDomain(url);
  return PRIMARY_SOURCE_DOMAINS.some((suffix) =>
    suffix.startsWith(".") ? domain.endsWith(suffix) : domain === suffix
  );
}

module.exports = { getDomain, getLean, isPrimarySource };
