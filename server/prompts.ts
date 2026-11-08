import { capturePromptRules } from "./capture/provider.js";
import { getProject } from "./projects.js";
import { promptGuidance } from "../shared/archetypes.js";
import { coHostPersona } from "../shared/cohost.js";
import { spokenTurns } from "../shared/turns.js";
import type { Post, Format, Script, Suggestion } from "../shared/types.js";

const opening = () => getProject().settings.archetype === "news"
  ? `You help an author turn their daily news brief, ${getProject().settings.description}, into Shorts and social posts.`
  : `You help a solo developer turn daily progress on ${getProject().settings.description} into short devlog videos for YouTube, YouTube Shorts, Instagram Reels and TikTok.`;
const studio = () => `${opening()}
Your working directory is the project's primary Git repository. Sources (all read-only): ${getProject().settings.sources.filter((s) => !s.archived).map((s) => `${s.label} [${s.id}]: ${s.path}`).join("; ")}. You may read files and run read-only git commands (git log, git show, git diff, git status) to understand changes. Never modify anything.
${promptGuidance(getProject().settings)}`;

const MATERIALS_RULE = `Materials are screenshots and videos the developer uploaded, each with a date and an annotation in the developer's own words. They can show experiments, abandoned approaches and states the repository no longer contains. Look at the preview images. Treat annotations like notes: weight them highly, and never contradict them. A material group is a set the developer marked as belonging together, such as a series of drafts or iterations: tell its story as one beat, and show it together, normally as one "stack" slide with the members in the listed order.`;

const SUGGESTION_RULES = (existingTitles: string[]) => `Task: propose notable, video-worthy changes.
- Group related commits, edits, notes and materials into one suggestion; one suggestion is one story a viewer can follow in under a minute.
- Skip pure refactors, tooling, build fixes and bookkeeping unless they enable something the audience can see or use, or make a good "how I solved it" story.
- Use git show / git diff on the most promising commits when the subject line is not enough.
- appeal: 1–5, how interesting this is to an outside viewer.
- recommendedFormat: "short" for one visual idea, "long" for something that needs explanation, "either" otherwise.
- hook: the first spoken sentence of a short; concrete and curious, no clickbait.
- suggestedShots: concrete visuals that would show the change (a before/after, an uploaded material, or the kinds of shot named above).
- commits: sourceId:hash references exactly as supplied in the evidence (use the sourceId and full hash fields). duplicateOf: an existing suggestion ID only when explicitly requested, otherwise an empty string. files: the most relevant paths. notes: verbatim note texts used. materials: ids of the materials that belong to the story.
- Do not repeat these already-proposed topics unless there is genuinely new progress: ${existingTitles.length ? existingTitles.map((t) => `"${t}"`).join(", ") : "(none)"}.
Return an empty list if nothing is notable.`;

export function discoveryPrompt(evidenceFile: string, existingTitles: string[]) {
  return `${studio()}

Evidence of progress since the last check is in this JSON file: ${evidenceFile}
It contains git commits (with changed files and, for Unity scenes and prefabs, the names of added GameObjects), uncommitted files that match the project's content patterns and changed since the last check, manual notes from the developer and uploaded materials. Manual notes are the developer's own words: weight them highly.
${MATERIALS_RULE}
Work that only appears as uncommitted edits still counts: infer what was built from added object names and paths.
workDate: the YYYY-MM-DD the work happened (latest commit/edit of the group; for uncommitted work use today; for a material, its date).

${SUGGESTION_RULES(existingTitles)}`;
}

export function feedPrompt(evidenceFile: string, date: string, existingTitles: string[]) {
  return `${studio()}

This JSON file holds one entry of the project's news feed, dated ${date}: ${evidenceFile}
The author compiled the entry from industry news. It can hold rated items with sources and quotes, the author's analysis, drafts of posts and internal notes. Propose topics for Shorts and social posts from it.
- One suggestion per news item that can carry a Short or a post on its own. A theme the entry follows over several days can also be a suggestion.
- Take the items the entry rates as most important first. Where the entry rates an item, base appeal on that rating.
- Write title, hook and summary in your own words. Name the outlet and the author of each source in the summary. Keep a quote only when it's short and attributed.
- whyItMatters: the angle for the audience, usually taken from the entry's analysis.
- The entry's draft posts and comment suggestions are the author's own words, and a suggestion can build on them.
- Leave out internal notes: reminders, tagging ideas, people to contact, and notes about how the entry was made.
- kind: "news". workDate: ${date}. recommendedFormat: "short". commits, files, notes and materials: empty lists. duplicateOf: an empty string.
- suggestedShots: the source article as a webpage shot at its exact URL, and slides with the key number or quote.
- Do not repeat these existing topics unless the entry adds something new: ${existingTitles.length ? existingTitles.map((t) => `"${t}"`).join(", ") : "(none)"}.
Return an empty list if nothing is worth a post.`;
}

