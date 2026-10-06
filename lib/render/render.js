'use strict'
// Offline renderer: replay + camera paths -> one clip per cut, frame-accurate.
// Uses prismarine-viewer's three.js world/entity meshes drawn into a
// headless-gl canvas; pixels are piped to ffmpeg as raw video. Because this
// runs from the replay (not live), any frame rate and resolution work, and a
// single shot can be re-rendered without re-shooting.
//
// Linux needs an X display for headless-gl: run under `xvfb-run -a`.
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const U = require('../util')
const { CameraPath, EYE } = require('../camera')
const { readReplay, replayPath, statesAt, actorResolver } = require('../mc/replay')
const skins = require('../skins')

global.THREE = require('three')
global.Worker = require('worker_threads').Worker
const THREE = global.THREE
const { createCanvas, loadImage } = require('node-canvas-webgl/lib')
const { Viewer, WorldView, Entity } = require('prismarine-viewer/viewer')
const entityDefs = require('prismarine-viewer/viewer/lib/entity/entities.json')

// Slim-arm skins ("Alex" model) have arms 3 pixels wide. Drawn on the 4-pixel model they
// show a transparent strip, so they get their own geometry: same bones, narrower arm cubes.
if (!entityDefs.player_slim) {
  const slim = JSON.parse(JSON.stringify(entityDefs.player))
  for (const b of slim.geometry.default.bones) {
    if (b.name === 'leftArm' || b.name === 'leftSleeve') for (const c of b.cubes || []) { c.size = [3, 12, 4]; c.origin = [4, 12, -2] }
    if (b.name === 'rightArm' || b.name === 'rightSleeve') for (const c of b.cubes || []) { c.size = [3, 12, 4]; c.origin = [-7, 12, -2] }
  }
  entityDefs.player_slim = slim
}
const PLAYER_BONE_DEFS = entityDefs.player.geometry.default.bones
const PLAYER_BONES = PLAYER_BONE_DEFS.map(b => b.name)
// The viewer parents bones but gives each its absolute pivot as local position,
// so a bone's rest origin sits at the sum of its ancestors' pivots plus its own.
// To rotate a limb about its real pivot we rotate about a point expressed in the
// bone's local frame: minus the sum of the ancestors' pivots.
const PLAYER_PIVOT_LOCAL = {}
for (const b of PLAYER_BONE_DEFS) {
  const sum = [0, 0, 0]
  let parent = b.parent
  while (parent) {
    const pb = PLAYER_BONE_DEFS.find(x => x.name === parent)
    if (!pb) break
    const pv = pb.pivot || [0, 0, 0]
    sum[0] += pv[0]; sum[1] += pv[1]; sum[2] += pv[2]
    parent = pb.parent
  }
  PLAYER_PIVOT_LOCAL[b.name] = sum.map(v => -v)
}
const SKY = {
  day: { bg: 0x87ceeb, ambient: 0xcccccc, sun: 0.55 },
  sunset: { bg: 0xf0a060, ambient: 0xb8a090, sun: 0.45 },
  night: { bg: 0x101830, ambient: 0x505870, sun: 0.15 }
}

function skyFor (timeOfDay) {
  const t = ((timeOfDay % 24000) + 24000) % 24000
  if (t >= 11500 && t < 13500) return SKY.sunset
  if (t >= 13500 && t < 22500) return SKY.night
  if (t >= 22500 || t < 500) return SKY.sunset
  return SKY.day
}

// Held items are the game's own: the item's 16x16 sprite, each opaque pixel extruded into a
// little block (how Minecraft itself shows a held item), gripped at the handle with the tip
// pointing forward and up. Blocks are held as small textured cubes. Units are model pixels.
const TEXTURE_ROOT = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public', 'textures')
const RIGHT_ARM_ORIGIN = (() => {
  // bone-local position of the right hand: model position minus the bone's rest origin
  const arm = PLAYER_BONE_DEFS.find(b => b.name === 'rightArm')
  const loc = PLAYER_PIVOT_LOCAL.rightArm
  const w = [arm.pivot[0] - loc[0], arm.pivot[1] - loc[1], arm.pivot[2] - loc[2]]
  return [-6 - w[0], 12.5 - w[1], 0 - w[2]]
})()
const ITEM_ALIASES = { compass: 'compass_00', clock: 'clock_00', crossbow: 'crossbow_standby', recovery_compass: 'recovery_compass_00' }
const HANDHELD = /(_sword|_axe|_pickaxe|_shovel|_hoe)$|^(stick|fishing_rod|bow|trident|mace|blaze_rod|bone|carrot_on_a_stick)$/
const itemCache = new Map() // name -> { geometry } | { texture } | null

function textureFile (version, kind, name) {
  for (const v of [version, '1.21.4', '1.21.1', '1.20.1']) {
    const f = path.join(TEXTURE_ROOT, v, kind, name + '.png')
    if (fs.existsSync(f)) return f
  }
  return null
}

