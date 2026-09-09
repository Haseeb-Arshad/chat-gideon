import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { type Mood, type Palette, moodPalette, rgbToCss } from '../lib/mood'
import { Spring, clamp } from '../lib/motion'

/**
 * The room GIDEON is sitting in.
 *
 * A single full-screen fragment shader: value-noise fBm put through two rounds
 * of domain warping, drifting upward, coloured by where the conversation
 * currently sits on the mood plane. Three details do most of the work:
 *
 *  - the upward drift and the warp evolution are accumulated as *phases* on the
 *    CPU rather than computed as speed × time, so changing the speed bends the
 *    motion instead of making the whole field jump;
 *  - the palette is sprung, not switched, so the light changes over seconds the
 *    way a mood does, and the six anchor palettes are blended by distance, so
 *    the colour is continuous rather than one of six looks;
 *  - the output is dithered before it hits an 8-bit framebuffer, which is the
 *    entire difference between a gradient and a gradient with visible steps.
 *
 * If WebGL2 is unavailable the canvas is skipped and the CSS layer underneath
 * carries the same palette, just without the flow.
 */

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform float uFlow;
uniform float uWarp;
uniform vec3 uBase;
uniform vec3 uBody;
uniform vec3 uCrest;
uniform float uEnergy;
uniform float uLevel;

out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Each octave is rotated as well as scaled; without that the lattice lines up
// with itself and the noise grows visible horizontal and vertical seams.
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = ROT * p * 2.02 + 11.3;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;

  vec2 p = uv * 1.3;
  p.y -= uFlow;

  // Domain warping: noise sampled at coordinates that are themselves noise.
  // One round gives clouds, two gives the folded, filament-like structure that
  // reads as something moving rather than something looping.
  vec2 q = vec2(fbm(p), fbm(p + vec2(5.2, 1.3)));
  vec2 r = vec2(
    fbm(p + 3.0 * q + vec2(1.7, 9.2) + uWarp),
    fbm(p + 3.0 * q + vec2(8.3, 2.8) - uWarp * 0.82)
  );
  // Sampling the last octave anisotropically stretches the structure along y,
  // so the field resolves into rising curtains rather than drifting blobs. It
  // is the difference between weather and something with a direction.
  float f = fbm((p + 2.4 * r) * vec2(1.55, 0.52));

  float band = clamp(f * 1.55 - 0.22, 0.0, 1.0);
  vec3 col = mix(uBase, uBody, band);

  // The crest only shows where the warp has folded hard, so the bright colour
  // arrives in ribbons instead of washing over everything.
  float ridge = pow(clamp(length(r) - 0.32, 0.0, 1.0), 2.0);
  col = mix(col, uCrest, ridge * (0.3 + uEnergy * 0.58));

  // Light rises: dimmer at the floor, stronger overhead.
  float vertical = smoothstep(-0.72, 0.95, uv.y);
  col *= mix(0.52, 1.45, vertical);

  // Hold the middle back — the face and the caption live there.
  float clearing = smoothstep(0.0, 1.05, length(uv * vec2(0.72, 1.3)));
  col *= mix(0.46, 1.0, clearing);

  col *= 1.0 - 0.34 * smoothstep(0.8, 1.7, length(uv));

  // Voice lifts the ribbons rather than the whole frame.
  col += uCrest * uLevel * 0.07 * ridge;

  // Dither into 8-bit. Without this the whole thing bands into visible steps.
  float d = hash(gl_FragCoord.xy + fract(uWarp) * 137.0);
  col += (d - 0.5) * 0.0055;

  outColor = vec4(max(col, 0.0), 1.0);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function link(gl: WebGL2RenderingContext) {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  if (!vertex || !fragment) return null
  const program = gl.createProgram()
  if (!program) return null
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }
  return program
}

export interface EmotionFieldProps {
  /** Where the conversation currently sits. Changes once per message. */
  mood: Mood
  /** Drives flow speed: a listening room is calmer than a speaking one. */
  active: boolean
  levelRef?: RefObject<number>
}

