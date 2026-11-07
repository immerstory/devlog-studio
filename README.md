# Devlog Studio

To set up Devlog Studio with a coding agent, paste this sentence into the agent:

```text
Clone https://github.com/immerstory/devlog-studio.git, follow the Requirements and Start sections of its README to install what's missing and start the app, then tell me what I still have to do myself, such as signing in to a CLI or entering an API key.
```

Devlog Studio turns daily progress on a software project into devlog videos: vertical shorts (9:16) and landscape YouTube videos (16:9). It reads the project's Git history, uncommitted content files, your notes and your uploaded screenshots and videos, proposes topics on a calendar, and asks you what to highlight. It then writes a script, captures shots in a browser or the open Unity editor and renders an MP4 with subtitles and ElevenLabs narration.

[![Watch "Rain changes everything", a devlog video made with Devlog Studio, on YouTube](docs/screenshots/video-poster.jpg)](https://youtu.be/0AxgHBwaNzI)

The video and screenshots show Grand Prompt Auto, a game invented for this README. Its images, activity and statistics are made up.

![The calendar with suggestions for each work day, and the selected day's suggestions beside it](docs/screenshots/calendar.png)

Each project has a type: game, web app, mobile app or something else. The type sets the default prompt text that tells the agent who it writes for and which shots work well. You can edit that text in the project settings and restore the default at any time.

## Requirements

- Node.js 22 and ffmpeg/ffprobe on `PATH`
- Internet access for the first webpage shot, which downloads Chrome headless shell into `cache/chrome`
- Docker with Compose, for Postgres and Garage
- `claude` (Claude Code) or `codex` CLI, signed in
- For Unity capture: the Unity editor open on the project, with a [Unity-MCP](https://github.com/IvanMurzak/Unity-MCP) server running over HTTP (see **Unity capture** below). The project needs the Universal Render Pipeline on Unity 6.
- An ElevenLabs API key, needed only for narration

## Start

1. Run `npm install`.
2. Run `npm run setup`. It generates credentials in `.env` and `docker/garage.toml`, starts Postgres and Garage, and creates the Garage bucket and key. Running it again keeps existing values.
3. Run `npm start` and open <http://localhost:4777>.
4. Under **Settings**, paste the ElevenLabs API key and enter a voice ID. **Check voice** confirms that the ID exists.

The app listens on 127.0.0.1 only. The containers publish Postgres on 127.0.0.1:5544 and Garage S3 on 127.0.0.1:3940. They restart with Docker.

## Agent costs

Agents run through the signed-in CLIs, so they use your Claude or ChatGPT subscription. The logged "API-equivalent cost" is the list price the CLI reports; it is not billed separately. If `ANTHROPIC_API_KEY` is set in the environment, `claude` bills per token instead.

## Workflow

Long work (progress checks, backfills, questions, scripts, captures, narration, renders, uploads) runs on the server as a task. While a task runs, a floating task box at the bottom right shows it with its latest log line; click a task to see its full log. **Cancel** stops a task at its next step: a capture after the current shot or frame, an agent run, a render or an upload at once. Work already finished, such as shots captured before the cancel, is kept. You can keep working anywhere in the app meanwhile, and when a task finishes, the page of its project shows the results. Finished tasks stay listed for two minutes, failed ones until you hide them. Tasks live in the server's memory: restarting the server stops running tasks, and the task box reports them as stopped.

1. **Add materials.** On **Materials**, upload screenshots and videos with the date they show, a title, tags and an annotation: the story behind them, such as an experiment, an abandoned version or a bug. To add files to an upload form, drop them on it, paste them or click to choose them. Materials appear on the calendar on their date. Image materials can also serve as slide backgrounds; they are used in turn and blurred. Without any, slides use blurred captures from the video itself. Choose them in the project's theme (see **Theme** below).

   ![The Materials page with uploaded screenshots, their dates, titles, annotations and tags](docs/screenshots/materials.png)

2. **Fill the calendar.**
   - **Backfill history** proposes suggestions for a past date range. It runs one agent call per week of commits, notes and materials, and dates each suggestion on the day the work happened. Processed weeks are remembered and skipped unless you select **re-run processed weeks**. Backfill does not change the progress-check state.
   - **Sidebar.** The first group is about the selected day: **Suggestions** lists its suggestions, **Activity** its notes, commits and materials (day cells show commit and material counts; a dot marks a note).
   - **New suggestion for a day.** Tick notes, commits and materials on **Activity**, or upload materials or add notes there; the form on **Suggestions** collects them. **Create suggestion** uses your own title and text; **Write up with agent** sends the ticked items and your text to the flow below. Any mix works, including text alone, for example a "how it started" story.
   - **A post you describe.** **Describe a post** takes what you want to say, including what you no longer have, and lets you upload new material or attach existing material for the draft to use. **Tell it differently** on a suggestion does the same from that suggestion. The agent searches two weeks either side by default: commits, sessions, notes and materials, plus all suggestions and posts. It returns one draft that lists which shots have material and which you must capture, what the evidence doesn't show, and which open suggestions it would replace. Nothing changes until you choose **Add suggestion**. Replaced suggestions are marked as merged, and their materials don't carry over.
   - **Propose changes since last check** reads commits since the previous check, uncommitted scene, prefab, terrain and material changes that differ from that check, and notes and materials added since then.
3. **Triage.** Use **Calendar** to see suggestions by work date or publish plan. Use **Triage list** to filter by status, kind, appeal, date or text. Select suggestions to approve, dismiss, restore, merge or schedule them together, or to create a video. Open a suggestion to edit it and to attach or upload materials. Select an attached material to edit it or delete it.
4. **Questions.** The post's suggestions appear as **Topics**, with all their fields; edit them there before the agent researches. Attach more materials to the video if needed. The agent reads the topics, annotations and preview images, researches the repository and asks up to six questions. **Back to suggestions…** in the post's header deletes the post with its questions, scripts, captures and renders, and returns its suggestions to the approved list. Final videos in `output/` stay. A post with a video on YouTube can't be turned back.
5. **Script & shots.** The agent writes narration and a shot list for each format. Every segment shows one of these visuals:

   ![A post's script, with narration, on-screen text and a chosen material for each segment](docs/screenshots/post.png)

   - **Editor shot:** a camera render from the open editor. A target object is framed automatically, and an occlusion check keeps walls out of the way. Optional camera moves are orbit (swing around the shot's centre), push (move toward it), pan (slide sideways, still looking ahead), turn (swivel on the spot) and rise (move up). Orbit, pan and turn are centred on your framing: an orbit of 40° starts 20° to one side and ends 20° to the other. Choose the target with **Pick object…** (search by name or browse the hierarchy of all loaded scenes) or **Use Unity selection** (the object selected in Unity). Paths add an index such as `[1]` when siblings share a name. To frame a shot yourself, set up the Scene view in Unity, then select **Use Scene view**. The first surface in the middle of the view becomes the shot's centre for push and orbit; the shot shows which object it lies on and how far away it is.
   - **Webpage shot:** a page filmed in headless Chrome, for a project with a browser capture target (**Project settings > Capture targets > Add browser target**, with an optional base URL so shots can use paths such as `/pricing`). The page scrolls from one position to another and can zoom in on a focus point; positions are pixels from the top or a CSS selector such as `#features`, which is brought to the top of the view. By default the move spans the whole shot with a smooth start and stop; **Start after** holds the page still for some seconds first, **Speed** sets the scroll speed in pixels per second (a scroll too long for the shot stops partway, and the task log says so), and **Movement** switches to a constant speed. Zoom follows the same timing. The page is shown on a phone or a desktop viewport (by default a phone for Shorts and a desktop for landscape videos). Its own animations, transitions and videos play at their real speed, because page time advances exactly one frame per filmed frame. **Hide** takes CSS selectors of elements to remove first, such as cookie banners. **CSS for this shot** adds your own CSS to the page after it loads, and the browser target's **CSS for every page** does the same for all its shots; the shot's CSS comes last, so it can override the target's. Pages that need a sign-in can't be filmed yet. Many search engines and some other sites answer automated browsers with a bot check; the shot then fails right away with the site's response (for example HTTP 429 and a CAPTCHA page). For those, record the page yourself and upload it as a material. The browser target's **User agent** setting replaces the browser's own one; empty uses Chrome's for desktop shots and an iPhone Safari one for phone shots. **Request headers** are sent with every request, one `Name: value` per line. By default they are the privacy signals `DNT: 1` (Do Not Track) and `Sec-GPC: 1` (Global Privacy Control), which the page's scripts also see; an empty list sends none. The browser is Chrome headless shell, which the app downloads on the first webpage shot.
   - **Material:** an uploaded screenshot or video. If the footage does not exist yet, the segment describes what to record; upload it and choose it in the segment.
   - **Slide:** a title, bullets, image, before/after, stack or outro card in the theme's paper-and-ink style. Images can come from earlier segments or from materials. A stack shows any number of images as polaroids that drop from the top or slide in from alternating sides, piling up slightly rotated and offset; the slide lasts at least long enough for each polaroid to land.

   After writing, a second agent run reads the narration in order as a viewer would and fixes lines that do not follow, such as a reply to a question the video never asks. The job log lists each change and its reason. Turn this off under **Settings > Agent**. A segment whose narration you edited shows the agent's version with a **restore** link. Each script run's prompt, raw output and read-through edits are kept in the `runs` table; the script's `runId` points to its run.

   Select **Capture editor shots** to render every editor shot. Every capture is kept as a take with the settings that produced it (the last five per shot and format); **Previous take** goes back to the one before and restores its settings, discarding the current take.
6. **Preview.** The player shows the video without narration, drawn by the same code as the final export. Subtitles are timed at a typical narration pace. **Render draft MP4** writes a half-resolution file. This step costs no ElevenLabs credits.
7. **Narration.** The page shows how many characters are billable and your remaining ElevenLabs quota. Narration runs only after you confirm. Audio is cached by text, voice and settings, so unchanged lines are never billed twice. Subtitles then follow the real word timings.
8. **Final.** Renders a full-resolution H.264/AAC MP4 (BT.709, normalised to -14 LUFS with one constant gain and a peak limiter, so levels within the mix stay as authored) into `output/<date>-<title>/`, with an `.srt` file and a `.txt` file holding the title, description, tags, hashtags and, for landscape videos, chapters. Copies are archived in Garage.

**Theme.** Under **Project settings > Theme**, **Edit theme…** opens the project's look beside a looping preview of a title, bullets, a polaroid stack and the ending, in either format. The preview uses the values as you edit them. The theme covers:

- the slide colours: background, its highlight and edge, wash, text, accent and photo frame;
- the slide font (headings, bullet points, photo captions and labels) and the logo on title slides, uploaded as files (TTF, OTF or WOFF fonts; PNG, JPEG, WebP or SVG images) and stored in Garage;
- the slide backgrounds;
- an optional intro and an optional outro.

**Intro and outro.** Each is a bumper: a short title sequence chosen from the installed styles, with that style's settings. The intro plays over the first segment, and that segment's narration and subtitles start after it. The outro plays over the end of the last segment.

The **Title card** style is built in: white text fades in on black, holds and fades out. Add your own styles with an extension (see **Extensions** below). A theme that names a style that isn't installed plays no bumper there.

**Bumper music.** Once a project has an intro or an outro, **Project settings > Theme** offers a music upload for it. The leading silence is cut on upload. Intro music starts with the video. For outro music, export your track against a full video, silent until the outro: the track is assumed to end with the video, so any music before the outro's start becomes a lead-in that plays before the title appears. The music keeps that position in every video, narrated or not. If you change the outro's length, for example its hold time, export the music again.

## Extensions

An extension adds bumper styles and theme presets without changing this repository. It's a folder with an `index.ts`, and the app finds it at startup. [`examples/title-card/index.ts`](examples/title-card/index.ts) is a complete example, and [`shared/extension.ts`](shared/extension.ts) defines the contract.

### Add an extension

1. Create `extensions/my-brand/index.ts`. Git ignores the contents of `extensions/`, so your files stay out of this repository.
2. Export the extension:

   ```ts
   import type { DevlogExtension } from "devlog-studio/extension";

   const extension: DevlogExtension = {
     id: "my-brand",
     name: "My brand",
     bumpers: [
       {
         id: "my-logo-sting",
         label: "Logo sting",
         description: "A title that fades in.",
         params: [{ key: "text", label: "Text", type: "text", default: "" }],
         seconds: () => 3,
         animation: {
           async prepare({ params, durationInFrames, width, height, title }) {
             return (ctx, frame) => {
               ctx.globalAlpha = Math.min(1, frame / 15);
               ctx.fillStyle = "#fff";
               ctx.font = "bold 96px sans-serif";
               ctx.textAlign = "center";
               ctx.fillText(String(params.text || title), width / 2, height / 2);
               ctx.globalAlpha = 1;
             };
           },
         },
       },
     ],
   };

   export default extension;
   ```

3. Restart the app. The style appears under **Project settings > Theme > Edit theme…**.

The same file runs on the server for the export and in the browser for the preview. So use no Node.js APIs in it, and import from Devlog Studio only with `import type`. Load fonts and other files in `prepare` through `platform`, because `prepare` runs once per video. The function it returns draws one frame on a transparent canvas of the video's full size, and frames can arrive in any order. If an extension fails to load, the app doesn't start, and the error names its folder.

### Add a theme preset

A preset applies colours, fonts, a logo, an intro and an outro in one step. Its file paths are relative to the extension's folder, and it can't name files outside that folder. A preset replaces what it defines and keeps the rest of the theme.

```ts
themePresets: [
  {
    id: "brand",
    label: "My brand",
    colors: { paper: "#f2ebdc", ink: "#211f1b" },
    displayFont: "assets/brand.ttf",
    logo: "assets/logo.png",
    outro: {
      style: "my-logo-sting",
      params: { text: "My game" },
      music: "assets/outro.wav",
    },
  },
],
```

Under **Project settings > Theme > Edit theme…**, choose the preset and select **Apply preset**. The app saves the result at once, and it stores the files in Garage like uploads. Bumper fonts go under `fonts`, by the key of the style's font parameter.

### Keep extensions in their own repository

Extensions often hold fonts, music and logos you can't publish. Choose one of these layouts:

- **Clone into the drop folder.** Run `git clone <your repository> extensions/my-brand`. The extension's repository stays independent, and this repository ignores it.
- **Use a separate folder of extensions.** Set `DEVLOG_EXTENSIONS_DIR` in `.env` to one or more folders, separated like `PATH` (`;` on Windows, `:` elsewhere). Relative paths count from this repository's folder. Each subfolder with an `index.ts` is an extension.
- **Add this repository as a submodule of your own.** This layout suits a project that keeps private material next to the tool:

  ```text
  my-devlog/              your private repository
  ├─ studio/              this repository, as a submodule
  ├─ extensions/my-brand/ your extension
  └─ output/              your final videos
  ```

  ```sh
  git submodule add https://github.com/immerstory/devlog-studio.git studio
  ```

  In `studio/.env`, set `DEVLOG_EXTENSIONS_DIR=../extensions` and `DEVLOG_OUTPUT_DIR=../output`. Run `npm install`, `npm run setup` and `npm start` inside `studio/`.

To type-check an extension outside this repository, map the import to the contract in its `tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "paths": { "devlog-studio/extension": ["../../studio/shared/extension.ts"] }
  },
  "include": ["."]
}
```

## AI co-host

A video can be a conversation between your narrator and an AI co-host. The co-host asks what a viewer wants to know, challenges your decisions and teases you, and you state the facts. The only visual difference is the color of the co-host's captions.

1. **Turn it on.** Under **Project settings > Co-host**, select **Use a co-host in this project**, then enter a name and an ElevenLabs voice ID that differs from your narrator's. Use only a voice you have the right to use. You can also edit the persona, the caption color and the co-host's share of the words.
2. **Choose per video.** In a post's Questions step, set each format to **Solo** or **Co-hosted** before you write its script. Changing a format that has a script deletes that format's script, narration and render record. The change is refused once the format is on YouTube.
3. **Review the lines.** In **Script & shots**, each segment lists its lines with a speaker. You can edit, reorder, add or remove them. Narration generates one take per line, so editing a line bills only that line.
4. **Resolve the check.** While writing, an agent run lists the co-host's factual claims and looks for a source in your answers, the evidence and your earlier lines. Unsupported lines are rewritten once, and what remains becomes a flag. Choose **Keep anyway** to keep a flagged line.

Any later change to the script, your answers or the evidence makes the check out of date. **Check co-host lines** runs it again. It costs one agent run, it only flags lines, and it never starts on its own.

You can't approve or upload a co-hosted video until the check is current and has no open flags, and the final render matches the checked script. If only your answers or the evidence changed, a new check is enough. If the script changed, the video also needs a new final render.

A kept flag applies to that exact line, claim and reason, and to the answers, evidence and earlier developer lines behind it. If any of them changes, you decide again.

Co-hosted videos declare synthetic media on YouTube and add a line naming the AI co-host to the description. You can edit that line in the project's co-host settings. Subtitle files mark speaker changes with `>>`.

## Publishing

1. **Attribution.** Under **Settings > Publishing**, enter the text every description ends with: music licence IDs, credits, links.
2. **Final render.** The Final step shows the video and exactly what gets published: title, description (your description, chapters for landscape, `#Shorts` and hashtags for portrait, then the attribution) and tags. Change the text in **Script & shots > Platform metadata** or in Settings, then render the final again.
3. **Approval.** **Approve & upload to YouTube** is the final OK. It uploads right away: scheduled for the episode's publish date and time (top of the episode; the default time comes from Settings), or, without a date or with a date already past, published as set under **Without a publish date**. A scheduled video stays private on YouTube until then. The subtitles are added as an English caption track. A new final render clears the approval.

**Connecting YouTube:**
1. In the Google Cloud Console, create a project, enable the **YouTube Data API v3**, and create an OAuth client of type **Desktop app**. Add yourself as a test user while the app is in testing.
2. Under **Global settings > Publishing**, add a YouTube connection, enter the client ID and secret and select **Save connection**. Then select **Connect** and approve access in your browser. The refresh token is stored in the settings and never sent to the browser.

YouTube allows 100 uploads per day per project.

**Statistics.** The Statistics page lists everything published in one table, whatever the platform, marked with the platform's icon. Above the table, you can filter by platform and by publishing date; the totals at the top stay for all posts. A number a platform doesn't report shows as a dash, such as views on Bluesky, and Bluesky replies count as comments. While YouTube is connected, the app fetches views, likes and comments of every uploaded video one minute after start and then every 3 hours (**statsIntervalHours** in the settings), storing one snapshot per refresh. The **Statistics** page shows the totals with their 24-hour change, a table of all videos and a chart of the selected video over time; **Refresh now** fetches immediately. A refresh also notices when a scheduled video has gone public. Uploading records the publication day as the episode's publish date, so the calendar shows the video on that day.

![The Statistics page with totals, a table of published posts and a chart of views over time](docs/screenshots/stats.png)

## Posts

The **Posts** page lists every post with its stage, outputs, destinations and publish date. You can filter by stage, platform and publish date. **Needs attention** shows posts with a failed publication, a missed publish time, a dependent publication that needs a new decision, or co-host lines that are flagged or need a check. Numbers are on the **Statistics** page.

![The Posts page with each post's stage, outputs, destinations and publish date](docs/screenshots/posts.png)

## Activity

The **Activity** page shows the project's work day by day: commits, notes and materials, plus anything you turn on under **Project settings > Connected activity**. Commits come from the project's **Sources**. Select **Refresh activity** to update the page. Records about the same work are grouped: the same commit always groups them, and the same time with shared files groups them as inferred. **Split** and **Join** override this, and your choice survives later reads.

![The Activity page with a session linked to the commits it produced](docs/screenshots/activity.png)

**AI sessions.** The app can read Claude Code and Codex session logs whose working directory is inside the project's sources. Both are off by default.

- Reading stays on this computer. The app stores one short digest per session and day: times, edited files, Git commands, check results and shortened prompts with secrets removed. Tool output, file contents, thinking and pasted text stay out, and the raw log is never stored.
- **Import screenshots I sent**, an option on each session source, also stores the images you sent to that tool. Images from the tool's own results stay out. Each image waits under **Materials > From sessions** with the words of its message until you add it. Agents can't see it there. Redaction can't clean an image, so check each one before you add it: a screenshot can show secrets, other projects or your desktop. On a suggestion or post, **Attach existing…** lists images from its sessions first, and inserting one adds it to your materials.
- **Summarize** runs an agent on one digest. This sends it to the provider of the selected agent, which can differ from the tool that wrote the log.
- **Review with sessions**, next to **Backfill history** on the calendar, runs an agent once per week with sessions and sends their digests to its provider. It compares them with the project's suggestions, adds topics and evidence, and proposes new text for a suggestion. That text applies only when you select **Accept update**. The agent sees dismissed topics and doesn't propose them again, an identical title is dropped, and a topic that shares commits with a suggestion shows **May repeat**. Suggestions in a post only gain evidence.
- Summaries give the writers background, and they can't quote them. Sessions without a summary add nothing to a script, and **Exclude** keeps a record away from every agent.
- These log formats are internal to each tool and can change. A log the app can't recognize adds no data, and the task log reports it.

Run `npx tsx scripts/session-preview.ts <folder> <from date> <source path>` to write digests to a folder without changing the database or using an agent.

A session that edits mostly outside the project's sources counts as other work, even when it runs in the project's folder. It starts excluded, and excluded records are hidden until you select **Show excluded**. **Include** brings one back. A session that edits nothing can't be told apart, so exclude it by hand.

**GitHub, Forgejo and Gitea.** Pull requests, issues and releases of a source whose `origin` remote is on one of these. GitHub is read through the `gh` CLI, which must be signed in. Forgejo and Gitea need an access token with read access to repositories and issues, which you enter in the project settings and which stays on the server. Records from a private repository are private.

## Publishing elsewhere

Besides YouTube, a post can go to Bluesky, LinkedIn, a folder or a Git-based site. All of them are connections under **Global settings > Publishing**. A video uploads from the post's **Final** step, and the others go out from its **Article** and **Publish** steps, where you also see each video's status.

- **Order.** A destination can wait until a video or article is public. A Bluesky text waiting for a scheduled Short goes out after the Short is actually public. Its text can use `{{youtube.url}}` and `{{article.url}}`, which only the server fills in.
- **Approval.** Each destination goes out only after you approve it, and editing it clears that approval.
- **While the app runs.** Bluesky and LinkedIn have no scheduling here, so the app sends at the right time, and only while it's running. After a restart, it sends anything up to 24 hours late and asks about anything older.
- **Bluesky.** Use an app password, not your account password.
- **LinkedIn.** Posts go to your personal profile. A connection lasts about 60 days, and then you connect it again. If the app stops while posting, it can't tell whether the post got through, so it asks you to check before retrying.
- **Articles.** The agent writes an article from the post's topics, answers and materials. **Preview** in the Article step shows it as a reader would, with its pictures and video in place, including edits you haven't saved. Every picture needs alt text before export. A Git site gets a commit on a new local branch, made in a temporary worktree, so your checkout stays as it is. Merge the branch to publish, or turn on pushing in the connection.

## Formats

| Format | Size | Length | Use |
|---|---|---|---|
| Short 9:16 | 1080×1920 | 35–55 s | YouTube Shorts, Instagram Reels, TikTok |
| Video 16:9 | 1920×1080 | 2–5 min | YouTube devlog, often one week's topics merged |

Each format gets its own script and its own editor captures, rendered natively for its aspect ratio. Materials are cropped to the centre of the frame.

## Storage

| Where | Content |
|---|---|
| Postgres | Settings (including the ElevenLabs key), suggestions, notes, materials metadata, episodes, agent runs with their evidence |
| Garage | Material files with thumbnails and previews, editor captures, narration audio, draft renders, archived finals |
| `output/` | Final videos and upload text, ready to post |
| `cache/` | Disposable working files: agent evidence, downloads, render inputs |

The settings API never returns the ElevenLabs key; it reports only whether one is stored. `ELEVENLABS_API_KEY` in the environment overrides the stored key.

## Unity capture

Editor shots use [Unity-MCP](https://github.com/IvanMurzak/Unity-MCP), an MCP server for the Unity editor. It's a separate project with its own license, and you install it in your Unity project by following its instructions.

1. Start the server with its HTTP transport (`streamableHttp`, its default).
2. Under **Project settings > Capture targets**, add a Unity target and enter the server's URL. The URL includes the `/mcp` path.
3. If you run the server with `token` authorization, enter a **Header helper**: a program that prints the request headers as a JSON object, such as `{"Authorization":"Bearer <token>"}`. The app runs it when it connects and doesn't store or log the result. With authorization set to `none`, leave it empty.

Capture calls the server's `script-execute` tool, so another MCP server works only if it offers a compatible tool. Whoever can reach that tool can run code in your editor, so keep the server on `127.0.0.1`.

**What capture does in your project:**

- Captures run C# through the MCP `script-execute` tool. A hidden, unsaved camera renders to PNG files outside the Unity project and is destroyed afterwards.
- Occlusion tests build colliders in a temporary preview scene. Loaded scenes, assets and import settings are never changed.
- Before capturing, the tool checks that the connected editor's `Application.dataPath` matches `unity.projectPath`.
- Edit-mode renders show only objects saved in the scene. Runtime-spawned characters, crowds and traffic need recorded footage uploaded as materials.

## Agent

Agents run headless and read-only in the project's primary source:

- Claude: `claude -p` with a JSON schema and only the read tools plus `git log/show/diff/status` allowed.
- Codex: `codex exec --sandbox read-only --output-schema`, with material previews attached as images.

Choose the default agent in **Settings**, or per action from the dropdown.

## Checks

- `npm run typecheck` checks TypeScript.
- `npm test` runs unit tests; database integration is skipped.
- `npm run test:integration` uses a disposable PostgreSQL schema. Agent, Unity and storage operations are mocked; it does not render or delete real Garage objects or output folders.
- `npm run check:public` fails on personal absolute paths and on anything shaped like a secret in tracked files.
- `npm run test:render` is a separate smoke test that renders a real draft, writes its temporary Garage objects and deletes them afterwards. Run it explicitly when those services are available.

## Development

- `video/` holds the video's drawing code: `renderer.ts` draws one frame on a canvas, `schedule.ts` says what plays when, and `bumpers.ts` maps each bumper style to its animation. The browser preview (`web/VideoPlayer.tsx`) and the export (`server/render.ts`) both use it, with `@napi-rs/canvas` and ffmpeg on the server.
- `server/db.ts` holds the schema. A schema change adds one `applyMigration` call with the next version number.

Read [`AGENTS.md`](AGENTS.md) for the working rules, which apply to people and coding agents alike. Report bugs and ideas in the [issue tracker](https://github.com/immerstory/devlog-studio/issues).

## Settings in `.env`

| Setting | Effect | Default |
|---|---|---|
| `DEVLOG_EXTENSIONS_DIR` | Folders that hold extensions | `extensions` |
| `DEVLOG_OUTPUT_DIR` | Folder for final videos | `output` |
| `PORT` | Port of the app, instead of the one in the settings | Empty |
| `ELEVENLABS_API_KEY` | ElevenLabs key, instead of the stored one | Empty |

`npm run setup` writes the database and storage settings to the same file.

## License

[MIT](LICENSE). Copyright (c) 2026 Immerstory GmbH.
