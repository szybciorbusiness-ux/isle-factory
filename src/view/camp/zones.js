// Drop-zone markers: a soft rounded rectangle painted on the ground (signed-distance shader on a flat plane),
// with chevron arrows pointing at the station that scroll gently toward it, breathing slowly. When the player
// stands in it the fill warms up, the rim thickens and the chevrons hurry; every drop flashes it a little.
// All zones are ONE InstancedMesh (per-instance size / arrow / state attributes). The accepted item's icon
// (a real 3D item from the pools) floats in the middle; camp.js draws that.
import * as THREE from 'three';
import { damp } from '../../util/anim.js';

const RIM = '#fff8e8', FILL = '#ffffff', FILL_HI = '#ffe7a0', CHEV = '#ffd36b';
const CAP = 6;

function zoneMaterial() {
  const m = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  m.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 zoneA;\nattribute vec4 zoneB;\nvarying vec2 vZoneUv;\nvarying vec4 vZoneA;\nvarying vec4 vZoneB;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvZoneUv = uv; vZoneA = zoneA; vZoneB = zoneB;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vZoneUv; varying vec4 vZoneA; varying vec4 vZoneB;
float zoneBox( vec2 p, vec2 b, float r ) { vec2 q = abs( p ) - b + r; return length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - r; }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
	{
		vec2 size = vZoneA.xy, dir = vZoneA.zw;
		float phase = vZoneB.x, hi = vZoneB.y, breath = vZoneB.z, appear = vZoneB.w;
		vec2 p = ( vZoneUv - 0.5 ) * size; p.y = -p.y;               // p.y = +z (south)
		p /= 0.9 + 0.1 * appear + 0.012 * breath + 0.02 * min( hi, 1.0 );
		vec2 hb = size * 0.5 - 0.1;
		float d = zoneBox( p, hb, 0.24 );
		float aa = max( fwidth( d ) * 1.1, 0.002 );
		float bw = 0.034 + 0.016 * min( hi, 1.0 );
		float rim = 1.0 - smoothstep( bw - aa, bw + aa, abs( d + bw + 0.012 ) );
		float inside = 1.0 - smoothstep( -aa, aa, d );
		vec2 perp = vec2( -dir.y, dir.x );
		float a = dot( p, dir ), c = dot( p, perp );
		float halfPerp = abs( dot( hb, abs( perp ) ) ), halfDir = abs( dot( hb, abs( dir ) ) );
		float off = halfPerp > 0.7 ? halfPerp - 0.4 : 0.0;
		float cc = off > 0.0 ? abs( abs( c ) - off ) : abs( c );
		float f = ( a + cc * 0.95 ) * 3.2 - phase;
		float fa = max( fwidth( f ), 0.001 );
		float chev = 1.0 - smoothstep( 0.17 - fa, 0.17 + fa, abs( fract( f ) - 0.5 ) );
		chev *= 1.0 - smoothstep( 0.17, 0.2, cc );
		chev *= 1.0 - smoothstep( halfDir - 0.24, halfDir - 0.12, abs( a ) );
		chev *= inside;
		float h = min( hi, 1.0 ), flash = max( hi - 1.0, 0.0 );
		float fillA = mix( 0.13 + 0.05 * breath, 0.34 + 0.06 * breath, h ) + 0.2 * flash;
		vec3 col = mix( vec3( ${new THREE.Color(FILL).toArray().map(v => v.toFixed(4)).join(', ')} ), vec3( ${new THREE.Color(FILL_HI).toArray().map(v => v.toFixed(4)).join(', ')} ), h );
		float alpha = inside * fillA;
		col = mix( col, vec3( ${new THREE.Color(CHEV).toArray().map(v => v.toFixed(4)).join(', ')} ), chev );
		alpha = max( alpha, chev * ( 0.7 + 0.25 * h ) );
		col = mix( col, vec3( ${new THREE.Color(RIM).toArray().map(v => v.toFixed(4)).join(', ')} ), rim );
		alpha = max( alpha, rim * ( 0.82 + 0.18 * h ) );
		diffuseColor.rgb = col;
		diffuseColor.a = alpha * appear;
	}`);
  };
  m.customProgramCacheKey = () => 'isle-camp-zones-v2';
  return m;
}

export function createZones(parent) {
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const A = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4);
  const B = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4);
  A.setUsage(THREE.DynamicDrawUsage); B.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('zoneA', A);
  geo.setAttribute('zoneB', B);
  const mesh = new THREE.InstancedMesh(geo, zoneMaterial(), CAP);
  mesh.count = 0; mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.name = 'camp-zones';
  parent.add(mesh);
  const list = [];
  const _m = new THREE.Matrix4();

  function add(zone, toward) {
    const [x, z, w, h] = zone;
    const cx = x + (w - 1) / 2, cz = z + (h - 1) / 2;
    const dx = toward.x - cx, dz = toward.z - cz;
    const dir = Math.abs(dx) > Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz) || -1];
    let phase = 0, breath = 0, hi = 0, appear = 0, flash = 0, t = list.length * 1.3;
    const zh = {
      center: new THREE.Vector3(cx, 0.02, cz), dir, rect: zone, w, h,
      appear: 0,        // target 0..1 (set by the owner)
      hi: 0,            // target highlight 0..1
      flash() { flash = Math.min(1, flash + 0.5); },
      step(dt) {
        t += dt;
        appear = damp(appear, this.appear, 6, dt);
        hi = damp(hi, this.hi, this.hi > hi ? 12 : 5, dt);
        flash = Math.max(0, flash - dt * 4);
        phase += dt * (0.55 + 1.6 * hi);
        breath = Math.sin(t * 2.1);
      },
      write(i) {
        _m.makeScale(w, 1, h).setPosition(cx, 0.018, cz);
        mesh.setMatrixAt(i, _m);
        A.setXYZW(i, w, h, dir[0], dir[1]);
        B.setXYZW(i, phase % 1000, hi + flash, breath, appear);
      },
      get highlight() { return hi; },
      get shown() { return appear; },
    };
    list.push(zh);
    return zh;
  }
  return {
    add,
    update(dt) {
      let n = 0;
      for (const z of list) { z.step(dt); if (z.shown > 0.01 && n < CAP) z.write(n++); }
      mesh.count = n; mesh.visible = n > 0;
      if (n) { mesh.instanceMatrix.needsUpdate = true; A.needsUpdate = true; B.needsUpdate = true; }
    },
    mesh,
  };
}
