import { api } from "../api";
import { t } from "../lib/i18n";
import { perspective, lookAt, multiply } from "../lib/mat4";
import type { Dimension, SchematicSurface, SurfaceView } from "../types";

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

/**
 * A schematic standing on the terrain, before anything is written to the world.
 *
 * Pasting used to be a leap of faith: pick a file by name, type three numbers,
 * and find out what you had done by walking there in game. The ghost is the
 * same blocks the paste will place, drawn where the paste will place them.
 */
export interface GhostPlacement {
  surface: SchematicSurface;
  /** North-west corner of the build, in world blocks. */
  x: number;
  z: number;
  /** World Y the bottom layer sits on. */
  y: number;
}

export interface WorldView3DHandle {
  element: HTMLElement;
  destroy(): void;
  /** Draws a schematic at a spot, or clears it when given null. */
  setGhost(placement: GhostPlacement | null): void;
  /** Terrain height at a world column, or null outside the loaded square. */
  heightAt(x: number, z: number): number | null;
  /** Called with world coordinates when the terrain is clicked. */
  onPick: ((x: number, z: number) => void) | null;
  /** Resolves once the terrain is loaded, so a caller can place onto it. */
  ready: Promise<void>;
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

/**
 * How much the ghost is lightened against the terrain.
 *
 * A schematic drawn in its true colours next to the world it will be pasted
 * into is indistinguishable from a build that is already there, which defeats
 * the point of a preview. Lightening rather than making it translucent keeps
 * the shape readable - a see-through building against a busy hillside is a
 * mess, and the depth buffer would need sorting to draw it correctly anyway.
 */
const GHOST_LIFT = 0.32;
/** Deepest the ghost's sides are drawn, so a build on a cliff edge stays cheap. */
const GHOST_SKIRT = 40;

/**
 * The schematic's surface as quads, positioned in the terrain's coordinates.
 *
 * Separate from `buildMesh` rather than generalised into it: the ghost skirts
 * down to the terrain underneath so the building looks like it is standing on
 * the ground, where the terrain skirts down to its own lowest column. One
 * function doing both would be an argument list describing two different jobs.
 */
function buildGhostMesh(
  placement: GhostPlacement,
  view: SurfaceView,
  terrainHeights: Int16Array,
  terrainColours: Uint8Array
): { data: Float32Array; vertices: number } {
  const { surface } = placement;
  const colours = decodeBase64(surface.colours);
  const raw = decodeBase64(surface.heights);
  const heights = new Int16Array(raw.buffer, raw.byteOffset, surface.width * surface.length);
  const palette = surface.palette.map((hex) => {
    const n = Number.parseInt(hex.slice(1), 16);
    // Lifted towards white here rather than in the shader: the colours are
    // baked into the vertex buffer, and the shader is shared with the terrain.
    const lift = (channel: number) => (channel / 255) * (1 - GHOST_LIFT) + GHOST_LIFT;
    return [lift((n >> 16) & 255), lift((n >> 8) & 255), lift(n & 255)] as [number, number, number];
  });

  const size = view.size;
  const parts: number[] = [];
  const push = (x: number, y: number, z: number, [r, g, b]: [number, number, number], shade: number) => {
    parts.push(x - size / 2, y, z - size / 2, r * shade, g * shade, b * shade);
  };
  const quad = (corners: [number, number, number][], colour: [number, number, number], shade: number) => {
    const [a, b, c, d] = corners;
    for (const p of [a, b, c, a, c, d]) push(p[0], p[1], p[2], colour, shade);
  };

  /** Terrain height at a grid column, or the ghost's own base outside the view. */
  const groundAt = (gx: number, gz: number): number => {
    if (gx < 0 || gz < 0 || gx >= size || gz >= size) return placement.y;
    const at = gz * size + gx;
    return terrainColours[at] === 0 ? placement.y : terrainHeights[at] + 1;
  };

  const top = (sx: number, sz: number): number | null => {
    if (sx < 0 || sz < 0 || sx >= surface.width || sz >= surface.length) return null;
    const at = sz * surface.width + sx;
    return colours[at] === 0 ? null : placement.y + heights[at] + 1;
  };

  for (let sz = 0; sz < surface.length; sz++) {
    for (let sx = 0; sx < surface.width; sx++) {
      const at = sz * surface.width + sx;
      const id = colours[at];
      if (id === 0) continue;
      const colour = palette[id] ?? [0.8, 0.8, 0.8];
      // Grid coordinates within the loaded square, which is what the mesh is
      // laid out in; the ghost may hang off the edge and that is fine.
      const gx = placement.x + sx - view.x;
      const gz = placement.z + sz - view.z;
      const y = placement.y + heights[at] + 1;

      quad(
        [
          [gx, y, gz],
          [gx, y, gz + 1],
          [gx + 1, y, gz + 1],
          [gx + 1, y, gz],
        ],
        colour,
        FACE_SHADE.top
      );

      const skirt = (nx: number, nz: number) => {
        const neighbour = top(nx, nz);
        const ground = groundAt(placement.x + nx - view.x, placement.z + nz - view.z);
        // Down to whichever is higher - the neighbouring part of the build, or
        // the ground it stands on - and never more than GHOST_SKIRT deep.
        return Math.max(neighbour ?? ground, ground, y - GHOST_SKIRT);
      };

      const north = skirt(sx, sz - 1);
      if (north < y) {
        quad([[gx, y, gz], [gx + 1, y, gz], [gx + 1, north, gz], [gx, north, gz]], colour, FACE_SHADE.north);
      }
      const south = skirt(sx, sz + 1);
      if (south < y) {
        quad(
          [[gx, y, gz + 1], [gx, south, gz + 1], [gx + 1, south, gz + 1], [gx + 1, y, gz + 1]],
          colour,
          FACE_SHADE.south
        );
      }
      const west = skirt(sx - 1, sz);
      if (west < y) {
        quad([[gx, y, gz], [gx, west, gz], [gx, west, gz + 1], [gx, y, gz + 1]], colour, FACE_SHADE.west);
      }
      const east = skirt(sx + 1, sz);
      if (east < y) {
        quad(
          [[gx + 1, y, gz], [gx + 1, y, gz + 1], [gx + 1, east, gz + 1], [gx + 1, east, gz]],
          colour,
          FACE_SHADE.east
        );
      }
    }
  }

  const data = new Float32Array(parts);
  return { data, vertices: parts.length / 6 };
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
  let ghostVertices = 0;
  /** Kept so the ghost can be rebuilt at a new spot without refetching. */
  let loaded: SurfaceView | null = null;
  let terrainHeights: Int16Array | null = null;
  let terrainColours: Uint8Array | null = null;
  let ghost: GhostPlacement | null = null;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
  if (!gl) {
    status.textContent = t("nincs_webgl");
    return {
      element: root,
      destroy() {},
      setGhost() {},
      heightAt: () => null,
      onPick: null,
      ready: Promise.resolve(),
    };
  }

  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  const ghostBuffer = gl.createBuffer();
  const aPos = gl.getAttribLocation(program, "aPos");
  const aColour = gl.getAttribLocation(program, "aColour");
  const uMvp = gl.getUniformLocation(program, "uMvp");
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.07, 0.08, 0.1, 1);

