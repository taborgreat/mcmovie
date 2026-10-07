'use strict'
// What a film actually did, written down at upload time (the project folder is deleted right
// after, so this is the only record). Later, with the numbers each film earns, this is what
// tells an edit strategy apart from another: how dense the narration was, who spoke, how it
// opened, what the music did, what the match had in it. Everything here is read from the
// plan, the timeline and the digest; nothing is asked of a model.
const path = require('path')
const U = require('../util')

const KIT_WORDS = ['stomper', 'endermage', 'kangaroo', 'digger', 'pyro', 'flash', 'beastmaster', 'vampire', 'gladiator', 'timelord', 'turtle', 'thor', 'switcher', 'spiderman', 'monk', 'jellyfish', 'hulk', 'fisherman', 'archer', 'ninja', 'grappler', 'anchor', 'viper', 'chameleon', 'surprise', 'specialist', 'phantom', 'poseidon', 'reaper', 'cultivator', 'milkman', 'lumberjack', 'scout', 'snail', 'tank', 'urgal', 'worm', 'achilles', 'camel', 'checkpoint', 'dwarf', 'fireman', 'frosty', 'kaya', 'launcher', 'madman', 'magma', 'neo', 'noob', 'rider', 'squid', 'stomper', 'blacksmith', 'barbarian']

const words = t => String(t || '').trim().split(/\s+/).filter(Boolean).length
const readIf = f => { try { return U.exists(f) ? U.readJson(f) : null } catch { return null } }

