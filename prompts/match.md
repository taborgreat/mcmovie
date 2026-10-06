# Match mode: narration plan for a recorded match

You turn a real hardcorepvp match into a narrated film (the format and its
length are stated at the top of `digest.md`). You do not invent events:
every claim in the narration must be supported by the digest (kills,
weapons, kits, health, who fought whom, how long they survived).

## Method: skeleton first, then zoom, told backwards

You never read raw data. The project folder holds a hierarchy:

- `digest.md` is the **skeleton**: winner, the ending, the winner's road
  and the runner-up's road (latest first), side moments for everyone else,
  one line per player (kit, place, kills, how far they walked, how it
  ended), the kill tree, and an index of moments. Each moment has an id.
- `moments/<id>.md` is the **zoom** on one moment: the blow by blow, where
  it happened (open ground, underground, biome), who was nearby, what was
  said, and a suggested film segment (`from_sec`, `to_sec`, `focus`, and
  how many seconds in the death lands).

Work like this:

1. Read `digest.md` only.
2. Start at the end. Who won, who was last to fall, how. Open the ending's
   moment file. That is the film's last segment and it is mandatory.
3. Walk the winner's road backwards and pick the one to three moments that
   explain how they got there. Do the same, briefly, for the runner-up if
   their road is interesting.
4. Pick side moments: one to three players who are **not** on the main
   road, so the film notices people beyond the winner. A funny death, a
   fight both walked away from, someone who walked a long way and met
   nobody: all fair. In a big match most players get no screen time;
   choose the ones with a story.
5. Open only the moment files you chose. Use their suggested segments as
   your `from_sec` / `to_sec` / `focus` (trim or extend to fit the length).
6. Write `doc.json` in chronological order. You planned it backwards; the
   audience watches it forwards, so each early segment should set up
   something the ending pays off.

Read `prompts/reference/kits.md` for what a kit does when you mention it.
Check your plan with `node bin/mcmatch.js check <slug>`.

## What the film must contain

- **The ending, always.** The final kill, with enough lead-up that it makes
  sense: who the last two were, how each got there, what state they were
  in. `check` fails if the final kill is not inside a segment.
- For a long film (180-300 s): the drop (first 8-12 s of the match), 3 to 6
  moments from the middle, the ending.
- For a Short (35 s to 3 minutes): two to four segments for a small match,
  up to six or seven when a bigger one has the moments. Make it as short as
  the match allows; a Short is not a quota to fill. Nearly every match is a
  Short now (a full 16:9 video only for ten or more players over a long
  match), so a Short carries the whole story, not a teaser. The usual shape:
  one early moment, one side moment, the ending. Skip the drop unless it
  matters.
- Segments are real time unless `speed` > 1 (use 3-6x for travel and quiet
  stretches; never for a kill). Players standing still or only walking were
  recorded sparsely, so travel looks best sped up or kept short.
- A player must be alive during a segment that focuses on them; `check`
  rejects a focus player who is already out.

## doc.json

```json
{
  "title": "The AFK Trap",
  "logline": "one or two plain sentences, see Title and logline below",
  "narrator": { "voice": "stock:narrator", "voice_desc": "sports documentary narrator, dry, a little amused" },
  "music": { "mood_tags": ["battle", "tense"], "tempo": "fast" },
  "cards": { "end_text": "hardcorepvp.com" },
  "segments": [
    { "id": "drop", "title": "The drop", "from_sec": 0, "to_sec": 11, "focus": ["taborgreat", "Strongs"], "music": "suspense",
      "narration": [
        { "id": "n1", "at_sec": 0.5, "text": "Four players. One map. Nobody is leaving together.", "emotion": "dry" },
        { "id": "p1", "at_sec": 5.0, "speaker": "Strongs", "chat": true, "text": "good luck everyone", "emotion": "cheerful" }
      ] },
    { "id": "final", "title": "The last two", "from_sec": 512, "to_sec": 561, "focus": ["taborgreat", "Surfs"],
      "narration": [ { "id": "n1", "at_sec": 1, "text": "...", "emotion": "building" } ],
      "shots": "auto" }
  ]
}
```

- `from_sec` / `to_sec` are match time, straight from the digest.
- `focus` lists the players the camera cares about, lead first. Two names
  make it a duel (the camera frames both). Only players near the lead are
  drawn, so keep a segment in one place: one fight, one chase.
- `narration[].at_sec` is seconds after the segment starts, in film time
  (after `speed` is applied). Narration may run over into the next segment.
- `shots`: leave it out or `"auto"`. The automatic camera reads the real
  terrain and picks angles that can see the players. Hand-written shots use
  the same path grammar as `prompts/scene.md` (plus `{"between": ["A","B"]}`
  as a look/target point), with `start_sec`/`end_sec` relative to the
  segment; use them only when you want a specific framing.

## Title and logline (they go on YouTube word for word)

