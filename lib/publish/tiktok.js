'use strict'
// TikTok through the Content Posting API (a developer app with Login Kit and Content Posting
// API). Checked against TikTok's docs on 2026-10-06:
//   consent    https://www.tiktok.com/v2/auth/authorize/  client_key, scope, response_type=code,
//              redirect_uri (https, registered, no parameters), state  -> ?code=
//   tokens     POST https://open.tiktokapis.com/v2/oauth/token/   (form)  access token 24 hours,
//              refresh token 365 days; a refresh may hand back a NEW refresh token
//   inbox      POST /v2/post/publish/inbox/video/init/   scope video.upload
//              { source_info: { source: "PULL_FROM_URL", video_url } }  -> publish_id
//              The clip lands in the account's drafts; a person adds the caption and posts it.
//              No audit needed. At most 5 pending drafts per 24 hours.
//   direct     POST /v2/post/publish/creator_info/query/ then /v2/post/publish/video/init/
//              scope video.publish, with post_info (title = the caption, privacy_level, ...).
//              Until the app passes TikTok's audit every direct post is private (SELF_ONLY).
//   status     POST /v2/post/publish/status/fetch/ { publish_id }
//              PROCESSING_DOWNLOAD -> SEND_TO_USER_INBOX (inbox) | PUBLISH_COMPLETE | FAILED
// TikTok fetches the video itself (PULL_FROM_URL): the address must be https, must not
// redirect, and its domain or URL prefix must be verified for the app in TikTok's developer
// portal. "mode" in the config picks inbox (the default) or direct.
const U = require('../util')
const { call, why } = require('./http')

const API = 'https://open.tiktokapis.com'
const TOKEN_URL = `${API}/v2/oauth/token/`

function mode (c) { return c && c.mode === 'direct' ? 'direct' : 'inbox' }
// user.info.basic: the account's name and avatar, shown on the admin page so it is plain which
// account the clips go to
function scopes (c) { return mode(c) === 'direct' ? ['user.info.basic', 'video.upload', 'video.publish'] : ['user.info.basic', 'video.upload'] }
function configured (c) { return !!(c && c.client_key && c.client_secret && c.redirect_uri) }
function ready (c) { return !!(c && c.enabled !== false && c.refresh_token) }

function authUrl (c, state) {
  const u = new URL('https://www.tiktok.com/v2/auth/authorize/')
  u.searchParams.set('client_key', c.client_key)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', scopes(c).join(','))
  u.searchParams.set('redirect_uri', c.redirect_uri)
  u.searchParams.set('state', state || 'mcmovie')
  return u.toString()
}

function tokenFields (d) {
  const now = Date.now()
  return {
    access_token: d.access_token, access_expires: new Date(now + (d.expires_in || 86400) * 1000).toISOString(),
    refresh_token: d.refresh_token, refresh_expires: new Date(now + (d.refresh_expires_in || 31536000) * 1000).toISOString(),
    open_id: d.open_id, scope: d.scope
  }
}

// The connected account's name and picture (scope user.info.basic).
async function userInfo (accessToken) {
  const r = await call('GET', `${API}/v2/user/info/`, { headers: { authorization: 'Bearer ' + accessToken }, query: { fields: 'open_id,display_name,avatar_url,username' } })
  const u = ok(r) && r.data.data && r.data.data.user ? r.data.data.user : null
  if (!u) throw new Error('TikTok would not say which account this is (' + why(r) + ')')
  return { display_name: u.display_name || '', avatar_url: u.avatar_url || '', username: u.username || '' }
}

async function exchangeCode (c, code) {
  const r = await call('POST', TOKEN_URL, { form: { client_key: c.client_key, client_secret: c.client_secret, code: decodeURIComponent(String(code)), grant_type: 'authorization_code', redirect_uri: c.redirect_uri } })
  if (r.status !== 200 || !r.data || !r.data.access_token) throw new Error('TikTok did not accept the code (' + why(r) + ')')
  const fields = tokenFields(r.data)
  try { Object.assign(fields, await userInfo(fields.access_token)) } catch { /* the login stands; the name is a nicety */ }
  if (!fields.username && c.username) fields.username = c.username
  return fields
}

// An access token lasts a day, so nearly every upload starts by getting a new one.
async function freshToken (c, save = () => {}) {
  if (!c.refresh_token) throw new Error('TikTok is not connected: run  node bin/mcpublish.js auth tiktok')
  if (c.access_token && Date.parse(c.access_expires || 0) - Date.now() > 10 * 60000) return c.access_token
  const r = await call('POST', TOKEN_URL, { form: { client_key: c.client_key, client_secret: c.client_secret, grant_type: 'refresh_token', refresh_token: c.refresh_token } })
  if (r.status !== 200 || !r.data || !r.data.access_token) throw new Error('TikTok would not renew the login (' + why(r) + '); run  node bin/mcpublish.js auth tiktok')
  const fields = tokenFields(r.data)
  if (!fields.refresh_token) delete fields.refresh_token
  Object.assign(c, fields); save(fields)
  return c.access_token
}

