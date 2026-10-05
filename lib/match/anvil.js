'use strict'
// Region-file reader for match worlds. The live server runs a newer Minecraft
// than the renderer understands, so chunks are not loaded through a
// version-specific library: the Anvil container and the chunk NBT layout
// (sections -> block_states palette + packed longs) have been stable since
// 1.18. Each palette entry (block name + properties) is mapped by NAME onto
// the renderer's version (1.21.4); blocks that do not exist there fall back
// to air and are counted.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')

const TARGET_VERSION = '1.21.4'
const mcData = require('minecraft-data')(TARGET_VERSION)
const Chunk = require('prismarine-chunk')(TARGET_VERSION)

const MIN_Y = -64
const HEIGHT = 384
const PLAINS = mcData.biomesByName.plains ? mcData.biomesByName.plains.id : 0

// Blocks added after the renderer's version -> closest look-alike.
const SUBSTITUTES = {
  short_dry_grass: 'dead_bush',
  tall_dry_grass: 'dead_bush',
  bush: 'fern',
  firefly_bush: 'fern',
  wildflowers: 'pink_petals',
  leaf_litter: 'air',
  cactus_flower: 'air',
  iron_chain: 'chain'
  // unknown names not listed here fall back to air and are reported
}

class StateMapper {
  constructor () {
    this.cache = new Map()
    this.unknown = new Map()
  }

  // name: "minecraft:oak_log", props: { axis: "y" } (string values) -> state id
  stateId (name, props) {
    const key = props ? name + JSON.stringify(props) : name
    let id = this.cache.get(key)
    if (id !== undefined) return id
    id = this._compute(name, props)
    this.cache.set(key, id)
    return id
  }

  _compute (name, props) {
    let short = name.startsWith('minecraft:') ? name.slice(10) : name
    if (SUBSTITUTES[short]) short = SUBSTITUTES[short]
    const block = mcData.blocksByName[short]
    if (!block) {
      this.unknown.set(short, (this.unknown.get(short) || 0) + 1)
      return 0
    }
    if (!block.states || !block.states.length) return block.defaultState !== undefined ? block.defaultState : block.minStateId
    // decode the default state into per-property indices, then override
    let rest = (block.defaultState !== undefined ? block.defaultState : block.minStateId) - block.minStateId
    const idx = new Array(block.states.length)
    for (let i = block.states.length - 1; i >= 0; i--) {
      const n = block.states[i].num_values
      idx[i] = rest % n
      rest = Math.floor(rest / n)
    }
    if (props) {
      for (let i = 0; i < block.states.length; i++) {
        const st = block.states[i]
        const v = props[st.name]
        if (v === undefined) continue
        let vi
        if (st.type === 'bool') vi = (v === 'true' || v === true) ? 0 : 1
        else if (st.values) vi = st.values.indexOf(String(v))
        else vi = parseInt(v, 10)
        if (vi >= 0 && vi < st.num_values) idx[i] = vi
      }
    }
    let data = 0
    for (let i = 0; i < block.states.length; i++) data = data * block.states[i].num_values + idx[i]
    return block.minStateId + data
  }

  // "minecraft:oak_log[axis=y]" -> state id
  fromString (s) {
    const m = /^([a-z0-9_:.-]+)(?:\[(.*)\])?$/.exec(String(s).trim())
    if (!m) return 0
    const props = m[2] ? Object.fromEntries(m[2].split(',').map(kv => kv.split('='))) : null
    return this.stateId(m[1], props)
  }
}

// Read index `i` from a packed long array stored as [hi, lo] int pairs.
function unpack (longs, bits, perLong, i) {
  const li = Math.floor(i / perLong)
  const off = (i % perLong) * bits
  const pair = longs[li]
  const hi = pair[0]; const lo = pair[1]
  const mask = (1 << bits) - 1
  if (off >= 32) return (hi >>> (off - 32)) & mask
  if (off + bits <= 32) return (lo >>> off) & mask
  return ((lo >>> off) | (hi << (32 - off))) & mask
}

class AnvilWorld {
  // regionDir: folder holding r.X.Z.mca files
  constructor (regionDir) {
    this.dir = regionDir
    this.mapper = new StateMapper()
    this.headers = new Map()
    this.chunks = new Map() // "cx,cz" -> prismarine-chunk column or null
  }

  _region (rx, rz) {
    const key = `${rx},${rz}`
    if (this.headers.has(key)) return this.headers.get(key)
    const file = path.join(this.dir, `r.${rx}.${rz}.mca`)
    let entry = null
    if (fs.existsSync(file)) {
      const fd = fs.openSync(file, 'r')
      const header = Buffer.alloc(4096)
      fs.readSync(fd, header, 0, 4096, 0)
      entry = { fd, header, file }
    }
    this.headers.set(key, entry)
    return entry
  }

  _rawChunk (cx, cz) {
    const region = this._region(cx >> 5, cz >> 5)
    if (!region) return null
    const i = ((cx & 31) + (cz & 31) * 32) * 4
    const offset = region.header.readUIntBE(i, 3)
    const sectors = region.header[i + 3]
    if (offset === 0 || sectors === 0) return null
    const head = Buffer.alloc(5)
    fs.readSync(region.fd, head, 0, 5, offset * 4096)
    const length = head.readUInt32BE(0)
    let type = head[4]
    let data
    if (type & 0x80) { // oversized chunk kept in a side file
      type &= 0x7f
      const side = path.join(this.dir, `c.${cx}.${cz}.mcc`)
      if (!fs.existsSync(side)) return null
      data = fs.readFileSync(side)
    } else {
      data = Buffer.alloc(length - 1)
      fs.readSync(region.fd, data, 0, length - 1, offset * 4096 + 5)
    }
    if (type === 1) return zlib.gunzipSync(data)
    if (type === 2) return zlib.inflateSync(data)
    if (type === 3) return data
    throw new Error(`chunk ${cx},${cz}: unsupported region compression type ${type} (set region-file-compression=deflate)`)
  }

