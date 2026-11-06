// Finds real, free photos on Wikimedia Commons.
// Nothing is downloaded: we only keep each photo's link, year, city and credit.
// The players' browsers load the pictures straight from Wikimedia.
const COMMONS = process.env.COMMONS_API || "https://commons.wikimedia.org/w/api.php";
const UA = "WhatYearGame/2.0 (photo-guessing party game; https://sofokliskonstantinou.com) about one request per second";

const sleep = ms => new Promise(r => setTimeout(r, ms));

const CITIES = ["London", "Paris", "Athens", "New York City", "Rome", "Berlin", "Amsterdam", "Istanbul", "Chicago", "Barcelona",
  "Vienna", "San Francisco", "Budapest", "Stockholm", "Copenhagen", "Lisbon", "Prague", "Warsaw", "Helsinki", "Oslo", "Dublin",
  "Brussels", "Munich", "Hamburg", "Madrid", "Milan", "Naples", "Thessaloniki", "Los Angeles", "Boston", "Philadelphia",
  "Washington, D.C.", "Toronto", "Montreal", "Sydney", "Melbourne", "Tokyo", "Moscow", "Zürich", "Rotterdam", "The Hague", "Utrecht"];
const FIRST_DECADE = 1900, LAST_DECADE = 2020;

// Anything that is not a photograph of a real scene
const NOT_A_PHOTO = /\b(maps?|plans?|posters?|logos?|coat of arms|flags?|stamps?|diagrams?|drawings?|paintings?|painted|oil on|watercolou?rs?|engravings?|etchings?|lithographs?|woodblock|woodcuts?|ukiyo-?e|shin-?hanga|hanga|illustrations?|artworks?|sculptures?|statuettes?|newspapers?|magazines?|pages?|documents?|letters?|tickets?|banknotes?|coins?|signatures?|covers?|adverts?|advertisements?|leaflets?|programmes?|timetables?|fahrpl[aä]ne?|aushang|notices?|announcements?|menus?|charts?|scans? of|texts?|cartoons?|caricatures?|sketch(es)?|postcards?|medals?|manuscripts?|books?|certificates?|screenshots?|renderings?|3d|cgi|models? of|portrait of|headshot|seal of|emblem|icon|clip ?art|microscop|x-ray|specimen|interior of a museum)\b/i;
// Signs that this really is a photograph
const PHOTO_HINT = /\b(photo|photos|photograph|photographs|photography|negative|glass plate|fortepan|bain news|nationaal archief|anefo|bundesarchiv|press photo|snapshot|street scene|black and white photographs|photochrom)\b/i;
// Everyday-life scenes make the best rounds
const SCENE_HINT = /\b(street|streets|road|square|market|people|crowd|traffic|cars?|bus(es)?|trams?|trains?|station|shops?|caf[eé]|beach|harbou?r|port|bridge|parade|festival|children|bicycles?|cyclists?|avenue|boulevard|corner|pedestrians?|demonstration|celebration|night|winter|snow)\b/i;
// Photos that are really about one person's face (portraits, politicians, speakers, actors...) are boring rounds
const PEOPLE_FOCUS = /\b(portraits?|headshots?|selfies?|close-?ups?|mugshots?|politicians?|ministers?|prime minister|presidents? of|mayors? of|members? of (the )?parliament|senators?|ambassadors?|diplomats?|delegations?|press conferences?|conferences?|congress(es)? of|summits?|meetings?|interviews?|speeches|speaking|speakers?|lectures?|panel discussions?|award ceremon(y|ies)|awards?|prizes?|signing|actors?|actresses|singers?|musicians?|footballers?|athletes?|celebrit(y|ies)|wikimedians?|wikipedians?|editathons?|people of|men of|women of|men in suits|groepsportret|group photo)\b/i;
// Streets, shops, crowds, weather, famous places: what the game is about
const KEEP_HINT = /\b(tower|cathedral|church|palace|castle|monument|memorial|museum|skyline|panorama|view of|views of|cityscape|aerial|landmark|canal|river|park|garden|fountain|buildings?|architecture|facade|houses|shopfront|storefront|metro|subway|airport|rain|fog|quay|waterfront|town hall|city hall|opera|theatre|theater|hotel|restaurant|bar|harbour|harbor)\b/i;
// Portraits are almost always upright; city scenes are wide
const isWide = (w, h) => w && h ? w / h >= 1.15 : true;
const OK_LICENSE = /public domain|^pd\b|pd-|cc0|cc[ -]?by/i;
const BAD_LICENSE = /\bnc\b|\bnd\b|non-?commercial|no ?deriv/i;

