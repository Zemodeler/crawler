# 02 — University adapters

One university = one adapter config. One VLE platform = one adapter module.
QMplus (Moodle) first; SurreyLearn (Brightspace) second.

## The interface

Everything above the adapter (sorting, extraction, diffing, calendar) is
platform-neutral and only sees these types.

The code is the reference: `src/types.ts` (`UniversityAdapter`, `VleItem`,
`Course`, `VleFile`, `Credentials`, `LoginBrowser`, `VleError`). In short:

```ts
interface UniversityAdapter {
  id: string; platform: "moodle" | "brightspace"; displayName: string; site: string;
  login(browser: LoginBrowser): Promise<Credentials>;      // real browser window
  whoAmI(c): Promise<{ userId: number; permittedFunctions: string[] }>;
  listCourses(c): Promise<Course[]>;
  listItems(c, course): Promise<VleItem[]>;
  download(c, file): Promise<ReadableStream<Uint8Array>>;  // adds the token itself
}
// VleItem kinds: file, page (html + files), link, external-tool (e.g. Echo360),
// assignment, quiz, event, announcement. Times are unix seconds.
// Errors are VleError with code invalid_token | access_denied | unavailable | bad_response.
```

Dates are plain unix seconds; naming, sorting and deadlines are done above the
adapter, so a Brightspace adapter only has to produce these types.

Rules every adapter follows:

- **Read-only.** Never submits, posts, marks read, or changes anything.
- **Polite.** At most 4 concurrent requests, backoff on 429/5xx, and
  incremental fetch using the platform's modified timestamps.
- **No secrets in logs.** Tokens are redacted at the HTTP layer, not by callers.
- **Fixture-testable.** `fetch` is injected, so the suite runs on hand-written,
  *synthetic* responses (`test/fixtures/moodle/`), never real student data in
  the repo.
- **Nothing credential-bearing leaves the adapter**: every URL it returns has
  `token`/`wstoken` stripped; a download or response body keeps its request slot
  until it is fully read, and an unread download is abandoned after 2 minutes.

## Moodle (QMplus)

### Verified on the live site (2026-10-15)

`tool_mobile_get_public_config` on `qmplus.qmul.ac.uk` reports:

| Field | Value | Meaning |
| --- | --- | --- |
| `enablewebservices` | 1 | REST web services are on |
| `enablemobilewebservice` | 1 | The mobile-app service is on |
| `typeoflogin` | 3 | SSO via an embedded browser, token handed back at the end |
| identity provider | SAML2 (`/auth/saml2/login.php`) | QM's Microsoft sign-in |
| `launchurl` | `/admin/tool/mobile/launch.php` | Token launch endpoint |

`/webservice/rest/server.php` answers with `invalidtoken` for a bad token,
confirming the REST endpoint is live.

### Login

1. Generate a random `passport`.
2. Open the login window at
   `launch.php?service=moodle_mobile_app&passport=<p>&urlscheme=moodlemobile`.
3. Student signs in through QM's SAML page (MFA included).
4. Moodle redirects to `moodlemobile://token=<base64>`. The login window
   (Electron, see 01) intercepts that navigation in `will-redirect` /
   `will-navigate`, cancels it and closes.
5. Decode `signature:::token[:::privatetoken]`, check the signature
   (`md5(wwwroot + passport)`), store the token in the OS credential store.

### Calls used