  // Returns a prismarine-chunk column (renderer version) or null if not generated.
  column (cx, cz) {
    const key = `${cx},${cz}`
    if (this.chunks.has(key)) return this.chunks.get(key)
    let col = null
    const raw = this._rawChunk(cx, cz)
    if (raw) {
      const parsed = nbt.simplify(nbt.parseUncompressed(raw, 'big'))
      col = this._build(parsed)
    }
    this.chunks.set(key, col)
    return col
  }

  _build (c) {
    const col = new Chunk({ minY: MIN_Y, worldHeight: HEIGHT })
    const sections = c.sections || []
    const pos = new Vec3(0, 0, 0)
    for (const s of sections) {
      const baseY = s.Y * 16
      if (baseY < MIN_Y || baseY >= MIN_Y + HEIGHT) continue
      const bs = s.block_states
      if (bs && bs.palette && bs.palette.length) {
        const ids = bs.palette.map(p => this.mapper.stateId(p.Name, p.Properties || null))
        if (ids.length === 1) {
          if (ids[0] !== 0) {
            for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) { pos.x = x; pos.y = baseY + y; pos.z = z; col.setBlockStateId(pos, ids[0]) }
          }
        } else if (bs.data) {
          const bits = Math.max(4, Math.ceil(Math.log2(ids.length)))
          const perLong = Math.floor(64 / bits)
          let i = 0
          for (let y = 0; y < 16; y++) {
            for (let z = 0; z < 16; z++) {
              for (let x = 0; x < 16; x++, i++) {
                const id = ids[unpack(bs.data, bits, perLong, i)]
                if (id) { pos.x = x; pos.y = baseY + y; pos.z = z; col.setBlockStateId(pos, id) }
              }
            }
          }
        }
      }
      // biomes: 4x4x4 cells per section
      const bio = s.biomes
      if (bio && bio.palette && bio.palette.length) {
        const bids = bio.palette.map(n => {
          const b = mcData.biomesByName[String(n).replace('minecraft:', '')]
          return b ? b.id : PLAINS
        })
        const bits = bids.length > 1 ? Math.ceil(Math.log2(bids.length)) : 0
        const perLong = bits ? Math.floor(64 / bits) : 0
        let i = 0
        for (let y = 0; y < 4; y++) {
          for (let z = 0; z < 4; z++) {
            for (let x = 0; x < 4; x++, i++) {
              const id = bits && bio.data ? bids[unpack(bio.data, bits, perLong, i)] : bids[0]
              pos.x = x * 4; pos.y = baseY + y * 4; pos.z = z * 4
              try { col.setBiome(pos, id === undefined ? PLAINS : id) } catch { /* out of range: ignore */ }
            }
          }
        }
      }
    }
    return col
  }

  stateIdAt (x, y, z) {
    const col = this.column(Math.floor(x / 16), Math.floor(z / 16))
    if (!col || y < MIN_Y || y >= MIN_Y + HEIGHT) return 0
    return col.getBlockStateId(new Vec3(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16))
  }

  setStateId (x, y, z, id) {
    const col = this.column(Math.floor(x / 16), Math.floor(z / 16))
    if (!col || y < MIN_Y || y >= MIN_Y + HEIGHT) return false
    col.setBlockStateId(new Vec3(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16), id)
    return true
  }

  // true if a camera or sight line cannot pass through this block
  isSolid (x, y, z, opts) {
    const id = this.stateIdAt(Math.floor(x), Math.floor(y), Math.floor(z))
    if (!id) return false
    const b = mcData.blocksByStateId[id]
    // leaves are "transparent" to the game but not to a camera. A walker filling in the gap
    // between two recorded points passes { leaves: false }: brushing through the edge of a
    // canopy is right, being lifted onto it is not.
    if (!b || b.boundingBox !== 'block') return false
    if (b.name.endsWith('leaves')) return !opts || opts.leaves !== false
    return !b.transparent
  }

  // water or lava at this spot (a swimmer is not standing on anything)
  isLiquid (x, y, z) {
    const id = this.stateIdAt(Math.floor(x), Math.floor(y), Math.floor(z))
    const b = id ? mcData.blocksByStateId[id] : null
    return !!b && (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column' || /seagrass|kelp/.test(b.name))
  }

  blockName (stateId) {
    const b = mcData.blocksByStateId[stateId]
    return b ? b.name : 'air'
  }

  biomeAt (x, y, z) {
    const col = this.column(Math.floor(x / 16), Math.floor(z / 16))
    if (!col) return null
    try {
      const id = col.getBiome(new Vec3(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16))
      const b = mcData.biomes[id]
      return b ? b.name : null
    } catch { return null }
  }

  // Highest solid block top at (x,z), scanning down from `from`.
  groundY (x, z, from = 200) {
    for (let y = from; y > MIN_Y; y--) if (this.isSolid(x, y, z)) return y + 1
    return null
  }

  close () {
    for (const r of this.headers.values()) if (r) { try { fs.closeSync(r.fd) } catch {} }
    this.headers.clear()
  }
}

module.exports = { AnvilWorld, StateMapper, unpack, TARGET_VERSION, MIN_Y, HEIGHT }
