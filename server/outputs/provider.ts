import type { OutputId } from "../../shared/outputs.js";
import type { Post, Suggestion } from "../../shared/types.js";

export type Log = (line: string) => void;
export interface PostContext { post: Post; suggestions: Suggestion[]; materials: string[]; materialIds: string[]; knownObjects: string[]; /** Whether the co-host says that it is an AI in this video. */ coHostDiscloses?: boolean }
export interface ExportInfo { files: string[] }
export interface OutputDefinition<TDraft> {
  id: OutputId;
  label: string;
  available: boolean;
  stages: string[];
  writer: { prompt(ctx: PostContext): string; schema(ctx: PostContext): object; normalize(raw: unknown, ctx: PostContext): TDraft };
  export(post: Post, draft: TDraft, log: Log): Promise<ExportInfo>;
}