function textFeatures (title, logline) {
  const t = String(title || ''); const l = String(logline || '')
  const low = (t + ' ' + l).toLowerCase()
  return {
    title_words: words(t.replace(/^.*?#\d+:\s*/, '')), logline_words: words(l),
    title_question: /\?/.test(t), logline_question: /\?/.test(l), title_number: /\d/.test(t.replace(/^.*?#\d+:\s*/, '')),
    kits_named: [...new Set(KIT_WORDS.filter(k => low.includes(k)))],
    second_person: /\byou\b/i.test(l)
  }
}

// A match film: the plan (doc.json), what was built from it (timeline.json) and the match (digest.json).
function matchFeatures (dir, doc) {
  const tl = readIf(path.join(dir, 'timeline.json'))
  const dg = readIf(path.join(dir, 'digest.json'))
  const segs = (doc.segments || []).slice()
  const filmSec = tl && tl.total_ticks ? tl.total_ticks / (tl.tick_rate || 20) : segs.reduce((n, s) => n + (s.to_sec - s.from_sec) / (s.speed || 1), 0)
  const lines = segs.flatMap(s => (s.narration || []).map(l => ({ ...l, seg: s.id })))
  const narratorLines = lines.filter(l => !l.speaker || l.speaker === 'narrator')
  const playerLines = lines.filter(l => l.speaker && l.speaker !== 'narrator')
  const wordsAll = lines.reduce((n, l) => n + words(l.text), 0)
  const first = segs[0] || {}
  const firstLine = (first.narration || []).slice().sort((a, b) => a.at_sec - b.at_sec)[0] || null
  const shots = tl ? tl.shots.slice().sort((a, b) => a.start_tick - b.start_tick) : []
  const kinds = {}
  for (const s of shots) { const k = String(s.auto || s.path?.type || 'planned').split(':')[0]; kinds[k] = (kinds[k] || 0) + 1 }
  const chrono = segs.every((s, i) => i === 0 || s.from_sec >= segs[i - 1].from_sec)
  const moods = [...new Set(segs.map(s => s.music).filter(m => typeof m === 'string'))]
  const tracks = tl && tl.music_cues ? [...new Set(tl.music_cues.map(c => c.track_id))] : []
  const fin = (dg && dg.finale) || {}
  const feast = !!(dg && (dg.phases || []).some(p => p.state === 'FEAST'))
  return {
    kind: 'match',
    narrator_voice: (doc.narrator && doc.narrator.voice) || 'stock:narrator',
    segments: segs.length, film_sec: +filmSec.toFixed(1), chronological: chrono,
    sped_segments: segs.filter(s => s.speed && s.speed > 1).length,
    lines: lines.length, words: wordsAll, words_per_min: filmSec ? +(wordsAll / (filmSec / 60)).toFixed(1) : null,
    narrator_lines: narratorLines.length, player_lines: playerLines.length, chat_lines: lines.filter(l => l.chat).length,
    player_line_share: lines.length ? +(playerLines.length / lines.length).toFixed(2) : 0,
    speakers: [...new Set(playerLines.map(l => l.speaker))].length,
    hook: { first_line: firstLine ? String(firstLine.text).slice(0, 120) : null, first_line_at_sec: firstLine ? firstLine.at_sec : null, first_speaker: firstLine ? (firstLine.speaker || 'narrator') : null, first_shot: shots[0] ? String(shots[0].auto || shots[0].path?.type || 'planned') : null, opens_on_segment: first.id || null },
    cuts: shots.length, cuts_per_min: filmSec && shots.length ? +(shots.length / (filmSec / 60)).toFixed(1) : null,
    shot_kinds: kinds,
    music: { moods, tracks, finale_song: tracks.includes('finale_song'), finale: fin.song || null },
    finale: { slow: !!fin.slow, why: fin.why_slow || null, kill: (dg && dg.kill_tree && dg.kill_tree.length) ? dg.kill_tree[dg.kill_tree.length - 1].by || null : null },
    match: dg ? {
      duration_sec: dg.duration_sec || null, players: dg.starting_players || (dg.players || []).length, kills: (dg.kill_tree || []).length,
      winner: dg.winner || null, winner_kit: ((dg.players || []).find(p => p.name === dg.winner) || {}).kit || null,
      kits: [...new Set((dg.players || []).map(p => p.kit).filter(Boolean))], feast, fights: (dg.fights || []).length, chat: (dg.chat || []).length,
      teams: ((dg.insight || {}).teams || []).length, highlights: ((dg.insight || {}).highlights || []).length, quiet_deaths: ((dg.insight || {}).quiet_deaths || []).length, towers: ((dg.insight || {}).towers || []).length, abilities: ((dg.insight || {}).abilities || []).length
    } : null
  }
}

function storyFeatures (dir, story) {
  const scenes = story.scenes || []
  const tl = readIf(path.join(dir, 'timeline.json'))
  return { kind: 'story', scenes: scenes.length, characters: (story.characters || []).length, point: story.point || null, feeling: story.feeling || null, film_sec: tl && tl.total_ticks ? +(tl.total_ticks / (tl.tick_rate || 20)).toFixed(1) : null, lines: tl ? tl.lines.length : null, moods: [...new Set(scenes.map(s => s.music_mood).filter(Boolean))] }
}

// Everything about one film worth comparing later. Never throws: a missing file leaves a hole.
function extract (dir, meta = {}, result = {}) {
  const out = { captured: new Date().toISOString(), text: textFeatures(meta.title, meta.logline), upload: null, plan: null }
  try {
    const at = result.at ? new Date(result.at) : new Date()
    out.upload = { format: meta.short ? 'short' : 'long', hour: at.getHours(), weekday: at.getDay(), privacy: meta.privacy || 'public' }
    const doc = readIf(path.join(dir, 'doc.json'))
    const story = readIf(path.join(dir, 'story.json'))
    if (doc) out.plan = matchFeatures(dir, doc)
    else if (story) out.plan = storyFeatures(dir, story)
    const strat = readIf(path.join(dir, 'strategy.json'))
    out.strategy_id = strat ? strat.id : null
    if (strat) out.strategy = { id: strat.id, version: strat.version || 1, why: strat.why || null, knobs: strat.knobs || null }
  } catch (e) { out.error = String(e.message).slice(0, 200) }
  return out
}

module.exports = { extract, textFeatures, matchFeatures, KIT_WORDS }
