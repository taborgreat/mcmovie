#!/usr/bin/env node
'use strict'
// mcmovie command line. Every stage is a command; `make` runs the
// deterministic stages (4-7) in order. Planning stages (1-3) are done by the
// LLM operator writing JSON files (see CLAUDE.md and prompts/).
const path = require('path')
const fs = require('fs')
const U = require('../lib/util')

function parseArgs (argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=')
      if (v !== undefined) args[k] = v
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) args[k] = argv[++i]
      else args[k] = true
    } else args._.push(a)
  }
  return args
}

const HELP = `mcmovie - prompt in, Minecraft movie out

Project lifecycle (LLM-planned stages marked *):
  new <slug> "<prompt>"         create projects/<slug>/ with prompt.txt
  * write story.json, world.json, scene_<id>.json, cast.json   (see prompts/)
  validate <slug>               schema + self-checks for every plan file
  timeline <slug>               stage 4: timeline.json, shoot.json, voice.json
  shoot <slug> [--scene id] [--keep-server] [--verbose]
                                stage 5a: drive bots on the server, record replays
  voice <slug> [--mock] [--force] [--url http://host:8880]
                                stage 5b: WAV per line via the TTS server
  voice:cast <slug> [--mock]    create designed/cloned voices on the TTS server
  render <slug> [--shot id] [--scene id] [--fps 30] [--size 1920x1080]
                                replays -> one clip per cut (needs xvfb on Linux)
  assemble <slug> [--preset medium] [--crf 18]
                                stage 7: edl.json -> final.mp4
  make <slug> [--mock-voice] [--size WxH] [--fps N] [--scene id]
                                timeline -> shoot + voice -> render -> assemble
  status <slug>                 which stage outputs exist

Server and assets:
  server:setup [--port 25566] [--ground-y 64] [--terrain flat|normal] [--seed s]
  server:start [--echo]         run the set server in the foreground
  server:stop
  terrain:pick <slug> [--near x,z]   scout a stage on the natural-terrain world -> projects/<slug>/terrain.json
  music:scan [dir]              build/refresh music/music_manifest.json
  music:demo                    download a CC-BY demo library covering the general moods
  music:mock                    synthetic test tracks
  skins:sync <name...> | --usercache <path/to/usercache.json> | --roster
  skins:list
  outro:make [--shape short|long] [--post] [--near x,z] [--facing 0-3]
                                film the outro every film ends on (real client, set server) and
                                lay the words over it -> assets/outro/; --post redoes only the words

Environment: MCMOVIE_TTS_URL (default http://127.0.0.1:8880)
`

