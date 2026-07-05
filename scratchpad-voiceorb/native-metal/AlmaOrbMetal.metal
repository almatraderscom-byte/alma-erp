//
//  AlmaOrbMetal.metal — photoreal glass voice orb (refraction + fluid)
//  Direct port of the session's verified WebGL/GLSL shader.
//  Add to the app target; pairs with AlmaMetalOrbView.swift.
//
#include <metal_stdlib>
using namespace metal;

// Must match the Swift `OrbUniforms` layout exactly.
struct Uniforms {
    float4x4 proj;
    float4x4 view;
    float4x4 model;   // rotation only (uniform scale) -> valid for normals
    float3   camPos;
    float    time;
    float    amp;
    float    detail;
    float    irid;
    float    _pad;
};

struct VOut {
    float4 position [[position]];
    float3 world;
    float3 normal;
};

// ---- Ashima 3D simplex noise (public domain) + fbm ----
static inline float3 mod289(float3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
static inline float4 mod289(float4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
static inline float4 permute(float4 x){ return mod289(((x*34.0)+1.0)*x); }
static inline float4 taylorInvSqrt(float4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

static float snoise(float3 v){
    const float2 C = float2(1.0/6.0, 1.0/3.0);
    const float4 D = float4(0.0, 0.5, 1.0, 2.0);
    float3 i  = floor(v + dot(v, C.yyy));
    float3 x0 = v - i + dot(i, C.xxx);
    float3 g = step(x0.yzx, x0.xyz);
    float3 l = 1.0 - g;
    float3 i1 = min(g.xyz, l.zxy);
    float3 i2 = max(g.xyz, l.zxy);
    float3 x1 = x0 - i1 + C.xxx;
    float3 x2 = x0 - i2 + 2.0 * C.xxx;
    float3 x3 = x0 - 1.0 + 3.0 * C.xxx;
    i = mod289(i);
    float4 p = permute(permute(permute(
                 i.z + float4(0.0, i1.z, i2.z, 1.0))
               + i.y + float4(0.0, i1.y, i2.y, 1.0))
               + i.x + float4(0.0, i1.x, i2.x, 1.0));
    float n_ = 1.0/7.0;
    float3 ns = n_ * D.wyz - D.xzx;
    float4 j = p - 49.0 * floor(p * ns.z * ns.z);
    float4 x_ = floor(j * ns.z);
    float4 y_ = floor(j - 7.0 * x_);
    float4 x = x_ * ns.x + ns.yyyy;
    float4 y = y_ * ns.x + ns.yyyy;
    float4 h = 1.0 - abs(x) - abs(y);
    float4 b0 = float4(x.xy, y.xy);
    float4 b1 = float4(x.zw, y.zw);
    float4 s0 = floor(b0)*2.0 + 1.0;
    float4 s1 = floor(b1)*2.0 + 1.0;
    float4 sh = -step(h, float4(0.0));
    float4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    float4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    float3 p0 = float3(a0.xy, h.x);
    float3 p1 = float3(a0.zw, h.y);
    float3 p2 = float3(a1.xy, h.z);
    float3 p3 = float3(a1.zw, h.w);
    float4 norm = taylorInvSqrt(float4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    float4 m = max(0.6 - float4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, float4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
static float fbm(float3 p){ float f=0.0, a=0.5; for(int i=0;i<4;i++){ f+=a*snoise(p); p*=2.03; a*=0.5; } return f; }

// analytic environment (no cubemap) — saturated blue sky + colored light blobs
static float3 envColor(float3 dir){
    float up = dir.y*0.5+0.5;
    float3 c = mix(float3(0.14,0.36,0.82), float3(0.62,0.83,1.0), up);
    c += float3(0.10,0.28,0.62) * pow(max(dot(dir, normalize(float3(0.6,0.4,0.6))), 0.0), 5.0);
    c += float3(0.16,0.52,0.70) * pow(max(dot(dir, normalize(float3(-0.5,0.2,0.5))), 0.0), 7.0);
    c += float3(0.34,0.22,0.62) * pow(max(dot(dir, normalize(float3(0.1,-0.6,0.5))), 0.0), 7.0);
    c += float3(0.9,0.85,0.8)   * pow(max(dot(dir, normalize(float3(-0.3,0.7,0.4))), 0.0), 60.0);
    return c;
}

vertex VOut orb_vertex(const device packed_float3* posBuf [[buffer(0)]],
                       const device packed_float3* norBuf [[buffer(1)]],
                       constant Uniforms& u              [[buffer(2)]],
                       uint vid                          [[vertex_id]]) {
    float3 p = float3(posBuf[vid]);
    float3 n = float3(norBuf[vid]);
    float d = fbm(normalize(p)*u.detail + float3(0.0, u.time*0.3, 0.0));
    p += n * d * u.amp;
    float3 P = normalize(p)*u.detail*1.3 + float3(0.0, u.time*0.25, 0.0);
    float3 np = float3(fbm(P+11.1), fbm(P+31.4), fbm(P+57.7));
    n = normalize(n + np*(0.12 + u.amp*1.0));
    float4 world = u.model * float4(p, 1.0);
    VOut o;
    o.world  = world.xyz;
    o.normal = normalize((u.model * float4(n, 0.0)).xyz);
    o.position = u.proj * u.view * world;
    return o;
}

fragment float4 orb_fragment(VOut in [[stage_in]], constant Uniforms& u [[buffer(0)]]) {
    float3 N = normalize(in.normal);
    float3 V = normalize(u.camPos - in.world);
    float3 I = -V;
    float fres = pow(1.0 - max(dot(N,V), 0.0), 3.0);

    // deep-blue volumetric body (deep core -> light cap)
    float g = clamp(N.y*0.5+0.5, 0.0, 1.0);
    float3 deep = float3(0.04,0.18,0.55), mid = float3(0.16,0.46,0.88), lite = float3(0.70,0.88,1.0);
    float3 body = mix(deep, mid, smoothstep(0.0, 0.60, g));
    body = mix(body, lite, smoothstep(0.74, 1.0, g));
    float3 col = body;

    // faint refractive chromatic shimmer
    float eta = 0.66;
    float3 rR = refract(I, N, eta - 0.02*u.irid);
    float3 rG = refract(I, N, eta);
    float3 rB = refract(I, N, eta + 0.02*u.irid);
    float3 refr = float3(envColor(rR).r, envColor(rG).g, envColor(rB).b);
    col = mix(col, refr*float3(0.55,0.74,1.0), 0.14);

    // broad top gloss cap
    float top = smoothstep(0.45, 1.0, dot(N, normalize(float3(-0.15,1.0,0.35))));
    col += float3(0.85,0.93,1.0) * top * 0.30;

    // crisp specular hotspot
    float3 L = normalize(float3(-0.5,0.9,0.7));
    float spec = pow(max(dot(reflect(-L, N), V), 0.0), 140.0);
    col += float3(1.0) * spec * 1.7;

    // fresnel rim (defines the edge on the light bg)
    col += float3(0.5,0.70,1.0) * fres * 0.45;

    return float4(clamp(col, 0.0, 1.0), 1.0);
}