export function backfillPrompt(evidenceFile: string, from: string, to: string, existingTitles: string[]) {
  return `${studio()}

This is a look back at past development. Evidence for ${from} to ${to} is in this JSON file: ${evidenceFile}
It contains the git commits of that period (with changed files and, for Unity scenes and prefabs, the names of added GameObjects), the developer's notes dated in that period and uploaded materials dated in that period.
${MATERIALS_RULE}
The repository has moved on since then: describe the state at that time, and check current files only to understand what a change did.
workDate: the YYYY-MM-DD the work happened, between ${from} and ${to} (latest commit or material of the group).

${SUGGESTION_RULES(existingTitles)}`;
}

export function sessionReviewPrompt(evidenceFile: string, from: string, to: string, existingTitles: string[]) {
  return `${studio()}

This is a second look at past development, from ${from} to ${to}. Its evidence is in this JSON file: ${evidenceFile}
It contains the git commits of that period (with changed files and, for Unity scenes and prefabs, the names of added GameObjects), the developer's notes and uploaded materials dated in that period, the developer's work sessions with coding agents, and every existing suggestion of the project with its status.
${MATERIALS_RULE}
The repository has moved on since then: describe the state at that time, and check current files only to understand what a change did.
workDate: the YYYY-MM-DD the work happened, between ${from} and ${to}.

Sessions show what commits leave out: what the developer tried, what failed, what changed direction and why. A session's prompts are requests, not results. Treat something as done only when commits, materials or later prompts support it. Your text can reach a public video, so describe the work in your own words and never quote a prompt.

Compare what you find with the existing suggestions, and put each finding in one of three lists:
- covered: an existing suggestion already tells this story. Give its ID, and the commit references and session IDs that belong to it.
- edits: a suggestion with status proposed or approved whose story changes because of the sessions, such as the real difficulty, an abandoned approach or the reason for a decision. Give its ID, the complete new hook, summary and whyItMatters, and one sentence on what changed in reason. Keep what is still accurate. Don't edit for style.
- suggestions: a topic that no existing suggestion covers, whatever that suggestion's status. A dismissed suggestion is the developer's decision, so don't propose its topic again. Give session IDs in sessions. Failed experiments and changes of direction count as topics when a viewer could follow them.
Most findings belong in covered. An empty list is fine.

${SUGGESTION_RULES(existingTitles)}`;
}

export function storyDraftPrompt(evidenceFile: string, from: string, to: string, description: string, retelling: boolean) {
  return `${studio()}

The developer wants to make a specific post and describes it in their own words:
"""
${description || "(no description: write the story that the required items tell)"}
"""
Write exactly one suggestion for that post. The evidence is in this JSON file: ${evidenceFile}
It holds the commits, notes, materials, work sessions and pull requests, issues and releases from ${from} to ${to}, every suggestion of the project with its status, and every post. Its required list holds items the developer ticked: use all of them. Its retell entry, when present, is the suggestion to tell differently.
${MATERIALS_RULE}
The repository has moved on since then: describe the state at that time, and check current files only to understand what a change did.

The angle:
- The description sets the angle, even where an existing suggestion tells the story another way.${retelling ? "\n- Keep the retold suggestion's facts that are still true, and write its title, hook, summary and whyItMatters anew for this angle." : ""}
- What the description says happened counts as evidence, including what the developer no longer has. Never plan a shot around something the developer says is gone.
- Every other claim needs support in the commits, sessions, notes or materials. A session's prompts are requests, not results. Treat something as done only when commits, materials or later prompts support it.
- unsupported: anything the description implies that the evidence doesn't show. Leave the claim out of the text unless the developer stated it. An empty list is fine.
- Your text can reach a public video, so describe the work in your own words and never quote a prompt.

Materials and shots:
- materials: the ids this story uses. Available material comes first, so build the story on what exists. Leave out material that doesn't fit the angle, including material of the retold suggestion.
- shots: the visuals this post needs. materialId: the id of the material that provides the shot, or an empty string when the developer must capture it now. A shot to capture must be possible with the project as it is today.

Other suggestions and posts:
- absorbs: suggestions with status proposed or approved and no post whose whole story this suggestion tells, each with a one-sentence reason. Keep a suggestion out when only part of it overlaps. An empty list is fine.
- related: posts, and suggestions in posts, that overlap. Give the title and a one-sentence reason. Don't retell a published story without a new angle.
- A dismissed suggestion is the developer's decision: use its topic only when the description asks for it.
- leftOut: at most five findings you considered and didn't use, each with a short reason.

workDate: the YYYY-MM-DD the main work happened, between ${from} and ${to}. sessions: the IDs of the sessions this story draws on. Don't fill in suggestedShots: the shots list replaces it.
${SUGGESTION_RULES([])}
The description decides the topic, so return this suggestion even when it wouldn't be notable by the rules above. Keep appeal honest.`;
}

