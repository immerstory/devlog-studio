import type { Format, YouTubeUpload } from "./types.js";

export type EgressConnectorId = "youtube" | "bluesky" | "linkedin" | "folder" | "git-site";
export type PublicationState = "draft" | "approved" | "waiting" | "scheduled" | "late" | "publishing" | "published" | "failed" | "cancelled";

export interface PublicationContent {
  /** May hold {{youtube.url}} and {{article.url}}; only the server fills them in. */
  text?: string;
  /** Link card or article post. */
  title?: string;
  description?: string;
  /** Attaches a rendered video instead of linking to it. */
  videoFormat?: Format;
  /** Publishes the post's article. */
  article?: boolean;
  /** Chosen before sending, so a retry can't post twice where the platform accepts it. */
  recordKey?: string;
}

/** A video's upload has one publication per post and format, so that others can wait for it before it exists. */
export const youtubePublicationId = (postId: string, format: Format) => `pub-youtube-${postId}-${format}`;
export const isYoutubePublicationId = (id: string) => id.startsWith("pub-youtube-");

export interface PublicationDependency {
  publicationId: string;
  when: "published" | "public";
}

/** One output going to one connection, with its state and platform IDs. */
export interface Publication {
  id: string;
  postId: string;
  connector: EgressConnectorId;
  connectionId: string;
  content: PublicationContent;
  dependsOn: PublicationDependency[];
  /** Absent means as soon as approved and unblocked. */
  publishAt?: string;
  /** Hash of the approved content; an edit clears the approval. */
  approvedHash?: string;
  state: PublicationState;
  result?: { platformId?: string; url?: string; publishedAt?: string; sentText?: string; publicAt?: string; error?: string; /** A video's title as published. */ title?: string; /** A YouTube upload's full record. */ upload?: YouTubeUpload };
  createdAt: string;
}

export interface EgressConnection {
  id: string;
  connector: EgressConnectorId;
  name: string;
  /** Visible to the client. */
  config: Record<string, string | boolean | undefined>;
  /** Never leaves the server. */
  secrets?: Record<string, string | undefined>;
}
export type PublicEgressConnection = Omit<EgressConnection, "secrets"> & { secretsSet: string[]; expiresAt?: string };

export const CONNECTOR_LABEL: Record<EgressConnectorId, string> = { youtube: "YouTube", bluesky: "Bluesky", linkedin: "LinkedIn", folder: "Folder", "git-site": "Git site" };
export const TEXT_LIMIT: Partial<Record<EgressConnectorId, number>> = { bluesky: 300, linkedin: 3000 };
/** What a placeholder counts for before its URL is known. */
export const PLACEHOLDER_LENGTH = 60;

export const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
const PLACEHOLDER = /\{\{(youtube\.url|article\.url)\}\}/g;
/** The length a text will have once its placeholders are filled in, at most. */
export const estimatedLength = (text: string) => graphemes(text.replace(PLACEHOLDER, "x".repeat(PLACEHOLDER_LENGTH)));
export const fillPlaceholders = (text: string, values: { youtubeUrl?: string; articleUrl?: string }) =>
  text.replace(PLACEHOLDER, (all, name: string) => (name === "youtube.url" ? values.youtubeUrl : values.articleUrl) ?? all);
export const hasPlaceholders = (text: string) => new RegExp(PLACEHOLDER.source).test(text);
