# Stage 3: Casting

Write `cast.json`: one voice profile per character in story.json.

```json
{
  "characters": {
    "Bram": { "voice": "stock:elderly_male", "voice_desc": "tired middle-aged man, slow, gravelly" },
    "Ola":  { "voice": "design", "voice_desc": "brisk adult woman, crisp, slightly nasal, quick", "language": "en" },
    "Villagers": { "voice": "crowd" }
  }
}
```

- `stock:<id>` reuses the voice bank (designed once on the voice server,
  `voice_server/bank.json`). Narrators: narrator (documentary baritone),
  caster (hyped esports), storyteller (warm), deadpan (dry), trailer (epic).
  Characters: adult_male, adult_female, young_male, young_female, kid, teen,
  elderly_male, elderly_female, gruff, villain, hero, coward, merchant,
  warrior_woman, wise, goofy, whisper, robot, crowd. Cheapest and most
  consistent; use for minor roles or when one fits.
- `design` generates a voice from `voice_desc` on the voice server, saves the
  reference clip, and reuses it in every future project (the id becomes
  `char_<id>`). Use for named leads with a distinctive description.
- `clone:<path.wav>` clones from a reference recording (add `ref_text`).
- `crowd` for group characters: N layered takes with jitter.
- Optional per character: `speed` (0.8-1.2), `gain_db`.

`mcmovie voice:cast <slug>` creates the designed/cloned profiles and fills in
`profile_id`. `mcmovie voice <slug>` renders every line. With `--mock` no
server is needed (placeholder audio with the right timing).
