#!/usr/bin/env node
'use strict'
// Match mode: a recorded hardcorepvp match in, a narrated film out.
// Separate from bin/mcmovie.js (staged movies); shares the renderer, voice
// client and assembler. The narration plan (doc.json) is written by the LLM
// operator from digest.md (see prompts/match.md).
const path = require('path')
const fs = require('fs')
const U = require('../lib/util')
const R = require('../lib/match/recording')
const formats = require('../lib/formats')

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

const HELP = `mcmatch - a recorded match in, a narrated film out

  list                          recordings waiting in the plugin's recordings folder
  import [id|latest] [slug] [--format short|long]
                                make projects/<slug>/ with digest.md + digest.json, sync skins;
                                format defaults to vertical short, regardless of match length
  * write doc.json              the narration plan (prompts/match.md), from digest.md
  check <slug>                  validate doc.json against the recording
  build <slug>                  doc.json + recording -> replays, timeline.json, voice.json
  make <slug> [--mock-voice] [--size 1920x1080] [--fps 30] [--keep-recording]
                                build -> voice -> render -> assemble, then DELETE the recording
  voice <slug> [--mock-voice]   only speak the lines (GPU; safe during a live match)
  finish <slug>                 only render + assemble + delete the recording (CPU heavy)
  cleanup <slug>                delete the recording a project points at

Recordings folder: ${R.root()}
(override with MCMOVIE_RECORDINGS). Rendering needs xvfb-run on Linux.
`

function recordingOf (dir) {
  const f = path.join(dir, 'recording.txt')
  if (!U.exists(f)) throw new Error('project has no recording.txt; run: mcmatch import')
  return fs.readFileSync(f, 'utf8').trim()
}

function ensureDisplay () {
  if (process.platform === 'linux' && !process.env.DISPLAY) throw new Error('rendering needs an X display: run under  xvfb-run -a -s "-screen 0 1920x1080x24"')
}

