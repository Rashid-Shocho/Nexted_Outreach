import { lastName } from './checks';

/**
 * A professor's papers since 2010, from Crossref (free, public).
 * Strict on purpose: a paper counts only when one of its authors has this family name, this first
 * initial AND this university in the paper itself. No match is better than somebody else's paper.
 */

export interface Paper {
  title: string;
  year: number;
  venue: string;
  doi: string;
  abstract?: string;
}

export interface Who {
  name: string;
  university: string | null;
  researchArea: string | null;
}

const FROM_YEAR = 2010;

export const fold = (s: string) =>
  s
    .replace(/ß/g, 'ss')
    .replace(/[łŁ]/g, 'l')
    .replace(/[øØ]/g, 'o')
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

const COMMON = new Set(
  'university universitat universite universiteit universitet uniwersytet universidad technical technische technology technological technion institute institut instituto science sciences applied national state royal college school faculty department of the and for in de la der die fur und et economics engineering polytechnic politechnika hochschule'.split(' '),
);

/** The words that tell one university from another: "TU Braunschweig" gives braunschweig. */
export function placeWords(university: string): string[] {
  const all = words(university.replace(/\(.*?\)/g, ' '));
  const own = all.filter((w) => w.length >= 3 && !COMMON.has(w));
  return own.length ? own : all.filter((w) => w.length >= 3);
}

const STOP = new Set('and the of for in on with to a an by from using based study analysis engineering systems system research science sciences materials material design methods applications'.split(' '));
const topicWords = (s: string) => new Set(words(s).filter((w) => w.length > 3 && !STOP.has(w)).map((w) => w.slice(0, 7)));

interface CrossrefItem {
  title?: string[];
  DOI?: string;
  type?: string;
  issued?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
  abstract?: string;
  author?: { given?: string; family?: string; affiliation?: { name?: string }[] }[];
}

/** Is this person, at this university, an author of the paper? */
export function isAuthor(item: CrossrefItem, who: Who): boolean {
  const family = fold(lastName(who.name)).replace(/[^a-z]/g, '');
  const first = words(who.name)[0] ?? '';
  const initial = first[0];
  const topic = topicWords(who.researchArea ?? '');
  const topical = [...topicWords(item.title?.[0] ?? '')].some((w) => topic.has(w)); // asked of papers that give only an initial
  const places = placeWords(who.university ?? '');
  if (!family || !initial || !places.length) return false;
  return (item.author ?? []).some((a) => {
    const f = words(a.family ?? '');
    const sameFamily = f.join('') === family || f.at(-1) === family;
    const given = words(a.given ?? '')[0] ?? '';
    if (!sameFamily || given[0] !== initial) return false;
    // "Leif" and "Lars" share an initial and can share a university: two full names must be the same
    if (given.length > 2 && first.length > 2 && given !== first) return false;
    if (given.length <= 2 && !topical) return false;
    const aff = words((a.affiliation ?? []).map((x) => x.name ?? '').join(' '));
    return places.some((p) => aff.includes(p));
  });
}

const stripTags = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

export function pickPapers(items: CrossrefItem[], who: Who, max = 6): Paper[] {
  const topic = topicWords(who.researchArea ?? '');
  const seen = new Set<string>();
  const found: (Paper & { score: number })[] = [];
  for (const it of items) {
    const title = stripTags(it.title?.[0] ?? '');
    const year = it.issued?.['date-parts']?.[0]?.[0] ?? 0;
    if (title.length < 15 || year < FROM_YEAR || !it.DOI || !isAuthor(it, who)) continue;
    if (/^(correction|erratum|corrigendum|retract|editorial|preface|foreword)/i.test(title)) continue;
    const key = words(title).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    const overlap = [...topicWords(title)].filter((w) => topic.has(w)).length;
    const abstract = stripTags(it.abstract ?? '').replace(/^abstract[:.]?\s*/i, '').slice(0, 500);
    found.push({ ...(abstract.length > 80 ? { abstract } : {}), title, year, venue: stripTags(it['container-title']?.[0] ?? ''), doi: it.DOI, score: Math.min(overlap, 4) * 2 + (year - FROM_YEAR) / 4 });
  }
  return found
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ score: _, ...p }) => p);
}

/** Null when Crossref could not be reached; an empty list when it has no certain paper. */
export async function findPapers(who: Who): Promise<Paper[] | null> {
  const family = lastName(who.name);
  if (!who.university || !family) return [];
  const u = new URL('https://api.crossref.org/works');
  u.search = new URLSearchParams({
    'query.author': who.name.replace(/\(.*?\)/g, ' '),
    'query.affiliation': placeWords(who.university).join(' '),
    filter: `from-pub-date:${FROM_YEAR}-01-01,has-affiliation:true`,
    select: 'title,author,issued,container-title,DOI,type,abstract',
    rows: '60',
  }).toString();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': 'nexted-outreach/1.0' }, signal: AbortSignal.timeout(25_000) });
      if (res.ok) return pickPapers(((await res.json()) as any)?.message?.items ?? [], who);
      if (res.status < 500 && res.status !== 429) return null;
    } catch {
      /* try once more */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}
