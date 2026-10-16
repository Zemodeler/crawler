# Echo360 transcript spike (M5.1)

Can Crawler get lecture captions from QM's "EchoVideo (Q-Review) Lecture
Recordings" (Echo360, an LTI activity in QMplus) without scraping the player?
Background and what is verified vs guessed: `docs/design/02-university-adapters.md`,
"Lecture transcripts (Echo360)".

## Run

Sign in once with the login spike (it saves the token), then:

```
electron spikes/echo360/main.mjs --course=ECS505U
electron spikes/echo360/main.mjs --course=ECS505U --activity=<cmid>   # if several LTI tools
```

It makes four QMplus calls and at most six Echo360 requests (the LTI
launch, the syllabus and four caption candidates), one at a time with a pause
between them. Nothing is changed on either side.

## Output (`out/`, git-ignored)

- `report.json`: one entry per step: the course's LTI activities, the launch
  endpoint (host and path) and launch **parameter names**, where the LTI post
  landed, the Echo360 **cookie names** it set, the syllabus's JSON keys and
  lesson counts, and each caption URL tried (status, content type, size).
  URLs are reduced to the origin plus a known route shape (`/section/:id/home`;
  any other path shows as `/<path>`). An error is recorded as a stage and a
  fixed code (e.g. `credentials / credentials-unreadable`), never as the
  caught message. No token, launch values, cookie values, response bodies or
  transcript text.
- `caption.vtt` / `caption.txt`: only if a candidate URL returned WebVTT.
  These are course content: don't commit or share them.

## What to look for

| Step | Good | Means |
| --- | --- | --- |
| `launch-data` | `ltiVersion: LTI-1p0` | Plain form post works. `1.3.0` means an OIDC flow the spike doesn't follow |
| `lti-post` | `sectionFound: true` | Echo360 accepted the launch from a non-browser fetch |
| `lti-post.cookies` | names listed | Which cookies the session needs (record names only) |
| `syllabus` | JSON, `lessons > 0` | Lesson and media ids are listable |
| `captions` | one attempt with `looksVtt: true` | That URL is the caption endpoint |

If every caption attempt fails, open the player in a normal browser with
devtools' Network tab, play a recording with CC on and note the request that
returns `WEBVTT` (path shape only). Put it in `captionCandidates()` and re-run.

## Tests

The pure helpers (`parse.mjs`) are tested on synthetic fixtures:

```
node --test spikes/echo360/parse.test.mjs
```
