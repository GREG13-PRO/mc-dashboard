import { api } from "../api";
import { t } from "../lib/i18n";
import { perspective, lookAt, multiply } from "../lib/mat4";
import type { Dimension, SurfaceView } from "../types";

/**
 * Blocky 3D view of a square of world, built from the same surface data the 2D
 * tiles come from.
 *
 * Hand-written WebGL rather than a 3D library: the whole scene is one buffer of
 * flat-shaded quads drawn in a single call, which is a shader pair and a
 * handful of matrix maths - not worth a runtime dependency, and this project
 * has a standing reason to keep its dependency list short.
 *
 * Only the surface is drawn, not every block: a 192-block square is 36k
 * columns, and columns are extruded down to whichever neighbour is lowest, so
 * what you see is the terrain's silhouette rather than a hollow sheet.
 */

const VIEW_BLOCKS = 192;
/**
 * How far a column's sides are drawn below its top.
 *
 * Extruding all the way down to the neighbour is the geometrically honest
 * reading of a surface heightmap, but it turns every tree into a solid pillar
 * from its canopy to the ground - a lobby full of cherry trees rendered as a
 * forest of spikes. Cutting the skirt short leaves canopies reading as
 * canopies while cliffs and walls still read as solid.
 */
const MAX_SKIRT = 6;
const FACE_SHADE = { top: 1, north: 0.86, south: 0.72, east: 0.8, west: 0.66 };

const VERTEX_SHADER = `
attribute vec3 aPos;
attribute vec3 aColour;
uniform mat4 uMvp;
varying vec3 vColour;
void main() {
  gl_Position = uMvp * vec4(aPos, 1.0);
  vColour = aColour;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vColour;
void main() {
  gl_FragColor = vec4(vColour, 1.0);
}`;

export interface WorldView3DHandle {
  element: HTMLElement;
  destroy(): void;
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  }
  return shader;
}

interface Mesh {
  data: Float32Array;
  vertices: number;
  /** Vertical centre of the terrain, so the camera has something to orbit. */
  centreY: number;
}

/**
 * Turns the surface square into flat-shaded quads.
 *
 * A column gets a top face, plus a side face towards any neighbour that sits
 * lower - one quad spanning the whole drop rather than one per block, which is
 * what keeps a cliff from costing hundreds of quads.
 */
function buildMesh(view: SurfaceView, palette: [number, number, number][]): Mesh {
  const size = view.size;
  const colours = decodeBase64(view.colours);
  const raw = decodeBase64(view.heights);
  const heights = new Int16Array(raw.buffer, raw.byteOffset, size * size);

  const parts: number[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < size * size; i++) {
    if (colours[i] === 0) continue;
    minY = Math.min(minY, heights[i]);
    maxY = Math.max(maxY, heights[i]);
  }
  if (!Number.isFinite(minY)) return { data: new Float32Array(0), vertices: 0, centreY: 64 };
  // Sides are extruded down to just below the lowest column in view, so the
  // terrain reads as solid rather than as a floating shell.
  const floor = minY - 1;

  const push = (
    x: number,
    y: number,
    z: number,
    [r, g, b]: [number, number, number],
    shade: number
  ) => {
    parts.push(x - size / 2, y, z - size / 2, r * shade, g * shade, b * shade);
  };

  const quad = (
    corners: [number, number, number][],
    colour: [number, number, number],
    shade: number
  ) => {
    const [a, b, c, d] = corners;
    for (const p of [a, b, c, a, c, d]) push(p[0], p[1], p[2], colour, shade);
  };

  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const i = z * size + x;
      const id = colours[i];
      if (id === 0) continue;
      const colour = palette[id] ?? [0.5, 0.5, 0.5];
      const y = heights[i] + 1;

      quad(
        [
          [x, y, z],
          [x, y, z + 1],
          [x + 1, y, z + 1],
          [x + 1, y, z],
        ],
        colour,
        FACE_SHADE.top
      );

      const neighbour = (nx: number, nz: number) => {
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) return Math.max(floor, y - MAX_SKIRT);
        const at = nz * size + nx;
        const below = colours[at] === 0 ? floor : heights[at] + 1;
        return Math.max(below, y - MAX_SKIRT);
      };

      const north = neighbour(x, z - 1);
      if (north < y) {
        quad(
          [
            [x, y, z],
            [x + 1, y, z],
            [x + 1, north, z],
            [x, north, z],
          ],
          colour,
          FACE_SHADE.north
        );
      }
      const south = neighbour(x, z + 1);
      if (south < y) {
        quad(
          [
            [x, y, z + 1],
            [x, south, z + 1],
            [x + 1, south, z + 1],
            [x + 1, y, z + 1],
          ],
          colour,
          FACE_SHADE.south
        );
      }
      const west = neighbour(x - 1, z);
      if (west < y) {
        quad(
          [
            [x, y, z],
            [x, west, z],
            [x, west, z + 1],
            [x, y, z + 1],
          ],
          colour,
          FACE_SHADE.west
        );
      }
      const east = neighbour(x + 1, z);
      if (east < y) {
        quad(
          [
            [x + 1, y, z],
            [x + 1, y, z + 1],
            [x + 1, east, z + 1],
            [x + 1, east, z],
          ],
          colour,
          FACE_SHADE.east
        );
      }
    }
  }

  const data = new Float32Array(parts);
  return { data, vertices: parts.length / 6, centreY: (minY + maxY) / 2 };
}