// Read an item or block texture once and turn it into something holdable.
async function loadItem (version, item) {
  const name = String(item).replace('minecraft:', '')
  if (itemCache.has(name)) return itemCache.get(name)
  let entry = null
  try {
    const itemFile = textureFile(version, 'items', ITEM_ALIASES[name] || name) || textureFile(version, 'item', ITEM_ALIASES[name] || name)
    if (itemFile) {
      const img = await loadImage(itemFile)
      const size = Math.min(img.width, 16)
      const cv = require('canvas').createCanvas(size, size)
      const ctx = cv.getContext('2d')
      ctx.drawImage(img, 0, 0, size, size, 0, 0, size, size) // animated strips: first frame
      const px = ctx.getImageData(0, 0, size, size).data
      const pos = []; const col = []; const idx = []; const nor = []
      const unit = new THREE.BoxGeometry(1, 1, 1)
      const up = unit.attributes.position.array; const un = unit.attributes.normal.array; const ui = unit.index.array
      let n = 0
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const k = (r * size + c) * 4
          if (px[k + 3] < 128) continue
          for (let v = 0; v < up.length; v += 3) {
            // thickness along x, sprite columns run forward (-z), rows run up (+y)
            pos.push(up[v], up[v + 1] + (size - 1 - r), up[v + 2] - c)
            nor.push(un[v], un[v + 1], un[v + 2])
            col.push(px[k] / 255, px[k + 1] / 255, px[k + 2] / 255)
          }
          for (const i of ui) idx.push(i + n)
          n += up.length / 3
        }
      }
      if (n) {
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
        g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
        g.setIndex(idx)
        entry = { geometry: g, handheld: HANDHELD.test(name) }
      }
    }
    if (!entry) {
      const blockFile = textureFile(version, 'blocks', name) || textureFile(version, 'blocks', name + '_side') || textureFile(version, 'blocks', name + '_front') || textureFile(version, 'block', name)
      if (blockFile) {
        const tex = new THREE.CanvasTexture(await loadImage(blockFile))
        tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter
        entry = { texture: tex }
      }
    }
  } catch { entry = null }
  itemCache.set(name, entry)
  return entry
}

function heldMesh (item) {
  if (!item) return null
  const name = String(item).replace('minecraft:', '')
  const entry = itemCache.get(name)
  const group = new THREE.Group()
  group.position.set(RIGHT_ARM_ORIGIN[0], RIGHT_ARM_ORIGIN[1], RIGHT_ARM_ORIGIN[2])
  if (entry && entry.geometry) {
    const mesh = new THREE.Mesh(entry.geometry, new THREE.MeshLambertMaterial({ vertexColors: true }))
    // grip: a tool is held by the bottom-left of its sprite, anything else by its middle
    const scale = entry.handheld ? 0.85 : 0.5
    const grip = entry.handheld ? [3, 3] : [8, 5] // (column, row from the bottom) in sprite pixels
    mesh.scale.set(scale, scale, scale)
    mesh.position.set(0, -grip[1] * scale, grip[0] * scale - 1)
    group.add(mesh)
    if (entry.handheld) group.rotation.x = 0.15
  } else if (entry && entry.texture) {
    const cube = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), new THREE.MeshLambertMaterial({ map: entry.texture }))
    cube.position.set(0, 0, -3.5)
    group.add(cube)
  } else {
    // nothing in the texture pack by that name: a plain cube rather than an empty hand
    const cube = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshLambertMaterial({ color: 0xc9a66b }))
    cube.position.set(0, 0, -3)
    group.add(cube)
  }
  return group
}

// Where a point of the player model sits in a bone's own frame (see PLAYER_PIVOT_LOCAL).
function boneLocal (bone, model) {
  const def = PLAYER_BONE_DEFS.find(b => b.name === bone)
  const loc = PLAYER_PIVOT_LOCAL[bone]
  return [model[0] - def.pivot[0] + loc[0], model[1] - def.pivot[1] + loc[1], model[2] - def.pivot[2] + loc[2]]
}

// Armour is drawn as plain coloured plates over the skin: enough to tell an iron kit from
// a diamond one at film distance. worn = "helmet,chestplate,leggings,boots" material names.
const ARMOR_COLORS = { leather: 0x8b5a2b, chainmail: 0x9aa0a6, iron: 0xd8d8d8, golden: 0xf2d43d, diamond: 0x4de0d8, netherite: 0x4a3f45, turtle: 0x3fa650 }
function armorPlates (worn) {
  const [helmet, chest, legs, boots] = String(worn || ',,,').split(',')
  const colorOf = (item) => { const k = Object.keys(ARMOR_COLORS).find(t => String(item).startsWith(t)); return k ? ARMOR_COLORS[k] : 0xbdbdbd }
  const plates = []
  const plate = (bone, size, at, item) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), new THREE.MeshLambertMaterial({ color: colorOf(item) }))
    const p = boneLocal(bone, at)
    m.position.set(p[0], p[1], p[2])
    plates.push({ bone, mesh: m })
  }
  if (helmet) plate('head', [9, 4.6, 9], [0, 30, 0], helmet)
  if (chest) { plate('body', [8.9, 12.4, 4.9], [0, 18, 0], chest); plate('leftArm', [4.9, 5, 4.9], [6, 21.6, 0], chest); plate('rightArm', [4.9, 5, 4.9], [-6, 21.6, 0], chest) }
  if (legs) { plate('leftLeg', [4.5, 7, 4.5], [1.9, 8.6, 0], legs); plate('rightLeg', [4.5, 7, 4.5], [-1.9, 8.6, 0], legs) }
  if (boots) { plate('leftLeg', [4.7, 5, 4.7], [1.9, 2.5, 0], boots); plate('rightLeg', [4.7, 5, 4.7], [-1.9, 2.5, 0], boots) }
  return plates
}

