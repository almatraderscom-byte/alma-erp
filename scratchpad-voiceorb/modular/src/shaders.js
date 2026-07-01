// shaders.js — GLSL sources for the orb and particle aura.

// Ashima / Stefan Gustavson 3D simplex noise (public domain) + fbm helper.
export const GLSL_SIMPLEX = /* glsl */`
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x,289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z *ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
float fbm(vec3 p){
  float f = 0.0, a = 0.5;
  for(int i=0;i<5;i++){ f += a*snoise(p); p *= 2.02; a *= 0.5; }
  return f;
}`;

export const ORB_VERT = GLSL_SIMPLEX + /* glsl */`
uniform float uTime, uDeform, uDetail, uAudio, uAudioLow, uAudioHigh;
varying vec3 vNormal, vPos;
varying float vDisp;
void main(){
  vec3 p = position;
  float t = uTime * 0.55;
  float base = fbm(normalize(p) * uDetail + vec3(0.0, t, 0.0));
  float ripple = snoise(normalize(p) * (uDetail*2.3) + vec3(t*1.7));
  float disp = base * uDeform
             + ripple * (0.10 + uAudioHigh * 0.55)
             + uAudioLow * 0.45;
  disp += uAudio * 0.35 * (0.6 + 0.4*sin(t*3.0));
  vec3 displaced = p + normal * disp;
  vDisp = disp;
  vPos = displaced;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}`;

export const ORB_FRAG = /* glsl */`
precision highp float;
uniform vec3 uColorA, uColorB, uColorC;
uniform float uAudio;
varying vec3 vNormal, vPos;
varying float vDisp;
void main(){
  vec3 viewDir = normalize(-vPos);
  float fres = pow(1.0 - max(dot(viewDir, normalize(vNormal)), 0.0), 2.4);
  float g = clamp(vDisp * 1.6 + 0.5, 0.0, 1.0);
  vec3 body = mix(uColorC, uColorA, smoothstep(0.0, 0.6, g));
  body = mix(body, uColorB, smoothstep(0.5, 1.0, g));
  vec3 col = body + uColorB * fres * (1.3 + uAudio*1.4);
  col += uColorB * 0.15;
  col *= 1.0 + uAudio * 0.6;
  gl_FragColor = vec4(col, 1.0);
}`;

export const AURA_VERT = /* glsl */`
uniform float uTime, uAudio, uAura, uDpr;
attribute float aRnd;
varying float vA;
void main(){
  vec3 p = position;
  float t = uTime*0.3 + aRnd*6.28;
  float breathe = 1.0 + 0.06*sin(t*1.5) + uAudio*0.35;
  p *= breathe;
  p.xy *= mat2(cos(t*0.1), -sin(t*0.1), sin(t*0.1), cos(t*0.1));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float twinkle = 0.4 + 0.6*sin(uTime*2.0 + aRnd*20.0);
  vA = twinkle * uAura * (0.5 + uAudio*0.8);
  gl_PointSize = (1.5 + aRnd*3.0) * uDpr * (300.0 / -mv.z) * (0.6 + uAudio*0.9);
  gl_Position = projectionMatrix * mv;
}`;

export const AURA_FRAG = /* glsl */`
precision mediump float;
uniform vec3 uColor; varying float vA;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if(d>0.5) discard;
  float a = smoothstep(0.5, 0.0, d) * vA;
  gl_FragColor = vec4(uColor, a);
}`;

export const PALETTES = [
  { name:'Aqua',   a:'#2fa8ff', b:'#7fe0ff', c:'#0a63ff', bloom:'#8ecbff' },
  { name:'Violet', a:'#8b5cf6', b:'#d8b4fe', c:'#5b21b6', bloom:'#c4b5fd' },
  { name:'Ember',  a:'#ff7a45', b:'#ffd08a', c:'#c2410c', bloom:'#ffb27a' },
  { name:'Mint',   a:'#22d3aa', b:'#b8ffe9', c:'#0f766e', bloom:'#8ff0d6' },
  { name:'Rose',   a:'#ff5c8a', b:'#ffc2d6', c:'#be185d', bloom:'#ff9bbd' },
];