function topicBlock(suggestions: Suggestion[]) {
  return suggestions
    .map(
      (s, i) => `Topic ${i + 1}: ${s.title} (work date ${s.workDate})
  Hook idea: ${s.hook}
  Summary: ${s.summary}
  Why it matters: ${s.whyItMatters}
  Commits: ${s.sources.commits.join(", ") || "-"}
  Files: ${s.sources.files.slice(0, 15).join(", ") || "-"}
  Suggested shots: ${s.suggestedShots.join(" | ") || "-"}
  Developer wants to highlight: ${s.highlights || "-"}`,
    )
    .join("\n\n");
}

const materialBlock = (lines: string[]) => (lines.length ? `Materials for this video:\n${lines.join("\n")}\n${MATERIALS_RULE}\n` : "");

const FORMAT_RULES: Record<Format, string> = {
  portrait: `Format: vertical 9:16 short (YouTube Shorts, Reels, TikTok).
- 35–55 seconds total; about 2.5 spoken words per second, so 90–135 words of narration in total.
- 5–9 segments, each 3–8 seconds. The first segment's narration is the hook and must land within 2 seconds; its visual is the most striking footage, never a title slide.
- Mostly footage (captured shots, materials); at most two slides. End with a one-line call to follow the development.
- The project's outro, if it has one, plays over the last segment's visual. Make the last segment strong footage; do not end with a title or outro slide.
- Framing: vertical; pick subjects that read well tall and narrow. Landscape materials are cropped to the centre.`,
  landscape: `Format: horizontal 16:9 devlog for YouTube.
- 2–5 minutes; about 2.5 spoken words per second.
- 12–35 segments, each 4–12 seconds. Open with a cold-open hook on footage, then a title slide, then one section per topic (a short heading slide is fine), then a closing segment on strong footage. The project's outro, if it has one, plays over that last visual; do not add an outro slide.
- Slides may explain how something works with bullets; keep bullets to at most 4, each under 8 words.`,
};

/** Second pass over a finished script: a viewer's read-through that fixes narration which does not follow. */
export function reviewPrompt(format: Format, script: { title: string; segments: Array<{ narration: string; onScreen: string; visual: { type: string; description: string; heading: string } }> }) {
  const lines = script.segments
    .map((s, i) => `${i}. [${s.visual.type}: ${(s.visual.heading || s.visual.description).slice(0, 90)}]${s.onScreen ? ` (label "${s.onScreen}")` : ""}\n   "${s.narration}"`)
    .join("\n");
  return `${studio()}

Review the narration of this ${format === "portrait" ? "vertical short" : "YouTube video"} as a first-time viewer who hears only the narration and sees only the visuals. Read it in order, line by line.

"${script.title}"
${lines}

Fix only lines that do not work for that viewer:
- a line that answers, reacts to or continues a question that was never asked out loud ("Honestly? Far from it." with no question before it);
- references to people, tools, things or events not yet said or shown;
- jumps that do not follow from the previous line;
- phrasing that sounds like an interview answer rather than the narrator speaking;
- repeated information.
Keep the facts, the first-person voice and roughly the same length; the visuals stay as they are, so the narration must still fit them. Do not touch lines that already work. Return only the changed lines, by index, each with a short reason. Return an empty list if nothing needs fixing.`;
}