// A floating name with a health bar, so a viewer can tell who is who and how close they
// are to dying. Redrawn only when the health shown changes.
function drawTag (canvas, name, hp) {
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.font = 'bold 34px sans-serif'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.strokeText(name, 128, 26)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(name, 128, 26)
  if (hp !== null && hp !== undefined) {
    const x = 38; const y = 54; const w = 180; const h = 14
    ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(x - 3, y - 3, w + 6, h + 6)
    ctx.fillStyle = '#3a0d0d'; ctx.fillRect(x, y, w, h)
    const frac = Math.max(0, Math.min(1, hp / 20))
    ctx.fillStyle = frac > 0.5 ? '#e23b3b' : (frac > 0.25 ? '#f08a2b' : '#ffd23b')
    ctx.fillRect(x, y, Math.round(w * frac), h)
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    for (let i = 1; i < 10; i++) ctx.fillRect(x + Math.round(w * i / 10) - 1, y, 2, h)
  }
}

// Short-lived particles, positioned analytically from their birth tick so the result does
// not depend on frame rate: hit sparks, the puff and scattered loot of a death, explosion
// debris, a lightning bolt.
class Effects {
  constructor (scene) { this.scene = scene; this.parts = []; this.flashUntil = -1 }

  clear () { for (const p of this.parts) this.scene.remove(p.mesh); this.parts = []; this.flashUntil = -1 }

