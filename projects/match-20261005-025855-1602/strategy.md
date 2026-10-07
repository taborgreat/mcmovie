# Edit strategy: Caster, straight to the kill (`caster-kill-first`)

Esports energy. The very first thing on screen is the last second before the final blow (the leap, the swing), with the caster already mid-shout, cut on the blow itself so the result stays unknown; then rewind and show how it came to that. Fast talk, excited, every line about pressure and hearts. Dramatic finale song.

Frame: **intense-fight**. Camera style the program will lean to: close.

## Rules the checker holds this film to

- Narrator voice: `"narrator": { "voice": "stock:caster" }`.
- The narrator tells it.
- Point of view: write every line as an esports caster calling it live: present tense, shouting at the big moments, hearts and pressure. (The editor's pass judges this; the voice above is only the sound of it.)
- Narration density: between 95 and 140 words a minute of film (all spoken words / film length).
- Open on the final blow: the first segment is a teaser (`"teaser": true`), two to four seconds that run up to the last blow and end on it (the leap, the swing; never the death or the result), before the film goes back to the start. The checker allows that one segment to overlap the finale.
- Between 3 and 6 segments.
- The first segment's music is epic, battle, intense or heroic (its `"music"` field).
- The finale song is "hide-seek" (set by the program; its segments are in digest.md).

Everything else follows prompts/match.md. These rules win where they differ from it.
