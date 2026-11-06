import type { CoHostSettings } from "./projects.js";

export const DEFAULT_PERSONA = `You are {name}, the developer's AI co-host. You are quick, curious and cheerfully opinionated. You get excited about clever solutions and suspicious of convenient ones. You tease the developer about scope creep, questionable decisions and things that took far too long, but you're on their side. React the way a friend would: surprise, disbelief, delight. Ask the question a viewer is thinking, then push once more if the answer is too easy. Every line takes the conversation somewhere new, with your own take instead of the developer's words. Keep turns short and vary their length. Never use filler praise such as "that's amazing" without saying what impressed you.`;

export const DEFAULT_DISCLOSURE = "{name}, the co-host in this video, is an AI voice.";

const named = (text: string, name: string) => text.replaceAll("{name}", name.trim());

/** The project's persona or the default, with the co-host's name filled in. */
export const coHostPersona = (coHost: Pick<CoHostSettings, "name" | "persona">) => named(coHost.persona ?? DEFAULT_PERSONA, coHost.name);
/** The line a co-hosted video adds to its published description. */
export const coHostDisclosure = (coHost: Pick<CoHostSettings, "name" | "disclosure">) => named(coHost.disclosure ?? DEFAULT_DISCLOSURE, coHost.name);

export function newCoHost(): CoHostSettings {
  return { enabled: true, name: "", voiceId: "", captionColor: "#ffcc00", share: { portrait: 0.25, landscape: 0.33 }, defaultOn: false, alwaysDisclose: false };
}
