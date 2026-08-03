import { api } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { createWorldView3D, type WorldView3DHandle } from "./WorldView3D";
import type { Dimension, MapInfo, PlayerPosition } from "../types";

/**
 * Pannable, zoomable world map built from one image per region.
 *
 * Tiles are plain <img> elements positioned by transform rather than a canvas:
 * the browser then handles decoding, caching and lazy loading, and a region
 * that has not finished rendering server-side simply appears when it arrives
 * instead of blocking the whole view.
 */

const REGION_PX = 512;
const BLOCKS_PER_REGION = 512;
// Faster than the 15s player-list poll it is built on, so a marker starts
// moving as soon as the underlying name list is known.
const PLAYER_POLL_MS = 3000;

export interface WorldMapHandle {
  element: HTMLElement;
  destroy(): void;
}

export function createWorldMap(
  serverId: string,
  info: MapInfo,
  initialDimension: Dimension
): WorldMapHandle {
  const root = document.createElement("div");
  root.className = "map-root";

  let dimension: Dimension = initialDimension;
  let scale = 0.5;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let players: PlayerPosition[] = [];
  let stopped = false;
  let view3d: WorldView3DHandle | null = null;
  let lastX = 0;
  let lastY = 0;

  root.innerHTML = `
    <div class="map-toolbar">
      <select id="map-dim">
        ${info.dimensions
          .map(
            (d) =>
              `<option value="${d.id}" ${d.id === dimension ? "selected" : ""}>${t(
                `dim_${d.id}`
              )}</option>`
          )
          .join("")}
      </select>
      <button class="btn" id="map-zoom-out">−</button>
      <button class="btn" id="map-zoom-in">+</button>
      <button class="btn" id="map-spawn">${t("map_spawn")}</button>
      <button class="btn" id="map-fit">${t("map_fit")}</button>
      <button class="btn" id="map-3d">${t("map_3d")}</button>
      <span class="map-coords" id="map-coords"></span>
    </div>
    <div class="map-viewport" id="map-viewport">
      <div class="map-canvas" id="map-canvas"></div>
      <div class="map-players" id="map-players"></div>
      <div class="map-3d-host" id="map-3d-host" hidden></div>
    </div>
  `;

  const viewport = root.querySelector<HTMLDivElement>("#map-viewport")!;
  const canvas = root.querySelector<HTMLDivElement>("#map-canvas")!;
  const coords = root.querySelector<HTMLSpanElement>("#map-coords")!;
  const playerLayer = root.querySelector<HTMLDivElement>("#map-players")!;

  function regionsFor(dim: Dimension) {
    return info.dimensions.find((d) => d.id === dim)?.regions ?? [];
  }

  function spawnFor(dim: Dimension) {
    return info.dimensions.find((d) => d.id === dim)?.spawn ?? { x: 0, z: 0 };
  }

  /** Centres on the world spawn at one pixel per block. */
  function goToSpawn() {
    const spawn = spawnFor(dimension);
    const box = viewport.getBoundingClientRect();
    scale = 1;
    offsetX = box.width / 2 - spawn.x * scale;
    offsetY = box.height / 2 - spawn.z * scale;
    paint();
  }

  function paint() {
    canvas.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    paintPlayers();
  }

  /**
   * Markers live outside the scaled canvas and are placed in screen space.
   * Inside it they would inherit the zoom, so a name label would be unreadably
   * small when zoomed out and enormous when zoomed in.
   */
  function paintPlayers() {
    const here = players.filter((p) => p.dimension === dimension);
    playerLayer.innerHTML = here
      .map(
        (p) =>
          `<div class="map-player" style="left:${p.x * scale + offsetX}px;top:${
            p.z * scale + offsetY
          }px;"><span class="map-player-dot"></span><span class="map-player-name">${escapeHtml(
            p.name
          )}</span></div>`
      )
      .join("");
  }

  async function pollPlayers() {
    try {
      players = await api.getMapPlayers(serverId);
    } catch {
      // A stopped server or an RCON hiccup just means no markers.
      players = [];
    }
    if (!stopped) paintPlayers();
  }

  function buildTiles() {
    const regions = regionsFor(dimension);
    canvas.innerHTML = regions
      .map(
        (r) =>
          `<img class="map-tile" loading="lazy" alt=""
                src="/api/servers/${serverId}/map/${dimension}/${r.x}/${r.z}.png"
                style="left:${r.x * REGION_PX}px;top:${r.z * REGION_PX}px;" />`
      )
      .join("");
  }

  /**
   * Zooms out until every region file fits. This is the deliberate opposite of
   * the default view: a world that has been walked across keeps a region file
   * per visited chunk, so fitting them all can shrink the built area to a few
   * pixels - useful to see how far the world reaches, not to look at anything.
   */
  function fit() {
    const regions = regionsFor(dimension);
    if (regions.length === 0) return;
    const minX = Math.min(...regions.map((r) => r.x));
    const maxX = Math.max(...regions.map((r) => r.x));
    const minZ = Math.min(...regions.map((r) => r.z));
    const maxZ = Math.max(...regions.map((r) => r.z));
    const spanX = (maxX - minX + 1) * REGION_PX;
    const spanZ = (maxZ - minZ + 1) * REGION_PX;
    const box = viewport.getBoundingClientRect();
    scale = Math.min(box.width / spanX, box.height / spanZ) * 0.92 || 0.5;
    offsetX = box.width / 2 - ((minX * REGION_PX + spanX / 2) * scale);
    offsetY = box.height / 2 - ((minZ * REGION_PX + spanZ / 2) * scale);
    paint();
  }

  root.querySelector<HTMLSelectElement>("#map-dim")!.onchange = (e) => {
    dimension = (e.target as HTMLSelectElement).value as Dimension;
    close3d();
    buildTiles();
    goToSpawn();
  };
  root.querySelector<HTMLButtonElement>("#map-zoom-in")!.onclick = () => {
    scale = Math.min(4, scale * 1.4);
    paint();
  };
  root.querySelector<HTMLButtonElement>("#map-zoom-out")!.onclick = () => {
    scale = Math.max(0.05, scale / 1.4);
    paint();
  };
  root.querySelector<HTMLButtonElement>("#map-fit")!.onclick = fit;
  root.querySelector<HTMLButtonElement>("#map-spawn")!.onclick = goToSpawn;

  const host3d = root.querySelector<HTMLDivElement>("#map-3d-host")!;
  const button3d = root.querySelector<HTMLButtonElement>("#map-3d")!;
  button3d.onclick = () => {
    if (view3d) {
      close3d();
      return;
    }
    // Opens on whatever the 2D map is currently centred on, so switching views
    // does not lose your place.
    const box = viewport.getBoundingClientRect();
    const centreX = (box.width / 2 - offsetX) / scale;
    const centreZ = (box.height / 2 - offsetY) / scale;
    view3d = createWorldView3D(serverId, dimension, centreX, centreZ);
    host3d.appendChild(view3d.element);
    host3d.hidden = false;
    button3d.classList.add("active");
  };

  function close3d() {
    view3d?.destroy();
    view3d = null;
    host3d.innerHTML = "";
    host3d.hidden = true;
    button3d.classList.remove("active");
  }

  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    viewport.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    // Block coordinates under the cursor, so the map can be read against
    // in-game positions rather than being a picture.
    const box = viewport.getBoundingClientRect();
    const worldX = Math.round((e.clientX - box.left - offsetX) / scale);
    const worldZ = Math.round((e.clientY - box.top - offsetY) / scale);
    coords.textContent = `X ${worldX}  Z ${worldZ}`;

    if (!dragging) return;
    offsetX += e.clientX - lastX;
    offsetY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    paint();
  };
  const onPointerUp = (e: PointerEvent) => {
    dragging = false;
    viewport.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // Zoom about the cursor rather than the origin, so what is under the
    // pointer stays under it.
    const box = viewport.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = Math.max(0.05, Math.min(4, scale * factor));
    offsetX = px - ((px - offsetX) * next) / scale;
    offsetY = py - ((py - offsetY) * next) / scale;
    scale = next;
    paint();
  };

  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", onPointerUp);
  viewport.addEventListener("wheel", onWheel, { passive: false });

  buildTiles();
  // The viewport has no size until it is in the document.
  requestAnimationFrame(goToSpawn);
  void pollPlayers();
  const playerTimer = setInterval(() => void pollPlayers(), PLAYER_POLL_MS);

  return {
    element: root,
    destroy() {
      stopped = true;
      close3d();
      clearInterval(playerTimer);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("pointermove", onPointerMove);
      viewport.removeEventListener("pointerup", onPointerUp);
      viewport.removeEventListener("wheel", onWheel);
    },
  };
}

export { BLOCKS_PER_REGION };