function ok (r) { return r.status === 200 && r.data && (!r.data.error || r.data.error.code === 'ok') }

// Send one clip. opts: { video_url, caption, log }. Inbox mode returns once the clip is in the
// account's drafts ({ status: 'inbox' }); direct mode once it is posted ({ status: 'posted' }).
async function upload (c, opts, save) {
  const log = opts.log || (() => {})
  const token = await freshToken(c, save)
  const headers = { authorization: 'Bearer ' + token }
  const direct = mode(c) === 'direct'
  let init
  if (direct) {
    // required before every direct post: what this account may do right now
    const info = await call('POST', `${API}/v2/post/publish/creator_info/query/`, { headers, json: {} })
    if (!ok(info)) throw new Error('TikTok would not describe the account (' + why(info) + ')')
    const allowed = (info.data.data && info.data.data.privacy_level_options) || []
    const want = c.privacy_level || 'PUBLIC_TO_EVERYONE'
    const privacy = allowed.includes(want) ? want : (allowed.includes('SELF_ONLY') ? 'SELF_ONLY' : allowed[0])
    if (!privacy) throw new Error('TikTok lists no privacy level this account may post with')
    if (privacy !== want) log(`tiktok: this app may not post as ${want} yet (not audited); posting as ${privacy}`)
    init = await call('POST', `${API}/v2/post/publish/video/init/`, {
      headers,
      json: {
        post_info: { title: String(opts.caption || '').slice(0, 2200), privacy_level: privacy, disable_duet: !!c.disable_duet, disable_comment: !!c.disable_comment, disable_stitch: !!c.disable_stitch, video_cover_timestamp_ms: c.cover_ms || 1000, brand_content_toggle: false, is_aigc: c.is_aigc !== false },
        source_info: { source: 'PULL_FROM_URL', video_url: opts.video_url }
      }
    })
  } else {
    init = await call('POST', `${API}/v2/post/publish/inbox/video/init/`, { headers, json: { source_info: { source: 'PULL_FROM_URL', video_url: opts.video_url } } })
  }
  if (!ok(init) || !init.data.data || !init.data.data.publish_id) throw new Error('TikTok would not take the video (' + why(init) + ')')
  const publishId = init.data.data.publish_id
  log(`tiktok: ${direct ? 'direct post' : 'draft'} ${publishId} started, waiting for TikTok to fetch the clip`)
  const until = Date.now() + (c.wait_minutes || 10) * 60000
  let state = 'PROCESSING_DOWNLOAD'; let fail = ''; let postId = null
  while (Date.now() < until) {
    await U.sleep(10000)
    const s = await call('POST', `${API}/v2/post/publish/status/fetch/`, { headers, json: { publish_id: publishId } })
    if (!ok(s) || !s.data.data) continue
    state = s.data.data.status || state; fail = s.data.data.fail_reason || ''
    const ids = s.data.data.publicaly_available_post_id // TikTok's own spelling
    if (Array.isArray(ids) && ids.length) postId = String(ids[0])
    if (state === 'FAILED' || state === 'PUBLISH_COMPLETE' || (!direct && state === 'SEND_TO_USER_INBOX')) break
  }
  if (state === 'FAILED') throw new Error(`TikTok could not use the clip (${fail || 'no reason given'})`)
  if (state === 'PROCESSING_DOWNLOAD' || state === 'PROCESSING_UPLOAD') throw new Error('TikTok was still fetching the clip when we stopped waiting')
  const url = postId && c.username ? `https://www.tiktok.com/@${String(c.username).replace(/^@/, '')}/video/${postId}` : null
  return { publish_id: publishId, status: state === 'PUBLISH_COMPLETE' ? 'posted' : 'inbox', post_id: postId, url }
}

// Where a draft stands now: still in the inbox, posted by hand (PUBLISH_COMPLETE, with the
// post id once TikTok has approved it for public viewing), or failed.
async function checkStatus (c, publishId, save) {
  const token = await freshToken(c, save)
  const s = await call('POST', `${API}/v2/post/publish/status/fetch/`, { headers: { authorization: 'Bearer ' + token }, json: { publish_id: publishId } })
  if (!ok(s) || !s.data.data) throw new Error('TikTok would not say (' + why(s) + ')')
  const d = s.data.data
  const ids = d.publicaly_available_post_id
  const postId = Array.isArray(ids) && ids.length ? String(ids[0]) : null
  return { state: d.status, fail: d.fail_reason || '', post_id: postId, url: postId && c.username ? `https://www.tiktok.com/@${String(c.username).replace(/^@/, '')}/video/${postId}` : null }
}

module.exports = { mode, scopes, configured, ready, authUrl, exchangeCode, userInfo, freshToken, upload, checkStatus }