| Need | Web service function |
| --- | --- |
| Identity | `core_webservice_get_site_info` |
| Modules | `core_enrol_get_users_courses` |
| Sections, files, pages | `core_course_get_contents` |
| Assignments + due dates | `mod_assign_get_assignments` |
| Quizzes | `mod_quiz_get_quizzes_by_courses` |
| Calendar events | `core_calendar_get_action_events_by_timesort` |
| Announcements | `mod_forum_get_forum_discussions` (news forum per course) |
| Other forums | the same call for every forum (4 pages of 50), `mod_forum_get_discussion_posts` for replies (100 threads), `core_enrol_get_enrolled_users` for who is staff. Posts become `forum-post` items; `src/forum.ts` keeps staff explanations, exam/deadline posts and date posts from anyone (students' are unverified, never deadline sources), trimmed, in `.crawler/forum/<year>__<module>.json`; the rest is discarded in the sync. |
| Files | `/webservice/pluginfile.php/...?token=` |

Exact availability is per site; on first sync the adapter calls
`core_webservice_get_site_info`, reads the list of permitted functions, and
degrades per feature rather than failing (e.g. no quiz function → quizzes come
only from the calendar).

### Token login — verified (2026-10-16)

Spike: `spikes/qmplus-login/main.mjs`.

- The whole flow works inside an Electron window: QMplus `launch.php` → QM's
  Microsoft SAML page → Microsoft's passkey/FIDO step and MFA → back to Moodle →
  `moodlemobile://token=…`, caught by a `protocol.handle("moodlemobile")`
  handler on the login session. The signature (`md5(wwwroot + passport)`)
  verified. The user agent has `Electron/x` stripped; Microsoft accepted it.
- Moodle **4.5.15** (`2024100715`). The token may call **470 functions**,
  including **every function in the table above**, plus
  `core_calendar_get_calendar_events`, the forum/resource/page/folder/url
  `get_*_by_courses` calls, `mod_lti_get_tool_launch_data`, and
  `tool_mobile_get_autologin_key`.
- `downloadfiles: true`, so files download with the token. A **private token**
  is issued too, which `tool_mobile_get_autologin_key` needs to open a logged-in
  browser page (relevant for transcripts behind LTI).
- The token is kept encrypted with Electron `safeStorage` and reused without
  signing in again (`--inspect`). Its lifetime is **unknown**; QMplus doesn't
  publish it. Record when it stops working, and handle `invalidtoken` as "sign
  in again".
- Pitfall: closing the last window quits Electron by default and killed the
  first run before its report. The login window needs a `window-all-closed`
  handler (the real app has a tray, so this is spike-only).
- **Enrolments are broader than "my modules".** One student had 23: current-year
  modules, all of last year's modules, and non-module sites (e.g. "Academic
  Integrity at Queen Mary Year 2"). Course names aren't uniform either:
  `ECS401U - Procedural Programming - 2025/26` vs
  `ECS505U Software Engineering 2026/27`, and shortnames like
  `ECS401U/ECS401A - 2025/26`. See module selection in 03.

### Fallback

If a site disables the mobile service, the adapter falls back to the
logged-in browser session: scrape course pages, and use Moodle's calendar
export (`/calendar/export.php`) for an authenticated `.ics` of events. Slower
and more fragile, but it keeps the adapter usable at more universities.

### Adding another Moodle university

A new Moodle site is a config entry, not code:

```ts
{ id: "kcl", platform: "moodle", displayName: "King's College London",
  baseUrl: "https://keats.kcl.ac.uk" }
```

`crawler doctor <url>` reads the public config and reports whether the mobile
service is on and which login type the site uses — the same check we ran on
QMplus. That output goes in the pull request that adds the university.

## Brightspace (SurreyLearn)

### Checked on the live site (2026-10-17, no account)

| Check | Result | Meaning |
| --- | --- | --- |
| `GET /d2l/login` | 302 → `/d2l/lp/auth/saml/login` → Microsoft Entra (tenant `6b902693-…`) | SAML sign-in through Surrey's Microsoft account, like QM; MFA happens on Microsoft's page |
| `GET /d2l/api/versions/` | 200 JSON, public | Valence REST API is live; `lp` and `le` (up to `1.99`) are supported |
| `GET /d2l/api/lp/1.0/users/whoami` | 403 without a session | API routes exist and need auth |

There is no mobile-token handoff like Moodle's `moodlemobile://`, and the
official Valence app ID/key needs Surrey to register an app. We don't depend
on that.

### Route: sign in in a window, then call Valence with the session

1. **Login.** Open `/d2l/login` in an isolated Electron session. The student
   signs in (Microsoft + MFA). Sign-in is done when the window reaches
   `/d2l/home`. Read the session cookies (`d2lSessionVal`,
   `d2lSecureSessionVal`) from that session; they are the credential, kept
   encrypted like the Moodle token. `LoginBrowser` needs a second method for
   this (capture cookies once a URL prefix loads), and `Credentials` needs a
   cookie form.
2. **Calls.** The same `/d2l/api/...` routes Brightspace's own pages use,
   sent with those cookies from Node `fetch`. **To confirm in the spike**
   (`spikes/surreylearn-login/`): that GETs with session cookies work, and
   whether any needs the XSRF token (from `/d2l/lp/auth/xsrf-tokens`) or a
   browser OAuth token (`/d2l/lp/auth/oauth2/token`) instead.
3. **Session lifetime** is shorter than a Moodle token; a 401/403 maps to
   `invalid_token` ("sign in again"). The spike records how long it lasts.

### Calls (Valence, `lp` / `le` versions from `/d2l/api/versions/`)

| Need | Route |
| --- | --- |
| Identity | `GET /d2l/api/lp/{v}/users/whoami` |
| Modules | `GET /d2l/api/lp/{v}/enrollments/myenrollments/?orgUnitTypeId=3` (paged with `bookmark`) |
| Files, pages, links | `GET /d2l/api/le/{v}/{orgUnitId}/content/toc` |
| File download | `GET /d2l/api/le/{v}/{orgUnitId}/content/topics/{topicId}/file` |
| Assignments + due dates | `GET /d2l/api/le/{v}/{orgUnitId}/dropbox/folders/` |
| Quizzes | `GET /d2l/api/le/{v}/{orgUnitId}/quizzes/` |
| Calendar | `GET /d2l/api/le/{v}/{orgUnitId}/calendar/events/` |
| Announcements | `GET /d2l/api/le/{v}/{orgUnitId}/news/` |
| Forums | `GET /d2l/api/le/{v}/{orgUnitId}/discussions/forums/` → topics → posts |

Brightspace dates are ISO strings in UTC; the adapter converts them to the
unix seconds the rest of Crawler uses.

### Not yet known

- Course naming and module start/end dates at Surrey (needed for year placement).
  The published semester dates do not establish module week numbering; see below.
- Surrey's lecture capture (likely Panopto, not Echo360), so transcripts need
  their own spike.
- Item ids are still `moodle:`-prefixed in `src/sorter.ts`, `src/pipeline.ts`
  and `src/deadlines.ts`; they should become platform-neutral before Surrey
  ships.

## Teaching-week maps (checked 2026-10-21)

`src/weeks.ts` maps a module's **numbered week** to a Monday. A term or semester
boundary alone does not say whether a module numbers a study or vacation week,
or how many numbered weeks it has. `readingWeeks` means calendar weeks omitted
from the numbering; a numbered reading week must not appear in that list.

- **QMUL 2026-27 Semester A:** keep the previously confirmed map: week 1 is
  Monday 21 September 2026, 12 numbered weeks, and reading week 7 (2 November)
  is still numbered. The existing QMplus observation "Assessment 1 - Week 11:
  Monday 30/11/2026" corroborates the numbering. QM's [central calendar](https://www.qmul.ac.uk/about/calendar/)
  gives teaching as 21 September–11 December but calls its 2026-27 dates
  provisional. School teaching dates can differ: the [School of Law year
  planner](https://www.qmul.ac.uk/law/postgraduate/programmes/llm-dip-year-planner-sept/)
  begins teaching on 28 September and has a study week on 2–6 November.
- **QMUL 2026-27 Semester B:** the [central calendar](https://www.qmul.ac.uk/about/calendar/)
  gives 25 January–16 April 2027, provisionally. The [School of Economics and
  Finance timeline](https://www.qmul.ac.uk/sef/postgraduate/msc/academic-year-timeline/)
  calls 8–12 March a reading week, while the [School of Law year
  planner](https://www.qmul.ac.uk/law/postgraduate/programmes/llm-dip-year-planner-sept/)
  has a no-teaching study week on 1–5 March and ends teaching on 9 April.
  Neither source establishes a common numbered week map, or whether the break
  is included in module numbering. The former provisional Semester B row was
  removed: `weekMapFor` and `teachingWeekAt` return `null` until a module's
  numbered sections or an explicit week-1 source verifies it.
- **Surrey 2026-27:** [university key dates](https://www.surrey.ac.uk/about/facts/key-dates)
  put semester one at 28 September–29 January (including winter vacation,
  revision and exams), and semester two at 8 February–11 June (including spring
  vacation and exams). [Visiting-student dates](https://www.surrey.ac.uk/incoming-exchange-study-abroad-and-traineeships/key-dates)
  identify teaching as 28 September–11 December and 8 February–14 May,
  interrupted by spring vacation 20 March–11 April. The university's [scheduling
  code](https://www.surrey.ac.uk/sites/default/files/2023-06/code-of-practice-scheduling-teaching-assessment.pdf)
  describes a *normal* pattern of teaching in semester weeks 1–11 and a
  semester-one week-15 reading week; it is not a 2026-27 module week map.
  Programme exceptions are listed on the key-dates page. No Surrey row is
  configured until its actual numbered module weeks and treatment of the
  spring break are verified.

## Transcripts

In scope: captions/transcripts only, never video files.

- **QM uses Echo360 ("EchoVideo (Q-Review) Lecture Recordings")**, an LTI
  activity in a "Recordings" section (seen in ECS505U). The token may call
  `mod_lti_get_tool_launch_data`, and the private token allows
  `tool_mobile_get_autologin_key` for a logged-in browser page, so the LTI
  launch can probably be followed from the app. **Spike**: does the Echo360
  side expose captions/transcripts per recording (VTT/SRT/text), and can they
  be fetched without scraping the player?
- Many modules also link YouTube videos as `url` activities (25 of 37 links in
  ECS505U, mostly worked solutions). YouTube captions are a possible later
  source; not in v1.
- Output: one `.txt` per lecture in `Course Materials/Transcripts/`, named to
  match its lecture where the match is unambiguous.
- If a module's recordings have no captions, the module page says so; nothing
  is generated by speech-to-text in v1.

## Lecture transcripts (Echo360)

Research for M5.1 (2026-10-16). Spike: `spikes/echo360/`, **run live on ECS505U on 2026-10-16: captions download** (see "Verified on QMplus" below).

### What we know, and from where

| Claim | Status | Source |
| --- | --- | --- |
| The recordings appear as `lti` modules, which our adapter turns into `external-tool` items with `toolName` | Verified | `src/adapters/moodle.ts`, ECS505U |
| The token may call `mod_lti_get_tool_launch_data`, and the private token unlocks `tool_mobile_get_autologin_key` | Verified | login spike, 2026-10-16 |
| `mod_lti_get_tool_launch_data(toolid = module instance)` returns `endpoint` plus signed `parameters[]` (name/value) to post as a form | Verified (live) | QMplus, ECS505U: LTI 1.0, endpoint on `echo360.org.uk` |
| Echo360 transcripts are WebVTT; instructors can "Download Original/Edited" in the media details | Verified (public docs) | Echo360 support [1], UQ eLearning [2], Stony Brook KB [3] |
| An LTI launch lands on a section page, and `<host>/section/<uuid>/syllabus` returns JSON (`data[].lesson.lesson.id`, `lesson.medias[]`, `hasVideo`) using the session's cookies | Verified (live); first seen in community code | open-source downloaders: soraxas/echo360 `course.py` [4], peter-tanner/echo360 README [5] |
| QM's region host | Verified (live) | `echo360.org.uk` |
| A per-media caption endpoint that students may call | Verified (live) | `/api/ui/echoplayer/lessons/<lesson>/medias/<media>/transcript-file?format=vtt` returns `text/vtt`; `…/transcript` returns the same as JSON |
| Student access to captions at all | Verified for ECS505U | 12 of 12 lessons have video; the first lecture's VTT has 1,688 cues (about 12,600 words). Other modules may differ |
| Rate limits | Not published | assume tight: one request at a time, with pauses |

Sources (checked 2026-10-16):

1. Echo360 support, "EchoVideo: Managing Transcriptions for Captures (Admins)":
   https://support.echo360.com/hc/en-us/articles/360038310372-EchoVideo-Managing-Transcriptions-for-Captures-Admins
2. UQ eLearning, "Edit and download an Echo360 video transcript (Ultra)":
   https://elearning.uq.edu.au/staff-guides-ultra/lecture-recordings-ultra/edit-and-download-echo360-video-transcript-ultra
3. Stony Brook IT KB, "Editing Echo360 Transcriptions and Uploading Closed Captions":
   https://it.stonybrook.edu/help/kb/editing-echo360-transcriptions-and-uploading-closed-captions
4. soraxas/echo360, `echo360/course.py` (`/section/<uuid>/syllabus`, falls back to `/home`):
   https://github.com/soraxas/echo360/blob/master/echo360/course.py
5. peter-tanner/echo360, README (fork of soraxas/echo360):
   https://github.com/peter-tanner/echo360#readme

### Proposed adapter flow

1. `listItems` already yields the `external-tool` item; add `instance` to it
   (contract change, M5 owner) so the launch can be requested.
2. `mod_lti_get_tool_launch_data(toolid)` → endpoint + signed fields. The
   signature (OAuth 1.0, LTI 1.1) carries the user's identity; it is never logged.
3. POST the fields as a form inside a dedicated Electron session (not plain
   Node `fetch`: Echo360 sets cookies and may redirect through several hops).
4. Read the section id from the landing URL; GET `/section/<id>/syllabus`.
5. For each lesson with media, fetch its captions (endpoint from the spike),
   convert VTT to text, and write `Course Materials/Transcripts/<lecture>.txt`.
   Skip a lesson when `hasTranscript`-style flags say there is none, and never
   download video.
6. Cache by lesson id + media modified time; re-fetch only new lessons.

**Electron-session option.** If the LTI post from a plain fetch is refused
(LTI 1.3 OIDC, or a SAML bounce), open the activity in a hidden window with
`tool_mobile_get_autologin_key` → `/admin/tool/mobile/autologin.php?userid&key&urlredirect=/mod/lti/launch.php?id=<cmid>`
and let Chromium run the auto-submitting forms. The key is single-use, rate
limited by Moodle (once per few minutes per user) and needs the private token.
After landing, call the same JSON routes with that window's session. Use a
non-persistent partition so Echo360 cookies never reach disk.

### Acceptable use

These routes are Echo360's own web UI, not a public API. Crawler only reads
what the signed-in student can already see, one request at a time, captions
only. Before shipping: check QM's Echo360 terms and the recording policy
(some lecturers forbid redistribution), keep transcripts in the student's own
folder only, and drop the feature cleanly (module page says "no transcripts")
if Echo360 or QM objects or the routes change.

### Verified on QMplus (2026-10-16, ECS505U, the student's own session)

- **LTI version:** `LTI-1p0`. A plain form POST of the signed fields works; no
  hidden window, autologin key or SAML bounce is needed.
- **Session:** Echo360 answers 200 with its "Class List" page and sets
  `ECHO_JWT`, `PLAY_SESSION` and CloudFront signed cookies on
  `echo360.org.uk`. The landing page names its section id (Electron's
  `session.fetch` does not report the final URL of the POST, so the id is
  read from the page).
- **Syllabus:** `GET /section/<id>/syllabus` returns JSON
  `{status, message, data[]}` with `SyllabusLessonType` rows: `lesson`,
  `medias[]` (`id`, `mediaType`, `title`, `isAvailable`,
  `isHiddenDueToCaptions`, …), `hasVideo`, `startTimeUTC`, `captureStartedAt`.
- **Captions:** `GET /api/ui/echoplayer/lessons/<lesson>/medias/<media>/transcript-file?format=vtt`
  returns WebVTT; `vttToText` turns it into plain text. Four Moodle calls and
  three Echo360 requests in total, paced.
- **Consequence for the flow above:** step 3 can use plain Node `fetch` with a
  small cookie jar (`getSetCookie()`), keeping the engine free of Electron;
  step 4 reads the section id from the landing page when the URL has none.
