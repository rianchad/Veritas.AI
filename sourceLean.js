// Outlet credibility lookup table. Keyed by normalized outlet name (lowercase,
// trimmed). lean matches the labels the API returns. tier: 1 = major wire
// services / flagship public broadcasters, 2 = major national outlets,
// 3 = regional / partisan / lower-traffic / aggregator.

const OUTLET_DATA = new Map([
  [
    "ap",
    {
      lean: "Center",
      tier: 1,
      allSides: "Center",
      description:
        "International wire service, founded 1846; widely syndicated across US and global media.",
    },
  ],
  [
    "associated press",
    {
      lean: "Center",
      tier: 1,
      allSides: "Center",
      description:
        "International wire service, founded 1846; widely syndicated across US and global media.",
    },
  ],
  [
    "reuters",
    {
      lean: "Center",
      tier: 1,
      allSides: "Center",
      description:
        "Global wire service headquartered in London; known for financial and breaking news coverage.",
    },
  ],
  [
    "bbc",
    {
      lean: "Center",
      tier: 1,
      allSides: "Center",
      description:
        "UK public broadcaster, founded 1927; one of the world's largest news organizations.",
    },
  ],
  [
    "bbc news",
    {
      lean: "Center",
      tier: 1,
      allSides: "Center",
      description:
        "UK public broadcaster, founded 1927; one of the world's largest news organizations.",
    },
  ],
  [
    "npr",
    {
      lean: "Lean Left",
      tier: 1,
      allSides: "Lean Left",
      description:
        "US nonprofit public radio network; flagship programs include Morning Edition and All Things Considered.",
    },
  ],
  [
    "pbs",
    {
      lean: "Center",
      tier: 1,
      allSides: "Center",
      description:
        "US public television broadcaster; NewsHour is its flagship nightly news program.",
    },
  ],
  [
    "pbs newshour",
    {
      lean: "Center",
      tier: 1,
      allSides: "Center",
      description:
        "US public television broadcaster; NewsHour is its flagship nightly news program.",
    },
  ],
  [
    "cnn",
    {
      lean: "Left",
      tier: 2,
      allSides: "Left",
      description: "US 24-hour cable news network, founded 1980; headquartered in Atlanta.",
    },
  ],
  [
    "fox news",
    {
      lean: "Right",
      tier: 2,
      allSides: "Right",
      description:
        "US 24-hour cable news network, founded 1996; leading cable news outlet by viewership.",
    },
  ],
  [
    "msnbc",
    {
      lean: "Left",
      tier: 2,
      allSides: "Left",
      description:
        "US cable news network with progressive commentary programming; sister channel to NBC News.",
    },
  ],
  [
    "nyt",
    {
      lean: "Lean Left",
      tier: 2,
      allSides: "Lean Left",
      description:
        "US daily newspaper, founded 1851; Pulitzer Prize-winning national and international coverage.",
    },
  ],
  [
    "new york times",
    {
      lean: "Lean Left",
      tier: 2,
      allSides: "Lean Left",
      description:
        "US daily newspaper, founded 1851; Pulitzer Prize-winning national and international coverage.",
    },
  ],
  [
    "wsj",
    {
      lean: "Lean Right",
      tier: 2,
      allSides: "Lean Right",
      description: "US business and financial daily newspaper, founded 1889; owned by News Corp.",
    },
  ],
  [
    "wall street journal",
    {
      lean: "Lean Right",
      tier: 2,
      allSides: "Lean Right",
      description: "US business and financial daily newspaper, founded 1889; owned by News Corp.",
    },
  ],
  [
    "washington post",
    {
      lean: "Lean Left",
      tier: 2,
      allSides: "Lean Left",
      description:
        "US daily newspaper based in DC, founded 1877; known for investigative and political reporting.",
    },
  ],
  [
    "the guardian",
    {
      lean: "Left",
      tier: 2,
      allSides: "Left",
      description:
        "UK-based progressive daily newspaper, founded 1821; global English-language readership.",
    },
  ],
  [
    "guardian",
    {
      lean: "Left",
      tier: 2,
      allSides: "Left",
      description:
        "UK-based progressive daily newspaper, founded 1821; global English-language readership.",
    },
  ],
  [
    "politico",
    {
      lean: "Center",
      tier: 2,
      allSides: "Center",
      description:
        "US politics and policy news outlet, founded 2007; known for insider DC coverage.",
    },
  ],
  [
    "the hill",
    {
      lean: "Center",
      tier: 2,
      allSides: "Center",
      description: "US political newspaper covering Congress and the White House; launched 1994.",
    },
  ],
  [
    "axios",
    {
      lean: "Center",
      tier: 2,
      allSides: "Center",
      description: "US digital news outlet founded 2017; known for brief 'smart brevity' format.",
    },
  ],
  [
    "breitbart",
    {
      lean: "Right",
      tier: 3,
      allSides: "Right",
      description: "US far-right news and opinion website, founded 2007 by Andrew Breitbart.",
    },
  ],
  [
    "breitbart news",
    {
      lean: "Right",
      tier: 3,
      allSides: "Right",
      description: "US far-right news and opinion website, founded 2007 by Andrew Breitbart.",
    },
  ],
  [
    "huffpost",
    {
      lean: "Left",
      tier: 2,
      allSides: "Left",
      description:
        "US progressive digital outlet, founded 2005 as The Huffington Post; owned by BuzzFeed.",
    },
  ],
  [
    "huffington post",
    {
      lean: "Left",
      tier: 2,
      allSides: "Left",
      description:
        "US progressive digital outlet, founded 2005 as The Huffington Post; owned by BuzzFeed.",
    },
  ],
  [
    "daily wire",
    {
      lean: "Right",
      tier: 3,
      allSides: "Right",
      description:
        "US conservative media company founded 2015 by Ben Shapiro; commentary-heavy output.",
    },
  ],
  [
    "the daily wire",
    {
      lean: "Right",
      tier: 3,
      allSides: "Right",
      description:
        "US conservative media company founded 2015 by Ben Shapiro; commentary-heavy output.",
    },
  ],
  [
    "newsweek",
    {
      lean: "Center",
      tier: 2,
      allSides: "Center",
      description: "US weekly news magazine, founded 1933; now primarily a digital outlet.",
    },
  ],
  [
    "time",
    {
      lean: "Center",
      tier: 2,
      allSides: "Center",
      description:
        "US weekly news magazine, founded 1923; known for Person of the Year and long-form features.",
    },
  ],
  [
    "time magazine",
    {
      lean: "Center",
      tier: 2,
      allSides: "Center",
      description:
        "US weekly news magazine, founded 1923; known for Person of the Year and long-form features.",
    },
  ],
  [
    "bloomberg",
    {
      lean: "Center",
      tier: 2,
      allSides: "Center",
      description:
        "US financial and business news organization, founded 1981; also operates a global TV network.",
    },
  ],
  [
    "bloomberg news",
    {
      lean: "Center",
      tier: 2,
      allSides: "Center",
      description:
        "US financial and business news organization, founded 1981; also operates a global TV network.",
    },
  ],
  [
    "the atlantic",
    {
      lean: "Lean Left",
      tier: 2,
      allSides: "Lean Left",
      description:
        "US monthly magazine, founded 1857; known for long-form essays on politics and culture.",
    },
  ],
  [
    "atlantic",
    {
      lean: "Lean Left",
      tier: 2,
      allSides: "Lean Left",
      description:
        "US monthly magazine, founded 1857; known for long-form essays on politics and culture.",
    },
  ],
  [
    "new yorker",
    {
      lean: "Left",
      tier: 2,
      allSides: "Left",
      description:
        "US magazine, founded 1925; noted for investigative journalism, fiction, and cultural criticism.",
    },
  ],
  [
    "the new yorker",
    {
      lean: "Left",
      tier: 2,
      allSides: "Left",
      description:
        "US magazine, founded 1925; noted for investigative journalism, fiction, and cultural criticism.",
    },
  ],
  [
    "vox",
    {
      lean: "Left",
      tier: 2,
      allSides: "Left",
      description: "US explanatory journalism outlet, founded 2014; part of Vox Media.",
    },
  ],
  [
    "vice",
    {
      lean: "Left",
      tier: 2,
      allSides: "Left",
      description:
        "US digital media company founded 1994; known for youth-focused news and documentary content.",
    },
  ],
  [
    "vice news",
    {
      lean: "Left",
      tier: 2,
      allSides: "Left",
      description:
        "US digital media company founded 1994; known for youth-focused news and documentary content.",
    },
  ],
  [
    "buzzfeed news",
    {
      lean: "Left",
      tier: 3,
      allSides: "Left",
      description:
        "US digital news division of BuzzFeed, closed in 2023; known for breaking investigations.",
    },
  ],
  [
    "abc news",
    {
      lean: "Lean Left",
      tier: 2,
      allSides: "Lean Left",
      description: "US broadcast television news division of ABC, a Disney subsidiary.",
    },
  ],
  [
    "cbs news",
    {
      lean: "Lean Left",
      tier: 2,
      allSides: "Lean Left",
      description: "US broadcast television news division of CBS, part of Paramount Global.",
    },
  ],
  [
    "nbc news",
    {
      lean: "Lean Left",
      tier: 2,
      allSides: "Lean Left",
      description: "US broadcast television news division of NBC, part of NBCUniversal.",
    },
  ],
  [
    "usa today",
    {
      lean: "Center",
      tier: 2,
      allSides: "Center",
      description:
        "US national daily newspaper, founded 1982; largest print circulation in the US.",
    },
  ],
  [
    "new york post",
    {
      lean: "Right",
      tier: 2,
      allSides: "Right",
      description:
        "US tabloid newspaper, founded 1801; owned by News Corp; conservative editorial stance.",
    },
  ],
  [
    "ny post",
    {
      lean: "Right",
      tier: 2,
      allSides: "Right",
      description:
        "US tabloid newspaper, founded 1801; owned by News Corp; conservative editorial stance.",
    },
  ],
  [
    "daily mail",
    {
      lean: "Right",
      tier: 3,
      allSides: "Right",
      description:
        "UK tabloid newspaper, founded 1896; one of the world's most-visited English news sites.",
    },
  ],
  [
    "al jazeera",
    {
      lean: "Center",
      tier: 2,
      allSides: "Center",
      description:
        "Qatar-based international news network, founded 1996; broad Middle East and global coverage.",
    },
  ],
  [
    "al jazeera english",
    {
      lean: "Center",
      tier: 2,
      allSides: "Center",
      description:
        "Qatar-based international news network, founded 1996; broad Middle East and global coverage.",
    },
  ],
  [
    "der spiegel",
    {
      lean: "Center",
      tier: 2,
      allSides: null,
      description:
        "Germany's largest weekly news magazine, founded 1947; known for investigative reporting.",
    },
  ],
  [
    "spiegel",
    {
      lean: "Center",
      tier: 2,
      allSides: null,
      description:
        "Germany's largest weekly news magazine, founded 1947; known for investigative reporting.",
    },
  ],
  [
    "financial times",
    {
      lean: "Center",
      tier: 1,
      allSides: "Center",
      description:
        "UK international business newspaper, founded 1888; known for its distinctive pink pages.",
    },
  ],
  [
    "ft",
    {
      lean: "Center",
      tier: 1,
      allSides: "Center",
      description:
        "UK international business newspaper, founded 1888; known for its distinctive pink pages.",
    },
  ],
  [
    "the economist",
    {
      lean: "Center",
      tier: 1,
      allSides: "Center",
      description:
        "UK weekly magazine, founded 1843; covers economics, politics, and international affairs.",
    },
  ],
  [
    "economist",
    {
      lean: "Center",
      tier: 1,
      allSides: "Center",
      description:
        "UK weekly magazine, founded 1843; covers economics, politics, and international affairs.",
    },
  ],
  [
    "propublica",
    {
      lean: "Lean Left",
      tier: 2,
      allSides: "Lean Left",
      description:
        "US nonprofit investigative newsroom, founded 2007; Pulitzer Prize-winning accountability journalism.",
    },
  ],
  [
    "the intercept",
    {
      lean: "Left",
      tier: 3,
      allSides: "Left",
      description:
        "US nonprofit digital outlet, founded 2014; known for national security and civil liberties reporting.",
    },
  ],
  [
    "intercept",
    {
      lean: "Left",
      tier: 3,
      allSides: "Left",
      description:
        "US nonprofit digital outlet, founded 2014; known for national security and civil liberties reporting.",
    },
  ],
  [
    "mother jones",
    {
      lean: "Left",
      tier: 3,
      allSides: "Left",
      description:
        "US progressive nonprofit magazine, founded 1976; known for investigative and political journalism.",
    },
  ],
  [
    "national review",
    {
      lean: "Right",
      tier: 3,
      allSides: "Right",
      description:
        "US conservative magazine, founded 1955 by William F. Buckley Jr.; influential in conservative thought.",
    },
  ],
  [
    "the federalist",
    {
      lean: "Right",
      tier: 3,
      allSides: "Right",
      description:
        "US conservative online magazine, founded 2013; focused on culture, politics, and religion.",
    },
  ],
  [
    "federalist",
    {
      lean: "Right",
      tier: 3,
      allSides: "Right",
      description:
        "US conservative online magazine, founded 2013; focused on culture, politics, and religion.",
    },
  ],
  [
    "reason",
    {
      lean: "Center",
      tier: 3,
      allSides: "Center",
      description:
        "US libertarian magazine and website, founded 1968; published by the Reason Foundation.",
    },
  ],
  [
    "slate",
    {
      lean: "Left",
      tier: 2,
      allSides: "Left",
      description:
        "US online magazine, founded 1996; known for analysis, commentary, and cultural criticism.",
    },
  ],
  [
    "salon",
    {
      lean: "Left",
      tier: 3,
      allSides: "Left",
      description:
        "US progressive online magazine, founded 1995; heavy commentary on politics and culture.",
    },
  ],
  [
    "daily beast",
    {
      lean: "Left",
      tier: 3,
      allSides: "Left",
      description:
        "US digital news outlet, founded 2008; known for political scoops and entertainment coverage.",
    },
  ],
  [
    "the daily beast",
    {
      lean: "Left",
      tier: 3,
      allSides: "Left",
      description:
        "US digital news outlet, founded 2008; known for political scoops and entertainment coverage.",
    },
  ],
  [
    "mediaite",
    {
      lean: "Center",
      tier: 3,
      allSides: null,
      description:
        "US media criticism and news outlet, founded 2009; focuses on media and politics.",
    },
  ],
  [
    "realclearpolitics",
    {
      lean: "Lean Right",
      tier: 3,
      allSides: "Lean Right",
      description: "US political news aggregator and polling average site, founded 2000.",
    },
  ],
  [
    "real clear politics",
    {
      lean: "Lean Right",
      tier: 3,
      allSides: "Lean Right",
      description: "US political news aggregator and polling average site, founded 2000.",
    },
  ],
  [
    "the dispatch",
    {
      lean: "Lean Right",
      tier: 3,
      allSides: null,
      description:
        "US center-right newsletter and podcast network, founded 2019 by Jonah Goldberg and Steve Hayes.",
    },
  ],
  [
    "dispatch",
    {
      lean: "Lean Right",
      tier: 3,
      allSides: null,
      description:
        "US center-right newsletter and podcast network, founded 2019 by Jonah Goldberg and Steve Hayes.",
    },
  ],
  [
    "ground news",
    {
      lean: "Center",
      tier: 3,
      allSides: null,
      description:
        "Canadian-based news aggregator that surfaces media bias and blindspot data across outlets.",
    },
  ],
  [
    "iran international",
    {
      lean: "Center",
      tier: 3,
      allSides: null,
      description:
        "London-based Persian-language satellite news channel; critical coverage of the Iranian government.",
    },
  ],
]);

const TIER_LABELS = {
  1: "Tier 1 · Wire service / public broadcaster",
  2: "Tier 2 · Major national outlet",
  3: "Tier 3 · Regional / partisan / specialty",
};

/**
 * Looks up credibility metadata for a news outlet by display name.
 * @param {string} outletName - Outlet name as returned by the server (e.g. "AP", "Reuters").
 * @returns {{lean: string, tier: number, allSides?: string, description?: string}|null} Metadata or null if unknown.
 */
function getOutletData(outletName) {
  if (!outletName) return null;
  return OUTLET_DATA.get(outletName.trim().toLowerCase()) || null;
}

/**
 * Collapses an outlet's fine-grained lean label (e.g. "Lean Left") into its
 * broad category, mirroring server/sourceLean.js's getLeanCategory.
 * @param {string} outletName - Outlet name as returned by the server.
 * @returns {"Left"|"Right"|"Center"|"Unrated"}
 */
function getLeanCategory(outletName) {
  const data = getOutletData(outletName);
  const lean = data ? data.lean : null;
  if (!lean) return "Unrated";
  if (lean.endsWith("Left")) return "Left";
  if (lean.endsWith("Right")) return "Right";
  if (lean === "Center") return "Center";
  return "Unrated";
}