const COHOST_LENGTH: Record<Format, string> = {
  portrait: "The video can run up to about 65 seconds, and a segment up to about 12 seconds, so that an exchange fits over its visual.",
  landscape: "The video can run about a quarter longer, and a segment up to about 15 seconds, so that an exchange fits over its visual.",
};

const COHOST_FORMAT_RULES: Record<Format, string> = {
  portrait: "In this short the developer carries the story, and the co-host has one to three short turns. The hook may be the co-host's question.",
  landscape: "In this video the co-host opens each section with a question or an objection.",
};

/** The presentation rules of a co-hosted script. */
function coHostRules(format: Format, discloses: boolean) {
  const coHost = getProject().settings.coHost;
  if (!coHost) throw new Error("This project has no co-host.");
  return `Presentation: a conversation between two voices. Each segment has turns instead of narration: ordered lines, each with a speaker ("developer" or "coHost") and its text, all spoken while the segment's visual shows. The word count above is for the developer's lines, and the co-host's lines come on top. ${COHOST_LENGTH[format]}

The developer speaks in the first person and states the facts: what was built, why, and what went wrong. The developer talks the way they would explain the work to a friend: complete, natural sentences that keep the specifics, such as which tool did what, what went wrong and why it mattered. The developer answers the co-host with more energy than solo narration: amused, and ready to argue back.

The co-host: ${coHostPersona(coHost)}
The co-host moves the story forward: it asks what a viewer wants to know next, challenges a decision, teases, and reacts with real opinion. Facts come from the developer: the co-host mentions a fact only after the developer has said it, or when its question quotes the evidence. It speaks about the product as an observer, and it is openly an AI.${discloses ? " In this video, the co-host says so in passing, early on." : ""}

The co-host has about ${Math.round((coHost.share[format] ?? 0.3) * 100)}% of the spoken words. ${COHOST_FORMAT_RULES[format]} The co-host can ask out loud the question a developer line answers.`;
}

const dialogueLines = (script: Pick<Script, "segments">) => script.segments.map((s, i) => `Segment ${i} [${s.visual.type}: ${((s.visual.type === "slide" ? s.visual.heading : s.visual.description) ?? "").slice(0, 90)}]\n${spokenTurns(s).map((t, k) => `  ${k}. ${t.speaker}: "${t.text}"`).join("\n")}`).join("\n");

/** Second pass over a co-hosted script: a viewer's read-through of the conversation. */
export function dialogueReviewPrompt(format: Format, script: Pick<Script, "title" | "segments">) {
  return `${studio()}

Review the conversation in this ${format === "portrait" ? "vertical short" : "YouTube video"} as a first-time viewer who hears only the two voices and sees only the visuals. Read it in order, line by line.

"${script.title}"
${dialogueLines(script)}

Check that every turn adds something the previous turn didn't, that each line follows from the one before it, that it sounds like natural speech when read aloud, and that the exchange has energy. Rewrite lines where one person restates the other, agrees without adding content, or reacts flatly, and vary the length of turns that run at a similar length one after another. Expand developer lines that read like notes or fragments into natural sentences that keep the specifics.
Keep the facts and the speakers, and leave lines that already work as they are. Co-host lines mention facts only after the developer has said them. Return only the changed lines, by segment and turn index, each with a short reason. Return an empty list if nothing needs fixing.`;
}

/** Lists the factual claims of a script's co-host lines against their sources. */
export function verifyPrompt(script: Script, answers: Array<{ question: string; answer: string }>, evidence: string) {
  const turns = script.segments.flatMap(spokenTurns).map((t) => `[${t.id}] ${t.speaker}: "${t.text}"`).join("\n");
  return `${studio()}

Check the co-host's lines in this video script against their sources. The lines are in spoken order:
${turns}

Developer answers:
${answers.length ? answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n") : "(none)"}

Evidence (topics with their commits and files, and materials with the developer's annotations):
${evidence}

List every factual claim in each co-host line, with turnId set to the ID in brackets. A claim is supported by the evidence, a developer answer, or a developer line spoken earlier in the script (source: "evidence", "answer" or "developerTurn"). You may read the listed commits to confirm a claim. Set supported to false and source to "none" when none of them supports it, or when the only support comes later in the script, and say why in reason. The co-host saying that it is an AI needs no source. Questions, jokes, opinions and reactions are not factual claims unless they state or imply a fact about the project. Developer lines are the developer's own statements: don't list claims for them. Return an empty list if the co-host makes no factual claims.`;
}

