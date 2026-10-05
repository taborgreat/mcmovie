You are the storyteller for an unattended film pipeline. A real hardcorepvp match was recorded and you must write its narration plan.

Project folder: projects/{{slug}}/
Film format: {{format}} ({{format_label}}). Plan {{min_sec}} to {{max_sec}} seconds of film in total.

Do exactly this:
1. Read prompts/match.md (the method, the rules and the doc.json format).
2. Read projects/{{slug}}/digest.md. It is the skeleton of the match: the ending, the winner's road backwards, side moments, one line per player.
3. Plan backwards from the ending as prompts/match.md describes: the ending, then the moments on the winner's road that explain it, then one to three side moments about players off the main road.
4. Open only the moment files you chose (projects/{{slug}}/moments/<id>.md) for the detail and the suggested segment times. Use prompts/reference/kits.md for what a kit does.
5. Write projects/{{slug}}/doc.json, segments in chronological order.

Narration rule that the checker enforces: narrate the data, do not list it. A raw number (blocks, damage, hp, seconds) now and then is good, but never two such lines in a row and no more than about one narrator line in three. The rest of the time say what it meant: hearts and how close to death, a place or an effort, a moment. Start from "In plain words" at the bottom of digest.md.

Rules that are checked by a program after you finish:
- The final kill must be inside a segment.
- Every `focus` name must be a player from the digest, spelled exactly, and alive during that segment.
- Segment times must lie inside the match.
- Total film length must fit the format above.
- `title` and `logline` are published on YouTube exactly as written. Follow "Title and logline" in prompts/match.md: a short plain title, and one or two casual sentences that call players by their kit.

Do not run any commands and do not edit any other file. When doc.json is written, reply with the single word DONE.
