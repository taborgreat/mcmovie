'use strict'
// Instagram Reels through the Instagram API with Instagram Login (a Creator or Business
// account and a Meta app with "API setup with Instagram Login"). Checked against Meta's docs
// on 2026-10-06:
//   consent    https://www.instagram.com/oauth/authorize  (scopes below) -> ?code= (1 hour, once)
//   tokens     POST https://api.instagram.com/oauth/access_token          short-lived
//              GET  https://graph.instagram.com/access_token              -> long-lived, 60 days
//              GET  https://graph.instagram.com/refresh_access_token      (token at least a day old)
//   publish    POST /<ig-id>/media  media_type=REELS, video_url, caption  -> a container
//              GET  /<container>?fields=status_code   IN_PROGRESS -> FINISHED | ERROR | EXPIRED
//              POST /<ig-id>/media_publish  creation_id=<container>       -> the media id
// Instagram fetches the video itself from video_url, so it must be public (lib/publish/hosting.js).
// 100 API posts per account per 24 hours.
const U = require('../util')
const { call, why } = require('./http')

// basic + publish for the Reels; manage_insights for the stats panel (add it on the app's
// permissions page first, or the consent screen refuses the whole login)
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights']
const GRAPH = 'https://graph.instagram.com'
const REFRESH_AFTER_DAYS = 7 // a long-lived token lasts 60 days; renewing weekly keeps it far from the edge

function configured (c) { return !!(c && c.app_id && c.app_secret && c.redirect_uri) }
function ready (c) { return !!(c && c.enabled !== false && c.access_token && c.ig_user_id) }
function base (c) { return c.api_version ? `${GRAPH}/${c.api_version}` : GRAPH }

function authUrl (c, state) {
  const u = new URL('https://www.instagram.com/oauth/authorize')
  u.searchParams.set('client_id', c.app_id)
  u.searchParams.set('redirect_uri', c.redirect_uri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', SCOPES.join(','))
  if (state) u.searchParams.set('state', state)
  return u.toString()
}

// The code from the consent redirect -> a 60-day token and the account's id. Returns the
// fields to store under "instagram" in config/publish.json.
async function exchangeCode (c, code) {
  const short = await call('POST', 'https://api.instagram.com/oauth/access_token', { form: { client_id: c.app_id, client_secret: c.app_secret, grant_type: 'authorization_code', redirect_uri: c.redirect_uri, code: String(code).replace(/#_$/, '') } })
  // older responses wrap it in { data: [ ... ] }
  const s = short.data && Array.isArray(short.data.data) ? short.data.data[0] : short.data
  if (short.status !== 200 || !s || !s.access_token) throw new Error('Instagram did not accept the code (' + why(short) + ')')
  const long = await call('GET', `${GRAPH}/access_token`, { query: { grant_type: 'ig_exchange_token', client_secret: c.app_secret, access_token: s.access_token } })
  if (long.status !== 200 || !long.data || !long.data.access_token) throw new Error('Instagram did not give a long-lived token (' + why(long) + ')')
  const me = await call('GET', `${base(c)}/me`, { query: { fields: 'user_id,username,profile_picture_url', access_token: long.data.access_token } })
  if (me.status !== 200 || !me.data) throw new Error('Instagram token works but the account could not be read (' + why(me) + ')')
  const now = Date.now()
  return {
    access_token: long.data.access_token, token_expires: new Date(now + (long.data.expires_in || 5184000) * 1000).toISOString(), token_refreshed: new Date(now).toISOString(),
    ig_user_id: String(me.data.user_id || me.data.id || s.user_id), username: me.data.username || c.username || '', avatar_url: me.data.profile_picture_url || ''
  }
}

// Renew the token when it is due. `save(fields)` stores what changed. Returns the token to use.
async function freshToken (c, save = () => {}) {
  if (!c.access_token) throw new Error('Instagram is not connected: run  node bin/mcpublish.js auth instagram')
  const refreshed = Date.parse(c.token_refreshed || 0) || 0
  const expires = Date.parse(c.token_expires || 0) || 0
  if (expires && expires < Date.now()) throw new Error('the Instagram token has expired (nothing was posted for 60 days): run  node bin/mcpublish.js auth instagram')
  if (Date.now() - refreshed < REFRESH_AFTER_DAYS * 86400000) return c.access_token
  const r = await call('GET', `${GRAPH}/refresh_access_token`, { query: { grant_type: 'ig_refresh_token', access_token: c.access_token } })
  if (r.status !== 200 || !r.data || !r.data.access_token) return c.access_token // still valid; try again next time
  const now = Date.now()
  const fields = { access_token: r.data.access_token, token_expires: new Date(now + (r.data.expires_in || 5184000) * 1000).toISOString(), token_refreshed: new Date(now).toISOString() }
  Object.assign(c, fields); save(fields)
  return c.access_token
}

// Post one Reel. opts: { video_url, caption, log }. Returns { id, url }.
async function publishReel (c, opts, save) {
  const log = opts.log || (() => {})
  const token = await freshToken(c, save)
  const auth = { authorization: 'Bearer ' + token }
  const made = await call('POST', `${base(c)}/${c.ig_user_id}/media`, { headers: auth, form: { media_type: 'REELS', video_url: opts.video_url, caption: String(opts.caption || '').slice(0, 2200), share_to_feed: c.share_to_feed === false ? 'false' : 'true' } })
  if (made.status !== 200 || !made.data || !made.data.id) throw new Error('Instagram would not take the video (' + why(made) + ')')
  const container = made.data.id
  log(`instagram: container ${container} created, waiting for Instagram to fetch and process the clip`)
  // Meta suggests asking about once a minute for up to five; a longer clip can take more
  const until = Date.now() + (c.wait_minutes || 10) * 60000
  let state = 'IN_PROGRESS'; let detail = ''
  while (Date.now() < until) {
    await U.sleep(20000)
    const s = await call('GET', `${base(c)}/${container}`, { headers: auth, query: { fields: 'status_code,status' } })
    if (s.status !== 200 || !s.data) continue
    state = s.data.status_code || state; detail = s.data.status || ''
    if (state !== 'IN_PROGRESS') break
  }
  if (state !== 'FINISHED') throw new Error(`Instagram did not finish processing the clip (${state}${detail ? ': ' + detail : ''})`)
  const pub = await call('POST', `${base(c)}/${c.ig_user_id}/media_publish`, { headers: auth, form: { creation_id: container } })
  if (pub.status !== 200 || !pub.data || !pub.data.id) throw new Error('Instagram processed the clip but did not publish it (' + why(pub) + ')')
  const id = pub.data.id
  let url = null
  try {
    const p = await call('GET', `${base(c)}/${id}`, { headers: auth, query: { fields: 'permalink' } })
    if (p.status === 200 && p.data && p.data.permalink) url = p.data.permalink
  } catch { /* the post is up; the link is a nicety */ }
  return { id, url }
}

module.exports = { SCOPES, configured, ready, authUrl, exchangeCode, freshToken, publishReel }