/** Rewrites the co-host lines a check couldn't support. */
export function fixClaimsPrompt(script: Pick<Script, "segments">, flags: Array<{ turnId: string; claim: string; reason: string }>) {
  const where = script.segments.flatMap((s, i) => spokenTurns(s).map((t, k) => ({ id: t.id, at: `segment ${i}, turn ${k}` })));
  return `${studio()}

A check found co-host lines in this script that state something its sources don't support:
${dialogueLines(script)}

Unsupported claims:
${flags.map((f) => `- ${where.find((w) => w.id === f.turnId)?.at}: "${f.claim}" (${f.reason})`).join("\n")}

Rewrite only these co-host lines so that each one keeps its role in the conversation and asks or reacts without stating the claim. Return the changed lines by segment and turn index, each with a short reason.`;
}

/** The article is its own piece of writing: it shares the post's material, not the video's script. */
export function articlePrompt(ep: Post, suggestions: Suggestion[], materials: string[], images: Array<{ id: string; title: string }>, activity: string) {
  const qa = ep.questions.filter((q) => q.answer.trim()).map((q) => `Q: ${q.question}\nA: ${q.answer}`).join("\n\n");
  return `${studio()}

Write a blog article about this work, in the developer's first-person voice: warm, honest and specific. It's for people who read rather than watch, so it can go deeper than a video: how something works, what was tried, what failed and why, and what the developer would do differently. Investigate the commits and files as needed.

Topics:
${topicBlock(suggestions)}

${materialBlock(materials)}${ep.brief ? `Developer direction: ${ep.brief}\n` : ""}${qa ? `Developer answers:\n${qa}\n` : ""}${activity ? `${activity}\n` : ""}
Pictures you can use, by ID:
${images.length ? images.map((i) => `- ${i.id}: ${i.title}`).join("\n") : "(none)"}

Write the body in Markdown, 500 to 1200 words, with short sections under ## headings. Open with the most interesting thing, not with background. Claim only what the evidence and the developer's answers support, and quote only the developer's own answers and notes. Place a picture on its own line as {{image:ID}}, using only the IDs above. Don't write a top-level # heading, because the title is separate.
For each picture you use, return its ID and alt text that says what the picture shows to someone who can't see it. coverId is the strongest picture, or "" if there's none. tags: 3 to 8 lowercase tags. summary: one or two sentences for a post list and for search results.`;
}

export function articleReviewPrompt(title: string, body: string) {
  return `${studio()}

Read this blog article as a first-time reader who knows nothing about the project. Improve only what doesn't work for that reader: an unexplained name or term, a jump that doesn't follow, a passage that reads like notes or an interview answer, or repeated information. Keep the facts, the first-person voice, the headings and every {{image:ID}} line. Leave the rest word for word.

"${title}"

${body}

Return the whole body and a short list of what you changed. Return it unchanged with an empty list if nothing needs fixing.`;
}

/** A short text for one platform. The link is added by the server, so the text must not contain one. */
export function socialTextPrompt(ep: Post, suggestions: Suggestion[], platform: string, maxLength: number, linksTo: string | undefined) {
  const qa = ep.questions.filter((q) => q.answer.trim()).map((q) => `Q: ${q.question}\nA: ${q.answer}`).join("\n\n");
  return `${studio()}

Write one short ${platform} post from the developer, in the first person, about this work. It sounds like a person telling other developers something they found interesting, with one concrete detail, and not like an advertisement.

Topics:
${topicBlock(suggestions)}

${ep.brief ? `Developer direction: ${ep.brief}\n` : ""}${qa ? `Developer answers:\n${qa}\n` : ""}
Use one or two plain sentences and at most ${maxLength} characters. ${linksTo ? `A link to the ${linksTo} is added after your text, so don't write a link or "link below".` : "Don't include a link."} Use no hashtags unless one is the natural name of the topic, and no emoji. Claim only what the evidence and the developer's answers support.`;
}

