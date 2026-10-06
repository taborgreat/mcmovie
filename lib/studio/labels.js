'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const studio = require('./server')
function install () {
  const source = path.join(__dirname, 'labels')
  const target = path.join(studio.DIR, 'plugins', 'FilmLabels.jar')
  const stamp = target + '.sha256'
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(source, 'FilmLabels.java'))).update(fs.readFileSync(path.join(source, 'plugin.yml'))).digest('hex')
  if (fs.existsSync(target) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === digest) return
  const jars = []
  function walk (dir) { for (const file of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, file.name); if (file.isDirectory()) walk(full); else if (file.name.endsWith('.jar')) jars.push(full) } }
  walk(path.join(studio.DIR, 'libraries'))
  const work = path.join(studio.DIR, 'label-build')
  fs.mkdirSync(work, { recursive: true })
  const bin = path.dirname(studio.config().java)
  const tool = name => bin === '.' ? name : path.join(bin, name)
  execFileSync(tool('javac'), ['-encoding', 'UTF-8', '-cp', jars.join(path.delimiter), '-d', work, path.join(source, 'FilmLabels.java')], { stdio: 'pipe' })
  fs.copyFileSync(path.join(source, 'plugin.yml'), path.join(work, 'plugin.yml'))
  execFileSync(tool('jar'), ['--create', '--file', target, '-C', work, '.'], { stdio: 'pipe' })
  fs.writeFileSync(stamp, digest)
}
module.exports = { install }
