/** The kind of product a project is. It sets the default prompt guidance and the content globs of a new project. */
export type ProjectArchetype = "game" | "webapp" | "mobile" | "news" | "other";

export interface ArchetypeDefinition {
  label: string;
  summary: string;
  /** Example for the project's description for prompts. */
  descriptionPlaceholder: string;
  /** Tells the agent who it writes for, what to emphasize and which shots work. */
  guidance: string;
  /** Content globs of a new project's first source. */
  contentGlobs: string[];
}

const PLAIN_LANGUAGE = "Avoid internal jargon, file names, class names and ticket language unless the detail itself is the interesting part.";

export const ARCHETYPES: Record<ProjectArchetype, ArchetypeDefinition> = {
  game: {
    label: "Game",
    summary: "For players and fellow game developers.",
    descriptionPlaceholder: "the Unity game My Game, a cosy farming sim",
    guidance: `Write for players and fellow game developers, not for the developer's own team: describe what changed in the game, what it looks or feels like, and why it is interesting. ${PLAIN_LANGUAGE}\nGood shots include gameplay moments, in-editor views of named objects and before/afters. In vertical video, pick subjects that read well tall and narrow, such as buildings, characters, towers and paths leading away.`,
    contentGlobs: ["*.unity", "*.prefab", "*.terrainlayer", "*.asset", "*.mat", "*.tscn", "*.umap"],
  },
  webapp: {
    label: "Web app",
    summary: "For people who use the product and fellow developers.",
    descriptionPlaceholder: "the web app My App, a budget tracker for freelancers",
    guidance: `Write for people who use or might use this product and for fellow developers, not for the developer's own team: describe what people can now do, what got faster or simpler, and why it matters. ${PLAIN_LANGUAGE}\nGood shots include a real task in the browser from start to finish, the page or result that changed, and before/afters. In vertical video, prefer the phone layout of a page.`,
    contentGlobs: [],
  },
  mobile: {
    label: "Mobile app",
    summary: "For people who use the app and fellow app developers.",
    descriptionPlaceholder: "the iOS and Android app My App, a habit tracker",
    guidance: `Write for people who use or might use this app and for fellow app developers, not for the developer's own team: describe what changed in the app, how it feels in the hand, and why it matters. ${PLAIN_LANGUAGE}\nGood shots include one complete flow on a phone screen, a gesture or transition that changed, and before/afters.`,
    contentGlobs: [],
  },
  news: {
    label: "Industry news",
    summary: "Topics from your own news brief, for people who follow the industry.",
    descriptionPlaceholder: "the XR Daily Brief, a daily roundup of XR industry news for the agency Example",
    guidance: `Topics come from the author's news brief, not from work on a product. Where other instructions speak of progress, changes or the developer's work, read them as the news item and the author's view of it. Write for people who follow this industry: what happened, who reported it, and what it means for them. Credit every source by outlet and author. Summarize in your own words, quote at most one short, attributed sentence per source, and don't present reported claims as your own findings. ${PLAIN_LANGUAGE}\nGood shots show the key number or quote as a title or bullet slide, an image the author uploaded as a material, and the name of the source on screen.`,
    contentGlobs: [],
  },
  other: {
    label: "Something else",
    summary: "For anyone interested in the project and fellow developers.",
    descriptionPlaceholder: "the open-source command-line tool my-tool, which cleans up photo libraries",
    guidance: `Write for people interested in this project and for fellow developers, not for the developer's own team: describe what changed, what it lets someone do, and why it is interesting. ${PLAIN_LANGUAGE}\nGood shots show the result as directly as possible: a demo, real output, a clear diagram, or a before/after.`,
    contentGlobs: [],
  },
};

export const ARCHETYPE_IDS = Object.keys(ARCHETYPES) as ProjectArchetype[];
export const isArchetype = (value: unknown): value is ProjectArchetype => typeof value === "string" && Object.hasOwn(ARCHETYPES, value);

/** The project's own guidance; without one, the default of its archetype, which follows later changes to that default. */
export const promptGuidance = (settings: { archetype: ProjectArchetype; promptGuidance?: string }) => settings.promptGuidance ?? ARCHETYPES[settings.archetype].guidance;