The film is uploaded as `HardcorePvP.com #<n>: <title>`, and the description
is your logline followed by the server address and hashtags. The publisher
adds the prefix, the number, the address and the hashtags; you write only
the title and the logline. Nobody edits them afterwards, so write them the
way a player would tell a friend what happened, not the way a trailer would.

- **title**: 2 to 5 plain words about the one thing people will remember
  from this match. No colon, no hashtag, no number, no player names.
  "The AFK Trap" is right. "Stomper's Last Stand" and "A Tale of Two
  Compasses" are the grand movie-poster style to stay away from.
- **logline**: one or two short sentences, casual, concrete, and a little
  funny when the match was. Call players by their kit in lower case ("a
  demoman", "the stomper"), not by name. Say what happened and how it
  turned, and stop. No moral, no dashes, no semicolons. The tone to match:

  > A demoman sets a trap just to go AFK! But luckily for him, the stomper
  > took the bait which led to the easiest cake of his life.

`check` rejects a title over 40 characters or with ":" or "#", a missing
logline, a logline over 220 characters, and dashes or semicolons in either.

## Voices: the narrator and the players

Pick the narrator to suit the match with `"narrator": { "voice": "stock:<id>" }`:
`narrator` (documentary baritone, the default), `caster` (hyped esports
commentary, good for kill-heavy matches), `deadpan` (dry, good for absurd
matches), `storyteller` (warm), `trailer` (epic, use sparingly).

A line with no `speaker` is the narrator. A line with `"speaker": "<player>"`
is spoken in that player's own (made-up, permanent) voice and cuts in between
narrator lines. The film cuts to
that player on the frame their line starts and stays on them while they say
it, so the voice always has a face (a kill close by keeps the camera). So
put a player's line at a moment when that player is in the segment. Only when
a voice is meant to be heard over someone or something else, add
`"show_speaker": false` to the line; that is rare and deliberate. Two kinds:

- **Real chat**: a chat line from the digest, word for word, with
  `"chat": true`. Place it where it was said (digest time minus the
  segment's `from_sec`).
- **Invented reactions**: short in-character lines that fit what the digest
  shows the player doing ("Not the zombie. Not like this."). Keep them
  good-natured: these are real people who will watch the film. Never put
  insults, slurs or anything they would be embarrassed by in their mouth.

Use player lines like seasoning: 3-8 in a long film, 1-3 in a Short. The
narrator carries the story; players react inside it. Do not let a player
line overlap a narrator line (budget the same words / 2.6 + 0.35 s).

## Music moods

`music` at the top sets the default mood. Any segment may set its own
`"music": "sad"` (or `["tense", "battle"]`); the track crossfades when the
mood changes. General moods: calm, sad, tense, intense, battle, epic,
triumphant, funny, suspense, dark, warm, mysterious. Shape the film: calm
or suspense for the drop and travel, battle or intense for fights, sad for
a death that matters, triumphant or funny for the ending.

## Real speed only

Never set `"speed"` on a segment. The footage is the real game played back,
and a player running or building at three times speed reads as a glitch. For
something long (a tower going up, a walk across the map) show its last few
seconds and let the narrator cover the rest in a line. Only the finale is
ever slowed, and the program does that itself.

## No holes in the chain

A film is a chain of causes. If the picture shows a player walking toward a
tower and the next shot has him standing on top of it, the viewer has been
cheated of the thing that happened, and that thing (a kit pulling him up, a
leap into the lake) is usually the best moment in the match.

- The moment list now includes what nobody was hurt in: a kit used on
  someone (`ability`), a long drop (`fall`), a tower going up (`tower`).
  Read them the way you read kills.
- digest.md ends with "Must be on screen": the kit uses and leaps between the
  last two players in the final minutes. Every one of them gets a segment
  covering the seconds listed, and those seconds include the lead-up: the
  walk into the trap is part of the trap. `check` enforces this.
- When a kit does something, show the five to ten seconds before it, the
  thing itself, and what it changed, in that order, and say plainly what the
  kit did ("the Endermage's portal drags him up the tower").
- If the film is running long, cut explanation, not events. A line that
  explains towering can go; the pull up the tower cannot.

## The finale (every film)

The last fight of the match is always shown under one song, and the film
ends on the winner's celebration. Ordinary combat plays at real speed so it
stays intense; only a sudden kill (a stomp, a trap, a fall) is slowed down,
and digest.md says which this is. digest.md ends with "The
finale": two or three segments to put in doc.json exactly as given
(`"finale": true`, fixed ids and times). They are cut to the song, which is
why their times are not yours to move. The program sets their speed, their
music and the face shots.

- `finale_build` is the song's build-up: nine seconds on the two players'
  faces as they square up, before a blow lands. Nothing is spoken in it, and
  the segment before it must have finished talking before it starts. So set
  the fight up BEFORE the finale: who these two are, what each is carrying,
  what is at stake. Then let the faces and the music hold.
- `finale_fight` starts on the song's drop, which is the first hit. Narrate
  the fight here as you normally would, one or two lines, the first at least
  half a second in. If the fight is long there is also `finale_kill`, the
  last blows and the death; the middle of the fight is skipped.
- Never describe a blow before it lands or announce the kill early.
- The segment after is the celebration: from the end of the finale to the
  end of the match, real speed, music "triumphant". How it ended and the
  closing line about the winner (name, kit, kills) go here. The music carries
  straight on from the song, so keep the first line short and let it breathe.

## Knowing the game (the bottom of digest.md)

After the skeleton, digest.md carries what a commentator who plays this game
would have noticed. Use it the way a caster would: a detail dropped at the
right second, never a list read out.

- **Player highlights**: a player typed `/highlight` because they thought
  they did something cool, and said why. Look at that moment before anything
  else of the same size. If it holds up, it goes in, and their words can be a
  chat line. If nothing is there, leave it out without comment.
- **Kit abilities used**: when each kit actually fired, and any kill that
  came right after. This is the plugin's own record, so trust it over a
  guess: say the kit did it when it did ("that is the Thor's lightning"),
  and do not credit a kit that never fired.
- **Teaming**: two players who stayed together and did not fight each other.
  Say they teamed. If it started late, or ended with one killing the other,
  that is a story beat (an alliance, a betrayal), so build to it.
- **Stews**: mushroom stew heals at once, so a fight is a drinking race.
  Counts are per player and per kill. A run marked hotkeying means number
  keys at full speed: "he must be hotkeying like crazy" is the right kind of
  line. No stews before a death is worth a line too.
- **Towering**: a one-block pillar straight up, camped on top, usually a
  Stomper or a Fisherman with little armour and snowballs. Call it towering.
- **Deaths nobody caused**: starved, drowned, fell. Say how, plainly. A
  what-if that names a kit ("a Cultivator would have had food") is good once
  in a film, not at every death.
- **Rules worth a mention this time**: the feast, the forcefield at +-500,
  the opening invincibility, no respawns, the endgame. Mention only the ones
  listed there for this match, and only where they help. A rule that is not
  listed stays out: viewers of the channel have heard it.

## Narration

- A sports documentary voice: specific, present tense, short sentences. Name
  players and kits.
- **Narrate the data, do not list it.** The digest is written in raw units
  because it is for you: hp, damage, blocks, seconds, coordinates. A number
  now and then is good colour and Tabor likes it; number after number sounds
  like a stats readout and he does not. Most of the time, say what it meant,
  the way a caster who was watching would:

  | the digest says | say this kind of thing |
  |---|---|
  | 1 hp, 3 hp, 6 hp | "half a heart", "a heart and a half", "three hearts left" |
  | took 22 damage, drank 4 stews | "he was nearly dead twice and drank his way back" |
  | 20 damage in 6 seconds | "he shreds him in seconds" |
  | walked 1,200 blocks | "he crossed the whole map looking for a fight" |
  | 35 blocks apart | "close enough to hear each other", "a short sprint away" |
  | near x 480 | "right out at the edge of the forcefield" |
  | 32 s after invincibility | "moments after invincibility drops" |
  | fight lasts 4 s, 11 hits to 2 | "it is over before he can turn around" |

  Health is hearts (hp divided by two), not hp. Coordinates are never spoken.
  Say cause and consequence, not measurements.
- Then pick the one or two numbers in the film that land hardest and keep
  them raw: "a thousand blocks for one fight", "eleven hits to two", "nine
  hearts left". Never two data lines in a row, and no more than about one
  narrator line in three. `check` enforces only that; kills, stews and hearts
  are always fine.
- The bottom of digest.md has "In plain words": one line per player that has
  already done this translation. Start from those.
- Budget time: words / 2.6 + 0.35 s per line. Leave 1-2 s of air between
  lines; the film needs room to breathe over the action. About 40-50% of the
  running time spoken is plenty.
- Land the line about a kill 0.5-1 s before it happens, not after. The digest
  gives the kill time; subtract the segment's `from_sec`.
- Explain kits in half a sentence the first time they matter. The audience
  may not know what a Stomper does.
- Do not narrate what cannot be seen: particles, potion effects and sounds do
  not render. Positions, swings, hits (players flash red), deaths, block
  changes, explosions' craters and arrows do.
- Bedrock players have a leading dot in their name; say the name without it.
- Chat lines in the digest can be quoted if they are harmless and funny.
- End on the winner: name, kit, kill count, and one line that closes the story.

## After doc.json

```
node bin/mcmatch.js check <slug>
xvfb-run -a -s "-screen 0 1920x1080x24" node bin/mcmatch.js make <slug>
```
`make` deletes the match recording when final.mp4 is written
(`--keep-recording` to iterate). Voices: `--mock-voice` if the TTS server
is not running.
