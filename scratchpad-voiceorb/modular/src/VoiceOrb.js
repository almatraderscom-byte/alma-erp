// VoiceOrb.js — the renderable orb: scene, shader mesh, particle aura, post FX, controls.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { ORB_VERT, ORB_FRAG, AURA_VERT, AURA_FRAG, PALETTES } from './shaders.js';
import { AudioEngine } from './audio.js';

export class VoiceOrb {
  constructor(mount, opts = {}){
    this.mount = mount;
    this.params = Object.assign({
      deform: 0.55, speed: 0.7, detail: 1.8, bloom: 1.05, aura: 1.0, micGain: 1.6, palette: 0,
    }, opts);
    this.audio = new AudioEngine(this.params.micGain);
    this._clock = new THREE.Clock();
    this._breath = 0;

    this._initRenderer();
    this._initScene();
    this._initOrb();
    this._initAura();
    this._initPost();
    this._initControls();
    this._bindResize();
    this.setPalette(this.params.palette);

    this._animate = this._animate.bind(this);
    this.renderer.setAnimationLoop(this._animate);
  }

  _initRenderer(){
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setClearColor(0x05070d, 1);
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    r.setPixelRatio(this._dpr);
    r.setSize(this.mount.clientWidth, this.mount.clientHeight);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.15;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.mount.appendChild(r.domElement);
    this.renderer = r;
  }

  _initScene(){
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, this._aspect(), 0.1, 100);
    this.camera.position.set(0, 0, 5.2);
    const bg = new THREE.Mesh(
      new THREE.SphereGeometry(40, 32, 32),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: 0x070b14 }),
    );
    this.scene.add(bg);
  }

  _initOrb(){
    const geo = new THREE.IcosahedronGeometry(1.15, 128);
    this.uniforms = {
      uTime: { value: 0 }, uDeform: { value: this.params.deform }, uDetail: { value: this.params.detail },
      uAudio: { value: 0 }, uAudioLow: { value: 0 }, uAudioHigh: { value: 0 },
      uColorA: { value: new THREE.Color() }, uColorB: { value: new THREE.Color() }, uColorC: { value: new THREE.Color() },
    };
    const mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: ORB_VERT, fragmentShader: ORB_FRAG });
    this.orb = new THREE.Mesh(geo, mat);
    this.scene.add(this.orb);

    this.core = new THREE.Mesh(
      new THREE.SphereGeometry(0.95, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0x2a6bff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending }),
    );
    this.scene.add(this.core);
  }

  _initAura(){
    const COUNT = 900;
    const pos = new Float32Array(COUNT * 3), rnd = new Float32Array(COUNT);
    for(let i = 0; i < COUNT; i++){
      const r = 1.5 + Math.random() * 1.6;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i*3] = r*Math.sin(ph)*Math.cos(th);
      pos[i*3+1] = r*Math.sin(ph)*Math.sin(th);
      pos[i*3+2] = r*Math.cos(ph);
      rnd[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
    this.auraUniforms = {
      uTime: { value: 0 }, uAudio: { value: 0 }, uAura: { value: this.params.aura },
      uColor: { value: new THREE.Color('#9fd0ff') }, uDpr: { value: this._dpr },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.auraUniforms, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, vertexShader: AURA_VERT, fragmentShader: AURA_FRAG,
    });
    this.aura = new THREE.Points(geo, mat);
    this.scene.add(this.aura);
  }

  _initPost(){
    const size = new THREE.Vector2(this.mount.clientWidth, this.mount.clientHeight);
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this._dpr);
    this.composer.setSize(size.x, size.y);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(size, this.params.bloom, 0.85, 0.2);
    this.composer.addPass(this.bloom);
    this.fxaa = new ShaderPass(FXAAShader);
    this._setFxaa();
    this.composer.addPass(this.fxaa);
  }

  _setFxaa(){
    const w = this.mount.clientWidth * this._dpr, h = this.mount.clientHeight * this._dpr;
    this.fxaa.material.uniforms['resolution'].value.set(1/w, 1/h);
  }

  _initControls(){
    const c = new OrbitControls(this.camera, this.renderer.domElement);
    c.enableDamping = true; c.dampingFactor = 0.08;
    c.enablePan = false; c.rotateSpeed = 0.7; c.zoomSpeed = 0.8;
    c.minDistance = 3.0; c.maxDistance = 9.0;
    c.autoRotate = true; c.autoRotateSpeed = 0.35;
    this.controls = c;
  }

  _aspect(){ return this.mount.clientWidth / this.mount.clientHeight; }

  _bindResize(){
    this._onResize = () => {
      const w = this.mount.clientWidth, h = this.mount.clientHeight;
      this.camera.aspect = w/h; this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.composer.setSize(w, h);
      this._setFxaa();
    };
    window.addEventListener('resize', this._onResize);
  }

  async startMic(){ this.audio.gain = this.params.micGain; await this.audio.start(); }
  stopMic(){ this.audio.stop(); }

  setPalette(i){
    this.params.palette = i;
    const p = PALETTES[i];
    this.uniforms.uColorA.value.set(p.a);
    this.uniforms.uColorB.value.set(p.b);
    this.uniforms.uColorC.value.set(p.c);
    this.auraUniforms.uColor.value.set(p.bloom);
    this.core.material.color.set(p.c);
  }

  _animate(){
    const dt = Math.min(this._clock.getDelta(), 0.05);
    const t = this._clock.elapsedTime;
    this.audio.gain = this.params.micGain;
    this.audio.sample();

    this._breath += dt;
    const idle = this.audio.active ? 0 : 1;
    const breath = (Math.sin(this._breath * 0.9) * 0.5 + 0.5) * 0.12 * idle;

    this.uniforms.uTime.value += dt * this.params.speed * (1 + this.audio.level*0.5);
    this.uniforms.uDeform.value = this.params.deform;
    this.uniforms.uDetail.value = this.params.detail;
    this.uniforms.uAudio.value = this.audio.level + breath;
    this.uniforms.uAudioLow.value = this.audio.low;
    this.uniforms.uAudioHigh.value = this.audio.high;

    const s = 1 + this.audio.level*0.10 + breath*0.6;
    this.orb.scale.setScalar(s);
    this.core.scale.setScalar(s*0.98);
    this.core.material.opacity = 0.30 + this.audio.level*0.4;

    this.auraUniforms.uTime.value = t;
    this.auraUniforms.uAudio.value = this.audio.level + breath*0.5;
    this.auraUniforms.uAura.value = this.params.aura;
    this.aura.rotation.y += dt*0.05;

    this.bloom.strength = this.params.bloom * (1 + this.audio.level*0.5);
    this.controls.autoRotateSpeed = this.audio.active ? 0.12 : 0.35;
    this.controls.update();
    this.composer.render();
  }

  dispose(){
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this._onResize);
    this.stopMic();
    this.renderer.dispose();
    this.mount.removeChild(this.renderer.domElement);
  }
}

export { PALETTES };
