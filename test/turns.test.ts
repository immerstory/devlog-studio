import { test } from "node:test";
import assert from "node:assert/strict";
import { takeHash, usableTakes, type ResolvedVoice, type VoiceOf } from "../server/takes.js";
import { toSrt } from "../server/timeline.js";
import { publishPackage } from "../server/pipeline.js";
import { scriptSchema } from "../server/agent.js";
import { coHostDisclosure, coHostPersona, DEFAULT_PERSONA } from "../shared/cohost.js";
import { flagKey, scriptFingerprint, verificationFingerprint } from "../server/verification.js";
import { spokenTurns } from "../shared/turns.js";
import type { NarrationTake, Segment, Speaker, Turn } from "../shared/types.js";

const narrator: ResolvedVoice = { voiceId: "narrator", modelId: "eleven_v4", stability: 0.45, similarityBoost: 0.8, style: 0.15, speed: 1 };
const coHost: ResolvedVoice = { ...narrator, voiceId: "cohost" };
const voices: VoiceOf = (speaker) => (speaker === "developer" ? narrator : coHost);
const segment = (id: string, turns: Turn[]): Segment => ({ id, narration: "", turns, visual: { type: "slide", layout: "title", heading: id } });
const turn = (id: string, speaker: Speaker, text: string): Turn => ({ id, speaker, text });
const takeOf = (segmentId: string, t: Turn, voice = voices(t.speaker)!): NarrationTake => ({ segmentId, turnId: t.id, speaker: t.speaker, file: `tts/${t.id}.mp3`, durationMs: 1000, words: [], hash: takeHash(voice, t.text) });

const ask = turn("t-ask", "coHost", "Drafts?");
const answer = turn("t-answer", "developer", "Drafts.");
const script = () => [segment("s1", [ask, answer]), segment("s2", [turn("t-end", "coHost", "Bold.")])];
const takes = () => [takeOf("s1", ask), takeOf("s1", answer), takeOf("s2", script()[1].turns![0])];
const kept = (segments: Segment[], voiceOf = voices) => usableTakes(takes(), segments, voiceOf).map((t) => t.turnId);

test("a solo segment speaks one developer line whose ID is the segment's", () => {
  assert.deepEqual(spokenTurns({ id: "s", narration: " Hello. " }), [{ id: "s", speaker: "developer", text: " Hello. " }]);
  assert.deepEqual(spokenTurns({ id: "s", narration: "   " }), []);
});

test("a co-hosted segment speaks its turns and skips empty ones", () => {
  const empty = turn("t-empty", "coHost", "  ");
  assert.deepEqual(spokenTurns(segment("s", [ask, empty, answer])), [ask, answer]);
});

test("a solo take keeps the hash stored takes already have", () => {
  assert.equal(takeHash(narrator, " Far too many pages. "), "70e6d3b8e29e8f1bf69756d9");
});

test("each voice has its own take of the same text", () => {
  assert.notEqual(takeHash(narrator, "Drafts."), takeHash(coHost, "Drafts."));
  assert.notEqual(takeHash(coHost, "Drafts."), takeHash({ ...coHost, stability: 0.2 }, "Drafts."));
});

test("takes stay valid while their turn, text and voice stay the same", () => {
  assert.deepEqual(kept(script()), ["t-ask", "t-answer", "t-end"]);
});

test("changing a turn's text removes only that take", () => {
  const edited = script();
  edited[0].turns![0] = { ...ask, text: "Really, drafts?" };
  assert.deepEqual(kept(edited), ["t-answer", "t-end"]);
});

test("swapping a turn's speaker removes that take", () => {
  const swapped = script();
  swapped[0].turns![1] = { ...answer, speaker: "coHost" };
  assert.deepEqual(kept(swapped), ["t-ask", "t-end"]);
});

test("deleting a turn removes that take", () => {
  const shorter = script();
  shorter[0].turns!.splice(0, 1);
  assert.deepEqual(kept(shorter), ["t-answer", "t-end"]);
});

test("reordering keeps all takes, and a moved take follows its turn", () => {
  const moved = script();
  moved[1].turns!.unshift(moved[0].turns!.pop()!);
  moved[0].turns!.reverse();
  const result = usableTakes(takes(), moved, voices);
  assert.deepEqual(result.map((t) => t.turnId), ["t-ask", "t-answer", "t-end"]);
  assert.equal(result.find((t) => t.turnId === "t-answer")!.segmentId, "s2");
});