// Film the project's cuts. With the studio set up (lib/studio), the match is replayed live
// in its own world on a private copy of the game and filmed by the real Minecraft client.
// A take that fails is tried again (a hung login, a client that did not come up): Tabor's
// rule is that a film drawn by the offline renderer never goes out by accident, so there is
// no quiet fallback. The offline renderer only runs when asked for: --offline (skip the
// studio) or --offline-fallback (use it if the studio keeps failing), and what it makes is
// refused by the upload check (lib/publish/verify.js) unless that is switched off too.
const TAKES = 3
async function film (dir, common, args) {
  const studio = require('../lib/studio/server')
  const capture = require('../lib/capture/client')
  if (!args.offline) {
    if (!(capture.config().enabled && studio.available() && capture.available())) {
      if (!args['offline-fallback']) throw new Error('the studio or the filming client is not set up (studio/, capture/); pass --offline to draw this film with the offline renderer instead')
    } else {
      let last = null
      for (let take = 1; take <= TAKES; take++) {
        try {
          let regionDir = null
          try { regionDir = path.join(R.resolve(recordingOf(dir)), 'region') } catch { /* recording gone */ }
          const r = await require('../lib/studio/perform').perform(dir, { ...common, regionDir, keepWorld: !!args['keep-world'], scene: args.scene, verbose: !!args.verbose })
          U.log('match', `filmed ${r.clips} clips in the studio with the real client`)
          return
        } catch (e) {
          last = e
          U.log('match', `studio filming failed (${e.message})${take < TAKES ? `; take ${take + 1} of ${TAKES}` : ''}`)
          try { await capture.stop() } catch { /* not running */ }
          try { await studio.stopRunning() } catch { /* not running */ }
          await U.sleep(5000)
        }
      }
      if (!args['offline-fallback']) throw new Error(`the real-client take failed ${TAKES} times (${last.message}); no film was made. Fix the studio and run finish again, or pass --offline`)
      U.log('match', 'using the offline renderer (--offline-fallback)')
    }
  }
  ensureDisplay()
  await require('../lib/render/render').render(dir, common)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  const size = args.size ? args.size.split('x').map(Number) : null
  const common = { width: size ? size[0] : undefined, height: size ? size[1] : undefined, fps: args.fps ? Number(args.fps) : undefined }

  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h':
      console.log(HELP); return

    case 'list': {
      const all = R.list()
      if (!all.length) { console.log(`no recordings in ${R.root()}`); return }
      for (const r of all) console.log(`${r.id}  ${r.ready ? 'ready     ' : (r.complete ? 'no map yet' : 'incomplete')}  ${String(r.players).padStart(2)} players  ${Math.floor(r.seconds / 60)}m${String(r.seconds % 60).padStart(2, '0')}s  winner ${r.winner || '-'}`)
      return
    }

    case 'import': {
      const recDir = R.resolve(args._[1] || 'latest')
      const rec = R.load(recDir)
      if (!rec.meta.complete) throw new Error('that recording never finished')
      if (!U.exists(rec.regionDir)) throw new Error('the map has not been moved into the recording yet (it happens when the server next boots)')
      const slug = args._[2] || ('match-' + rec.meta.id)
      const dir = U.projectDir(slug)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'recording.txt'), recDir + '\n')
      const fmt = formats.writeProject(dir, args.format || formats.forMatch(rec.meta.ticks / 20).id, args.format ? 'forced' : 'short-form match edit')
      const d = require('../lib/match/digest').write(rec, dir, fmt)
      console.log(`format: ${fmt.id} (${fmt.label})`)
      const sk = await require('../lib/skins').sync(rec.players.filter(p => !p.anon).map(p => ({ name: p.name, uuid: p.uuid })), { source: 'match' })
      console.log(`project ${slug}: ${d.players.length} players, ${Math.floor(d.duration_sec / 60)}m${d.duration_sec % 60}s, winner ${d.winner || 'nobody'}; ${sk.length} skins ready`)
      console.log(`read projects/${slug}/digest.md, then write projects/${slug}/doc.json (prompts/match.md)`)
      return
    }

    case 'check': {
      const dir = U.projectDir(args._[1])
      const rec = R.load(recordingOf(dir))
      const r = require('../lib/match/build').check(U.readJson(path.join(dir, 'doc.json')), rec, formats.ofProject(dir, args.format).id)
      for (const e of r.errors) console.log('error: ' + e)
      for (const w of r.warnings) console.log('warn:  ' + w)
      console.log(r.errors.length ? 'FAIL' : `OK (${(r.video_sec || 0).toFixed(0)}s of film)`)
      if (r.errors.length) process.exitCode = 1
      return
    }

    case 'build': {
      const dir = U.projectDir(args._[1])
      const r = require('../lib/match/build').build(dir, { fps: common.fps, fresh: !!args.fresh })
      for (const e of r.errors) console.log('error: ' + e)
      for (const w of r.warnings) console.log('warn:  ' + w)
      if (!r.ok) { process.exitCode = 1; return }
      console.log(`built ${r.scenes} segments, ${r.shots} shots, ${r.lines} narration lines, ${r.video_sec.toFixed(0)}s of film`)
      return
    }

    case 'make': {
      const dir = U.projectDir(args._[1])

      const sz = formats.sizeFor(dir, args)
      Object.assign(common, { width: sz.width, height: sz.height, fps: sz.fps })
      U.log('match', `format ${sz.format.id}: ${sz.width}x${sz.height}@${sz.fps}`)
      const r = require('../lib/match/build').build(dir, { fps: common.fps })
      for (const w of r.warnings) U.log('match', 'warn: ' + w)
      if (!r.ok) { for (const e of r.errors) console.log('error: ' + e); throw new Error('doc.json has errors') }
      U.log('match', `built ${r.scenes} segments, ${r.video_sec.toFixed(0)}s of film`)
      await require('../lib/skins').sync(r.players, { source: 'match' })
      const vc = require('../lib/voice/client')
      await vc.castVoices(dir, { mock: !!args['mock-voice'], url: args.url })
      await vc.voice(dir, { mock: !!args['mock-voice'], url: args.url })
      await film(dir, common, args)
      const edl = require('../lib/assemble/edl').build(dir, common)
      for (const w of edl.warnings) U.log('match', 'warn: ' + w)
      const out = await require('../lib/assemble/ffmpeg').assemble(dir, { preset: args.preset, crf: args.crf })
      if (!U.exists(out) || fs.statSync(out).size < 10000) throw new Error('final.mp4 was not written; the recording is kept')
      console.log('FINAL ' + out)
      if (args['keep-recording']) console.log('recording kept (--keep-recording)')
      else console.log('deleted recording ' + R.remove(recordingOf(dir)))
      return
    }

    case 'voice': {
      const dir = U.projectDir(args._[1])
      const vc = require('../lib/voice/client')
      await vc.castVoices(dir, { mock: !!args['mock-voice'], url: args.url })
      await vc.voice(dir, { mock: !!args['mock-voice'], force: !!args.force, url: args.url })
      return
    }

    // render + assemble + delete the recording: the CPU-heavy half of `make`
    case 'finish': {
      const dir = U.projectDir(args._[1])

      const sz = formats.sizeFor(dir, args)
      Object.assign(common, { width: sz.width, height: sz.height, fps: sz.fps })
      await film(dir, common, args)
      const edl = require('../lib/assemble/edl').build(dir, common)
      for (const w of edl.warnings) U.log('match', 'warn: ' + w)
      const out = await require('../lib/assemble/ffmpeg').assemble(dir, { preset: args.preset, crf: args.crf })
      if (!U.exists(out) || fs.statSync(out).size < 10000) throw new Error('final.mp4 was not written; the recording is kept')
      console.log('FINAL ' + out)
      if (args['keep-recording']) console.log('recording kept (--keep-recording)')
      else { try { console.log('deleted recording ' + R.remove(recordingOf(dir))) } catch (e) { console.log('recording already gone: ' + e.message) } }
      return
    }

    case 'cleanup': {
      const dir = U.projectDir(args._[1])
      console.log('deleted recording ' + R.remove(recordingOf(dir)))
      return
    }

    default:
      console.log(HELP)
      throw new Error(`unknown command ${cmd}`)
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error('error: ' + (e.stack || e.message)); process.exit(1) })
