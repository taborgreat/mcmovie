'use strict'
// The title and logline of a plan go on YouTube word for word (see
// publish.js), so the plan checkers hold them to the house style. Only what
// a program can judge lives here; the voice is described in prompts/.
const TITLE_MAX = 40
const LOGLINE_MAX = 220

function problems (title, logline) {
  const out = []
  const t = String(title || '').trim(); const l = String(logline || '').trim()
  if (t.length > TITLE_MAX) out.push(`title is ${t.length} characters; keep it to ${TITLE_MAX} or fewer (it is the YouTube title)`)
  if (/[:#]/.test(t)) out.push('title must not contain ":" or "#" (the publisher adds the series prefix and number itself)')
  if (!l) out.push('logline is missing; it is the YouTube description (one or two plain sentences about what happened)')
  if (l.length > LOGLINE_MAX) out.push(`logline is ${l.length} characters; keep it to ${LOGLINE_MAX} or fewer (one or two sentences)`)
  if (/[–—;]/.test(t + l)) out.push('title and logline must not use dashes or semicolons; write short plain sentences')
  return out
}

module.exports = { problems, TITLE_MAX, LOGLINE_MAX }
