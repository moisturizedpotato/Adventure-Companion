import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./diary.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const diaryModule = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const { buildGemmaDiaryInput, makeDiary } = diaryModule;

const plan = {
  locality: "Brooklyn",
  timing: "afternoon",
  duration: "2 hours",
  friendJoining: false,
  friendPreferences: "",
  place: { name: "Medgar Evers Pool", details: "", source: undefined },
};

test("local fallback reflects only the plan and details the user supplied", () => {
  const entry = makeDiary(plan, {
    notes: "This is an illustrative sample, not a real visit.",
    mood: "curious",
    moments: ["The pool name caught my attention."],
  });

  assert.match(entry.story, /Medgar Evers Pool, Brooklyn/);
  assert.match(entry.story, /afternoon; 2 hours available/);
  assert.match(entry.story, /This is an illustrative sample, not a real visit\./);
  assert.match(entry.story, /curious/);
  assert.match(entry.story, /The pool name caught my attention\./);
  assert.doesNotMatch(entry.story, /swam|sunshine|water|friends? joined/i);
});

test("local fallback stays clear when the user shared no notes or moments", () => {
  const entry = makeDiary(plan, { notes: "", mood: "", moments: [] });

  assert.equal(entry.story, "A diary note for Medgar Evers Pool, Brooklyn.\n\nThe plan was afternoon; 2 hours available.\n\nNo outing notes or saved moments were added.");
});

test("attached photo is saved with the entry but omitted from Gemma input", () => {
  const photoDataUrl = "data:image/jpeg;base64,LOCAL_SAMPLE_IMAGE";
  const draft = {
    notes: "The pool name caught my attention.",
    mood: "",
    moments: [],
    photoDataUrl,
  };
  const entry = makeDiary(plan, draft);
  const gemmaInput = buildGemmaDiaryInput(plan, draft);

  assert.equal(entry.photoDataUrl, photoDataUrl);
  assert.ok(!gemmaInput.prompt.includes(photoDataUrl));
  assert.ok(!gemmaInput.prompt.includes(draft.notes));
  assert.match(buildGemmaDiaryInput(plan, draft, "a blue towel beside a tiled pool").prompt, /blue towel beside a tiled pool/);
});

test("Gemma prompt uses distilled cues, a changeable creative nudge, and evidence-based reflection", () => {
  const draft = {
    notes: "I saw a very blue towel folded by the tiled pool.",
    mood: "calm",
    moments: [],
  };
  const firstPrompt = buildGemmaDiaryInput(
    plan,
    draft,
    "a blue towel beside a tiled pool",
    "notice a small detail that quietly changes the day's meaning",
  ).prompt;
  const nextPrompt = buildGemmaDiaryInput(
    plan,
    draft,
    "a blue towel beside a tiled pool",
    "let the emotional impression emerge gradually rather than naming it first",
  ).prompt;

  assert.ok(!firstPrompt.includes(draft.notes));
  assert.match(firstPrompt, /reportedFactCues/);
  assert.match(firstPrompt, /center the user's inner experience and behavior/i);
  assert.match(firstPrompt, /candid, compassionate, and fair/i);
  assert.match(firstPrompt, /never guess the user's gender/i);
  assert.match(firstPrompt, /notice a small detail that quietly changes the day's meaning/);
  assert.notEqual(firstPrompt, nextPrompt);
  assert.doesNotMatch(firstPrompt, /Requested noting manner|with 2–5 paragraphs/i);
});

test("Gemma context preserves mood changes and concrete behavior cues without source sentences", () => {
  const draft = {
    notes: "I walked the quiet path. I noticed blue path markers.",
    mood: "Worn out at first, then calmer and curious.",
    moments: ["I chose to pause and sit for a while."],
  };
  const prompt = buildGemmaDiaryInput(plan, draft).prompt;

  assert.ok(!prompt.includes(draft.notes));
  assert.match(prompt, /fatigue or low energy/);
  assert.match(prompt, /calm or relief/);
  assert.match(prompt, /curiosity or openness/);
  assert.match(prompt, /reported shift toward greater ease or openness/);
  assert.match(prompt, /chose active movement/);
  assert.match(prompt, /paid attention to visual details/);
});