  _rng (seed) { let h = seed >>> 0; return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

  _add (tick, life, pos, vel, g, size, color, opts = {}) {
    const mat = opts.basic ? new THREE.MeshBasicMaterial({ color, transparent: !!opts.fade, opacity: 1, fog: false }) : new THREE.MeshLambertMaterial({ color })
    const mesh = new THREE.Mesh(opts.geometry || new THREE.BoxGeometry(size, size, size), mat)
    this.scene.add(mesh)
    this.parts.push({ mesh, born: tick, life, p: pos, v: vel, g, floor: opts.floor, grow: opts.grow || 0, fade: !!opts.fade, keep: !!opts.keep })
  }

  burst (kind, at, tick) {
    const r = this._rng(Math.round(tick * 131 + at.x * 17 + at.z * 29) ^ kind.length * 7919)
    const dir = (speed, up = 0) => { const a = r() * Math.PI * 2; const e = r() * 2 - 1; const c = Math.sqrt(1 - e * e); return [Math.cos(a) * c * speed, e * speed + up, Math.sin(a) * c * speed] }
    if (kind === 'hit') {
      for (let i = 0; i < 7; i++) this._add(tick, 8 + r() * 4, [at.x, at.y + 1.1, at.z], dir(0.11, 0.05), -0.012, 0.09, [0xff3b3b, 0xffffff, 0xffd24d][i % 3])
    } else if (kind === 'death') {
      for (let i = 0; i < 16; i++) this._add(tick, 16 + r() * 8, [at.x + (r() - 0.5) * 0.6, at.y + 0.3 + r() * 1.2, at.z + (r() - 0.5) * 0.6], [(r() - 0.5) * 0.04, 0.03 + r() * 0.05, (r() - 0.5) * 0.04], 0, 0.2, i % 2 ? 0xd8d8d8 : 0x9a9a9a)
      for (let i = 0; i < 8; i++) this._add(tick, 70, [at.x, at.y + 0.9, at.z], dir(0.07, 0.17), -0.02, 0.17, [0x8b6a3e, 0xbfc4c9, 0xf2d43d, 0xb5651d, 0x6b6b6b][i % 5], { floor: at.y + 0.09, keep: true })
    } else if (kind === 'explosion') {
      for (let i = 0; i < 40; i++) this._add(tick, 18 + r() * 10, [at.x, at.y + 0.5, at.z], dir(0.22 + r() * 0.2, 0.08), -0.015, 0.22 + r() * 0.2, [0xffa030, 0xffd070, 0x6b6b6b, 0x3a3a3a][i % 4], { floor: at.y - 1 })
      this._add(tick, 8, [at.x, at.y + 0.5, at.z], [0, 0, 0], 0, 1, 0xfff0c0, { basic: true, fade: true, grow: 0.75, geometry: new THREE.SphereGeometry(1.2, 12, 8) })
      for (let i = 0; i < 14; i++) this._add(tick, 30 + r() * 14, [at.x + (r() - 0.5) * 2, at.y + 0.8, at.z + (r() - 0.5) * 2], [(r() - 0.5) * 0.03, 0.05 + r() * 0.05, (r() - 0.5) * 0.03], 0, 0.5 + r() * 0.4, i % 2 ? 0x5a5a5a : 0x8a8a8a) // smoke
      this.flashUntil = tick + 3
    } else if (kind === 'firework') {
      // a round burst in the rocket's own colours, drifting down as it fades
      const palette = (at.colors && at.colors.length ? at.colors : [0xff4040, 0xffd040, 0x40a0ff, 0x60ff80, 0xff60e0])
      const count = 54
      for (let i = 0; i < count; i++) {
        const v = dir(0.28 + r() * 0.06)
        this._add(tick, 26 + r() * 10, [at.x, at.y, at.z], v, -0.006, 0.2, palette[i % palette.length], { basic: true })
      }
      this._add(tick, 4, [at.x, at.y, at.z], [0, 0, 0], 0, 1, 0xffffff, { basic: true, fade: true, grow: 0.5, geometry: new THREE.SphereGeometry(0.8, 10, 6) })
    } else if (kind === 'lightning') {
      // a jagged column: stacked segments, each nudged sideways, with a wider faint glow
      let ox = 0; let oz = 0
      for (let seg = 0; seg < 12; seg++) {
        const y = at.y + 4 + seg * 8
        this._add(tick, 9, [at.x + ox, y, at.z + oz], [0, 0, 0], 0, 1, 0xf4fbff, { basic: true, fade: true, geometry: new THREE.BoxGeometry(0.7, 8.4, 0.7) })
        ox += (r() - 0.5) * 2.2; oz += (r() - 0.5) * 2.2
      }
      this._add(tick, 7, [at.x, at.y + 48, at.z], [0, 0, 0], 0, 1, 0xa8d4ff, { basic: true, fade: true, geometry: new THREE.BoxGeometry(2.6, 96, 2.6) })
      this.parts[this.parts.length - 1].mesh.material.opacity = 0.35
      this.parts[this.parts.length - 1].baseOpacity = 0.35
      for (let i = 0; i < 20; i++) this._add(tick, 12 + r() * 8, [at.x, at.y + 0.3, at.z], dir(0.24, 0.14), -0.02, 0.14, i % 2 ? 0xffffff : 0xfff2a0, { basic: true })
      this.flashUntil = tick + 4
    }
  }

  update (tick) {
    this.parts = this.parts.filter(p => {
      const dt = tick - p.born
      if (dt < 0 || dt > p.life) { this.scene.remove(p.mesh); return false }
      let y = p.p[1] + p.v[1] * dt + 0.5 * p.g * dt * dt
      let x = p.p[0] + p.v[0] * dt; let z = p.p[2] + p.v[2] * dt
      if (p.floor !== undefined && y < p.floor) { y = p.floor; if (p.keep) { const land = (-p.v[1] - Math.sqrt(Math.max(0, p.v[1] * p.v[1] - 2 * p.g * (p.p[1] - p.floor)))) / p.g; x = p.p[0] + p.v[0] * land; z = p.p[2] + p.v[2] * land } }
      p.mesh.position.set(x, y, z)
      const k = dt / p.life
      if (p.grow) p.mesh.scale.setScalar(1 + p.grow * dt)
      else if (!p.keep) p.mesh.scale.setScalar(Math.max(0.05, 1 - k * 0.8))
      if (p.fade) p.mesh.material.opacity = Math.max(0, (p.baseOpacity || 1) * (1 - k * k))
      return true
    })
  }
}

// Clouds and a sun, so the sky is not a flat colour. Deterministic per scene.
function buildSky (scene, center, timeOfDay, seedStr) {
  let h = 2166136261
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619) }
  const r = () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const t = ((timeOfDay % 24000) + 24000) % 24000
  const night = t >= 13500 && t < 22500
  const clouds = new THREE.Group()
  const mat = new THREE.MeshBasicMaterial({ color: night ? 0x5a6078 : 0xffffff, transparent: true, opacity: night ? 0.5 : 0.88, fog: false })
  for (let i = 0; i < 46; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(14 + r() * 26, 4, 10 + r() * 20), mat)
    m.position.set(center[0] + (r() - 0.5) * 560, 188 + r() * 14, center[2] + (r() - 0.5) * 560)
    clouds.add(m)
  }
  scene.add(clouds)
  if (!night) {
    const angle = (t / 24000) * Math.PI * 2 // 0 = sunrise in the east, 6000 = overhead
    const sun = new THREE.Mesh(new THREE.BoxGeometry(34, 34, 2), new THREE.MeshBasicMaterial({ color: 0xfff3b8, fog: false }))
    sun.position.set(center[0] + Math.cos(angle) * 420, center[1] + Math.max(60, Math.sin(angle) * 420), center[2] + 80)
    sun.lookAt(center[0], center[1], center[2])
    scene.add(sun)
  }
  return { update (tick) { clouds.position.x = ((tick * 0.02) % 120) } }
}

class EntityPool {
  constructor (scene, version) {
    this.scene = scene
    this.version = version
    this.meshes = new Map() // key -> { obj, mesh, kind, bones, skinApplied }
    this.skinTextures = new Map()
  }

