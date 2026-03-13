const cv = require('canvas');
const pv = require('prismarine-viewer');
console.log('canvas:', cv.version || 'loaded');
console.log('prismarine-viewer:', require('prismarine-viewer/package.json').version);
console.log('node-canvas-webgl:', require('node-canvas-webgl/package.json').version);