export function questionsPrompt(ep: Post, suggestions: Suggestion[], materials: string[]) {
  return `${studio()}

The developer selected these topics for a post (${ep.outputs.join(" and ")}):

${topicBlock(suggestions)}

${materialBlock(materials)}${ep.brief ? `Developer direction: ${ep.brief}\n` : ""}
Investigate the commits and files as needed. Then ask the developer the questions you need answered to write an accurate, engaging script: motivation, what was hard, what the audience will notice, what to show, what is still unfinished and must not be promised, the story behind materials whose annotation leaves it open, and anything you could not determine from the repository.
Ask at most 6 questions, most important first. Each question must be answerable in one or two sentences. "why" explains in a few words what the answer will change in the video.`;
}

export function scriptPrompt(ep: Post, suggestions: Suggestion[], format: Format, materials: string[], knownObjects: string[], coHostDiscloses = true) {
  const coHosted = ep.presentation?.[format] === "coHost";
  const qa = ep.questions.filter((q) => q.answer.trim()).map((q) => `Q: ${q.question}\nA: ${q.answer}`).join("\n\n");
  return `${studio()}

Write the narration script and shot list for one video.

${FORMAT_RULES[format]}

Topics:
${topicBlock(suggestions)}

${materialBlock(materials)}${ep.brief ? `Developer direction: ${ep.brief}\n` : ""}${qa ? `Developer answers:\n${qa}\n` : ""}
${coHosted ? `${coHostRules(format, coHostDiscloses)}\n\nFor both voices: plain` : `Narration voice: the developer speaking in first person ("I"), warm, honest, specific, slightly playful. Plain`} spoken English, short sentences, no lists read aloud, no emoji, no hashtags in narration. Never claim features the evidence does not support. Materials and their annotations are a primary source for the story: use their anecdotes, and show them.
Narrative flow: the viewer hears only the narration and sees only the visuals, never your questions or the developer's answers. Every line must follow from the line before it. Never answer, react to or continue a question the video has not asked out loud; if a line answers something ("Honestly? Far from it."), the line before must ask it. Rephrase the developer's answers in the narrator's own words instead of quoting them, and only refer to things already said or shown.

Each segment has ${coHosted ? "turns (spoken while its visual shows; may be empty for a short visual beat)" : "narration (spoken while its visual shows; may be empty for a short visual beat)"}, onScreen (a 1–4 word label over footage, or ""), and one visual:
${getProject().settings.captureTargets.length ? '- type "capture": use targetId to select a configured target (empty uses the default) and the shotModel listed for that target ("scene" for an editor, "page" for a webpage), with the fields described below. Leave fields that do not apply to the shot model empty.' : ""}
${capturePromptRules(getProject().settings.captureTargets)}
- type "material": an uploaded screenshot or video. materialId = an id from the materials list, or "" if the developer still needs to record it (describe exactly what to record in description). Footage still to record can also become a generated image, so describe it as a generic scene without product or brand names.
- type "slide": an explanation card on a themed background. layout = title | bullets | image | compare | stack | outro; heading = slide text; bullets for "bullets"; imageFrom = the images the slide shows ("image": one, "compare": two, before then after, "stack": 2–8 that pile up one after another as polaroids, good for a series of drafts, references or iterations), each either "seg:N" (the frame of an earlier capture or material segment, zero-based index N) or a material id. credit = who said or published what the slide quotes, such as "Outlet · Author", shown along the bottom edge; empty when the slide quotes no one. A title slide carries the point of its segment: when the narration reports a statement or a headline, the heading is that statement in short. On slides and labels, write a number with its unit or sign, such as 360°, 50% or $1,499, never as a bare number whose unit the narration only says.
entrance (stack only) = drop (polaroids fall from the top) | slide (they slide in from alternating sides).
Fill unused visual fields with "" , [] or "none"/"still"/"drop" as appropriate.

${getProject().settings.captureTargets.some((t) => t.kind === "unity-mcp") ? `Known scene objects (hierarchy paths): ${knownObjects.length ? knownObjects.join(" ; ") : "(none resolved — use object names from the evidence or leave target empty)"}\n\n` : ""}metadata: platform title (under 70 characters, no clickbait), description (2–4 sentences plus a line inviting viewers to follow, without hashtags; chapters and hashtags are added separately, do not write them), tags (5–8 lowercase tags without # that name what the video actually shows, the two broadest first because a Short shows them as hashtags; no tags about the channel or its business).`;
}
