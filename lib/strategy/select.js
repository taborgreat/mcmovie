'use strict'
// Which strategy a match film is planned under, and the brief the planner gets for it.
// Eligibility comes from what the match has in it (the digest); among the eligible, a
// strategy still short of its five films is tried in proportion to how many are still short
// (at least one time in four; always while every one is short), otherwise the best-scoring one wins, with a little randomness so the
// runners-up keep getting films. The same strategy is not used for two films in a row when
// there is a choice.
const fs = require('fs')
const path = require('path')
const U = require('../util')
const store = require('./store')

const MIN_FILMS = 5
const EXPLORE = 0.25

function fits (s, d) {
  const f = s.fits || {}
  const players = d.starting_players || (d.players || []).length || 0
  if (f.min_players && players < f.min_players) return `needs ${f.min_players}+ players`
  if (f.max_players && players > f.max_players) return `only up to ${f.max_players} players`
  const ins = d.insight || {}
  for (const need of f.needs || []) {
    if (need === 'chat' && (d.chat || []).length < 4) return 'needs players who typed (4+ chat lines)'
    if (need === 'teaming' && !((ins.teams || []).length)) return 'needs a team-up in the match'
    if (need === 'abilities' && (ins.abilities || []).length < 2) return 'needs kit abilities on record (2+)'
    if (need === 'sudden_kill' && !(d.finale && d.finale.slow)) return 'needs a sudden final kill'
    if (need === 'quiet_death' && !((ins.quiet_deaths || []).length)) return 'needs a death nobody caused'
    if (need === 'tower' && !((ins.towers || []).length)) return 'needs a tower'
  }
  return null
}

const LAST = path.join(U.ROOT, 'automation', 'strategy_last.json')
// the recipe planned most recently (every plan, test runs included), so two films in a row never share one
function lastUsed () {
  try { return U.readJson(LAST).id || null } catch { /* none yet */ }
  try { const films = require('../publish/films').read().films || []; const f = films.find(x => x.features && x.features.strategy_id); return f ? f.features.strategy_id : null } catch { return null }
}

// d: the digest object. Returns { strategy, why, eligible: [...], skipped: {id: reason} }.
function choose (d, { force = null, rand = Math.random, scores = null } = {}) {
  const all = store.active()
  if (force) { const s = all.find(x => x.id === force) || store.get(force); if (!s) throw new Error(`no strategy ${force}`); return { strategy: s, why: 'asked for by name', eligible: [s.id], skipped: {} } }
  const skipped = {}
  const eligible = all.filter(s => { const r = fits(s, d); if (r) skipped[s.id] = r; return !r })
  if (!eligible.length) { const s = all.find(x => x.id === 'default') || all[0]; return { strategy: s, why: 'nothing fitted this match; the house style', eligible: [], skipped } }
  if (!scores) { try { scores = require('./score').load().strategies || {} } catch { scores = {} } }
  const n = s => (scores[s.id] && scores[s.id].n) || 0
  const mean = s => (scores[s.id] && scores[s.id].mean) || 0
  const prev = lastUsed()
  let pool = eligible.length > 1 ? eligible.filter(s => s.id !== prev) : eligible
  // A recipe made for what this match is (digest traits: chat-heavy, rampage, quiet...) is a
  // nudge, never a lock: it is drawn twice as often among the learners and gets a small bonus
  // once scored. (A lock sent every small match to the caster's teaser-and-rewind opening.)
  const labels = (d.traits && d.traits.labels) || []
  const pref = s => ((s.fits && s.fits.prefers) || []).filter(t => labels.includes(t)).length
  const liked = pool.filter(s => pref(s) > 0)
  // the one hard case: a match that was a typed-out story goes to a recipe made for dialogue
  // (love-story, players-only, story-first) whenever one is eligible; anything else would skip it
  if (labels.includes('dialogue')) { const made = pool.filter(s => ((s.fits && s.fits.prefers) || []).includes('dialogue')); if (made.length) pool = made }
  const young = pool.filter(s => n(s) < MIN_FILMS)
  const ripe = pool.filter(s => n(s) >= MIN_FILMS)
  let pick; let why
  // while most of the eligible set is still learning, most films go to learning it
  const explore = young.length ? Math.max(EXPLORE, young.length / pool.length) : 0
  if (young.length && (!ripe.length || rand() < explore)) {
    const fewest = Math.min(...young.map(n))
    const c = young.filter(s => n(s) === fewest)
    // weighted draw: a recipe that fits the match counts twice
    const weights = c.map(s => pref(s) > 0 ? 2 : 1); const total = weights.reduce((a, b) => a + b, 0)
    let r = rand() * total; pick = c[c.length - 1]
    for (let i = 0; i < c.length; i++) { r -= weights[i]; if (r < 0) { pick = c[i]; break } }
    why = `still learning: ${pick.id} has ${n(pick)} of ${MIN_FILMS} films`
  } else {
    const top = ripe.slice().sort((a, b) => (mean(b) + 0.03 * pref(b)) - (mean(a) + 0.03 * pref(a))).slice(0, 3)
    pick = rand() < 0.1 && top.length > 1 ? top[1 + Math.floor(rand() * (top.length - 1))] : top[0]
    why = `${pick.id} scores ${mean(pick).toFixed(2)} over ${n(pick)} films`
  }
  if (liked.includes(pick)) why += `; fits the match (${labels.filter(l => (pick.fits.prefers || []).includes(l)).join(', ')})`
  return { strategy: pick, why, eligible: eligible.map(s => s.id), skipped }
}

