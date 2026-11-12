// Belt material: vertex-coloured Lambert whose track (uv.y in 0..1) gets warm chevrons painted procedurally
// in the fragment shader. All belts share one `phase` uniform, advanced from dt at exactly item speed, so the
// stripes and the items riding them move together. u is world distance along the lane (p * lane length, so a
// curve is PI/4 long and its chevrons scroll at BELT.speed / beltLength per lane unit, exactly like its items),
// and a per-belt stripe offset carries the distance accumulated along the belt chain, which keeps the stripes
// continuous where a curve (not a whole number of stripes long) meets the next belt.
//
// Two flavours:
// - static (ghosts, icons): geometry already laid out along its path, uv.x = world distance.
// - bend (the world belts, one InstancedMesh): geometry is (p, y, lateral) and the vertex shader places it on a
//   per-instance bend between straight and either quarter curve (instance attribute beltData = (stripe offset,
//   bend, highlight, side gaps)). Shapes morph smoothly, and a shadow-depth twin bends the same way.
//   Side gaps: where another belt side-loads into this one, the rail on that side sinks to the track over the
//   feeder's width, so merging items roll in through an opening instead of through the rail. Packed as
//   round(gap+ * 255) + 256 * round(gap- * 255), gap+ being the +lateral side (each 0..1, animated by the view).
import * as THREE from 'three';
import { BELT_TOP } from './models.js';

// Track height the rail sinks to inside a side gap (a hair below the track, so the track wins the depth test).
const GAP_Y = (BELT_TOP - 0.003).toFixed(4);

export const CHEVRONS_PER_TILE = 3;

export function createBeltUniforms(stripe, bed = '#7d8597') {
  return { uBeltPhase: { value: 0 }, uBeltStripe: { value: new THREE.Color(stripe) }, uBeltBed: { value: new THREE.Color(bed) } };
}

// Keep in sync with bendPath() in models.js. Returns (x, z, heading, lane length) at progress p (0 entry -> 1 exit).
const BEND_GLSL = /* glsl */`
attribute vec4 beltData;
vec4 beltBend( float b, float p ) {
	float L = 1.0 + ( 0.78539816 - 1.0 ) * min( 1.0, abs( b ) );
	float k = b * 1.57079633 / L;
	float sg = ( 1.0 - p ) * L;
	float ks = k * sg;
	vec2 c = abs( k ) < 1e-3 ? vec2( 0.5 - sg, 0.5 * ks * sg ) : vec2( 0.5 - sin( ks ) / k, ( 1.0 - cos( ks ) ) / k );
	return vec4( c, -ks, L );
}
// side-gap weight of a vertex (p, y, lateral): rail region on a gapped side, faded out past the feeder's width
float beltGap( vec3 q ) {
	float g = q.z > 0.0 ? mod( beltData.w, 256.0 ) : floor( beltData.w / 256.0 );
	return g / 255.0 * ( 1.0 - smoothstep( 0.3, 0.45, abs( q.x - 0.5 ) ) ) * smoothstep( 0.285, 0.31, abs( q.z ) );
}`;
const BEND_BEGIN = /* glsl */`
	vec4 bendQ = beltBend( beltData.y, position.x );
	vec2 bendN = vec2( -sin( bendQ.z ), cos( bendQ.z ) );
	float bendY = mix( position.y, min( position.y, ${GAP_Y} ), beltGap( position ) );
	vec3 transformed = vec3( bendQ.x + bendN.x * position.z, bendY, bendQ.y + bendN.y * position.z );`;
const BEND_NORMAL = /* glsl */`
	vec4 bendQn = beltBend( beltData.y, position.x );
	vec2 bendNn = vec2( -sin( bendQn.z ), cos( bendQn.z ) );
	vec2 bendNl = normalize( mix( normal.zy, vec2( 0.0, 1.0 ), beltGap( position ) ) + vec2( 0.0, 1e-4 ) );
	vec3 objectNormal = vec3( bendNn.x * bendNl.x, bendNl.y, bendNn.y * bendNl.x );`;

export function makeBeltMaterial(uniforms, opts = {}, { bend = false } = {}) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, ...opts });
  m.onBeforeCompile = shader => {
    shader.uniforms.uBeltPhase = uniforms.uBeltPhase;
    shader.uniforms.uBeltStripe = uniforms.uBeltStripe;
    shader.uniforms.uBeltBed = uniforms.uBeltBed;
    let vs = shader.vertexShader.replace('#include <common>', `#include <common>
varying vec2 vBeltUv;
varying float vBeltOff;
varying float vBeltHi;
varying float vBeltGap;${bend ? BEND_GLSL : '\nattribute float beltOff;'}`);
    if (bend) {
      vs = vs
        .replace('#include <beginnormal_vertex>', BEND_NORMAL)
        .replace('#include <begin_vertex>', `${BEND_BEGIN}
	vBeltUv = vec2( position.x * bendQ.w, uv.y );
	vBeltOff = beltData.x;
	vBeltHi = beltData.z;
	vBeltGap = beltGap( position );`);
    } else {
      vs = vs.replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvBeltUv = uv;\n\tvBeltOff = beltOff;\n\tvBeltHi = 0.0;\n\tvBeltGap = 0.0;');
    }
    shader.vertexShader = vs;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vBeltUv;\nvarying float vBeltOff;\nvarying float vBeltHi;\nvarying float vBeltGap;\nuniform float uBeltPhase;\nuniform vec3 uBeltStripe;\nuniform vec3 uBeltBed;')
      .replace('#include <color_fragment>', `#include <color_fragment>
	if ( vBeltUv.y < 1.5 ) {
		float across = vBeltUv.y - 0.5;
		// chevron coordinate: constant along ">" shapes pointing in the travel direction (+u)
		float f = ( vBeltUv.x + vBeltOff ) * ${CHEVRONS_PER_TILE}.0 - uBeltPhase + abs( across ) * 1.15;
		float d = abs( fract( f ) - 0.5 );
		float aa = max( fwidth( f ) * 0.8, 0.001 );
		float stripe = 1.0 - smoothstep( 0.115 - aa, 0.115 + aa, d );
		float edge = 1.0 - smoothstep( 0.3, 0.4, abs( across ) );
		// soft groove shading toward the rails so the track reads as recessed (gentle: no dark gutters)
		float groove = mix( 0.93, 1.0, 1.0 - smoothstep( 0.3, 0.5, abs( across ) ) );
		diffuseColor.rgb *= groove;
		diffuseColor.rgb = mix( diffuseColor.rgb, uBeltStripe, stripe * edge );
	}
	// a side-load opening: the sunk rail takes the bed colour, so the feeder's track runs straight in
	diffuseColor.rgb = mix( diffuseColor.rgb, uBeltBed * 0.95, smoothstep( 0.15, 0.6, vBeltGap ) );
	// highlight: >= 0 a warm hover brighten of the whole belt (stripes included), < 0 a soft rose (long-press)
	diffuseColor.rgb *= vBeltHi >= 0.0 ? 1.0 + vBeltHi * vec3( 0.22, 0.2, 0.14 ) : 1.0 - vBeltHi * vec3( 0.16, -0.1, -0.1 );`);
  };
  m.customProgramCacheKey = () => (bend ? 'isle-belt-chevrons-bend-v6' : 'isle-belt-chevrons-v6');
  return m;
}

// Shadow-depth twin of the bend material, so belts cast their bent shape.
export function makeBeltDepthMaterial() {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${BEND_GLSL}`)
      .replace('#include <begin_vertex>', BEND_BEGIN);
  };
  m.customProgramCacheKey = () => 'isle-belt-depth-bend-v2';
  return m;
}