const stripHtml = s => String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

// Wikimedia asks small tools to go slowly: about one request per second, and to wait when it says "too many requests".
let lastCall = 0, pauseUntil = 0;
const GAP = process.env.COMMONS_API ? 50 : 1100;   // (a faster gap is only for testing against a fake server)
const status = { note: "" };
async function politeFetch(url, timeout) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = Math.max(pauseUntil, lastCall + GAP) - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const r = await fetch(url, { headers: { "User-Agent": UA, "Api-User-Agent": UA }, signal: AbortSignal.timeout(timeout) });
    if (r.status !== 429 && r.status !== 503) return r;
    const ra = Number(r.headers.get("retry-after"));
    const ms = (ra > 0 ? ra * 1000 : 0) || Math.min(60000, 5000 * 2 ** attempt);
    pauseUntil = Date.now() + ms;
    status.note = `Wikimedia is busy, waiting ${Math.round(ms / 1000)}s`;
  }
  throw new Error("Wikimedia is too busy right now");
}
async function commons(params) {
  const url = COMMONS + "?" + new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params });
  const r = await politeFetch(url, 25000);
  if (!r.ok) throw new Error("Wikimedia answered " + r.status);
  return r.json();
}

const INFO = { prop: "imageinfo|categories", cllimit: "max", clshow: "!hidden", iiprop: "url|mime|size|extmetadata", iiurlwidth: "1280", iiextmetadatafilter: "LicenseShortName|Artist|DateTimeOriginal|ImageDescription|ObjectName|Categories" };
function toCandidates(d, year) {
  const pages = d?.query?.pages || [];
  return pages.map(p => {
    const ii = p.imageinfo && p.imageinfo[0]; if (!ii) return null;
    const m = ii.extmetadata || {};
    const cats = [stripHtml(m.Categories?.value), ...(p.categories || []).map(c => String(c.title || "").replace(/^Category:/, ""))].join(" | ");
    return {
      pageid: p.pageid, title: String(p.title || ""), mime: ii.mime, w: ii.width, h: ii.height,
      thumb: ii.thumburl || ii.url, page: ii.descriptionurl || "",
      lic: stripHtml(m.LicenseShortName?.value), artist: stripHtml(m.Artist?.value).slice(0, 80),
      dto: stripHtml(m.DateTimeOriginal?.value), desc: stripHtml(m.ImageDescription?.value || m.ObjectName?.value).slice(0, 200), cats
    };
  }).filter(Boolean)
    .filter(c => c.mime === "image/jpeg" && c.w >= 900 && c.h >= 600 && c.w / c.h < 2.2 && isWide(c.w, c.h))
    .filter(c => /^https:\/\/upload\.wikimedia\.org\//.test(c.thumb) || (!!process.env.COMMONS_API && !!c.thumb))
    .filter(c => OK_LICENSE.test(c.lic) && !BAD_LICENSE.test(c.lic))
    .map(c => {
      const text = (c.title + " " + c.desc + " " + c.cats).replace(/prints and photographs/ig, "photographs");
      const cameraTime = /\d{1,2}:\d{2}/.test(c.dto);           // a real camera writes the time it was taken
      const isPhoto = PHOTO_HINT.test(text) || cameraTime || /\bphotographer\b/i.test(c.artist);
      const yearOk = (() => { const y = (c.dto.match(/\b(18|19|20)\d{2}\b/) || [])[0]; return !y || Math.abs(Number(y) - year) <= 1; })();
      const score = (SCENE_HINT.test(text) ? 2 : 0) + (cameraTime ? 1 : 0) + (/fortepan|bain news|nationaal archief|anefo/i.test(text) ? 1 : 0);
      const scene = SCENE_HINT.test(text) || KEEP_HINT.test(text);
      return { ...c, ok: isPhoto && yearOk && !NOT_A_PHOTO.test(text) && !PEOPLE_FOCUS.test(text) && scene, score };
    })
    .filter(c => c.ok);
}
async function candidates(year, city) {
  // 1) files sitting directly in "Category:<year> in <city>"
  const direct = toCandidates(await commons({ action: "query", generator: "categorymembers", gcmtitle: `Category:${year} in ${city}`, gcmtype: "file", gcmlimit: "50", ...INFO }), year);
  if (direct.length) return direct;
  // 2) otherwise look in its sub-categories, photos only
  return toCandidates(await commons({ action: "query", generator: "search", gsrsearch: `deepcat:"${year} in ${city}" filetype:bitmap photograph`, gsrnamespace: "6", gsrlimit: "40", ...INFO }), year);
}

function cleanCaption(c) {
  let t = c.desc || c.title.replace(/^File:/, "").replace(/\.[a-z]{3,4}$/i, "").replace(/[_]+/g, " ");
  t = t.replace(/^(title|omschrijving|description)\s*:\s*/i, "").replace(/\s*abstract\/medium:.*$/i, "").replace(/\s+/g, " ").trim();
  return t.length > 110 ? t.slice(0, 107).trim() + "…" : t;
}
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/**
 * Adds new photos to `bank` (an array) until it has grown by `count`.
 * Takes up to 3 photos from each "<year> in <city>" category and spreads them evenly over the decades.
 * onFound(photo) is called for each new photo; shouldStop() can end the search early.
 */
async function growBank(bank, count, { onFound = () => {}, shouldStop = () => false, tried = new Set(), log = () => {} } = {}) {
  const have = new Set(bank.map(p => String(p.id)));
  const perDecade = {};
  bank.forEach(p => { const d = Math.floor(p.year / 10) * 10; perDecade[d] = (perDecade[d] || 0) + 1; });
  const decades = []; for (let d = FIRST_DECADE; d <= LAST_DECADE; d += 10) decades.push(d);
  let added = 0, fails = 0, misses = 0;
  while (added < count && !shouldStop()) {
    // the decade with the fewest photos goes first, then a year + city we haven't tried yet
    const dec = decades.slice().sort((a, b) => (perDecade[a] || 0) - (perDecade[b] || 0) || Math.random() - .5)[0];
    let year, city, key, guard = 0;
    do { year = dec + Math.floor(Math.random() * Math.min(10, new Date().getFullYear() - dec + 1)); city = CITIES[Math.floor(Math.random() * CITIES.length)]; key = year + "|" + city; } while (tried.has(key) && ++guard < 400);
    if (guard >= 400) { perDecade[dec] = (perDecade[dec] || 0) + 1000; if (decades.every(d => (perDecade[d] || 0) >= 1000)) break; continue; }
    tried.add(key);
    try {
      const cs = (await candidates(year, city)).filter(c => !have.has(String(c.pageid)));
      if (!cs.length) { if (++misses > 2000) break; continue; }
      const best = shuffle(cs).sort((a, b) => b.score - a.score).slice(0, 3);
      for (const c of best) {
        const p = { id: String(c.pageid), url: c.thumb, w: c.w, h: c.h, year, city, caption: cleanCaption(c), credit: `${c.artist || "Unknown photographer"} · ${c.lic} · Wikimedia Commons`, page: c.page };
        bank.push(p); have.add(p.id); added++;
        perDecade[dec] = (perDecade[dec] || 0) + 1;
        status.note = "";
        onFound(p);
      }
    } catch (e) {
      log("Photo search: " + e.message);
      if (++fails >= 25 && added === 0) throw e;
      await sleep(2000);
    }
  }
  return added;
}

/**
 * Looks again at every photo already in the bank (only the text about it on Wikimedia, no pictures are downloaded)
 * and returns the ones that are close-ups of people: upright portraits, politicians, speakers, actors...
 */
async function checkBank(bank, { log = () => {}, onProgress = () => {} } = {}) {
  const bad = [];
  for (let i = 0; i < bank.length; i += 20) {
    const part = bank.slice(i, i + 20);
    const d = await commons({ action: "query", pageids: part.map(p => p.id).join("|"), ...INFO });
    const pages = new Map((d?.query?.pages || []).map(pg => [String(pg.pageid), pg]));
    for (const p of part) {
      const pg = pages.get(String(p.id));
      if (!pg || pg.missing || !pg.imageinfo) { bad.push({ p, why: "no longer on Wikimedia" }); continue; }
      const ii = pg.imageinfo[0], m = ii.extmetadata || {};
      const cats = [stripHtml(m.Categories?.value), ...(pg.categories || []).map(c => String(c.title || "").replace(/^Category:/, ""))].join(" | ");
      const text = String(pg.title || "") + " " + stripHtml(m.ImageDescription?.value || m.ObjectName?.value) + " " + cats + " " + (p.caption || "");
      const hit = text.match(PEOPLE_FOCUS);
      if (!isWide(ii.width, ii.height)) bad.push({ p, why: "upright (portrait shape)" });
      else if (hit) bad.push({ p, why: "about people: " + hit[0] });
      else { p.w = ii.width; p.h = ii.height; }
    }
    onProgress(Math.min(bank.length, i + 20), bank.length);
  }
  return bad;
}

module.exports = { growBank, checkBank, status, shuffle };