  async skinTexture (skinName) {
    if (this.skinTextures.has(skinName)) return this.skinTextures.get(skinName)
    const file = skins.skinPathFor(skinName)
    if (!file) { this.skinTextures.set(skinName, null); return null }
    const img = await loadImage(file)
    const tex = new THREE.CanvasTexture(img)
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.flipY = false
    this.skinTextures.set(skinName, tex)
    return tex
  }

  get (key, state) {
    let e = this.meshes.get(key)
    if (e) return e
    const kind = state.name === 'player' ? 'player' : state.name
    let obj
    try {
      obj = new Entity('1.16.4', kind === 'player' && state.model === 'slim' ? 'player_slim' : kind, this.scene).mesh
    } catch {
      const g = new THREE.BoxGeometry(state.w || 0.6, state.h || 1.8, state.w || 0.6)
      g.translate(0, (state.h || 1.8) / 2, 0)
      obj = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xaa66aa }))
    }
    const mesh = obj.children && obj.children[0] && obj.children[0].skeleton ? obj.children[0] : null
    const bones = {}
    const rest = {}
    if (mesh && kind === 'player') PLAYER_BONES.forEach((n, i) => { bones[n] = mesh.skeleton.bones[i]; rest[n] = mesh.skeleton.bones[i].position.clone() })
    this.scene.add(obj)
    e = { obj, mesh, kind, bones, rest, skinApplied: false, walkPhase: 0, lastPos: null, swingUntil: -1, heldName: null, heldMesh: null, armorWorn: '', armorPlates: [], tag: null, tagKey: '' }
    this.meshes.set(key, e)
    return e
  }

  async applySkin (e, skinName) {
    if (e.skinApplied || !e.mesh) return
    const tex = skinName ? await this.skinTexture(skinName) : null
    e.skinApplied = true
    if (!tex) return
    // the default texture is set asynchronously by the viewer; wait for it then override
    for (let i = 0; i < 20 && !e.mesh.material.map; i++) await U.sleep(25)
    e.mesh.material.map = tex
    e.mesh.material.needsUpdate = true
  }

  remove (key) {
    const e = this.meshes.get(key)
    if (!e) return
    if (e.tag) this.scene.remove(e.tag.sprite)
    this.scene.remove(e.obj)
    this.meshes.delete(key)
  }

  // Rotate a player bone about its true pivot (see PLAYER_PIVOT_LOCAL).
  rotateBone (e, name, x, y, z) {
    const bone = e.bones[name]
    if (!bone) return
    const pl = PLAYER_PIVOT_LOCAL[name]
    bone.rotation.set(x, y, z)
    const p = new THREE.Vector3(pl[0], pl[1], pl[2])
    const rotated = p.clone().applyQuaternion(bone.quaternion)
    bone.position.copy(e.rest[name]).add(p).sub(rotated)
  }

  // Pose a player mesh: body yaw, head look, walk cycle, sneak, swing.
  posePlayer (e, st, tick, dtTicks) {
    const b = e.bones
    const o = e.obj
    const sneaking = st.anim === 'sneak' || st.anim === 'crouch'
    o.position.set(st.x, st.y - (sneaking ? 0.15 : 0), st.z)
    o.rotation.set(0, st.yaw || 0, 0, 'YXZ')
    // death: fall over sideways over the `dying` ramp (0..1), tinted red
    if (st.dying) {
      o.rotation.set(0, st.yaw || 0, Math.min(1, st.dying * 1.6) * Math.PI / 2, 'YXZ')
      o.position.y += 0.1
    }
    if (st.hurt) e.hurtUntil = tick + 5
    if (e.mesh) {
      const red = st.dying || tick < (e.hurtUntil || -1)
      e.mesh.material.color.setRGB(1, red ? 0.45 : 1, red ? 0.45 : 1)
    }
    if (!b.head) return
    // walk cycle driven by distance moved
    if (e.lastPos) {
      const d = U.distXZ(e.lastPos, st)
      e.walkPhase += d * 2.2
    }
    e.lastPos = { x: st.x, z: st.z }
    const moving = e.lastPos && st.moving
    const amp = moving ? (st.anim === 'sprint' ? 0.9 : (sneaking ? 0.4 : 0.7)) : 0
    const s = Math.sin(e.walkPhase) * amp
    // Life: nobody stands perfectly still. Arms drift like the game's own idle sway, the
    // head wanders a little, and whoever is speaking nods and gestures so the eye finds them.
    if (e.phase === undefined) e.phase = (st.id || 1) * 1.7
    const age = tick + e.phase * 20
    const swayZ = Math.cos(age * 0.09) * 0.05 + 0.05
    const swayX = Math.sin(age * 0.067) * 0.05
    const talking = !!st.talking && !st.dying
    const still = !moving
    const gesture = talking && still ? Math.max(0, Math.sin(age * 0.19)) * 0.55 : 0 // forearm lifts on and off
    const nod = talking ? Math.sin(age * 0.55) * 0.07 : 0
    const lookYaw = still && !talking ? Math.sin(age * 0.031) * 0.12 + Math.sin(age * 0.113) * 0.04 : 0
    const lookPitch = still ? Math.sin(age * 0.047) * 0.035 : 0

    this.rotateBone(e, 'body', sneaking ? 0.45 : 0, still ? Math.sin(age * 0.04) * 0.025 : 0, 0)
    this.rotateBone(e, 'leftLeg', s, 0, 0)
    this.rotateBone(e, 'rightLeg', -s, 0, 0)
    this.rotateBone(e, 'leftArm', -s * 0.8 - swayX + (talking && still ? Math.max(0, Math.sin(age * 0.13 + 2)) * 0.3 : 0), 0, swayZ)
    // positive x swings a limb forwards (the model faces -z)
    let armX = s * 0.8 + swayX + gesture; let armZ = -swayZ
    if (st.swing) e.swingUntil = tick + 6
    if (tick < e.swingUntil) {
      const p = 1 - (e.swingUntil - tick) / 6
      armX = Math.sin(Math.PI * p) * 1.9 + 0.2
      armZ = Math.sin(Math.PI * p) * 0.25
    } else if (st.held) armX += 0.3 // arm slightly raised when holding something
    this.rotateBone(e, 'rightArm', armX, 0, armZ)
    this.rotateBone(e, 'head', (st.pitch || 0) + (sneaking ? -0.45 : 0) + nod + lookPitch, lookYaw, 0)
    if ((st.held || null) !== e.heldName) {
      if (e.heldMesh) b.rightArm.remove(e.heldMesh)
      e.heldName = st.held || null
      e.heldMesh = heldMesh(e.heldName)
      if (e.heldMesh) b.rightArm.add(e.heldMesh)
    }
    if ((st.armor || '') !== e.armorWorn) {
      for (const pl of e.armorPlates) b[pl.bone].remove(pl.mesh)
      e.armorWorn = st.armor || ''
      e.armorPlates = e.armorWorn ? armorPlates(e.armorWorn) : []
      for (const pl of e.armorPlates) b[pl.bone].add(pl.mesh)
    }
    o.visible = !st.dead && !st.invisible
    // name and health above the head (match films)
    if (this.nametags && st.username) {
      const hp = st.hp === undefined ? null : Math.round(st.hp)
      const key = st.username + '|' + hp
      if (!e.tag) {
        const canvas = require('canvas').createCanvas(256, 80)
        const tex = new THREE.CanvasTexture(canvas)
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
        sprite.scale.set(2.1, 0.66, 1)
        this.scene.add(sprite)
        e.tag = { canvas, tex, sprite }
      }
      if (key !== e.tagKey) { drawTag(e.tag.canvas, String(st.username).replace(/^\./, ''), hp); e.tag.tex.needsUpdate = true; e.tagKey = key }
      e.tag.sprite.position.set(st.x, st.y + (sneaking ? 2.25 : 2.5), st.z)
      e.tag.sprite.visible = o.visible && !st.dying
    }
  }

  poseOther (e, st, tick = 0) {
    // animals and monsters have no walk cycle here; a small hop keeps them from sliding
    if (st.moving) st = { ...st, y: st.y + Math.abs(Math.sin(tick * 0.55 + (st.id || 0))) * 0.07 }
    e.obj.position.set(st.x, st.y, st.z)
    e.obj.rotation.set(0, st.yaw || 0, 0)
  }
}