  /** Points the attributes at one buffer; both have the same interleaved layout. */
  function bind(which: WebGLBuffer | null) {
    if (!gl) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, which);
    const stride = 6 * 4;
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(aColour);
    gl.vertexAttribPointer(aColour, 3, gl.FLOAT, false, stride, 3 * 4);
  }

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

    const mvp = multiply(
      perspective(Math.PI / 4, width / height, 1, distance * 4 + 1000),
      lookAt(cameraEye(), [0, centreY, 0], [0, 1, 0])
    );
    gl.uniformMatrix4fv(uMvp, false, mvp);
    bind(buffer);
    gl.drawArrays(gl.TRIANGLES, 0, vertices);
    if (ghostVertices > 0) {
      bind(ghostBuffer);
      gl.drawArrays(gl.TRIANGLES, 0, ghostVertices);
    }
  }

  function cameraEye(): [number, number, number] {
    return [
      Math.cos(pitch) * Math.sin(yaw) * distance,
      centreY + Math.sin(pitch) * distance,
      Math.cos(pitch) * Math.cos(yaw) * distance,
    ];
  }

  /**
   * World column under a point on the canvas.
   *
   * Marched rather than solved: the terrain is a heightfield, not a plane, so
   * there is no closed form - the ray is stepped forward until it drops below
   * the surface, then bisected once to land on the right block rather than the
   * one half a step past it. Half-block steps because a step longer than a
   * block can jump clean over a wall and pick the ground behind it.
   */
  function pick(clientX: number, clientY: number): { x: number; z: number } | null {
    if (!loaded || !terrainHeights || !terrainColours) return null;
    const box = canvas.getBoundingClientRect();
    const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
    const tanHalf = Math.tan(Math.PI / 8);
    const ndcX = ((clientX - box.left) / box.width) * 2 - 1;
    const ndcY = 1 - ((clientY - box.top) / box.height) * 2;

    const eye = cameraEye();
    const target: [number, number, number] = [0, centreY, 0];
    const norm = (v: number[]): [number, number, number] => {
      const len = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / len, v[1] / len, v[2] / len];
    };
    const cross = (a: number[], b: number[]) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const forward = norm([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    const right = norm(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const dir = norm([
      forward[0] + right[0] * ndcX * tanHalf * aspect + up[0] * ndcY * tanHalf,
      forward[1] + right[1] * ndcX * tanHalf * aspect + up[1] * ndcY * tanHalf,
      forward[2] + right[2] * ndcX * tanHalf * aspect + up[2] * ndcY * tanHalf,
    ]);

    const size = loaded.size;
    /** Mesh-local coordinates are grid coordinates shifted by half the square. */
    const heightAtLocal = (lx: number, lz: number): number | null => {
      const gx = Math.floor(lx + size / 2);
      const gz = Math.floor(lz + size / 2);
      if (gx < 0 || gz < 0 || gx >= size || gz >= size) return null;
      const at = gz * size + gx;
      return terrainColours![at] === 0 ? null : terrainHeights![at] + 1;
    };

    const step = 0.5;
    const far = distance * 4;
    let previous = 0;
    for (let travelled = 1; travelled < far; travelled += step) {
      const px = eye[0] + dir[0] * travelled;
      const py = eye[1] + dir[1] * travelled;
      const pz = eye[2] + dir[2] * travelled;
      const ground = heightAtLocal(px, pz);
      if (ground !== null && py <= ground) {
        // One bisection back towards the last point that was still in the air,
        // which is enough to land on the block that was clicked rather than its
        // neighbour.
        const middle = (previous + travelled) / 2;
        const mx = eye[0] + dir[0] * middle;
        const mz = eye[2] + dir[2] * middle;
        const hit = heightAtLocal(mx, mz) !== null ? middle : travelled;
        return {
          x: Math.floor(eye[0] + dir[0] * hit + size / 2) + loaded.x,
          z: Math.floor(eye[2] + dir[2] * hit + size / 2) + loaded.z,
        };
      }
      previous = travelled;
    }
    return null;
  }

  function rebuildGhost() {
    if (!gl) return;
    if (!ghost || !loaded || !terrainHeights || !terrainColours) {
      ghostVertices = 0;
      requestDraw();
      return;
    }
    const mesh = buildGhostMesh(ghost, loaded, terrainHeights, terrainColours);
    ghostVertices = mesh.vertices;
    gl.bindBuffer(gl.ARRAY_BUFFER, ghostBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    requestDraw();
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
    // A click places the ghost, a drag orbits. Told apart by distance rather
    // than by time: orbiting starts with a slow careful movement as often as a
    // fast one, and a placement is never dragged.
    const downX = e.clientX;
    const downY = e.clientY;
    let moved = 0;
    const move = (m: PointerEvent) => {
      moved = Math.max(moved, Math.hypot(m.clientX - downX, m.clientY - downY));
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
      if (moved <= 4 && handle.onPick) {
        const spot = pick(u.clientX, u.clientY);
        if (spot) handle.onPick(spot.x, spot.z);
      }
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
      resolveReady();
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
      resolveReady();
      return;
    }
    centreY = mesh.centreY;
    vertices = mesh.vertices;
    status.remove();

    // Kept unpacked so placement can read heights without decoding again on
    // every pointer move.
    loaded = view;
    terrainColours = decodeBase64(view.colours);
    const rawHeights = decodeBase64(view.heights);
    terrainHeights = new Int16Array(rawHeights.buffer, rawHeights.byteOffset, view.size * view.size);

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    bind(buffer);
    requestDraw();
    resolveReady();
    // A ghost set while the terrain was still loading has been remembered but
    // not drawn; now there is something to stand it on.
    if (ghost) rebuildGhost();
  })();

  const handle: WorldView3DHandle = {
    element: root,
    onPick: null,
    ready,
    setGhost(placement) {
      ghost = placement;
      rebuildGhost();
    },
    heightAt(x, z) {
      if (!loaded || !terrainHeights || !terrainColours) return null;
      const gx = x - loaded.x;
      const gz = z - loaded.z;
      if (gx < 0 || gz < 0 || gx >= loaded.size || gz >= loaded.size) return null;
      const at = gz * loaded.size + gx;
      return terrainColours[at] === 0 ? null : terrainHeights[at] + 1;
    },
    destroy() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("wheel", onWheel);
      // Frees the buffers immediately instead of waiting for the context to be
      // garbage collected; browsers allow only a handful of live contexts.
      gl.deleteBuffer(buffer);
      gl.deleteBuffer(ghostBuffer);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
  return handle;
}