test("changing a co-host voice setting removes only co-host takes", () => {
  const retuned: VoiceOf = (speaker) => (speaker === "developer" ? narrator : { ...coHost, stability: 0.2 });
  assert.deepEqual(kept(script(), retuned), ["t-answer"]);
});

test("removing the co-host removes only co-host takes", () => {
  const noCoHost: VoiceOf = (speaker) => (speaker === "developer" ? narrator : undefined);
  assert.deepEqual(kept(script(), noCoHost), ["t-answer"]);
});

test("solo takes pass through", () => {
  const solo: NarrationTake = { segmentId: "s", file: "tts/s.mp3", durationMs: 1, words: [], hash: "anything" };
  assert.deepEqual(usableTakes([solo], [{ id: "s", narration: "Hi", visual: { type: "slide", layout: "title", heading: "" } }], voices), [solo]);
});

test("subtitle files mark speaker changes", () => {
  const srt = toSrt([
    { text: "Drafts?", startMs: 0, endMs: 1000, color: "#ffcc00" },
    { text: "Yes.", startMs: 1000, endMs: 2000, speakerChange: true },
    { text: "Drafts.", startMs: 2000, endMs: 3000 },
  ]);
  assert.equal(srt, "1\n00:00:00,000 --> 00:00:01,000\nDrafts?\n\n2\n00:00:01,000 --> 00:00:02,000\n>> Yes.\n\n3\n00:00:02,000 --> 00:00:03,000\nDrafts.\n");
});

test("a co-hosted script schema asks for turns, and a solo one for narration", () => {
  const solo = scriptSchema([]).properties.segments.items as { properties: Record<string, unknown>; required: string[] };
  const coHosted = scriptSchema([], true).properties.segments.items as { properties: Record<string, unknown>; required: string[] };
  assert.ok(solo.properties.narration && !solo.properties.turns);
  assert.ok(coHosted.properties.turns && !coHosted.properties.narration);
  assert.ok(coHosted.required.includes("turns") && !coHosted.required.includes("narration"));
});

test("the persona and disclosure fill in the name, and an edit replaces the default", () => {
  assert.match(coHostPersona({ name: "Robin" }), /^You are Robin,/);
  assert.equal(coHostPersona({ name: "Robin", persona: "You are grumpy." }), "You are grumpy.");
  assert.ok(DEFAULT_PERSONA.includes("somewhere new"));
  assert.equal(coHostDisclosure({ name: "Robin" }), "Robin, the co-host in this video, is an AI voice.");
});

test("a co-hosted description carries the disclosure, and a solo one doesn't", () => {
  const draft = { format: "portrait" as const, title: "T", segments: [], metadata: { title: "T", description: "About this.", tags: [] } };
  assert.ok(publishPackage(draft, "portrait", [], "Robin is an AI voice.").description.startsWith("About this.\n\nRobin is an AI voice."));
  assert.ok(!publishPackage(draft, "portrait", []).description.includes("AI voice"));
});

test("fingerprints follow the spoken script, and flag keys follow a line's support", () => {
  const post = { questions: [{ id: "q", question: "Q", answer: "A" }] };
  const s = { segments: script() };
  assert.equal(scriptFingerprint(s), scriptFingerprint({ segments: script() }));
  assert.notEqual(scriptFingerprint(s), scriptFingerprint({ segments: [script()[1], script()[0]] }));
  assert.notEqual(verificationFingerprint(s, post, "e"), verificationFingerprint(s, post, "changed"));
  assert.notEqual(verificationFingerprint(s, post, "e"), verificationFingerprint(s, { questions: [] }, "e"));
  const key = flagKey(s, post, "e", "t-end", "Claim", "r");
  assert.equal(flagKey(s, post, "e", "t-end", " claim ", "R"), key, "case and spacing don't matter");
  assert.notEqual(flagKey(s, post, "changed", "t-end", "Claim", "r"), key);
  assert.notEqual(flagKey(s, post, "e", "t-end", "Claim", "other"), key);
  const noDeveloperLine = { segments: [segment("s1", [ask]), segment("s2", [turn("t-end", "coHost", "Bold.")])] };
  assert.notEqual(flagKey(noDeveloperLine, post, "e", "t-end", "Claim", "r"), key, "an earlier developer line is support");
});
