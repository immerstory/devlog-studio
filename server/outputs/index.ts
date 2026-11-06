import type { OutputId } from "../../shared/outputs.js";
import { videoOutput } from "./video.js";
import { articleOutput } from "./article.js";

export const outputDefinition = (id: OutputId) => id === "article" ? articleOutput : videoOutput(id);
export { videoOutput, articleOutput };