export function createWorldView3D(
  serverId: string,
  dimension: Dimension,
  centreX: number,
  centreZ: number
): WorldView3DHandle {
  const root = document.createElement("div");
  root.className = "map-3d";
  root.innerHTML = `
    <canvas class="map-3d-canvas"></canvas>
    <div class="map-3d-status">${t("betoltes")}</div>
  `;
  const canvas = root.querySelector<HTMLCanvasElement>("canvas")!;
  const status = root.querySelector<HTMLDivElement>(".map-3d-status")!;

  let disposed = false;
  let yaw = Math.PI / 4;
  let pitch = 0.62;
  let distance = VIEW_BLOCKS * 1.6;
  let centreY = 64;
  let vertices = 0;
  let frame = 0;

  const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
  if (!gl) {
    status.textContent = t("nincs_webgl");
    return { element: root, destroy() {} };
  }

  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  const aPos = gl.getAttribLocation(program, "aPos");
  const aColour = gl.getAttribLocation(program, "aColour");
  const uMvp = gl.getUniformLocation(program, "uMvp");
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.07, 0.08, 0.1, 1);

  function draw() {
    if (disposed || !gl) return;
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (vertices === 0) return;

    const eye: [number, number, number] = [
      Math.cos(pitch) * Math.sin(yaw) * distance,
      centreY + Math.sin(pitch) * distance,
      Math.cos(pitch) * Math.cos(yaw) * distance,
    ];
    const mvp = multiply(
      perspective(Math.PI / 4, width / height, 1, distance * 4 + 1000),
      lookAt(eye, [0, centreY, 0], [0, 1, 0])
    );
    gl.uniformMatrix4fv(uMvp, false, mvp);
    gl.drawArrays(gl.TRIANGLES, 0, vertices);
  }

  function requestDraw() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  const onPointerDown = (e: PointerEvent) => {
    // The 2D map's viewport sits underneath and captures the pointer on its own
    // pointerdown. Letting this bubble would hand the capture straight back to
    // it, so the orbit would receive one move event and never an up - leaving
    // the move listener attached for good.
    e.stopPropagation();
    canvas.setPointerCapture(e.pointerId);
    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (m: PointerEvent) => {
      yaw -= (m.clientX - lastX) * 0.008;
      // Stop just short of straight down and of the horizon, where the camera
      // would either gimbal-flip or slide under the terrain.
      pitch = Math.max(0.08, Math.min(1.5, pitch + (m.clientY - lastY) * 0.006));
      lastX = m.clientX;
      lastY = m.clientY;
      requestDraw();
    };
    const up = (u: PointerEvent) => {
      canvas.releasePointerCapture(u.pointerId);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    distance = Math.max(24, Math.min(VIEW_BLOCKS * 3, distance * (e.deltaY < 0 ? 1 / 1.15 : 1.15)));
    requestDraw();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  const onResize = () => requestDraw();
  window.addEventListener("resize", onResize);

  void (async () => {
    let view: SurfaceView;
    try {
      view = await api.getSurfaceView(
        serverId,
        dimension,
        Math.round(centreX - VIEW_BLOCKS / 2),
        Math.round(centreZ - VIEW_BLOCKS / 2),
        VIEW_BLOCKS
      );
    } catch {
      status.textContent = t("nem_sikerult_betolteni");
      return;
    }
    if (disposed) return;

    const palette = view.palette.map((hex) => {
      const n = Number.parseInt(hex.slice(1), 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] as [
        number,
        number,
        number,
      ];
    });
    const mesh = buildMesh(view, palette);
    if (mesh.vertices === 0) {
      status.textContent = t("nincs_vilagadat");
      return;
    }
    centreY = mesh.centreY;
    vertices = mesh.vertices;
    status.remove();

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    const stride = 6 * 4;
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(aColour);
    gl.vertexAttribPointer(aColour, 3, gl.FLOAT, false, stride, 3 * 4);
    requestDraw();
  })();

  return {
    element: root,
    destroy() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("wheel", onWheel);
      // Frees the buffer immediately instead of waiting for the context to be
      // garbage collected; browsers allow only a handful of live contexts.
      gl.deleteBuffer(buffer);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