// Staged scenes are filmed live by the real Minecraft client when it is set up (capture/)
// and config/capture.json does not turn it off. --no-film / --offline uses the old renderer.
function filming (args) {
  if (args['no-film'] || args.offline) return false
  const c = require('../lib/capture/client')
  return c.config().enabled && c.available()
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  const slug = args._[1]
  const dir = slug ? U.projectDir(slug) : null
  const common = {}
  if (dir && ['shoot', 'render', 'assemble', 'make', 'timeline'].includes(cmd)) {
    const sz = require('../lib/formats').sizeFor(dir, args)
    Object.assign(common, { width: sz.width, height: sz.height, fps: sz.fps })
  }

  switch (cmd) {
    case undefined:
    case 'help': case '--help': case '-h':
      console.log(HELP); return

    case 'new': {
      const prompt = args._.slice(2).join(' ')
      if (!slug) throw new Error('usage: mcmovie new <slug> "<prompt>"')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt + '\n')
      console.log(`created ${path.relative(process.cwd(), dir)}/prompt.txt`)
      console.log('next: write story.json + world.json (prompts/outline.md), then one scene_<id>.json per scene (prompts/scene.md), then cast.json (prompts/casting.md); run: mcmovie validate ' + slug)
      return
    }

    case 'validate': {
      const V = require('../lib/validate')
      const r = V.validateProject(dir)
      V.printReports(r.reports)
      if (!r.ok) process.exitCode = 1
      return
    }

    case 'timeline': {
      const V = require('../lib/validate')
      const r = V.validateProject(dir)
      if (!r.ok) { V.printReports(r.reports); throw new Error('plan has errors; fix them first') }
      const tl = require('../lib/timeline').build(dir, { fps: common.fps, fresh: !!args.fresh })
      console.log(`timeline: ${tl.scenes.length} scenes, ${tl.total_ticks} ticks (${(tl.total_ticks / 20).toFixed(1)}s), ${tl.lines.length} lines, ${tl.shots.length} shots -> ${tl.cuts.length} cuts, music ${tl.music ? tl.music.track_id : 'none'}`)
      return
    }

    case 'shoot': {
      const film = filming(args)
      const r = await require('../lib/mc/shoot').shoot(dir, { ...common, film, scene: args.scene, keepServer: !!args['keep-server'], verbose: !!args.verbose })
      for (const s of r) console.log(`scene ${s.id}: ${s.duration_ticks} ticks, ${s.late_ticks} late ticks, ${s.wall_seconds.toFixed(1)}s wall${s.clips ? `, ${s.clips.length} clips filmed` : ''}`)
      return
    }

    case 'voice': {
      const v = require('../lib/voice/client')
      await v.castVoices(dir, { mock: !!args.mock, url: args.url })
      await v.voice(dir, { mock: !!args.mock, force: !!args.force, url: args.url })
      return
    }

    case 'voice:cast': {
      const cast = await require('../lib/voice/client').castVoices(dir, { mock: !!args.mock, url: args.url })
      for (const [id, c] of Object.entries(cast.characters)) console.log(`${id}: ${c.voice} -> ${c.profile_id}`)
      return
    }

    case 'render': {
      // cuts the real client filmed during the shoot are finished clips already
      const cuts = U.readJson(path.join(dir, 'timeline.json')).cuts.filter(c => !args.scene || c.scene_id === args.scene)
      if (!args.offline && !args['no-film'] && cuts.length && cuts.every(c => c.source === 'client' && c.clip && U.exists(path.join(dir, c.clip)))) {
        console.log(`${cuts.length} clips were filmed by the real client during the shoot; nothing to render (use --offline for the old renderer)`)
        return
      }
      ensureDisplay()
      const r = await require('../lib/render/render').render(dir, { ...common, shot: args.shot, scene: args.scene })
      console.log(`rendered ${r.length} clips`)
      return
    }

    case 'assemble': {
      const edl = require('../lib/assemble/edl').build(dir, common)
      for (const w of edl.warnings) console.log('warn: ' + w)
      const out = await require('../lib/assemble/ffmpeg').assemble(dir, { preset: args.preset, crf: args.crf, verbose: !!args.verbose })
      console.log(out)
      return
    }

    case 'make': {
      const V = require('../lib/validate')
      const r = V.validateProject(dir)
      V.printReports(r.reports)
      if (!r.ok) throw new Error('plan has errors; fix them first')
      const tl = require('../lib/timeline').build(dir, { fps: common.fps })
      U.log('make', `timeline: ${tl.total_ticks} ticks`)
      const v = require('../lib/voice/client')
      const mock = !!args['mock-voice']
      // voice runs concurrently with the shoot (different machines/processes in spirit; here, same event loop)
      const voiceP = (async () => { await v.castVoices(dir, { mock, url: args.url }); return v.voice(dir, { mock, url: args.url }) })()
      const film = filming(args)
      const shootP = require('../lib/mc/shoot').shoot(dir, { ...common, film, scene: args.scene, keepServer: !!args['keep-server'] })
      const [, shots] = await Promise.all([voiceP, shootP])
      U.log('make', `shot ${shots.length} scenes${film ? ' (filmed by the real client)' : ''}`)
      if (!film) { ensureDisplay(); await require('../lib/render/render').render(dir, { ...common, scene: args.scene }) }
      const edl = require('../lib/assemble/edl').build(dir, common)
      for (const w of edl.warnings) U.log('make', 'warn: ' + w)
      const out = await require('../lib/assemble/ffmpeg').assemble(dir, { preset: args.preset, crf: args.crf })
      console.log('FINAL ' + out)
      return
    }

    case 'status': {
      const files = ['prompt.txt', 'story.json', 'world.json', 'cast.json', 'timeline.json', 'shoot.json', 'voice.json', 'shoot_log.json', 'voice_result.json', 'edl.json', 'final.mp4']
      for (const f of files) console.log(`${U.exists(path.join(dir, f)) ? 'x' : ' '} ${f}`)
      const story = U.exists(path.join(dir, 'story.json')) ? U.readJson(path.join(dir, 'story.json')) : null
      if (story) for (const s of story.scenes) {
        const rp = U.exists(path.join(dir, 'replay', `scene_${s.id}.json.gz`))
        console.log(`${U.exists(path.join(dir, `scene_${s.id}.json`)) ? 'x' : ' '} scene_${s.id}.json   replay:${rp ? 'yes' : 'no'}`)
      }
      const clips = U.exists(path.join(dir, 'clips')) ? fs.readdirSync(path.join(dir, 'clips')).length : 0
      const wavs = U.exists(path.join(dir, 'wav')) ? fs.readdirSync(path.join(dir, 'wav')).length : 0
      console.log(`clips: ${clips}  wavs: ${wavs}`)
      return
    }

    case 'server:setup': {
      const s = require('../lib/mc/server')
      const cfg = s.setup({ port: args.port ? Number(args.port) : undefined, groundY: args['ground-y'] ? Number(args['ground-y']) : undefined, terrain: args.terrain, seed: args.seed })
      console.log(`server configured: ${cfg.host}:${cfg.port}, terrain ${cfg.terrain}, ground_y ${cfg.groundY}, jar ${s.jarPath() ? 'present' : 'MISSING (download Paper 1.21.4 to server/paper.jar)'}`)
      return
    }

    case 'server:start': {
      const s = require('../lib/mc/server')
      const h = await s.start({ echo: !!args.echo })
      console.log(`server ready on ${h.cfg.host}:${h.cfg.port} (Ctrl-C to stop)`)
      process.on('SIGINT', async () => { await h.stop(); process.exit(0) })
      process.on('SIGTERM', async () => { await h.stop(); process.exit(0) })
      await new Promise(() => {})
      return
    }

    case 'server:stop': {
      const ok = await require('../lib/mc/server').stopRunning()
      console.log(ok ? 'stopped' : 'no server pid found')
      return
    }

    // scout a stage on the natural-terrain set world and write projects/<slug>/terrain.json
    case 'terrain:pick': {
      const near = args.near ? args.near.split(',').map(Number) : undefined
      const t = await require('../lib/mc/terrain').pick({ near, out: dir ? path.join(dir, 'terrain.json') : undefined })
      console.log(`stage: ${t.biome}, ground y=${t.ground_y}, ${t.stage.size}x${t.stage.size} from ${t.stage.from.join(',')}, origin ${t.origin.join(',')}, ${t.trees_cleared_at_shoot} trees to clear`)
      return
    }

    case 'music:scan': {
      const r = require('../lib/music/manifest').scan(args._[1])
      console.log(`manifest: ${r.added} added, ${r.total} total -> music/music_manifest.json (fill in mood_tags/tempo)`)
      return
    }

    case 'music:demo': {
      const r = await require('../lib/music/demo').install()
      console.log(`demo library: ${r.fetched} downloaded, ${r.total} tracks in the manifest (Kevin MacLeod, CC BY 4.0; credits are added to video descriptions)`)
      return
    }

    case 'music:mock': {
      const m = require('../lib/music/manifest').mock()
      console.log(`${m.tracks.length} tracks in manifest`)
      return
    }

    case 'skins:sync': {
      const sk = require('../lib/skins')
      let entries = args._.slice(1)
      if (args.usercache) entries = sk.entriesFromUsercache(args.usercache)
      else if (args.roster) entries = sk.readRoster().players
      if (!entries.length) throw new Error('give usernames, --usercache <file>, or --roster')
      const r = await sk.sync(entries, { force: !!args.force, source: args.usercache ? 'usercache' : 'mojang' })
      console.log(`${r.length} skins ready in skins/ (roster: skins/players.json)`)
      return
    }

    case 'skins:list': {
      const sk = require('../lib/skins')
      for (const p of sk.readRoster().players) console.log(`${p.name.padEnd(17)} ${p.model.padEnd(8)} ${p.skin}`)
      return
    }

    // the outro every film ends on: filmed with the real client, then the words are laid over it
    case 'outro:make': {
      const shapes = args.shape ? [args.shape] : undefined
      const near = args.near ? String(args.near).split(',').map(Number) : undefined
      const r = await require('../lib/outro/make').make({ shapes, near, facing: args.facing !== undefined ? Number(args.facing) : undefined, postOnly: !!args.post, verbose: !!args.verbose })
      for (const o of r) { console.log(`${o.file}: ${o.seconds}s, breaks at ${o.measured.breaks.join(', ')} s, blast ${o.measured.blast} s, far bolt ${o.measured.bolt1} s, second bolt ${o.measured.bolt2} s, words lock ${o.measured.seal} s, address gone ${o.measured.title_gone} s`); for (const pr of o.problems) console.log('  PROBLEM: ' + pr) }
      return
    }

    default:
      console.log(HELP)
      throw new Error(`unknown command ${cmd}`)
  }
}

function ensureDisplay () {
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    throw new Error('rendering needs an X display for headless-gl. Run under xvfb: xvfb-run -a -s "-screen 0 1920x1080x24" mcmovie render <slug>  (sudo apt install xvfb)')
  }
}

main().catch(e => { console.error('error: ' + (e.stack || e.message)); process.exit(1) })
