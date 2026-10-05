'use strict'
// Runs the planning LLM headless (Claude Code by default). The prompt comes
// from a template in prompts/auto/ with {{placeholders}} filled in. The LLM is
// only asked to read and write plan files; validation and every command are
// run by the daemon, which feeds errors back for another round.
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const U = require('../util')

function fill (templateName, vars) {
  let text = fs.readFileSync(path.join(U.ROOT, 'prompts', 'auto', templateName), 'utf8')
  for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(String(v))
  return text
}

function run (cfg, prompt, logFile) {
  return new Promise((resolve, reject) => {
    const args = [...cfg.llm.args]
    if (cfg.llm.model) args.push('--model', cfg.llm.model)
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    const log = fs.createWriteStream(logFile, { flags: 'a' })
    log.write(`\n===== ${new Date().toISOString()} prompt =====\n${prompt}\n===== output =====\n`)
    const child = spawn(cfg.llm.command, args, { cwd: U.ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    let out = ''
    child.stdout.on('data', d => { out += d; log.write(d) })
    child.stderr.on('data', d => log.write(d))
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`LLM timed out after ${cfg.llm.timeout_minutes} minutes`)) }, cfg.llm.timeout_minutes * 60000)
    child.on('error', e => { clearTimeout(timer); reject(new Error(`could not run ${cfg.llm.command}: ${e.message}`)) })
    child.on('exit', code => { clearTimeout(timer); log.end(); code === 0 ? resolve(out) : reject(new Error(`LLM exited with code ${code}; see ${logFile}`)) })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

module.exports = { run, fill }