export function EmotionField({ mood, active, levelRef }: EmotionFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const target = useRef({ mood, active })
  target.current = { mood, active }

  // Published on the root so the rest of the interface can pick the mood up
  // too. The shader smooths its own colour with springs; out here the elements
  // that read these carry long transitions, which comes to the same thing.
  useEffect(() => {
    const palette = moodPalette(mood)
    const root = document.documentElement.style
    root.setProperty('--field-base', rgbToCss(palette.base))
    root.setProperty('--field-body', rgbToCss(palette.body))
    root.setProperty('--field-crest', rgbToCss(palette.crest))
    root.setProperty('--field-crest-soft', rgbToCss(palette.crest, 0.16))
    root.setProperty('--field-crest-faint', rgbToCss(palette.crest, 0.07))
    root.setProperty('--field-energy', mood.arousal.toFixed(3))
  }, [mood])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
    })
    if (!gl) {
      wrap.dataset.mode = 'css'
      return
    }

    const program = link(gl)
    if (!program) {
      wrap.dataset.mode = 'css'
      return
    }
    wrap.dataset.mode = 'gl'

    const uniforms = {
      res: gl.getUniformLocation(program, 'uRes'),
      flow: gl.getUniformLocation(program, 'uFlow'),
      warp: gl.getUniformLocation(program, 'uWarp'),
      base: gl.getUniformLocation(program, 'uBase'),
      body: gl.getUniformLocation(program, 'uBody'),
      crest: gl.getUniformLocation(program, 'uCrest'),
      energy: gl.getUniformLocation(program, 'uEnergy'),
      level: gl.getUniformLocation(program, 'uLevel'),
    }
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    gl.useProgram(program)

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    // The field is soft by construction, so half resolution is free quality.
    const SCALE = 0.55
    let width = 0
    let height = 0
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(2, Math.round(wrap.clientWidth * dpr * SCALE))
      const h = Math.max(2, Math.round(wrap.clientHeight * dpr * SCALE))
      if (w === width && h === height) return
      width = w
      height = h
      canvas.width = w
      canvas.height = h
      gl.viewport(0, 0, w, h)
      gl.uniform2f(uniforms.res, w, h)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)

    // Springs, not lerps: the colour eases in and settles instead of ramping.
    const start = moodPalette(target.current.mood)
    const channels: Spring[] = []
    const seed = [...start.base, ...start.body, ...start.crest]
    for (const value of seed) channels.push(new Spring(value, 0.16, 1))
    const energySpring = new Spring(target.current.mood.arousal, 0.3, 1)

    let flow = Math.random() * 40
    let warp = Math.random() * 30
    let level = 0
    let previous = performance.now()
    let frame = 0

    const render = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.0005, (now - previous) / 1000))
      previous = now

      const palette = moodPalette(target.current.mood)
      const goal = [...palette.base, ...palette.body, ...palette.crest]
      for (let i = 0; i < channels.length; i += 1) channels[i].step(goal[i], dt)
      const energy = energySpring.step(target.current.mood.arousal, dt)

      const raw = levelRef?.current ?? 0
      level += (raw - level) * Math.min(1, dt * 8)

      // Accumulating the phase means a change of speed bends the flow instead
      // of teleporting it, which a naive `time * speed` cannot avoid.
      const pace = reducedMotion ? 0.08 : 1
      const speed = 0.07 + energy * 0.085 + (target.current.active ? 0.025 : 0) + level * 0.1
      flow += dt * speed * pace
      warp += dt * (0.05 + energy * 0.06) * pace

      gl.uniform1f(uniforms.flow, flow)
      gl.uniform1f(uniforms.warp, warp)
      gl.uniform3f(uniforms.base, channels[0].value, channels[1].value, channels[2].value)
      gl.uniform3f(uniforms.body, channels[3].value, channels[4].value, channels[5].value)
      gl.uniform3f(uniforms.crest, channels[6].value, channels[7].value, channels[8].value)
      gl.uniform1f(uniforms.energy, clamp(energy, 0, 1))
      gl.uniform1f(uniforms.level, clamp(level, 0, 1))
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      frame = requestAnimationFrame(render)
    }

    frame = requestAnimationFrame(render)

    // A backgrounded tab should not keep a shader warm.
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame)
      } else {
        previous = performance.now()
        frame = requestAnimationFrame(render)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', onVisibility)
      observer.disconnect()
      gl.deleteProgram(program)
      gl.deleteVertexArray(vao)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [levelRef])

  return (
    <div className="emotion-field" ref={wrapRef} data-mode="css" aria-hidden="true">
      <canvas ref={canvasRef} className="emotion-canvas" />
      <span className="emotion-wash" />
      <span className="emotion-grain" />
    </div>
  )
}

export type { Palette }