async function ffmpegSink (file, w, h, fps) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const args = ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0',
    '-vf', 'vflip', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]
  const p = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] })
  const done = new Promise((resolve, reject) => { p.on('exit', c => c === 0 ? resolve() : reject(new Error('ffmpeg exited ' + c))) })
  return {
    write (buf) {
      if (!p.stdin.write(buf)) return new Promise(r => p.stdin.once('drain', r))
    },
    async end () { p.stdin.end(); await done }
  }
}

async function renderScene (dir, sceneId, cuts, timeline, opts) {
  const w = opts.width || 1920; const h = opts.height || 1080; const fps = opts.fps || timeline.fps || 30
  const replay = readReplay(replayPath(dir, sceneId))
  const version = replay.meta.version
  const Chunk = require('prismarine-chunk')(version)
  const World = require('prismarine-world')(version)
  const columns = new Map(replay.columns.map(c => [`${c.x},${c.z}`, c]))
  const loaded = new Map() // chunk objects by key, for block lookups (camera safety)
  const world = new World((cx, cz) => {
    const c = columns.get(`${cx},${cz}`)
    if (!c) return null
    try { const col = Chunk.fromJson(c.json); loaded.set(`${cx},${cz}`, col); return col } catch (e) { U.log('render', `bad column ${cx},${cz}: ${e.message}`); return null }
  })
  const blockData = require('minecraft-data')(version)
  const V3 = require('vec3').Vec3
  const solidAt = (x, y, z) => {
    const col = loaded.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
    if (!col || y < -64 || y > 319) return false
    try {
      const b = blockData.blocksByStateId[col.getBlockStateId(new V3(((Math.floor(x) % 16) + 16) % 16, Math.floor(y), ((Math.floor(z) % 16) + 16) % 16))]
      return !!b && b.boundingBox === 'block' && (!b.transparent || b.name.endsWith('leaves'))
    } catch { return false }
  }

  const canvas = createCanvas(w, h)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setSize(w, h, false)
  const viewer = new Viewer(renderer)
  if (!viewer.setVersion(version)) throw new Error(`renderer does not support ${version}`)
  const sky = skyFor(replay.meta.time_of_day !== undefined ? replay.meta.time_of_day : 6000)
  viewer.scene.background = new THREE.Color(sky.bg)
  viewer.ambientLight.color = new THREE.Color(sky.ambient)
  viewer.directionalLight.intensity = sky.sun
  viewer.scene.fog = new THREE.Fog(sky.bg, 60, 140)
  const center = replay.meta.center || [0, 65, 0]
  const viewDistance = opts.viewDistance || Math.min(8, (replay.meta.radius || 6) + 1)
  const worldView = new WorldView(world, viewDistance, new (require('vec3').Vec3)(center[0], center[1], center[2]))
  viewer.listen(worldView)
  await worldView.init(new (require('vec3').Vec3)(center[0], center[1], center[2]))
  await viewer.waitForChunksToRender()
  U.log('render', `scene ${sceneId}: world ready (${Object.keys(viewer.world.loadedChunks).length} chunks)`)

  // held items are built from the game's textures; load each one used in this scene up front
  const heldNames = new Set()
  for (const f of replay.frames) for (const a of f.a) if (a.held) heldNames.add(String(a.held).replace('minecraft:', ''))
  for (const n of heldNames) await loadItem(version, n)
  const pool = new EntityPool(viewer.scene, version)
  const look = require('../assemble/mix').load()
  pool.nametags = opts.nametags !== undefined ? opts.nametags : (timeline.mode === 'match' && look.nametags !== false)
  const effects = new Effects(viewer.scene)
  const skyObjects = look.clouds === false ? null : buildSky(viewer.scene, center, replay.meta.time_of_day !== undefined ? replay.meta.time_of_day : 6000, String(sceneId))
  const baseAmbient = viewer.ambientLight.intensity
  const actorSkins = new Map((replay.meta.actors || []).map(a => [a.id, a.skin]))
  const shootFile = path.join(dir, 'shoot.json')
  if (U.exists(shootFile)) {
    const sc = (U.readJson(shootFile).scenes || []).find(x => x.id === sceneId)
    for (const a of (sc && sc.actors) || []) if (a.skin) actorSkins.set(a.id, a.skin)
  }
  const gl = canvas.getContext('webgl')
  const camCtx = { actor: actorResolver(replay) }
  const speech = new Map() // username -> [[startTick, endTick]]
  for (const l of timeline.lines.filter(x => x.scene_id === sceneId)) {
    const start = l.local_tick !== undefined ? l.local_tick : 0
    const len = (l.duration_sec || l.est_sec || 2) * 20
    if (!speech.has(l.character)) speech.set(l.character, [])
    speech.get(l.character).push([start, start + len])
  }
  const isTalking = (name, t) => (speech.get(name) || []).some(([a, b]) => t >= a && t <= b)
  const pixels = Buffer.alloc(w * h * 4)
  const ticksPerFrame = 20 / fps
  const outputs = []

  // apply block updates up to tick t (in order)
  let blockCursor = 0
  const blockFrames = replay.frames.filter(f => f.b && f.b.length)
  async function applyBlocksUpTo (t) {
    let changed = false
    while (blockCursor < blockFrames.length && blockFrames[blockCursor].t <= t) {
      for (const b of blockFrames[blockCursor].b) {
        // a change outside the recorded area (a natural world never sits still) has no chunk to land in
        if (!columns.has(`${Math.floor(b.x / 16)},${Math.floor(b.z / 16)}`)) continue
        const pos = new (require('vec3').Vec3)(b.x, b.y, b.z)
        try {
          await world.setBlockStateId(pos, b.s)
          viewer.setBlockStateId(pos, b.s)
          changed = true
        } catch { /* a block the renderer cannot place is not worth failing a film over */ }
      }
      blockCursor++
    }
    if (changed) await viewer.waitForChunksToRender()
  }

  for (const cut of cuts) {
    const shot = timeline.shots.find(s => s.id === cut.shot_id)
    const cam = new CameraPath({ ...shot, start_tick: shot.local_start, end_tick: shot.local_end })
    const clipFile = path.join(dir, 'clips', `${cut.shot_id.replace(/[^A-Za-z0-9_.-]/g, '_')}.mp4`)
    const nFrames = Math.max(1, Math.round((cut.local_end - cut.local_start) / ticksPerFrame))
    U.log('render', `cut ${cut.shot_id}: ticks ${cut.local_start}-${cut.local_end} -> ${nFrames} frames @${fps} (${w}x${h})`)
    const sink = await ffmpegSink(clipFile, w, h, fps)
    const seen = new Set()
    let lastTick = cut.local_start
    effects.clear()
    for (const e of pool.meshes.values()) { e.lastHurt = -100; e.deathShown = false }
    let fxFrame = Math.max(0, Math.floor(cut.local_start))
    const t0 = Date.now()
    for (let i = 0; i < nFrames; i++) {
      const tick = cut.local_start + i * ticksPerFrame
      const camTick = Math.min(tick, cut.local_hold_from !== undefined ? cut.local_hold_from : tick)
      const states = statesAt(replay, tick)
      await applyBlocksUpTo(tick)
      // entities
      const present = new Set()
      for (const [key, st] of states) {
        present.add(key)
        const e = pool.get(key, st)
        if (key.startsWith('actor:')) {
          if (!e.skinApplied) await pool.applySkin(e, require('../prefs').isAlias(st.username) ? null : (actorSkins.get(st.username) || st.skin || st.username))
          st.talking = isTalking(st.username, tick)
          pool.posePlayer(e, st, tick, tick - lastTick)
          if (look.particles !== false) {
            if (st.hurt && tick - (e.lastHurt === undefined ? -100 : e.lastHurt) > 5) { effects.burst('hit', st, tick); e.lastHurt = tick }
            if (st.dying && !e.deathShown) { effects.burst('death', st, tick); e.deathShown = true }
          }
        } else pool.poseOther(e, st, tick)
        seen.add(key)
      }
      for (const key of [...pool.meshes.keys()]) if (!present.has(key)) pool.remove(key)
      // world effects recorded on the frames this video frame passes over
      while (fxFrame < replay.frames.length && replay.frames[fxFrame].t <= tick) {
        for (const fx of replay.frames[fxFrame].x || []) if (look.particles !== false) effects.burst(fx.type, fx, replay.frames[fxFrame].t)
        fxFrame++
      }
      effects.update(tick)
      if (skyObjects) skyObjects.update(tick)
      viewer.ambientLight.intensity = tick <= effects.flashUntil ? baseAmbient * 1.8 : baseAmbient
      // camera
      const pose = cam.evaluate(camTick, camCtx)
      if (pose.hide) { const me = pool.meshes.get('actor:' + pose.hide); if (me) me.obj.visible = false }
      // A planned camera can land inside real terrain (the planner cannot see every hill).
      // Lift it until it is in the open. Automatic match shots are already terrain-checked.
      if (!shot.auto && !pose.hide) { let lift = 0; while (lift < 9 && solidAt(pose.x, pose.y + lift, pose.z)) lift += 0.5; pose.y += lift }
      viewer.camera.position.set(pose.x, pose.y, pose.z)
      viewer.camera.rotation.set(pose.pitch, pose.yaw, 0, 'ZYX')
      const fov = w < h ? Math.min(100, pose.fov * 1.32) : pose.fov
      if (viewer.camera.fov !== fov) { viewer.camera.fov = fov; viewer.camera.updateProjectionMatrix() }
      await worldView.updatePosition(viewer.camera.position)
      await viewer.waitForChunksToRender()
      renderer.render(viewer.scene, viewer.camera)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      await sink.write(Buffer.from(pixels))
      lastTick = tick
    }
    await sink.end()
    const secs = (Date.now() - t0) / 1000
    U.log('render', `wrote ${path.relative(dir, clipFile)} in ${secs.toFixed(1)}s (${(nFrames / secs).toFixed(1)} fps)`)
    outputs.push({ cut, clip: path.relative(dir, clipFile), frames: nFrames })
    void EYE
  }
  for (const wk of viewer.world.workers) wk.terminate()
  return outputs
}

