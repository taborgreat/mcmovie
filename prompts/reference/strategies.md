# Edit strategies: the knobs

An edit strategy is the recipe a match film is planned under. The live set is
`automation/strategies.json` (seeded from `config/edit_strategies.json`, mirrored to
MongoDB `edit_strategies`); each film records which one it used (`strategy.json` in the
project, `features.strategy` on the film record), and `lib/strategy/score.js` scores
strategies from the films' numbers. `node bin/mcmatch.js strategy list` shows them.

```json
{
  "id": "caster-kill-first", "name": "...", "status": "active|retired", "parent": null, "version": 1,
  "fits": { "min_players": 2, "max_players": 120, "needs": ["chat", "teaming", "abilities", "sudden_kill", "quiet_death", "tower"] },
  "knobs": {
    "frame": "match-story | intense-fight | machinima-story | love-story | comedy | kit-showcase",
    "narration": { "mode": "narrator | players-only | kit-focused | narrator-no-kits | minimal", "voice": "stock:<id>", "wpm": [lo, hi], "data": "none | little | some", "persona": "the point of view every line is written from (a nature documentary, a bored referee, an esports caster...); judged by the editor pass, not the checker" },
    "structure": { "open": "any | kill-first | chronological | chat-line | leap-or-kill", "segments": [lo, hi] },
    "music": { "opening": "any | epic | funny | quiet | warm | enchanting", "finale_song": "<id from config/finale_songs.json>" },
    "camera": { "style": "mixed | close | wide" },
    "text": { "title": "plain | question | kits" }
  },
  "brief": "a paragraph the planner reads", "notes": "the hypothesis, in one line"
}
```

- `fits.needs` is checked against the digest: `chat` = 4+ chat lines, `teaming` = a
  team-up found by insight, `abilities` = 2+ kit abilities on record, `sudden_kill` = the
  finale is a sudden kill, `quiet_death`, `tower`.
- Every knob under `narration`, `structure.open`, `structure.segments`, `music.opening`
  and `text.title` is enforced by `lib/strategy/check.js` (15% tolerance on bands).
  `music.finale_song` is applied by the program (it sets the finale's times and song).
  `camera.style` is a lean the automatic camera will follow; not enforced yet.
- Choosing (`lib/strategy/select.js`): among the eligible, a strategy with fewer than 5
  films is tried about one time in four (always while every strategy is short); otherwise
  the best score, with a little randomness; never the same strategy twice in a row when
  there is a choice. `node bin/mcmatch.js strategy <slug> --id <x>` forces one.
- Scoring (`lib/strategy/score.js`): 0-1 per film = 60% hold (YouTube's relative retention,
  or % watched) + 30% reach (first-48-hour views against the median of the ten films
  before it, so the feed's mood cancels) + 10% likes/shares/saves per view. A strategy is
  judged on 5+ films; `mean`, `recent` (last 3) and `spread` are kept.
- Growing the set: `store.derive(parentId, changes, { id, name, notes })` makes a child
  that changes one thing, with the reason in `notes`; `store.retire(id, why)` retires one.
  Change one knob at a time, and write the hypothesis down, or the scores mean nothing.

## `narration.player_lines` and `structure.travel` (Max's rules as modes)

- `player_lines`: `any` (default: real chat and short invented in-character
  lines, in the player's permanent voice) or `chat-only` (a player speaks
  only what they really typed, word for word, `"chat": true`; `check`
  refuses anything else). `players-only` and `story-first` use chat-only.
- `travel`: `any` (default: 3-6x for dull stretches) or `cut` (nothing is
  sped up; `check` refuses `speed` > 1, so a dull stretch is cut instead).

## `effects` (what the plan may lay over the picture)

- `register`: `clean` (default) or `memed`. Clean offers only the game-native
  clips (armour and sword upgrades, the chest, the bat, the heart / dirt /
  challenge transitions). Memed also offers the meme clips (WASTED, YOU DIED,
  FIGHT / K.O., the Hulk, the troll face, the countdowns, "here we go
  again"). Memes only ever appear under a memed strategy: Tabor does not want
  them in every video, only the right ones.
- `promo`: true lets the assembler lay a subscribe nudge (a promo clip)
  over a quiet moment in about half of this strategy's films. Off unless set:
  Tabor never wants it in every video, only in certain kinds, never spam.
- `max`: how many effects (stings, inserts and transitions together) one film
  may carry; 1 under clean, 3 under memed unless set. The checker counts.
- Each clip's purpose is in `config/effects.json` (`use`), and digest.md
  prints the ones on offer. A call lands on a moment (`at_sec`) or on the
  first death / hit in the segment (`on`), and clips with a beat (a
  countdown's GO, the PERFECT K.O.) are timed so the beat hits the moment.

## Ideas waiting for a knob

- **A whole Short cut to one song** (Tabor's note on the Rush E file: "maybe whole thing used as
  one short machinima going with song"): the film is the song's length, cuts land on its beats,
  narration minimal or none, no separate finale song. Needs a `music.whole_song` knob and
  beat-aware cutting in the editor (`lib/timeline.js` / `lib/assemble`); not built. Until then
  Rush E is a `frantic`/`chaos` mood track in the library.
