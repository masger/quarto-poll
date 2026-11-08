# quarto-poll

Live audience polling inside [Quarto](https://quarto.org) revealjs presentations. The audience scans a QR code on the slide, answers on their phone, and the slide updates in real time. No Mentimeter, no account for the audience, no server to run: votes go through a free [Firebase Realtime Database](https://firebase.google.com/docs/database) that you own.

Question types: single choice (live bar chart), short text (live word cloud) and open answers (cards). A choice question with a `- [x]` option becomes a quiz question with points and a leaderboard. Results can be hidden until you close the poll and shown again on a later slide.

This extension was vibe coded with Claude (Anthropic) by Michael Asger Andersen in an evening. It is tested end to end against Firebase, but read the code before you trust it with anything important.

## Quick start

1. Set up Firebase once (see below) so you have a database URL, an API key and a presenter login.
2. In the folder of your presentation, install the extension:

   ```bash
   quarto add masger/quarto-poll
   ```

   This creates `_extensions/masger/poll`. The audience page is hosted at <https://masger.github.io/poll/>; it is a single static HTML file that you can also host yourself (see below).
3. Create `_poll.yml` in the same folder with your Firebase values (see *Configure*). The filter finds it by itself; you do not need `metadata-files`.
4. Add `filters: [poll]` to the deck and write the polls as below. Render with `quarto render my-talk.qmd` and open the HTML file. The example below is a complete working deck.

## Write a poll

```markdown
---
title: "My talk"
format:
  revealjs:
    filters: [poll]
---

## Most of us do not genotype before clopidogrel

::: {.poll #clopidogrel}
What do you do on Monday when a patient with a stent needs clopidogrel?

- Order a CYP2C19 genotype first
- Switch to ticagrelor without testing
- Give clopidogrel and wait
:::

## One word for pharmacogenetics today

::: {.poll #word type="text"}
One word that describes pharmacogenetics in your daily work
:::

## Results from the first question

::: {.poll-results poll="clopidogrel"}
:::

## Nobody sees the distribution until I close the poll

::: {.poll #dose results="hidden"}
Which dose would you choose?

- 5 mg
- 10 mg
- 20 mg
:::

## Open answers appear as cards

::: {.poll #barrier type="open"}
What is your biggest barrier to using pharmacogenetics?
:::
```

A `.poll` div holds one paragraph (the question) and an optional bullet list (the options). Without a list the poll is free text. Attributes:

| Attribute | Meaning |
| --- | --- |
| `#id` | Poll id, used by `.poll-results` and in the database. Defaults to `poll1`, `poll2`, ... |
| `type="text"` | Short free text (80 characters) shown as a word cloud (implied when there is no list). |
| `type="open"` | Open answers (300 characters) shown as cards, like an open-ended question. |
| `results="hidden"` | While the poll is open the slide shows only the number of answers, not what people chose. Close the poll (leave the slide or press V) to reveal the chart. |
| `auto="false"` | Do not open the poll when the slide appears; open it with the V key. |

During the talk: the poll opens when its slide is shown and closes when you leave the slide (votes are kept). Press **V** to open or close the poll on the current slide, **X** to reset its votes. The slide shows a QR code, the address of the audience page and the room code, so people without a camera can type it.

## Quiz with points

Mark the correct option with a task-list checkbox and the poll becomes a quiz question:

```markdown
## Which gene activates clopidogrel?

::: {.poll #gene points="2"}
Which gene decides whether clopidogrel is activated?

- [ ] CYP2D6
- [x] CYP2C19
- [ ] SLCO1B1
:::

## Scores

::: {.poll-scores top="10"}
:::
```

The first time a quiz question opens, the audience page asks for a name. The correct answer is not written to the database while the question is open, so nobody can look it up; it is revealed when you close the question (leave the slide or press V). The slide then marks the correct bar in green and shows how many got it right, and each phone shows right or wrong, the player's total and the top five. A `.poll-scores` div shows the leaderboard (`top`, default 10). `points` is the number of points for a correct answer (default 1). `correct="2"` (1-based) is an alternative to the checkbox. Every participant can change their answer while the question is open, so close it before you discuss.

## Configure: `_poll.yml`

Create a file named `_poll.yml` next to your `.qmd` (add it to `.gitignore`, it holds the presenter password):

```yaml
poll:
  db: https://YOUR-PROJECT-default-rtdb.europe-west1.firebasedatabase.app
  api-key: AIza...                # Firebase web API key (not a secret)
  email: presenter@example.com    # Firebase Authentication user
  password: "..."                 # quote it if it contains # or spaces
  room: pgx26                     # short room code, unique per talk
  audience: https://masger.github.io/poll/
  color: "#B22222"                # bar and word colour
  lang: da                        # da or en, for the slide labels and the audience page
  close-on-leave: true
```

The filter reads this file verbatim, so any characters are fine in the password. You can also put a `poll:` block in the YAML header of the deck; header values win, and the file fills in the rest. Point to another file with `poll: {file: other.yml}` or switch the file off with `poll: {file: none}`. Header values are parsed as Markdown by Pandoc, so `$`, `*` and `_` in a password would be mangled there; keep the password in the file.

The rendered HTML contains the password, so do not publish the deck itself.

## Set up Firebase (once, about ten minutes)

You need four values: the database URL, the web API key, and the email and password of one presenter user.

1. **Create a project.** Go to <https://console.firebase.google.com>, **Add project**, any name, Analytics off.
2. **Create the database.** Left menu, **Build > Realtime Database > Create database**. Choose a location (for Europe: Belgium, `europe-west1`) and **Start in locked mode**. The **Data** tab now shows the database URL at the top, like `https://my-project-default-rtdb.europe-west1.firebasedatabase.app`. That is `db`.
3. **Publish the rules.** Open the **Rules** tab. It shows a small JSON document (`".read": false, ".write": false`), not YAML. Replace the whole thing with the contents of [`database.rules.json`](database.rules.json), change `PRESENTER_EMAIL` to the email you will create in step 4, and click **Publish**.
4. **Create the presenter login.** **Build > Authentication > Get started**. Under **Sign-in method** enable **Email/Password**. Under **Users**, **Add user** with an email and a password. They are `email` and `password`.
5. **Get the API key.** Click the gear next to **Project Overview**, **Project settings**. Scroll down to **Your apps**, click the web icon `</>`, give the app a nickname, leave Firebase Hosting unticked and click **Register app**. The page shows a `firebaseConfig` snippet; copy the `apiKey` value (starts with `AIza`). That is `api-key`. The rest of the snippet is not needed; the extension does not use the Firebase SDK.

When `database.rules.json` changes in a new version of the extension, paste it again and publish; the deck does not update the rules by itself.

What the rules do: anyone with the room code can read the polls and write one vote per device, only while the poll is open and only a valid option index or a short text. Only the signed-in presenter can create polls, open and close them, and reset votes. No personal data is stored: a vote is a random device id and an option index or a short text.

Free plan limit: the Spark plan allows **100 simultaneous connections** to the database. Every phone and the presenter each hold one. For a larger audience switch the project to the Blaze (pay as you go) plan, which keeps the same free quota for storage and traffic; a poll with a few hundred votes stays at zero cost.

## Host the audience page yourself

Copy `audience/index.html` to any static host and set `audience` to its URL. The page takes `?r=<room>&db=<database url>&l=<da|en>` from the QR code, so one copy works for any database. Edit `DEFAULT_DB` in the file so that people who type the room code by hand reach your database.

## Develop and test without Firebase

`dev/mock_firebase.py` imitates the parts of the Firebase REST API that the plugin uses (GET, PUT, PATCH, DELETE and event streaming) and serves static files:

```bash
python dev/mock_firebase.py --port 8787 --static .
quarto render example.qmd
# open http://localhost:8787/example.html and http://localhost:8787/audience/?r=test&db=http%3A%2F%2Flocalhost%3A8787
```

`dev/headless.js` drives a headless Edge or Chrome over the DevTools protocol for end-to-end checks, for example:

```bash
node dev/headless.js "http://localhost:8787/example.html" --wait 3000 --eval "Reveal.slide(1)" --wait 1500 --eval "document.querySelector('.poll-status').textContent"
```

## How it works

`poll.lua` turns each `.poll` div into a `<div class="quarto-poll">` with the question and options as data attributes and injects the config as `window.QUARTO_POLL`. `poll.js` waits for Reveal, signs in to Firebase with the REST API, listens to `pub/<room>/polls` as a server-sent event stream, writes the poll metadata when its slide appears and renders the chart on every update. The audience page listens to `pub/<room>` and writes `pub/<room>/polls/<id>/votes/<device>`. The QR code is generated in the browser with [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT).

## Licence

MIT. Copyright 2026 Michael Asger Andersen.
