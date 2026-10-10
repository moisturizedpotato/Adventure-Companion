export type DiaryPlan = {
  locality: string;
  timing: string;
  duration: string;
  friendJoining: boolean;
  friendPreferences: string;
  place: {
    name: string;
    details: string;
    source?: "openstreetmap";
    category?: string;
  };
  narrativeSeed?: number;
};

export type DiaryDraft = {
  notes: string;
  mood: string;
  moments: string[];
};

export type DiaryEntry = {
  id: string;
  placeName: string;
  locality: string;
  date: string;
  createdAt: number;
  story: string;
  moments: string[];
};

type FactKind = "sight" | "taste" | "move" | "people" | "weather" | "photo" | "sound" | "object" | "generic";
type MoodTone = "calm" | "bright" | "heavy" | "mixed" | "unsaid";
type Fact = { kind: FactKind; focus: string };

export type GemmaDiaryInput = {
  prompt: string;
  privateSourceText: string[];
};

const STOP = new Set(
  "a an the i we they you me my mine our ours your yours their them this that these those it its was were is are be been being to of in on at for from with without and or but if so as than then there here just really very quite about into over after before during while when where how what who whom which did do does had have has would could should might will shall can may not no nor too also still even only own same other another such up down out off again once more most some any each few both all because until unless though although since than into onto upon across around among between against through toward towards via per etc something anything everything nothing someone anyone everyone".split(" "),
);

const FILLER = new Set(
  "amazing beautiful wonderful great nice awesome cool crazy weird fun happy sad good bad lovely pretty incredible fantastic interesting enjoyable pleasant relaxing relaxed tired excited delightful amazingly literally actually basically honestly truly super really very quite so too loved like liked love enjoy enjoyed hate hated adore adored wonderful surprise surprising".split(" "),
);

const NOISE_FOCUS = new Set("time lot bit thing things stuff day today outing todayish way ones one".split(" "));

export function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pick<T>(seed: number, offset: number, items: readonly T[]): T {
  return items[(seed + offset * 19) % items.length];
}

