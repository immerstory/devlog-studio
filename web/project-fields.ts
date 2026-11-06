/** Explanations of project fields, shared by the New project dialog and the project settings. */

export const PUBLIC_TITLE_HINT = "The title viewers see: intros and outros can show it in your videos.";

export const DESCRIPTION_HINT = "Tells the agent what this project is. Every suggestion, question and script request starts with it, so write a phrase that fits the sentence below. It does not appear in your videos.";

export const descriptionExample = (description: string) => `“…turn daily progress on ${description || "…"} into short devlog videos…”`;

export const NAME_HINT = "Shown in the project switcher and used in the project's URL.";

export const SLUG_HINT = "The project's part of the app's address, such as my-project in #/p/my-project/calendar.";

export const SOURCE_LABEL_HINT = "Your name for this source. The agent sees it next to the path.";

export const CONTENT_GLOBS_HINT = "Discover also reports uncommitted files that match these comma-separated patterns, such as *.unity or Assets/Scenes/**, so the agent can suggest topics from work you haven't committed. Each changed file can start an agent run. For tracked Unity scenes and prefabs, the agent sees the names of added objects; for other files, only the path and status. Commits always count. Leave this empty to use only commits, notes and materials.";

export const PRIMARY_SOURCE_HINT = "The agent runs in this working copy, and it reads the other sources from there.";

export const TARGET_NAME_HINT = "Your name for this target. You see it when you choose where a shot is filmed.";

export const MCP_URL_HINT = "Address of the running Unity-MCP server, usually ending in /mcp. Its default port is 8080. The server must accept Streamable HTTP connections.";

export const UNITY_PROJECT_HINT = "A safety check: each capture stops if the connected editor has a different project open. This is the folder that holds Assets. If empty, the primary source is expected.";

export const HEADER_HELPER_HINT = "Optional. A program that prints request headers as a JSON object, such as {\"Authorization\": \"Bearer …\"}. Use it when the server requires a token. Devlog Studio runs it to connect and keeps the result only in memory. Leave it empty when the server has no authorization, which is the Unity-MCP default.";

export const HEADER_ARGS_HINT = "Optional. Arguments for the header helper, separated by commas.";

export const DEFAULT_TARGET_HINT = "Shots without their own target are filmed here.";

export const BASE_URL_HINT = "Optional. Lets shots use a path such as /pricing. Shots with a full URL do not use it.";

export const USER_AGENT_HINT = "Optional. How the browser identifies itself to the site. If empty, desktop shots use Chrome's own and phone shots use iPhone Safari's.";

export const TARGET_CSS_HINT = "Optional. Added to every page this target films, for example to hide a banner. Shots can add their own CSS after it.";

export const REQUEST_HEADERS_HINT = "Sent with every request, one \"Name: value\" per line. The default asks sites not to track you, through Do Not Track and Global Privacy Control. Empty sends no extra headers.";

export const WORKING_COPY_HINT = "The folder on this computer that holds the project's Git repository. The agent reads its commits and changes to suggest devlog topics, and does not change anything there.";
