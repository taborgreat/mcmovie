'use strict'
// Does the plan do what its strategy says? Measured on doc.json alone (this runs before
// anything is built), with a little tolerance on the bands. Every finding is an error the
// planner gets back, worded so it knows what to change.
const KITS = require('../publish/features').KIT_WORDS

const words = t => String(t || '').trim().split(/\s+/).filter(Boolean).length
const kitWords = t => KITS.filter(k => new RegExp('\\b' + k + 's?\\b', 'i').test(String(t || '')))

// strategy: the strategy.json record; doc: the plan; digest: the digest object (for moments)
function check (doc, strategy, digest = {}) {
  const errors = []
  if (!strategy || !strategy.knobs) return errors
  const k = strategy.knobs; const nar = k.narration || {}; const st = k.structure || {}; const mu = k.music || {}; const tx = k.text || {}
  const segs = doc.segments || []
  const lines = segs.flatMap(s => s.narration || [])
  const narr = lines.filter(l => !l.speaker || l.speaker === 'narrator')
  const player = lines.filter(l => l.speaker && l.speaker !== 'narrator')
  const filmSec = segs.reduce((n, s) => n + Math.max(0, (s.to_sec - s.from_sec) / (s.speed || 1)), 0)
  const allWords = lines.reduce((n, l) => n + words(l.text), 0)
  const wpm = filmSec ? allWords / (filmSec / 60) : 0
  const tag = `strategy "${strategy.id}"`

  if (nar.voice && (!doc.narrator || doc.narrator.voice !== nar.voice)) errors.push(`${tag}: the narrator voice must be "${nar.voice}" (doc.json "narrator": { "voice": "${nar.voice}" })`)
  if (nar.mode === 'players-only') {
    if (narr.length > 1) errors.push(`${tag}: players only: at most one narrator line in the whole film (there are ${narr.length}); use the players' own chat lines with "speaker" and "chat": true`)
    if (player.length < 3) errors.push(`${tag}: players only: at least three lines spoken by players (there are ${player.length})`)
  }
  if (nar.mode === 'kit-focused') {
    const n = narr.reduce((c, l) => c + kitWords(l.text).length, 0)
    if (n < 3) errors.push(`${tag}: kit-focused: the narration must name kits and what they do at least three times (it does ${n})`)
  }
  if (nar.mode === 'narrator-no-kits') {
    const bad = []
    for (const l of lines) if (/\bkits?\b/i.test(l.text) || kitWords(l.text).length) bad.push(l.id)
    if (/\bkits?\b/i.test(doc.title) || kitWords(doc.title).length || /\bkits?\b/i.test(doc.logline) || kitWords(doc.logline).length) bad.push('title/logline')
    if (bad.length) errors.push(`${tag}: no kit talk: the word "kit" and every kit name are banned in narration, title and logline (found in ${bad.join(', ')})`)
  }
  if (nar.mode === 'host') {
    // one host (Trina): every spoken line is hers, nobody else narrates
    const h = (nar.hosts || [])[0]
    const spoken = segs.flatMap(s => (s.narration || []).filter(l => !l.chat).map(l => ({ ...l, seg: s.id })))
    const strangers = h ? spoken.filter(l => String(l.speaker || 'narrator').toLowerCase() !== String(h.id).toLowerCase()) : []
    if (strangers.length) errors.push(`${tag}: every spoken line is ${h.name}'s ("speaker": "${h.id}"); no narrator, no other voice (${strangers.slice(0, 3).map(l => l.seg + '.' + l.id).join(', ')})`)
  }
  if (nar.mode === 'duo') {
    const hosts = (nar.hosts || []).map(h => h.id)
    const hostNames = (nar.hosts || []).map(h => h.name || h.id)
    const ordered = segs.flatMap(s => (s.narration || []).slice().sort((a, b) => a.at_sec - b.at_sec).map(l => ({ ...l, seg: s.id })))
    const spoken = ordered.filter(l => !l.chat)
    const strangers = spoken.filter(l => !hosts.includes(String(l.speaker || 'narrator').toLowerCase()))
    if (strangers.length) errors.push(`${tag}: every spoken line belongs to ${hosts.join(' or ')} ("speaker"); no narrator, no other voice (${strangers.slice(0, 3).map(l => l.seg + '.' + l.id).join(', ')}${strangers.length > 3 ? '…' : ''})`)
    if (spoken.length < 8) errors.push(`${tag}: a double act needs at least eight lines (there are ${spoken.length})`)
    if (spoken.length) {
      const [first, second] = spoken
      const greet = (n) => new RegExp(`^(and )?hey,? it'?s ${n}\\b`, 'i')
      if (!first || String(first.speaker).toLowerCase() !== hosts[0] || !greet(hostNames[0]).test(String(first.text).trim())) errors.push(`${tag}: the first line is ${hostNames[0]}'s and starts "Hey, it's ${hostNames[0]}"`)
      if (!second || String(second.speaker).toLowerCase() !== hosts[1] || !greet(hostNames[1]).test(String(second.text).trim())) errors.push(`${tag}: the second line is ${hostNames[1]}'s and starts "and hey, it's ${hostNames[1]}!"`)
      // full first names are for the serious moments only, and those are rare
      const fulls = (nar.hosts || []).map(h => (h.full_name || '').split(' ')[0]).filter(Boolean)
      if (fulls.length) {
        const used = spoken.filter(l => fulls.some(f => new RegExp(`\\b${f}\\b`).test(String(l.text)))).length
        if (used > 2) errors.push(`${tag}: ${fulls.join(' and ')} are the names for a serious moment; they come up ${used} times, at most twice in a film and most films never`)
      }
    }
    let run = 1
    for (let i = 1; i < spoken.length; i++) {
      run = String(spoken[i].speaker).toLowerCase() === String(spoken[i - 1].speaker).toLowerCase() ? run + 1 : 1
      if (run >= 3) { errors.push(`${tag}: ${spoken[i].speaker} has three lines in a row at ${spoken[i].seg}.${spoken[i].id}; it is a conversation, hand it back`); break }
    }
    // commentary, not a tutorial: nobody explains what a kit does
    const lectures = spoken.filter(l => /\b(is a kit|kit that|kits? (can|let|give|make)s?\b|the ability to|which means he can|that means (he|she|they) can)/i.test(String(l.text)))
    if (lectures.length) errors.push(`${tag}: no kit lectures, everyone knows the kits; react, do not explain (${lectures.slice(0, 2).map(l => `"${String(l.text).slice(0, 50)}"`).join(', ')})`)
    const kitTalk = spoken.reduce((n, l) => n + kitWords(l.text).length, 0)
    if (kitTalk > 4) errors.push(`${tag}: kit names come up ${kitTalk} times; four at most, they are commentating, not teaching`)
    const share = spoken.length ? spoken.filter(l => String(l.speaker).toLowerCase() === hosts[0]).length / spoken.length : 0.5
    if (spoken.length >= 8 && (share < 0.35 || share > 0.65)) errors.push(`${tag}: the two share the talking (${hosts[0]} has ${Math.round(share * 100)}% of the lines; 35-65%)`)
  }
  if (nar.mode === 'minimal') {
    if (narr.length > 5) errors.push(`${tag}: minimal narration: five narrator lines at most (there are ${narr.length})`)
    if (allWords > 45) errors.push(`${tag}: minimal narration: 45 spoken words at most in the whole film (there are ${allWords})`)
  }
  if (nar.wpm && filmSec > 10) {
    const [lo, hi] = nar.wpm
    if (wpm < lo * 0.85) errors.push(`${tag}: narration too sparse: ${wpm.toFixed(0)} words a minute, the strategy wants ${lo}-${hi} (add lines or shorten segments)`)
    if (wpm > hi * 1.15) errors.push(`${tag}: narration too dense: ${wpm.toFixed(0)} words a minute, the strategy wants ${lo}-${hi} (cut words or let a moment breathe)`)
  }
  // travel: 'cut' means uneventful stretches are cut, never sped up (Max's preference, as a mode)
  if (st.travel === 'cut') for (const s of segs) if ((s.speed || 1) > 1) errors.push(`${tag}: no sped-up footage: segment ${s.id} runs at ${s.speed}x; cut the dull stretch instead`)
  // narration.player_lines 'chat-only' is enforced in lib/match/build.js check (it needs the recording's chat)
  if (st.segments) {
    const [lo, hi] = st.segments
    if (segs.length < lo || segs.length > hi) errors.push(`${tag}: ${lo} to ${hi} segments (there are ${segs.length})`)
  }
  const first = segs[0]
  const firstLine = first ? (first.narration || []).slice().sort((a, b) => a.at_sec - b.at_sec)[0] : null
  if (st.open === 'kill-first') {
    if (!first || !first.teaser) errors.push(`${tag}: open on the kill: the first segment must be a teaser ("teaser": true, two to four seconds around the final kill)`)
  }
  if (st.open === 'chronological') {
    for (let i = 1; i < segs.length; i++) if (segs[i].from_sec < segs[i - 1].from_sec) { errors.push(`${tag}: strictly in order: segment ${segs[i].id} starts before ${segs[i - 1].id}`); break }
    if (first && first.teaser) errors.push(`${tag}: strictly in order: no teaser segment`)
  }
  if (st.open === 'chat-line') {
    if (!firstLine || !firstLine.chat) errors.push(`${tag}: open on a chat line: the first line of the first segment must be a player's chat line ("chat": true)`)
  }
  if (st.open === 'leap-or-kill' && first) {
    const moments = [...(digest.kill_tree || []).map(x => x.at_sec), ...((digest.insight || {}).abilities || []).map(x => x.at_sec)].filter(x => typeof x === 'number')
    const ok = moments.some(t => t >= first.from_sec - 0.5 && t <= first.from_sec + 3 * (first.speed || 1) + 0.5)
    if (!ok) errors.push(`${tag}: open on the most physical moment: the first segment must have a kill, a leap or a kit ability within its first three seconds (${moments.length ? 'moments are at ' + moments.map(t => t.toFixed(0) + 's').join(', ') : 'none on record: pick another opening'})`)
  }
  const MOODS = { epic: ['epic', 'battle', 'intense', 'heroic'], funny: ['funny', 'silly', 'playful', 'comedy', 'sneaky', 'mischief'], quiet: ['calm', 'peaceful', 'warm', 'mysterious'], warm: ['warm', 'romantic', 'hopeful', 'calm'], enchanting: ['enchanting', 'fairytale', 'wonder', 'warm'] }
  if (mu.opening && mu.opening !== 'any' && first) {
    const want = MOODS[mu.opening] || [mu.opening]
    if (!first.music || !want.includes(String(first.music))) errors.push(`${tag}: the first segment's "music" must be one of ${want.join(', ')} (it is ${first.music ? '"' + first.music + '"' : 'missing'})`)
  }
  if (tx.title === 'question' && !/\?/.test(doc.title || '')) errors.push(`${tag}: the title must be a question`)
  if (tx.title === 'kits' && !kitWords(doc.title).length) errors.push(`${tag}: the title must name a kit`)
  return errors
}

// The measurements, for the record (and for the review pass to read)
function measure (doc) {
  const segs = doc.segments || []
  const lines = segs.flatMap(s => s.narration || [])
  const narr = lines.filter(l => !l.speaker || l.speaker === 'narrator'); const player = lines.filter(l => l.speaker && l.speaker !== 'narrator')
  const filmSec = segs.reduce((n, s) => n + Math.max(0, (s.to_sec - s.from_sec) / (s.speed || 1)), 0)
  const allWords = lines.reduce((n, l) => n + words(l.text), 0)
  return { segments: segs.length, film_sec: +filmSec.toFixed(1), words: allWords, words_per_min: filmSec ? +(allWords / (filmSec / 60)).toFixed(0) : 0, narrator_lines: narr.length, player_lines: player.length, teaser: !!(segs[0] && segs[0].teaser), first_music: segs[0] ? segs[0].music || null : null, voice: (doc.narrator || {}).voice || null, kit_mentions: narr.reduce((c, l) => c + kitWords(l.text).length, 0) }
}

module.exports = { check, measure }