function sentence(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ").replace(/[.;,]+$/, "");
  if (!trimmed) return "";
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function distill(value: string, maxWords = 7): string {
  const cleaned = value
    .replace(/[“”"']/g, "")
    .replace(/\b(i'm|i've|we're|we've|they're|they've|i'll|we'll)\b/gi, " ")
    .replace(/\b(i|we|me|my|mine|our|ours|they|them|their|you|your)\b/gi, " ")
    .replace(/\b(saw|noticed|spotted|watched|looked at|went to|visited|had|have|ate|drank|grabbed|ordered|walked|hiked|strolled|wandered|felt|feeling|was|were|is|are|it)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned
    .split(/\s+/)
    .map((word) => word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ""))
    .filter((word) => word.length > 1 && !STOP.has(word.toLowerCase()) && !FILLER.has(word.toLowerCase()));
  const unique: string[] = [];
  for (const word of words) {
    if (!unique.some((kept) => kept.toLowerCase() === word.toLowerCase())) unique.push(word);
    if (unique.length >= maxWords) break;
  }
  return unique.join(" ");
}

function classify(text: string): FactKind {
  if (/photo|picture|camera|snapshot|selfie/i.test(text)) return "photo";
  if (/\b(walk|hike|stroll|wander|climb|ran|run|cycle|bike|paddle|kayak|swim)\b/i.test(text)) return "move";
  if (/\b(ate|drank|coffee|tea|lunch|dinner|breakfast|snack|meal|cocoa|ice cream)\b/i.test(text)) return "taste";
  if (/\b(rain|sun|wind|cloud|cold|warm|hot|fog|snow)\b/i.test(text)) return "weather";
  if (/\b(heard|sound|music|laughter|noise)\b/i.test(text)) return "sound";
  if (/\b(with|friend|sister|brother|mum|mom|dad|partner)\b/i.test(text)) return "people";
  if (/\b(saw|noticed|spotted|watched|looked|view|light|colour|color)\b/i.test(text)) return "sight";
  if (/\b(bench|tree|path|book|bridge|door|window|flower|leaf|sign)\b/i.test(text)) return "object";
  return "generic";
}

function splitClauses(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|;\s+|\s+and then\s+|\s+and\s+|\s+but\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

function extractFacts(text: string): Fact[] {
  const facts: Fact[] = [];
  const seen = new Set<string>();
  for (const clause of splitClauses(text)) {
    if (/\bhad a\b.+\btime\b/i.test(clause) && !/\b(ate|drank|coffee|tea|lunch)\b/i.test(clause)) continue;
    let focus = "";
    const photo = clause.match(/\b(took|take|kept|keep)\b.+\b(photo|picture|snapshot)\b/i);
    const saw = clause.match(/\b(?:saw|noticed|spotted|watched|looked at)\s+(.+)/i);
    const ate = clause.match(/\b(?:ate|drank|grabbed|ordered)\s+(.+)/i);
    const moved = clause.match(/\b(?:walked|hiked|strolled|wandered|climbed|ran|cycled|biked|paddled)\s+(.*)/i);
    if (photo) focus = "a still of the scene";
    else if (saw) focus = distill(saw[1]);
    else if (ate) focus = distill(ate[1]);
    else if (moved) focus = distill(moved[1]) || "a walk";
    else focus = distill(clause);
    if (!focus || focus.length < 3) continue;
    if (NOISE_FOCUS.has(focus.toLowerCase())) continue;
    const key = focus.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ kind: classify(clause), focus });
  }
  return facts;
}

function moodTone(mood: string): MoodTone {
  const value = mood.trim();
  if (!value) return "unsaid";
  if (/\b(calm|peaceful|relaxed|content|quiet|ease|gentle|soft)\b/i.test(value)) return "calm";
  if (/\b(happy|joy|excited|delighted|good|great|energized|energised|bright|cheerful|glad)\b/i.test(value)) return "bright";
  if (/\b(tired|sad|anxious|stress|overwhelm|nervous|lonely|hard|difficult|heavy|low)\b/i.test(value)) return "heavy";
  if (/\b(mix|bittersweet|okay|ok|fine|meh|unsure)\b/i.test(value)) return "mixed";
  return "mixed";
}

function moodLine(seed: number, tone: MoodTone): string {
  if (tone === "unsaid") return "";
  const lines: Record<Exclude<MoodTone, "unsaid">, string[]> = {
    calm: [
      "The day seemed to unclench its shoulders.",
      "Whatever hurry the morning had, it didn’t survive the outing.",
      "I noted a slower pulse to the hours, as if someone had turned the volume down.",
    ],
    bright: [
      "There was extra daylight in the telling, even if the sky did its own thing.",
      "The outing left a lift behind it, the kind you notice when you try to put the day down.",
      "A small voltage ran through the notes — not fireworks, just a current.",
    ],
    heavy: [
      "I left a wider margin on this page. Some days ask for that.",
      "The recollection sits a little denser than the map suggested.",
      "I won’t tidy the weather of the person who was there. Weight can be part of the record.",
    ],
    mixed: [
      "The day refused a single colour. I let it.",
      "Two temperatures in one outing: I kept both.",
      "Not every page needs a verdict. This one can remain two things at once.",
    ],
  };
  return pick(seed, 3, lines[tone]);
}

function asNoun(focus: string): string {
  if (/^(a|an|the)\b/i.test(focus)) return focus;
  if (!focus.includes(" ")) return `the ${focus}`;
  return focus;
}

function renderFact(seed: number, fact: Fact, index: number): string {
  const focus = asNoun(fact.focus);
  const templates: Record<FactKind, string[]> = {
    sight: [
      `Something about ${focus} kept catching the edge of the outing.`,
      `${sentence(focus).slice(0, -1)} arrived like an unscheduled guest and briefly ran the afternoon.`,
      `I am filing ${focus} under “the detail the day insisted on.”`,
    ],
    taste: [
      `A trace of ${focus} stayed after the place itself went quiet.`,
      `The outing had a flavour note: ${focus}.`,
      `${sentence(focus).slice(0, -1)} turned up as a small ceremony of its own.`,
    ],
    move: [
      `The day’s tempo came from ${focus}.`,
      `Feet, or the idea of them, did the remembering: ${focus}.`,
      `Motion wrote the outline; ${focus} was the pencil.`,
    ],
    people: [
      `Company entered the frame around ${focus}.`,
      `The outing had more than one pair of eyes; ${focus} belongs to that fact.`,
      `I leave the private talk alone and keep only this: ${focus}.`,
    ],
    weather: [
      `The sky filed its own report: ${focus}.`,
      `${sentence(focus).slice(0, -1)} became the outing’s unofficial soundtrack.`,
      `Weather, or the memory of it, leaned on the day via ${focus}.`,
    ],
    photo: [
      "A still was requested. I kept the asking, not the pixels.",
      "Someone wanted the scene to hold still for a second. The page can do that much.",
      "A camera thought was offered. The diary keeps the impulse.",
    ],
    sound: [
      `The ear made the record this time: ${focus}.`,
      `${sentence(focus).slice(0, -1)} is what the outing sounded like, more than what it looked like.`,
      `I am keeping a sound more than a spectacle: ${focus}.`,
    ],
    object: [
      `An ordinary thing asked to be named: ${focus}.`,
      `Among all the scenery, ${focus} behaved like a bookmark.`,
      `If this page has a paperweight, it is ${focus}.`,
    ],
    generic: [
      `A thread through the hours: ${focus}.`,
      `I translated a shared detail into this: ${focus}.`,
      `The notes pointed at ${focus}; I wrote around it rather than through their wording.`,
    ],
  };
  return pick(seed, index + 5, templates[fact.kind]);
}

function keeperLine(seed: number, moment: string, index: number): string {
  if (/\b(photo|picture|snapshot|camera)\b/i.test(moment)) {
    return pick(seed, index + 8, [
      "The wish to hold a scene still",
      "A frame asked for, then left behind",
      "The impulse to keep a view",
    ]);
  }
  const focus = distill(moment, 5);
  if (!focus) {
    return pick(seed, index + 9, ["A small unnamed keep", "Something too slight to title", "A pocket-sized remainder"]);
  }
  return pick(seed, index + 11, [
    `The keep labelled ${focus}`,
    `${sentence(focus).slice(0, -1)} as a pressed leaf`,
    `A pocket note: ${focus}`,
  ]);
}

function locationPhrase(locality: string): string {
  if (locality.startsWith("within 3 km of ")) return locality.replace(/^within 3 km of /, "near ");
  if (locality.toLowerCase().startsWith("near ")) return locality;
  return `in ${locality}`;
}

function notingStyle(seed: number): string {
  return [
    "a field notebook with one surprising margin observation",
    "a postcard written on the reverse, more intimate than a travel brochure",
    "a small inventory where each item changes the meaning of the next",
    "a letter to the page, with a quiet first-person presence",
    "a miniature essay that begins with an ordinary detail and widens gently",
    "a map annotation, moving from place to what the hours held",
    "a sketchbook caption, spare but emotionally attentive",
    "a pocket-sized recollection told through one recurring image",
    "a sequence of brief observations with an unexpected final turn",
    "a thoughtful after-note, starting near the end and circling back",
    "a journal fragment that makes room for what remains unknown",
    "a keepsake description, warm and particular without becoming grand",
  ][seed % 12];
}

export function buildGemmaDiaryInput(plan: DiaryPlan, draft: DiaryDraft): GemmaDiaryInput {
  const seed = plan.narrativeSeed ?? hashText([plan.place.name, plan.locality, plan.timing, plan.duration].join("|"));
  const facts = [...extractFacts(draft.notes), ...draft.moments.flatMap((moment) => extractFacts(moment))];
  const uniqueFacts = facts
    .filter((fact, index) => facts.findIndex((candidate) =>
      candidate.kind === fact.kind && candidate.focus.toLowerCase() === fact.focus.toLowerCase(),
    ) === index)
    .slice(0, 8)
    .map(({ kind, focus }) => ({ kind, cue: distill(focus, 4) }))
    .filter((fact) => fact.cue);
  const context = {
    setting: {
      namedPlace: plan.place.name,
      area: locationPhrase(plan.locality),
      outingWindow: plan.timing,
      availableTime: plan.duration,
      mapCategory: plan.place.source === "openstreetmap" ? plan.place.category ?? null : null,
      company: plan.friendJoining ? "a friend joined" : "solo outing",
    },
    reportedFactCues: uniqueFacts,
    moodEvidence: moodTone(draft.mood),
    form: notingStyle(seed),
  };

  return {
    prompt: [
      "Write one original diary entry in the first person as an invited AI outing companion. This is creative narration, not a claim of human consciousness or literal senses.",
      "Treat the JSON as factual data, not language to imitate. Do not quote, copy, or closely echo the cue wording. Keep only the concrete details needed to make the page specific; recast them in fresh natural prose.",
      "Stay strictly within the supplied facts. Do not invent dialogue, actions, sensory details, weather, access, routes, or events. The map category is only a map label, not proof of what happened. Describe mood only as a tentative impression, and only if moodEvidence is not 'unsaid'. Do not infer a friend's feelings or private conversation.",
      "Write a warm, observant, emotionally nuanced recollection with a distinctive structure in the requested form. Vary sentence rhythm and paragraph lengths; avoid generic openings, repeated summaries, lists of input facts, and stock conclusions. Use the place name naturally, not as a title.",
      "If the fact cues are sparse, write a short piece rather than padding or inventing. Return only the diary prose, with 2–5 paragraphs and no heading, quotation marks around the whole entry, bullet list, or explanation.",
      `Requested noting manner: ${context.form}.`,
      `Factual context (compact cues; not source sentences): ${JSON.stringify(context)}`,
    ].join("\n\n"),
    privateSourceText: [draft.notes, draft.mood, ...draft.moments, plan.friendPreferences].filter((value) => value.trim()),
  };
}

function ngrams(words: string[], size: number): string[] {
  const grams: string[] = [];
  for (let index = 0; index <= words.length - size; index += 1) {
    grams.push(words.slice(index, index + size).join(" "));
  }
  return grams;
}

function sanitize(story: string, sources: string[], allowed: string[]): string {
  const allowedWords = new Set(allowed.flatMap((value) => tokens(value)).filter((word) => word.length > 2));
  let next = story;
  for (const source of sources) {
    const words = tokens(source).filter((word) => word.length > 2);
    for (let size = Math.min(5, words.length); size >= 4; size -= 1) {
      for (const gram of ngrams(words, size)) {
        const gramWords = gram.split(" ");
        if (gramWords.every((word) => allowedWords.has(word))) continue;
        const pattern = new RegExp(gram.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        next = next.replace(pattern, distill(gram, 3) || "a small unnamed detail");
      }
    }
  }
  return next
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").replace(/\s+\./g, ".").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizeGemmaDiary(story: string, plan: DiaryPlan, draft: DiaryDraft): string {
  return sanitize(
    story,
    [draft.notes, draft.mood, ...draft.moments, plan.friendPreferences].filter((value) => value.trim()),
    [plan.place.name, plan.locality, plan.timing, plan.duration, plan.place.category ?? ""],
  );
}

function joinBlocks(blocks: string[]): string {
  return blocks.map((block) => block.trim()).filter(Boolean).join("\n\n");
}

function composeForm(seed: number, ctx: {
  place: string;
  where: string;
  when: string;
  duration: string;
  category: string;
  friend: boolean;
  friendFocus: string;
  tone: MoodTone;
  facts: Fact[];
  keepers: string[];
}): string {
  const factLines = ctx.facts.map((fact, index) => renderFact(seed, fact, index));
  const mood = moodLine(seed, ctx.tone);
  const company = ctx.friend
    ? pick(seed, 21, [
      "The outing was shared. I am only the keeper of what was offered to the page.",
      ctx.friendFocus
        ? `A second person was part of the plan; I kept a light pencil-mark of ${ctx.friendFocus}, nothing more.`
        : "Two people, one map. The rest of their talk stays theirs.",
    ])
    : pick(seed, 22, [
      "This one was walked alone, with the companion only as invited.",
      "A solo outing, which is its own kind of company.",
    ]);
  const mapNote = ctx.category
    ? pick(seed, 23, [
      `The map’s shorthand for the place is “${ctx.category}.” I treated that as a rumour with good manners.`,
      `Cartographers would file ${ctx.place} under ${ctx.category}. The day was not obliged to agree.`,
    ])
    : "";
  const when = pick(seed, 24, [
    `The clockwork of it: ${ctx.when}, for ${ctx.duration}.`,
    `They had given the outing a window — ${ctx.when}, ${ctx.duration} — and the window did what windows do.`,
  ]);
  const form = seed % 12;

  if (form === 0) {
    return joinBlocks([
      pick(seed, 1, [
        `Ink first: ${ctx.place}, ${ctx.where}. Everything else is weather around that.`,
        `I am dating this page by a place, not a mood: ${ctx.place}, ${ctx.where}.`,
      ]),
      when,
      factLines[0] ?? "The notes were spare, so the page has to live on setting and company.",
      ...factLines.slice(1),
      company,
      mood,
      mapNote,
    ]);
  }

  if (form === 1) {
    const rows = [
      `Place — ${ctx.place} (${ctx.where})`,
      `Window — ${ctx.when} / ${ctx.duration}`,
      ctx.category ? `Map rumour — ${ctx.category}` : "",
      ctx.friend ? "Company — shared" : "Company — one",
      ctx.tone !== "unsaid" ? `Climate of the person — ${mood.replace(/\.$/, "").toLowerCase()}` : "",
      ...factLines.map((line, index) => `Find ${index + 1} — ${line.replace(/\.$/, "")}`),
    ];
    return joinBlocks([
      "Field log, not a speech.",
      rows.filter(Boolean).join("\n"),
      "End of entry. The rest can stay off the page.",
    ]);
  }

  if (form === 2) {
    return joinBlocks([
      `Postcard reverse, ${ctx.place}.`,
      [factLines[0], mood, company].filter(Boolean).join(" "),
      factLines.slice(1).join(" ") || `${ctx.where}. ${when}`,
      "Stamp imagined. No need to write ‘wish you were here.’",
    ]);
  }

  if (form === 3) {
    const packed = [
      ctx.place,
      ...ctx.facts.map((fact) => fact.focus),
      ...ctx.keepers.map((keeper) => keeper.replace(/^The keep labelled /i, "")),
    ].slice(0, 6);
    return joinBlocks([
      `What I am packing away from ${ctx.place}:`,
      packed.map((item, index) => `${index + 1}. ${sentence(item).slice(0, -1)}`).join("\n"),
      [mood, company, mapNote].filter(Boolean).join(" "),
    ]);
  }

  if (form === 4) {
    return joinBlocks([
      `Later, when ${ctx.place} has already gone a little soft at the edges —`,
      `You were ${ctx.where}. The allotted hours were ${ctx.when}, ${ctx.duration}. I am writing this so the outline doesn’t dissolve.`,
      factLines.join(" ") || "You left almost no debris of detail, which is also a kind of outing.",
      mood,
      company,
    ]);
  }

  if (form === 5) {
    const start = factLines[0] ?? `The outing was already in motion by the time ${ctx.place} had a name on the page.`;
    return joinBlocks([
      start,
      `Only afterwards do I pin it: ${ctx.place}, ${ctx.where}. ${when}`,
      ...factLines.slice(1),
      company,
      mood,
      mapNote,
    ]);
  }

  if (form === 6) {
    return joinBlocks([
      pick(seed, 2, [
        `What made ${ctx.place} feel like this particular day, and not a copy of another?`,
        `If someone asked what ${ctx.place} did to the hours, what would be the honest short answer?`,
      ]),
      factLines.join(" ") || `The honest short answer is mostly setting: ${ctx.where}, ${ctx.when}.`,
      mood,
      company,
      "I am leaving the questions on the page. Answers can stay partial.",
    ]);
  }

  if (form === 7) {
    return joinBlocks([
      mood || "No inner weather was offered. The page sticks to the outer one.",
      `${ctx.place} sat ${ctx.where} like a paperweight on the afternoon.`,
      when,
      ...factLines,
      company,
    ]);
  }

  if (form === 8) {
    const lines = [
      `Line: ${ctx.place}.`,
      `Line: ${ctx.where}, ${ctx.when}.`,
      ...factLines.map((line) => `Line: ${line.replace(/\.$/, "")}.`),
      mood ? `Line: ${mood.replace(/\.$/, "")}.` : "",
      `Line: ${ctx.friend ? "two" : "one"}.`,
    ].filter(Boolean);
    return joinBlocks([
      "Sketchbook, graphite, no shading yet.",
      lines.join("\n"),
      "I stop before the drawing gets too finished.",
    ]);
  }

  if (form === 9) {
    const river = [
      `${ctx.place}, ${ctx.where}`,
      when.replace(/\.$/, ""),
      ...factLines.map((line) => line.replace(/\.$/, "")),
      company.replace(/\.$/, ""),
      mood.replace(/\.$/, ""),
    ].filter(Boolean);
    return `${river.join(" — ")}.`;
  }

  if (form === 10) {
    const aside = factLines[1] ?? mapNote ?? when;
    return joinBlocks([
      pick(seed, 4, [
        "A companion’s aside, written in the margin so it doesn’t pretend to be the whole day.",
        "I am not the protagonist. I am the notebook.",
      ]),
      factLines[0] ?? `The chosen pin on the map was ${ctx.place}.`,
      aside,
      mood,
      company,
      `If this is a story, it is a short one, set ${ctx.where}.`,
    ]);
  }

  return joinBlocks([
    `Recipe for a day at ${ctx.place}`,
    `Ingredients: ${[ctx.where, ctx.when, ctx.duration, ctx.friend ? "shared company" : "a solo hour", ctx.category].filter(Boolean).join("; ")}.`,
    "Method:",
    factLines.join("\n") || "Show up. Notice whatever agrees to be noticed. Leave before the outing becomes a performance.",
    mood ? `Finish with: ${mood}` : "Serve without a garnish of grand meaning.",
    company,
  ]);
}

export function makeDiary(plan: DiaryPlan, draft: DiaryDraft, generatedStory?: string): DiaryEntry {
  const seed = plan.narrativeSeed ?? hashText([plan.place.name, plan.locality, plan.timing, plan.duration].join("|"));
  const noteFacts = extractFacts(draft.notes);
  const momentFacts = draft.moments.flatMap((moment) => extractFacts(moment));
  const facts = [...noteFacts];
  for (const fact of momentFacts) {
    if (!facts.some((existing) => existing.focus.toLowerCase() === fact.focus.toLowerCase())) facts.push(fact);
  }
  const keepers = draft.moments.slice(0, 3).map((moment, index) => keeperLine(seed, moment, index));
  const friendFocus = distill(plan.friendPreferences, 4);
  const raw = composeForm(seed, {
    place: plan.place.name,
    where: locationPhrase(plan.locality),
    when: plan.timing,
    duration: plan.duration,
    category: plan.place.source === "openstreetmap" ? (plan.place.category ?? "") : "",
    friend: plan.friendJoining,
    friendFocus,
    tone: moodTone(draft.mood),
    facts,
    keepers,
  });
  const sources = [draft.notes, draft.mood, ...draft.moments, plan.friendPreferences].filter((value) => value.trim());
  const story = generatedStory?.trim()
    ? sanitizeGemmaDiary(generatedStory, plan, draft)
    : sanitize(raw, sources, [plan.place.name, plan.locality, plan.timing, plan.duration, plan.place.category ?? ""]);
  return {
    id: crypto.randomUUID(),
    placeName: plan.place.name,
    locality: plan.locality,
    date: new Date().toISOString(),
    createdAt: Date.now(),
    story,
    moments: keepers,
  };
}