const MOOD_WORDS = { epic: 'epic, battle, intense or heroic', funny: 'funny, silly, playful, comedy, sneaky or mischief', quiet: 'calm, peaceful, warm or mysterious', warm: 'warm, romantic, hopeful or calm', enchanting: 'enchanting, fairytale, wonder or warm' }

// The brief the planner reads: the idea in a paragraph, then the rules the checker will hold
// it to, in words. Short on purpose.
function brief (s, d) {
  const k = s.knobs || {}; const nar = k.narration || {}; const st = k.structure || {}; const mu = k.music || {}; const tx = k.text || {}
  const rules = []
  rules.push(`Narrator voice: \`"narrator": { "voice": "${nar.voice || 'stock:narrator'}" }\`.`)
  const modes = {
    narrator: 'The narrator tells it.',
    'players-only': 'NO narrator, apart from one line at most. The film is the players\' own chat lines in their voices (`"speaker"`, `"chat": true`), at least three of them, plus the music and the game\'s sound.',
    'kit-focused': 'Kit-focused: the narration names the kits and what they did at least three times, and the title names a kit.',
    'narrator-no-kits': 'No kit talk at all: never the word "kit" and never a kit\'s name, in the narration, the title or the logline. People with names, not classes.',
    minimal: 'Minimal narration: five narrator lines at most in the whole film, each short, 45 words in total at most.'
  }
  rules.push(modes[nar.mode] || modes.narrator)
  if (nar.persona) rules.push(`Point of view: write every line as ${nar.persona}. (The editor's pass judges this; the voice above is only the sound of it.)`)
  if (nar.wpm) rules.push(`Narration density: between ${nar.wpm[0]} and ${nar.wpm[1]} words a minute of film (all spoken words / film length).`)
  if (nar.data === 'none') rules.push('No raw numbers in the narration at all (no blocks, damage, hp, seconds).')
  if (nar.data === 'little') rules.push('Raw numbers rarely: at most one narrator line in four.')
  const opens = {
    'kill-first': 'Open on the final blow: the first segment is a teaser (`"teaser": true`), two to four seconds that run up to the last blow and end on it (the leap, the swing; never the death or the result), before the film goes back to the start. The checker allows that one segment to overlap the finale.',
    chronological: 'Strictly in order: segments sorted by time, no teaser.',
    'chat-line': 'Open on a chat line: the first line of the first segment is a player\'s chat line (`"chat": true`), not the narrator.',
    'leap-or-kill': 'Open on the most physical moment there is: the first segment contains a kill, a leap or a kit ability within its first three seconds.',
    any: null
  }
  if (opens[st.open]) rules.push(opens[st.open])
  if (st.segments) rules.push(`Between ${st.segments[0]} and ${st.segments[1]} segments.`)
  if (mu.opening && mu.opening !== 'any') rules.push(`The first segment's music is ${MOOD_WORDS[mu.opening] || mu.opening} (its \`"music"\` field).`)
  if (mu.finale_song) rules.push(`The finale song is "${mu.finale_song}" (set by the program; its segments are in digest.md).`)
  if (tx.title === 'question') rules.push('The title is a question.')
  if (tx.title === 'kits') rules.push('The title names at least one kit.')
  const lines = [`# Edit strategy: ${s.name} (\`${s.id}\`)`, '', s.brief, '']
  if (k.frame) lines.push(`Frame: **${k.frame}**. Camera style the program will lean to: ${(k.camera || {}).style || 'mixed'}.`, '')
  lines.push('## Rules the checker holds this film to', '', ...rules.map(r => '- ' + r), '')
  lines.push('Everything else follows prompts/match.md. These rules win where they differ from it.')
  return lines.join('\n') + '\n'
}

// Write the choice into the project: strategy.json (the recipe as used) and strategy.md (the brief).
function write (dir, choice, d) {
  const s = choice.strategy
  const rec = { id: s.id, name: s.name, version: s.version || 1, parent: s.parent || null, chosen_at: new Date().toISOString(), why: choice.why, eligible: choice.eligible, skipped: choice.skipped, fits: s.fits, knobs: s.knobs, brief: s.brief }
  U.writeJson(path.join(dir, 'strategy.json'), rec)
  try { U.writeJson(LAST, { id: s.id, at: rec.chosen_at, project: path.basename(dir) }) } catch { /* best effort */ }
  fs.writeFileSync(path.join(dir, 'strategy.md'), brief(s, d))
  return rec
}

function read (dir) { try { const f = path.join(dir, 'strategy.json'); return U.exists(f) ? U.readJson(f) : null } catch { return null } }

module.exports = { MIN_FILMS, EXPLORE, fits, choose, brief, write, read }
