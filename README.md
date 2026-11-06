# quarto-poll

Live audience polling inside [Quarto](https://quarto.org) revealjs presentations. The audience scans a QR code on the slide, answers on their phone, and the slide updates in real time. No Mentimeter, no account for the audience, no server to run: votes go through a free [Firebase Realtime Database](https://firebase.google.com/docs/database) that you own.

Question types: single choice (live bar chart) and free text (live word cloud). Results can be shown again on a later slide.

## Install

```bash
quarto add masger/quarto-poll
```

This copies `_extensions/poll` into your project. The audience page is hosted at <https://masger.github.io/poll/>; it is a single static HTML file that you can also host yourself (see `audience/index.html`).

## Write a poll

```markdown
---
title: "My talk"
format:
  revealjs:
    filters: [poll]
metadata-files: [_poll.yml]
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
```

A `.poll` div holds one paragraph (the question) and an optional bullet list (the options). Without a list the poll is free text. Attributes:

| Attribute | Meaning |
| --- | --- |
| `#id` | Poll id, used by `.poll-results` and in the database. Defaults to `poll1`, `poll2`, ... |
| `type="text"` | Free text with a word cloud (implied when there is no list). |
| `auto="false"` | Do not open the poll when the slide appears; open it with the V key. |

During the talk: the poll opens when its slide is shown and closes when you leave the slide (votes are kept). Press **V** to open or close the poll on the current slide, **X** to reset its votes.

## Configure

Put the connection details in `_poll.yml` next to the deck (git-ignore it, it holds the presenter password) and reference it with `metadata-files: [_poll.yml]`. You can also put the `poll:` block directly in the YAML header.

```yaml
poll:
  db: https://YOUR-PROJECT-default-rtdb.europe-west1.firebasedatabase.app
  api-key: AIza...                # Firebase web API key (not a secret)
  email: presenter@example.com    # Firebase Authentication user
  password: ...
  room: pgx26                     # short code the audience can also type by hand
  audience: https://masger.github.io/poll/
  color: "#B22222"                # bar and word colour
  lang: da                        # da or en, for the slide labels and the audience page
  close-on-leave: true
```

Keep the room code unique per talk (or reset votes with X). The rendered HTML contains the password, so do not publish the deck itself.

## Set up Firebase (once, about ten minutes)

1. Go to <https://console.firebase.google.com>, **Add project**, any name, Analytics off.
2. **Build > Realtime Database > Create database**. Choose a location (for Europe: Belgium, `europe-west1`) and **locked mode**. Copy the database URL; it is `poll.db`.
3. Open the **Rules** tab, paste the contents of [`database.rules.json`](database.rules.json), replace `PRESENTER_EMAIL` with the address you create in step 4, and **Publish**.
4. **Build > Authentication > Get started**. Under **Sign-in method** enable **Email/Password**. Under **Users** add a user with that email and a password; they are `poll.email` and `poll.password`.
5. **Project settings > General > Your apps > Web app** (the `</>` icon). Register it without hosting and copy `apiKey`; it is `poll.api-key`.

What the rules do: anyone with the room code can read the polls and write one vote per device, and only while the poll is open and only a valid option or a short text. Only the signed-in presenter can create polls, open and close them, and reset votes. No personal data is stored: a vote is a random device id and an option index or a short text.

Free plan limit: the Spark plan allows **100 simultaneous connections** to the database. Every phone and the presenter each hold one. For a larger audience switch the project to the Blaze (pay as you go) plan, which has the same free quota for storage and traffic; a poll of a few hundred votes stays at zero cost.

## Host the audience page yourself

Copy `audience/index.html` to any static host and set `poll.audience` to its URL. The page takes `?r=<room>&db=<database url>&l=<da|en>` from the QR code, so one copy works for any database. Edit `DEFAULT_DB` in the file if you want people to be able to type the code by hand without the QR code.

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