async function render (dir, opts = {}) {
  const tlFile = path.join(dir, 'timeline.json')
  const timeline = U.readJson(tlFile)
  let cuts = timeline.cuts
  if (opts.shot) cuts = cuts.filter(c => c.shot_id === opts.shot || c.shot_id.endsWith('.' + opts.shot))
  if (opts.scene) cuts = cuts.filter(c => c.scene_id === opts.scene)
  if (!cuts.length) throw new Error('no cuts to render (run timeline first, check --shot/--scene)')
  const byScene = new Map()
  for (const c of cuts) { if (!byScene.has(c.scene_id)) byScene.set(c.scene_id, []); byScene.get(c.scene_id).push(c) }
  const results = []
  for (const [sceneId, sceneCuts] of byScene) {
    if (!U.exists(replayPath(dir, sceneId))) throw new Error(`no replay for scene ${sceneId}; run shoot first`)
    results.push(...await renderScene(dir, sceneId, sceneCuts, timeline, opts))
  }
  // write clip paths back
  const tl = U.readJson(tlFile)
  for (const r of results) {
    const c = tl.cuts.find(x => x.shot_id === r.cut.shot_id && x.start_tick === r.cut.start_tick)
    if (c) { c.clip = r.clip; c.frames = r.frames; c.fps = opts.fps || tl.fps; c.source = 'render' } // not the real game: the upload check refuses it
    const s = tl.shots.find(x => x.id === r.cut.shot_id)
    if (s) s.clip = r.clip
  }
  U.writeJson(tlFile, tl)
  return results
}

module.exports = { render, renderScene, skyFor }
