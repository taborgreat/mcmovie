'use strict'
// Minimal replacement for the upstream node-canvas-webgl package.
// prismarine-viewer only needs two things from it in node: a canvas whose
// getContext('webgl') returns a headless-gl context (for THREE.WebGLRenderer),
// and loadImage (for textures). Upstream pins canvas@2 which has no prebuilt
// binary for modern node; this uses whatever canvas/gl are installed.
const canvasLib = require('canvas')
const createGL = require('gl')

// headless-gl turns an Image into pixels by drawing it on a canvas it gets
// from document.createElement. Node has no document, so provide the one call.
if (typeof global.document === 'undefined') {
  const make = () => canvasLib.createCanvas(1, 1)
  global.document = { createElement: make, createElementNS: (ns, tag) => make() }
}

function createCanvas (width, height) {
  const canvas = canvasLib.createCanvas(width, height)
  let gl = null
  const origGetContext = canvas.getContext.bind(canvas)
  canvas.getContext = function (type, attrs) {
    if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
      if (!gl) {
        gl = createGL(width, height, { preserveDrawingBuffer: true, antialias: true, ...(attrs || {}) })
        if (!gl) throw new Error('headless-gl could not create a WebGL context. On Linux run under xvfb-run (sudo apt install xvfb).')
        gl.canvas = canvas
      }
      return gl
    }
    return origGetContext(type, attrs)
  }
  // THREE.WebGLRenderer touches these DOM-ish members.
  canvas.addEventListener = () => {}
  canvas.removeEventListener = () => {}
  canvas.style = {}
  canvas.clientWidth = width
  canvas.clientHeight = height
  Object.defineProperty(canvas, 'glContext', { get: () => gl })
  return canvas
}

module.exports = {
  createCanvas,
  loadImage: canvasLib.loadImage,
  Image: canvasLib.Image,
  ImageData: canvasLib.ImageData
}
