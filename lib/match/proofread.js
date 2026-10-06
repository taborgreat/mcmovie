'use strict'
// Cheap, deterministic checks before audio/captions; not a replacement for an
// editorial reading. Recorded chat and exact usernames are intentionally exempt.
const corrections = { teh: 'the', recieve: 'receive', recieved: 'received', definately: 'definitely', seperate: 'separate', seperated: 'separated', alot: 'a lot', becuase: 'because', thier: 'their', untill: 'until', occured: 'occurred', occuring: 'occurring', succesful: 'successful', wierd: 'weird', fourty: 'forty', maths: 'math' }
function problems (doc, names = []) {
  const protectedNames = new Set(names.map(n => String(n).replace(/^\./, '').toLowerCase()))
  const errors = []
  for (const seg of doc.segments || []) for (const line of seg.narration || []) {
    if (line.chat) continue
    const text = String(line.text || '')
    for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9_]*\b/g)) {
      const word = match[0].toLowerCase()
      if (corrections[word] && !protectedNames.has(word)) errors.push(`Proofread ${seg.id}.${line.id}: "${match[0]}" → "${corrections[word]}" (American English narration; keep original usernames).`)
    }
    for (const m of text.matchAll(/\b(the|a|an|and|to|of|is)\s+\1\b/gi)) errors.push(`Proofread ${seg.id}.${line.id}: repeated word "${m[0]}".`)
    if (/\b(could|would|should) of\b/i.test(text)) errors.push(`Proofread ${seg.id}.${line.id}: use "could/would/should have", not "of".`)
  }
  return errors
}
module.exports = { problems }
