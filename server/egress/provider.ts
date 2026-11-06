import type { EgressConnection, Publication, PublicationContent } from "../../shared/publications.js";
import type { Post } from "../../shared/types.js";

export interface PublishResult { platformId?: string; url?: string; sentText?: string }
export interface PublishContext {
  post: Post;
  connection: EgressConnection;
  /** The text with its placeholders filled in. */
  text: string;
  log: (line: string) => void;
  /** The URL a link card points at, when the text links to something. */
  linkUrl?: string;
  /** A still frame of the linked video, for a link card. */
  thumbnail?: () => Promise<Buffer | undefined>;
  values: { youtubeUrl?: string; youtubeId?: string; articleUrl?: string };
}

/** Publishes an output to one platform. A new platform needs one new connector. */
export interface EgressConnector {
  id: Publication["connector"];
  label: string;
  accepts: Array<"video" | "article" | "text">;
  capabilities: {
    /** The platform holds a future publish time itself. */
    schedules: boolean;
    /** Sending twice after a crash can't post twice. */
    idempotent: boolean;
    metrics: boolean;
  };
  /** Returns the problems that block approval. */
  validate(content: PublicationContent, post: Post): string[];
  publish(publication: Publication, context: PublishContext): Promise<PublishResult>;
  /** Whether the public can see the result, so dependents can run. */
  isPublic(result: NonNullable<Publication["result"]>, connection: EgressConnection): Promise<boolean>;
  metrics?(result: NonNullable<Publication["result"]>, connection: EgressConnection): Promise<Record<string, number>>;
}
